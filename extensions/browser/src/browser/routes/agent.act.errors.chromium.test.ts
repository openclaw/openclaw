import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import express from "express";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "../bridge-auth-registry.js";
import { browserAct } from "../client-actions.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import { BrowserServiceError } from "../client-fetch.js";
import { browserSnapshot } from "../client.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "../server-middleware.js";
import { getFreePort } from "../test-port.js";
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
    let targetId: string;
    let refs: Record<string, { name?: string }>;

    beforeAll(async () => {
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-browser-action-errors-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      page = context.pages()[0] ?? (await context.newPage());
      await page.setContent(`<button>Visible noneditable control</button>
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
      const session = await context.newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      targetId = targetInfo.targetId;
      await session.detach();
      const state: BrowserServerState = {
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
      baseUrl = await listenLoopback(controlServer);
      controlPort = Number(new URL(baseUrl).port);
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
        await closeHttpServer(controlServer);
      }
      if (cdpUrl) {
        await closePlaywrightBrowserConnection({ cdpUrl });
      }
      await context?.close();
    });

    function ref(name: string) {
      return expectDefined(
        Object.entries(refs).find(([, info]) => info.name === name)?.[0],
        `snapshot ref for ${name}`,
      );
    }

    function target(name: string) {
      return { targetId, ref: ref(name), timeoutMs: 700 };
    }

    it.each([
      { name: "Visible noneditable control", kind: "type", cause: /not an.*input|not editable/i },
      { name: "Numeric input", kind: "type", cause: /number|numeric/i },
      { name: "Read-only input", kind: "type", cause: /not editable|read.only/i },
      { name: "Disabled button", kind: "click", cause: /not enabled|disabled/i },
      { name: "Covered button", kind: "click", cause: /covered|pointer events/i },
      { name: "Missing button", kind: "click", cause: /not found|no longer/i },
      { name: "Duplicate button", kind: "click", cause: /matched 2 elements/i },
    ] as const)("preserves $name failure", async ({ name, kind, cause }) => {
      const action: BrowserActRequest =
        kind === "type" ? { kind, ...target(name), text: "hello" } : { kind, ...target(name) };
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
    });

    it("keeps the cause bounded for long input and inside nested batches", async () => {
      const action: BrowserActRequest = {
        kind: "type",
        ...target("Read-only input"),
        text: "x".repeat(2_000),
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
        ...target("Working input"),
        text: "browser remains usable",
      });
      expect(
        await page.getByRole("textbox", { name: "Working input", exact: true }).inputValue(),
      ).toBe("browser remains usable");
    });
  },
);
