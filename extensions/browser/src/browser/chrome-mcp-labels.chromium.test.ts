import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import * as fixture from "./chrome-mcp.chromium.test-support.js";
import { evaluateChromeMcpScript } from "./chrome-mcp.js";

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")("Chrome MCP frame labels", () => {
  it.each(["page", "iframe", "removed iframe element", "cross-origin page", "cross-origin iframe"])(
    "keeps labels bound to their documents: %s",
    async (mode) => {
      const crossOrigin = mode.startsWith("cross-origin");
      const clipToFrameRef = mode.endsWith("iframe") || mode === "removed iframe element";
      await fixture.withMcpBrowser(
        async ({ context, page, profile, profileName }) => {
          let imagePath: string | undefined;
          try {
            const frameHtml = "<button style='width:180px;height:100px'>Frame button</button>";
            const frameUrl = "http://localhost:22222/frame";
            const pageUrl = "http://127.0.0.1:11111/labels";
            if (crossOrigin) {
              // Adjacent backend IDs in separate renderers expose the MCP UID namespace collision.
              const collisionControls = fixture.controls(
                16,
                (index) => `<button aria-label="Identity ${index}"></button>`,
              );
              await fixture.serveHtml(page, frameUrl, frameHtml + collisionControls);
              await fixture.serveHtml(
                page,
                pageUrl,
                `<button>Top button</button><iframe src="${frameUrl}"></iframe>` +
                  collisionControls,
              );
              await page.goto(pageUrl);
            } else {
              await page.setContent(`<button>Top button</button>
        <iframe srcdoc="${frameHtml}"></iframe>`);
            }
            const frameButton = page
              .frameLocator("iframe")
              .getByRole("button", { name: "Frame button", exact: true });
            await frameButton.waitFor();
            if (crossOrigin) {
              const session = await context.newCDPSession(page);
              try {
                const { targetInfos } = await session.send("Target.getTargets");
                expect(targetInfos).toContainEqual(
                  expect.objectContaining({ type: "iframe", url: frameUrl }),
                );
                const frame = expectDefined(
                  page.frames().find((candidate) => candidate.url() === frameUrl),
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
            const routes = fixture.mcpRoutes(profileName, profile);
            const snapshot = await fixture.routeSnapshot(routes);
            const frameRef = expectDefined(
              Object.entries(snapshot.refs).find(([, value]) => value.name === "Frame button")?.[0],
              "iframe button ref",
            );
            const identity = await evaluateChromeMcpScript({
              profileName,
              profile,
              targetId: snapshot.targetId,
              args: [frameRef],
              fn: "(el) => ({ tagName: el.tagName, text: el.textContent, documentUrl: el.ownerDocument.URL })",
            });
            expect(identity).toEqual({
              tagName: "BUTTON",
              text: "Frame button",
              documentUrl: crossOrigin ? frameUrl : "about:srcdoc",
            });
            if (mode === "removed iframe element") {
              await frameButton.evaluate((button) => {
                const observer = new MutationObserver(() => {
                  if (document.querySelector("[data-openclaw-mcp-overlay]")) {
                    button.remove();
                    observer.disconnect();
                  }
                });
                observer.observe(document.documentElement, { childList: true });
              });
            }
            const response = await fixture.routePost(routes, "/screenshot", {
              targetId: snapshot.targetId,
              labels: true,
              ...(clipToFrameRef ? { ref: frameRef } : {}),
            });
            const proofDir = process.env.OPENCLAW_BROWSER_MCP_LABEL_PROOF_DIR;
            if (proofDir && mode === "iframe") {
              await fs.mkdir(proofDir, { recursive: true });
              await page.screenshot({ path: path.join(proofDir, "iframe-after-operation.png") });
            }
            if (mode === "removed iframe element") {
              expect(response.statusCode, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
                400,
              );
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
          }
        },
        "mcp-frame-labels",
        crossOrigin,
      );
    },
    120_000,
  );
});
