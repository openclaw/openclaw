import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createTempHomeEnv } from "../test-support.js";
import { createBrowserTool } from "./browser-tool.js";
import { resolveOpenClawUserDataDir } from "./browser/chrome.js";
import { dispatchBrowserControlRequest } from "./browser/local-dispatch.runtime.js";
import { getPlaywrightCore } from "./browser/playwright-core.runtime.js";
import { withBrowserRequestScope } from "./browser/request-scope.js";
import { stopBrowserScreencasts } from "./browser/screencast/session.js";
import { parseScreencastFrame } from "./browser/screencast/test-support.js";
import { handleBrowserScreencastUpgrade } from "./browser/screencast/upgrade.js";
import { getFreePort } from "./browser/test-port.js";
import { stopBrowserControlService } from "./control-service.js";

// Mirrors the host's plugin tool wrapper: one context-level guard resolves the invoking
// call from the async context when it runs (`assertPluginToolInvocationSourceCurrent`).
const PROFILE = "invocation-fixture";
const invocations = new AsyncLocalStorage<() => void>();
const assertInvocationCurrent = () => invocations.getStore()?.();
function invocation() {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    run: <T>(work: () => Promise<T>) =>
      invocations.run(() => {
        if (!current) {
          throw new Error("tool invocation authority is no longer active");
        }
      }, work),
  };
}

let restoreHome: (() => Promise<void>) | undefined;
async function useIsolatedManagedBrowser() {
  restoreHome = (await createTempHomeEnv("openclaw-browser-invocation-")).restore;
  // The managed profile directory resolves when modules load, before this test's temp home.
  // Refuse to launch from a real state directory: run with a temporary OPENCLAW_STATE_DIR.
  const userDataDir = resolveOpenClawUserDataDir(PROFILE);
  expect(path.relative(os.userInfo().homedir, userDataDir).startsWith("..")).toBe(true);
  // Its own CDP port keeps this test away from any other OpenClaw browser on the host;
  // the in-process control service opens no listener.
  const cdpPort = await getFreePort();
  // No configured SSRF policy: the host's local preview capability admits loopback
  // pages and fences every navigation hop with the invocation guard.
  setRuntimeConfigSnapshot({
    browser: {
      enabled: true,
      defaultProfile: PROFILE,
      headless: true,
      noSandbox: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        getPlaywrightCore().chromium.executablePath(),
      profiles: { [PROFILE]: { cdpPort, color: "#FF4500" } },
    },
  });
}

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await stopBrowserScreencasts();
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
  await restoreHome?.();
  restoreHome = undefined;
});

// Opt-in: crosses real managed Chromium, the host's in-process Browser control service and
// the local-preview navigation authority fence, whose CDP listeners run in whichever async
// context delivers the shared connection's events rather than the navigating call's.
describe.runIf(process.env.OPENCLAW_BROWSER_INVOCATION_E2E === "1")(
  "Browser tool invocation authority on a reused CDP connection",
  () => {
    it("checks each navigation against its own caller, not the call that connected", async () => {
      let onRedirect: (() => void) | undefined;
      let targetRequests = 0;
      const server = createServer((req, res) => {
        if (req.url === "/redirect") {
          onRedirect?.();
          res.writeHead(302, { Location: "/target" }).end();
          return;
        }
        if (req.url === "/target") {
          targetRequests += 1;
        }
        res.writeHead(200, { "Content-Type": "text/html" }).end("<title>fixture</title>");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await useIsolatedManagedBrowser();
      try {
        const profile = PROFILE;
        const tool = createBrowserTool({
          assertInvocationCurrent,
          allowLocalLoopback: true,
          // The host's loopback grant also rechecks the caller through async context.
          assertLocalLoopbackCurrent: assertInvocationCurrent,
        });
        const first = invocation();
        // The first call creates and caches the shared Playwright CDP connection.
        const opened = await first.run(async () => {
          // Loopback previews are admitted only once the OpenClaw-owned process runs.
          await tool.execute("start", { action: "start", profile });
          return await tool.execute("first", {
            action: "open",
            url: `${origin}/first`,
            profile,
          });
        });
        const targetId = (opened.details as { targetId?: string }).targetId;
        expect(targetId).toBeTypeOf("string");
        const navigate = (call: ReturnType<typeof invocation>, url: string) =>
          call.run(() => tool.execute("navigate", { action: "navigate", url, targetId, profile }));

        // While the connecting call stays current, a caller that ends mid-navigation must not
        // borrow its authority: the fenced redirect hop fails closed before reaching /target.
        const revoked = invocation();
        onRedirect = revoked.revoke;
        await expect(navigate(revoked, `${origin}/redirect`)).rejects.toThrow(
          "tool invocation authority is no longer active",
        );
        expect(targetRequests).toBe(0);
        onRedirect = undefined;

        // Once the connecting call ends, a current caller still navigates and opens tabs.
        first.revoke();
        const current = invocation();
        await expect(navigate(current, `${origin}/second`)).resolves.toMatchObject({
          details: { url: `${origin}/second` },
        });
        await expect(
          current.run(() =>
            tool.execute("open", { action: "open", url: `${origin}/third`, profile }),
          ),
        ).resolves.toMatchObject({ details: { url: `${origin}/third` } });
      } finally {
        server.close();
      }
    }, 60_000);

    it("streams screencast frames only for pages its own minting request may view", async () => {
      const privateRequests: string[] = [];
      const pages = createServer((req, res) => {
        privateRequests.push(req.url ?? "");
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end("<body style='background:#c00'>loopback-only preview</body>");
        // Granted navigation reaches this server; a viewer's check never causes a request.
      });
      const viewerGateway = createServer();
      viewerGateway.on("upgrade", (req, socket, head) => {
        void handleBrowserScreencastUpgrade(req, socket, head);
      });
      const pagesHost = await listen(pages);
      const viewerHost = await listen(viewerGateway);
      await useIsolatedManagedBrowser();
      const query = { profile: PROFILE };
      const granted = invocation();
      // A host-granted local preview request that is still running.
      const grantedScope = {
        allowLocalLoopback: true,
        assertInvocationCurrent,
        assertLocalLoopbackCurrent: assertInvocationCurrent,
        assertCurrent: async () => assertInvocationCurrent(),
      };
      const opened = createDeferred<string>();
      const navigate = createDeferred<void>();
      const navigated = createDeferred<number>();
      const release = createDeferred<void>();
      const grantedRequest = granted.run(() =>
        withBrowserRequestScope(grantedScope, async () => {
          // This request creates the shared Playwright connection, so its async context
          // is the one every later page event on that connection is delivered in.
          await dispatchBrowserControlRequest({ method: "POST", path: "/start", query });
          const tab = await dispatchBrowserControlRequest({
            method: "POST",
            path: "/tabs/open",
            query,
            body: { url: "about:blank" },
          });
          opened.resolve((tab.body as { targetId: string }).targetId);
          await navigate.promise;
          const result = await dispatchBrowserControlRequest({
            method: "POST",
            path: "/navigate",
            query,
            body: { url: `http://${pagesHost}/private`, targetId: await opened.promise },
          });
          navigated.resolve(result.status);
          await release.promise;
        }),
      );
      void grantedRequest.catch((error: unknown) => opened.reject(error));
      try {
        const targetId = await opened.promise;
        // Viewers mint through their own request, which has no loopback grant.
        const watch = async (requester?: { signal: AbortSignal; isCurrent: () => boolean }) => {
          const minted = await dispatchBrowserControlRequest({
            method: "POST",
            path: "/screencast",
            query,
            body: { targetId },
            ...(requester ? { requester } : {}),
          });
          expect(minted.status).toBe(200);
          const { token } = minted.body as { token: string };
          const socket = new WebSocket(`ws://${viewerHost}/browser/screencast?token=${token}`);
          const frameUrls: string[] = [];
          socket.on("message", (data, binary) => {
            if (binary) {
              frameUrls.push(parseScreencastFrame(data as Buffer).header.url);
            }
          });
          const viewer = { frameUrls, closed: "open" };
          socket.once("close", (code, reason) => {
            viewer.closed = `${code} ${reason.toString()}`;
          });
          await expect.poll(() => frameUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);
          return viewer;
        };

        // Allowed: the viewer receives frames of the page its own request may view.
        const viewer = await watch();
        expect(viewer.frameUrls.every((url) => url === "about:blank")).toBe(true);

        // The granted request legitimately navigates the shared tab to a loopback page.
        navigate.resolve();
        expect(await navigated.promise).toBe(200);
        expect(privateRequests).toContain("/private");
        // Nearest forbidden: the page event arrives in the granted request's context, but
        // the viewer is checked as its own minting request and never sees that page.
        const privateUrl = `http://${pagesHost}/private`;
        await expect
          .poll(() => viewer.closed, { timeout: 10_000 })
          .not.toBe("open")
          .catch(() => {});
        const privateFrames = viewer.frameUrls.filter((url) => url === privateUrl).length;
        console.info(
          `[screencast-proof] viewer: ${viewer.closed}; frames of the loopback page: ${privateFrames}`,
        );
        expect(viewer.closed).toBe("4003 navigation_blocked");
        expect(privateFrames).toBe(0);

        // Revocation: a viewer whose requesting connection ends stops receiving frames.
        await dispatchBrowserControlRequest({
          method: "POST",
          path: "/navigate",
          query,
          body: { url: "about:blank", targetId },
        });
        const connection = new AbortController();
        let current = true;
        const revoked = await watch({ signal: connection.signal, isCurrent: () => current });
        current = false;
        connection.abort();
        await expect.poll(() => revoked.closed, { timeout: 10_000 }).toBe("4006 authority_revoked");
        console.info(`[screencast-proof] revoked viewer: ${revoked.closed}`);
      } finally {
        release.resolve();
        await grantedRequest.catch(() => {});
        pages.close();
        viewerGateway.close();
      }
    }, 60_000);
  },
);
