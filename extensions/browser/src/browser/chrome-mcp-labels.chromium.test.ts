import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { closeChromeMcpSession, evaluateChromeMcpScript } from "./chrome-mcp.js";
import { resolveBrowserConfig } from "./config.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { registerBrowserAgentSnapshotRoutes } from "./routes/agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")("Chrome MCP frame labels", () => {
  it.each(["page", "iframe", "removed iframe element", "cross-origin page", "cross-origin iframe"])(
    "keeps labels bound to their documents: %s",
    async (mode) => {
      const crossOrigin = mode.startsWith("cross-origin");
      const clipToFrameRef = mode.endsWith("iframe") || mode === "removed iframe element";
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const profileName = "mcp-frame-labels";
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-mcp-labels-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`, ...(crossOrigin ? ["--site-per-process"] : [])],
        },
      );
      let imagePath: string | undefined;
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        const frameHtml = "<button style='width:180px;height:100px'>Frame button</button>";
        if (crossOrigin) {
          // Adjacent backend IDs in separate renderers expose the MCP UID namespace collision.
          const collisionControls = Array.from(
            { length: 16 },
            (_, index) => `<button aria-label="Identity ${index}"></button>`,
          ).join("");
          await page.route("http://localhost:22222/frame", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: frameHtml + collisionControls,
            }),
          );
          await page.route("http://127.0.0.1:11111/labels", (route) =>
            route.fulfill({
              contentType: "text/html",
              body:
                '<button>Top button</button><iframe src="http://localhost:22222/frame"></iframe>' +
                collisionControls,
            }),
          );
          await page.goto("http://127.0.0.1:11111/labels");
        } else {
          await page.setContent(`<button>Top button</button>
        <iframe srcdoc="${frameHtml}"></iframe>`);
        }
        await page
          .frameLocator("iframe")
          .getByRole("button", { name: "Frame button", exact: true })
          .waitFor();
        if (crossOrigin) {
          const session = await context.newCDPSession(page);
          try {
            const { targetInfos } = await session.send("Target.getTargets");
            expect(targetInfos).toContainEqual(
              expect.objectContaining({
                type: "iframe",
                url: "http://localhost:22222/frame",
              }),
            );
            const frame = expectDefined(
              page.frames().find((candidate) => candidate.url() === "http://localhost:22222/frame"),
              "cross-origin frame",
            );
            const frameSession = await context.newCDPSession(frame);
            try {
              const roots = await Promise.all(
                [session, frameSession].map((client) =>
                  client.send("DOM.getDocument", { depth: -1 }),
                ),
              );
              const ids = roots.map(({ root }) => {
                const buttons = new Set<number>();
                const pending = [root];
                while (pending.length > 0) {
                  const node = pending.pop()!;
                  const labelIndex = node.attributes?.indexOf("aria-label") ?? -1;
                  const name = labelIndex >= 0 ? node.attributes?.[labelIndex + 1] : undefined;
                  if (node.nodeName === "BUTTON" && name) {
                    buttons.add(node.backendNodeId);
                  }
                  pending.push(...(node.children ?? []));
                }
                return buttons;
              });
              expect([...ids[0]!].some((id) => ids[1]!.has(id))).toBe(true);
            } finally {
              await frameSession.detach();
            }
          } finally {
            await session.detach();
          }
        }
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: profileName,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: {
              [profileName]: {
                driver: "existing-session",
                cdpUrl,
                color: "#123456",
                mcpCommand: process.env.OPENCLAW_BROWSER_MCP_TEST_COMMAND,
              },
            },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        registerBrowserAgentSnapshotRoutes(
          routes.app,
          createBrowserRouteContext({ getState: () => state }),
        );
        const snapshotResponse = createBrowserRouteResponse();
        await expectDefined(routes.getHandlers.get("/snapshot"), "snapshot route")(
          { params: {}, query: { format: "ai" } },
          snapshotResponse.res,
        );
        expect(snapshotResponse.statusCode, JSON.stringify(snapshotResponse.body)).toBe(200);
        const snapshot = snapshotResponse.body as {
          targetId: string;
          refs: Record<string, { name?: string }>;
        };
        const frameRef = expectDefined(
          Object.entries(snapshot.refs).find(([, value]) => value.name === "Frame button")?.[0],
          "iframe button ref",
        );
        const identity = await evaluateChromeMcpScript({
          profileName,
          profile: { cdpUrl, mcpCommand: process.env.OPENCLAW_BROWSER_MCP_TEST_COMMAND },
          targetId: snapshot.targetId,
          args: [frameRef],
          fn: "(el) => ({ tagName: el.tagName, text: el.textContent, documentUrl: el.ownerDocument.URL })",
        });
        expect(identity).toEqual({
          tagName: "BUTTON",
          text: "Frame button",
          documentUrl: crossOrigin ? "http://localhost:22222/frame" : "about:srcdoc",
        });
        if (mode === "removed iframe element") {
          await page
            .frameLocator("iframe")
            .getByRole("button", { name: "Frame button", exact: true })
            .evaluate((button) => {
              const observer = new MutationObserver(() => {
                if (document.querySelector("[data-openclaw-mcp-overlay]")) {
                  button.remove();
                  observer.disconnect();
                }
              });
              observer.observe(document.documentElement, { childList: true });
            });
        }
        const response = createBrowserRouteResponse();
        await expectDefined(routes.postHandlers.get("/screenshot"), "screenshot route")(
          {
            params: {},
            query: {},
            body: {
              targetId: snapshot.targetId,
              labels: true,
              ...(clipToFrameRef ? { ref: frameRef } : {}),
            },
          },
          response.res,
        );
        const proofDir = process.env.OPENCLAW_BROWSER_MCP_LABEL_PROOF_DIR;
        if (proofDir && mode === "iframe") {
          await fs.mkdir(proofDir, { recursive: true });
          await page.screenshot({ path: path.join(proofDir, "iframe-after-operation.png") });
        }
        if (mode === "removed iframe element") {
          expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
        } else {
          expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
          const screenshot = response.body as { path: string; labelsCount: number };
          imagePath = screenshot.path;
          expect(screenshot.labelsCount).toBe(clipToFrameRef ? 1 : crossOrigin ? 34 : 2);
          expect((await fs.stat(imagePath)).size).toBeGreaterThan(0);
        }
        expect(await page.locator("[data-openclaw-mcp-overlay]").count()).toBe(0);
        expect(
          await page.frameLocator("iframe").locator("[data-openclaw-mcp-overlay]").count(),
        ).toBe(0);
      } finally {
        if (imagePath) {
          await fs.rm(imagePath);
        }
        try {
          await closeChromeMcpSession(profileName);
        } finally {
          await context.close();
        }
      }
    },
    120_000,
  );
});
