import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { createTempHomeEnv } from "../test-support.js";
import { createBrowserTool } from "./browser-tool.js";
import { resolveOpenClawUserDataDir } from "./browser/chrome.js";
import { getPlaywrightCore } from "./browser/playwright-core.runtime.js";
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
afterEach(async () => {
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
      restoreHome = (await createTempHomeEnv("openclaw-browser-invocation-")).restore;
      // The managed profile directory resolves when modules load, before this test's temp home.
      // Refuse to launch from a real state directory: run with a temporary OPENCLAW_STATE_DIR.
      const userDataDir = resolveOpenClawUserDataDir(PROFILE);
      expect(path.relative(os.userInfo().homedir, userDataDir).startsWith("..")).toBe(true);
      try {
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
  },
);
