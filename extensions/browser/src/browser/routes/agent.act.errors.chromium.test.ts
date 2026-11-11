import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import express from "express";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../../../test-support/hanging-loopback-server.js";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "../bridge-auth-registry.js";
import { browserAct } from "../client-actions.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import { BrowserServiceError, fetchBrowserJson } from "../client-fetch.js";
import { browserCloseTab, browserOpenTab, browserSnapshot, browserTabs } from "../client.js";
import { resolveBrowserConfig } from "../config.js";
import { launchChromium, readTargetId } from "../pw-chromium.test-support.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "../server-middleware.js";
import { registerBrowserRoutes } from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.runIf(process.env.OPENCLAW_BROWSER_ACTION_ERRORS_E2E === "1")(
  "Chromium action errors through the browser client",
  () => {
    let context: BrowserContext;
    let page: Page;
    let controlServer: Server;
    let baseUrl: string;
    let controlPort: number;
    let cdpUrl: string;
    let fixture: Server;
    let targetId: string;
    let refs: Record<string, { name?: string }>;
    let state: BrowserServerState;

    beforeAll(async () => {
      fixture = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(`<button>Visible noneditable control</button>
          <input type="number" aria-label="Numeric input">
          <input readonly aria-label="Read-only input">
          <button disabled>Disabled button</button>
          <div style="position:relative;width:150px;height:40px">
            <button style="width:100%;height:100%">Covered button</button>
            <div style="position:absolute;inset:0;background:#ddd"></div>
          </div>
          <button id="missing">Missing button</button>
          <button id="duplicate">Duplicate button</button>
          <input aria-label="Working input">`);
      });
      const fixturePort = await listenOnLoopback(fixture);
      ({ context, cdpUrl } = await launchChromium(
        tempDirs.make("openclaw-browser-action-errors-"),
      ));
      page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`http://127.0.0.1:${fixturePort}`);
      targetId = await readTargetId(page);
      state = {
        port: 0,
        profiles: new Map(),
        resolved: resolveBrowserConfig({
          defaultProfile: "errors",
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          profiles: { errors: { cdpUrl, color: "#123456", attachOnly: true } },
        }),
      };
      const app = express();
      const auth = { token: randomUUID() };
      installBrowserCommonMiddleware(app);
      installBrowserAuthMiddleware(app, auth);
      registerBrowserRoutes(app, createBrowserRouteContext({ getState: () => state }));
      controlServer = createServer(app);
      controlPort = await listenOnLoopback(controlServer);
      baseUrl = `http://127.0.0.1:${controlPort}`;
      setBridgeAuthForPort(controlPort, auth);
      const snapshot = await browserSnapshot(baseUrl, {
        targetId,
        format: "ai",
        interactive: true,
      });
      if (snapshot.format !== "ai") {
        throw new Error("Expected AI snapshot");
      }
      refs = expectDefined(snapshot.refs, "snapshot refs");
      await page.locator("#missing").evaluate((element) => element.remove());
      await page.locator("#duplicate").evaluate((element) => {
        element.after(element.cloneNode(true));
      });
    }, 30_000);

    afterAll(async () => {
      if (controlServer) {
        deleteBridgeAuthForPort(controlPort);
        await new Promise<void>((resolve, reject) => {
          controlServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (cdpUrl) {
        await closePlaywrightBrowserConnection({ cdpUrl });
      }
      await context?.close();
      if (fixture) {
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });

    function ref(name: string) {
      return expectDefined(
        Object.entries(refs).find(([, info]) => info.name === name)?.[0],
        `snapshot ref for ${name}`,
      );
    }

    it.each([
      { name: "Visible noneditable control", kind: "type", cause: /not an.*input|not editable/i },
      { name: "Numeric input", kind: "type", cause: /number|numeric/i },
      { name: "Read-only input", kind: "type", cause: /not editable|read.only/i },
      { name: "Disabled button", kind: "click", cause: /not enabled|disabled/i },
      { name: "Covered button", kind: "click", cause: /covered|pointer events/i },
      { name: "Missing button", kind: "click", cause: /not found|no longer/i },
      { name: "Duplicate button", kind: "click", cause: /matched 2 elements/i },
    ] as const)(
      "preserves the $name failure without service advice",
      async ({ name, kind, cause }) => {
        const action: BrowserActRequest =
          kind === "type"
            ? { kind, targetId, ref: ref(name), text: "hello", timeoutMs: 700 }
            : { kind, targetId, ref: ref(name), timeoutMs: 700 };
        const error = await browserAct(baseUrl, action).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BrowserServiceError);
        expect(error).toMatchObject({ status: 500, code: "ACT_OPERATION_FAILED" });
        expect((error as Error).message).toMatch(cause);
        expect((error as Error).message).not.toMatch(
          /browser is currently unavailable|restart|retry the browser tool/i,
        );
        if (name !== "Missing button") {
          expect((error as Error).message).not.toMatch(/not found or not visible/i);
        }
      },
    );

    it("keeps the cause bounded for long input and inside nested batches", async () => {
      const action: BrowserActRequest = {
        kind: "type",
        targetId,
        ref: ref("Read-only input"),
        text: "x".repeat(2_000),
        timeoutMs: 700,
      };
      const error = await browserAct(baseUrl, action).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BrowserServiceError);
      expect((error as Error).message).toMatch(/not editable|read.only/i);
      expect((error as Error).message.length).toBeLessThan(1_000);
      expect((error as Error).message).not.toContain("x".repeat(100));
      const batch = await browserAct(baseUrl, {
        kind: "batch",
        targetId,
        actions: [{ kind: "batch", actions: [action] }],
      });
      expect(batch.results?.[0]).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not editable|read.only/i),
      });
    });

    it("still fills an editable input after the action failures", async () => {
      await browserAct(baseUrl, {
        kind: "type",
        targetId,
        ref: ref("Working input"),
        text: "browser remains usable",
        timeoutMs: 700,
      });
      expect(
        await page.getByRole("textbox", { name: "Working input", exact: true }).inputValue(),
      ).toBe("browser remains usable");
    });

    it.each(["implicit", "explicit", "batch"] as const)(
      "closes a crashed renderer through %s act requests",
      async (mode) => {
        const crashed = await context.newPage();
        const policy = state.resolved.ssrfPolicy;
        try {
          await crashed.goto(page.url().replace("127.0.0.1", "localhost"));
          const crashedId = await readTargetId(crashed);
          await browserSnapshot(baseUrl, { targetId: crashedId, format: "ai" });
          const session = await context.newCDPSession(crashed);
          const didCrash = crashed.waitForEvent("crash");
          await Promise.race([didCrash, session.send("Page.crash").then(() => didCrash)]);
          await expect(
            browserAct(baseUrl, { kind: "press", key: "Enter", targetId: crashedId }),
          ).rejects.toMatchObject({ code: "ACT_OPERATION_FAILED" });
          if (mode === "batch") {
            await closePlaywrightBrowserConnection({ cdpUrl });
            state.resolved.ssrfPolicy = { ...policy, blockedHostnames: ["localhost"] };
          }

          const result = await browserAct(
            baseUrl,
            mode === "batch"
              ? {
                  kind: "batch",
                  targetId: crashedId,
                  actions: [{ kind: "batch", actions: [{ kind: "close" }] }, { kind: "close" }],
                }
              : { kind: "close", ...(mode === "explicit" ? { targetId: crashedId } : {}) },
          );
          expect(result).toMatchObject({ ok: true, targetId: crashedId });
          if (mode === "batch") {
            expect(result).toMatchObject({
              results: [{ ok: true }],
              aborted: { reason: "closed", afterAction: 1, skipped: 1, url: "" },
            });
          }
          const { tabs } = await browserTabs(baseUrl);
          expect(tabs).not.toContainEqual(expect.objectContaining({ targetId: crashedId }));
          expect(tabs).toContainEqual(expect.objectContaining({ targetId }));
          state.resolved.ssrfPolicy = policy;
          expect(await browserSnapshot(baseUrl, { format: "ai" })).toMatchObject({ targetId });
        } finally {
          state.resolved.ssrfPolicy = policy;
          await crashed.close().catch(() => {});
        }
      },
      20_000,
    );

    it.each([false, true])(
      "reports renderer crashes with new-tab recovery (cold connection: %s)",
      async (cold) => {
        const crashed = await context.newPage();
        const opened: string[] = [];
        try {
          await crashed.goto(page.url().replace("127.0.0.1", "localhost"));
          const crashedId = await readTargetId(crashed);
          const sibling = await browserOpenTab(baseUrl, page.url());
          opened.push(sibling.targetId);
          await browserSnapshot(baseUrl, { targetId: crashedId, format: "ai" });
          if (cold) {
            await closePlaywrightBrowserConnection({ cdpUrl });
          }
          const session = await context.newCDPSession(crashed);
          const didCrash = crashed.waitForEvent("crash");
          await Promise.race([didCrash, session.send("Page.crash").then(() => didCrash)]);
          // Closing this target below retires the CDP session; detach waits on its dead renderer.

          for (const [path, body] of [
            ["/screenshot", { targetId: crashedId }],
            [`/snapshot?targetId=${crashedId}&format=ai&timeoutMs=2000`, undefined],
            ["/snapshot?format=ai&timeoutMs=2000", undefined],
            ["/navigate", { targetId: crashedId, url: page.url() }],
          ] as const) {
            const error = await fetchBrowserJson(`${baseUrl}${path}`, {
              timeoutMs: 2_000,
              ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
              headers: { "Content-Type": "application/json" },
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(BrowserServiceError);
            expect(error).toMatchObject({ status: 500, code: "ACT_OPERATION_FAILED" });
            expect((error as Error).message).toMatch(/tab.*crashed/i);
            expect((error as Error).message).toMatch(/open.*new tab/i);
            expect((error as Error).message).not.toMatch(
              /browser is currently unavailable|restart|retry the browser tool/i,
            );
          }
          expect((await browserTabs(baseUrl)).tabs).toContainEqual(
            expect.objectContaining({ targetId: crashedId, crashed: true }),
          );
          expect(
            await browserSnapshot(baseUrl, { targetId: sibling.targetId, format: "ai" }),
          ).toMatchObject({ snapshot: expect.stringContaining("Working input") });
          const replacement = await browserOpenTab(baseUrl, page.url());
          opened.push(replacement.targetId);
          expect(
            await browserSnapshot(baseUrl, { targetId: replacement.targetId, format: "ai" }),
          ).toMatchObject({ snapshot: expect.stringContaining("Working input") });
          await browserCloseTab(baseUrl, crashedId);
          expect((await browserTabs(baseUrl)).tabs).not.toContainEqual(
            expect.objectContaining({ targetId: crashedId }),
          );
        } finally {
          await crashed.close().catch(() => {});
          for (const openedId of opened) {
            await browserCloseTab(baseUrl, openedId);
          }
        }
      },
      20_000,
    );
  },
);
