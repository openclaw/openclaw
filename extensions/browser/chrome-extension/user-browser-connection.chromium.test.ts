import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { USER_BROWSER_IDLE_RELEASE_MS } from "../src/browser/pw-session-contracts.js";
import { runExtensionRelayDaemon } from "../src/browser/relay-daemon.js";
import { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";
import { createBrowserRouteContext } from "../src/browser/server-context.js";
import { getFreePort } from "../src/browser/test-port.js";
import {
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../src/control-service.js";
import { relayTestKey } from "./relay-key.test-support.js";

// A real Chromium with the unpacked extension. The harness talks to Chromium only at the
// browser target, so the only debugger ever attached to the page tab is the extension's.
const runE2E =
  process.env.OPENCLAW_BROWSER_EXTENSION_E2E === "1" &&
  (process.platform === "linux" || process.platform === "darwin");
const cleanups: Array<() => Promise<void>> = [];
const PAGE_HTML =
  "<title>pending</title><script>" +
  'const query = matchMedia("(prefers-color-scheme: dark)");' +
  'const show = () => { document.title = query.matches ? "dark" : "light"; };' +
  'show(); query.addEventListener("change", show);' +
  "</script><button>Theme probe</button>";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
  clearRuntimeConfigSnapshot();
});

type CdpClient = {
  send: (method: string, params?: object, sessionId?: string) => Promise<Record<string, unknown>>;
};

async function connectBrowserTarget(port: number): Promise<CdpClient> {
  let version: { webSocketDebuggerUrl?: string } | undefined;
  await expect
    .poll(
      async () => {
        version = (await fetch(`http://127.0.0.1:${port}/json/version`)
          .then((response) => response.json())
          .catch(() => undefined)) as typeof version;
        return Boolean(version?.webSocketDebuggerUrl);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const ws = new WebSocket(version?.webSocketDebuggerUrl ?? "");
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  cleanups.push(async () => ws.terminate());
  let nextId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  ws.on("message", (raw) => {
    const message = JSON.parse(rawDataToString(raw)) as Record<string, unknown>;
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    send: async (method, params, sessionId) => {
      const id = ++nextId;
      const reply = new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
      });
      ws.send(
        JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
      );
      const message = await reply;
      if (message.error) {
        throw new Error(`${method}: ${JSON.stringify(message.error)}`);
      }
      return (message.result ?? {}) as Record<string, unknown>;
    },
  };
}

async function launchUserBrowser(root: string) {
  const port = await getFreePort();
  const child: ChildProcess = spawn(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      // Without a keyring service, the cookie store never opens and no page loads.
      "--password-store=basic",
      // The user's system appearance: dark.
      "--force-dark-mode",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(root, "chromium")}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  return await connectBrowserTarget(port);
}

async function evaluate(cdp: CdpClient, sessionId: string, expression: string) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  return (result.result as { value?: unknown } | undefined)?.value;
}

async function startPageServer(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Theme probe server did not bind");
  }
  return `http://127.0.0.1:${address.port}/theme`;
}

describe.runIf(runE2E)("extension relay connection to the user's browser", () => {
  it.each(["owned", "borrowed"] as const)(
    "keeps the system color scheme and detaches after idle through an %s relay",
    async (topology) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-user-browser-")),
      );
      cleanups.push(async () => await fs.rm(root, { recursive: true, force: true }));
      const stateDir = path.join(root, "state");
      const token = relayTestKey(11);
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(stateDir, "credentials", "browser-extension-relay.secret"),
        `${token}\n`,
        { mode: 0o600 },
      );
      const relayPort = await getFreePort();
      const config = {
        gateway: { auth: { mode: "token" as const, token: "user-browser-test" } },
        browser: { profiles: { e2e: { driver: "extension" as const, cdpPort: relayPort } } },
      };
      setRuntimeConfigSnapshot(config, config);

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        if (topology === "borrowed") {
          const daemon = await runExtensionRelayDaemon({ port: relayPort });
          expect(daemon.port).toBe(relayPort);
          cleanups.push(async () => {
            daemon.stop();
            await daemon.done;
          });
        }
        const state = await startBrowserControlServiceFromConfig();
        cleanups.push(stopBrowserControlService);
        if (!state) {
          throw new Error("Browser control did not start");
        }
        expect(state.extensionRelays?.get("e2e")?.ownership).toBe(topology);
        state.resolved.ssrfPolicy = undefined;

        const cdp = await launchUserBrowser(root);
        const extensionDir = path.dirname(fileURLToPath(import.meta.url));
        const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", {
          path: extensionDir,
        });
        const { targetId: optionsTarget } = await cdp.send("Target.createTarget", {
          url: `chrome-extension://${String(extensionId)}/options.html`,
        });
        const { sessionId: options } = await cdp.send("Target.attachToTarget", {
          targetId: optionsTarget,
          flatten: true,
        });
        const extension = String(options);
        await expect
          .poll(() => evaluate(cdp, extension, "typeof chrome.runtime?.sendMessage"))
          .toBe("function");
        await expect(
          evaluate(
            cdp,
            extension,
            `chrome.runtime.sendMessage(${JSON.stringify({
              type: "pair",
              pairingString: `ws://127.0.0.1:${relayPort}/extension#${token}`,
              accessMode: "all",
            })})`,
          ),
        ).resolves.toMatchObject({ ok: true });

        const pageUrl = await startPageServer();
        const { targetId: probeTarget } = await cdp.send("Target.createTarget", { url: pageUrl });
        const probe = String(probeTarget);
        const title = async () =>
          (
            (await cdp.send("Target.getTargetInfo", { targetId: probe })).targetInfo as {
              title: string;
            }
          ).title;
        const debuggerAttached = async () =>
          (await evaluate(
            cdp,
            extension,
            `chrome.debugger.getTargets().then((targets) => targets.some((target) => target.id === ${JSON.stringify(probe)} && target.attached))`,
          )) as boolean;
        await expect.poll(title).toBe("dark");
        expect(await debuggerAttached()).toBe(false);

        const dispatcher = createBrowserRouteDispatcher(
          createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: false }),
        );
        const snapshot = async () => {
          const response = await dispatcher.dispatch({
            method: "GET",
            path: "/snapshot",
            query: { profile: "e2e", targetId: probe },
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          console.log(`[${topology}] snapshot ok; page title=${await title()}`);
        };

        // Drive the tab through OpenClaw: the page keeps the system dark scheme.
        await expect.poll(() => getBrowserControlState()?.extensionRelays?.has("e2e")).toBe(true);
        await snapshot();
        expect(await debuggerAttached()).toBe(true);
        expect(await title()).toBe("dark");

        // With nothing in progress, OpenClaw disconnects and the extension detaches.
        const idleStarted = Date.now();
        await expect
          .poll(debuggerAttached, {
            timeout: USER_BROWSER_IDLE_RELEASE_MS + 30_000,
            interval: 1_000,
          })
          .toBe(false);
        console.log(
          `[${topology}] extension debugger detached ${Math.round((Date.now() - idleStarted) / 1000)}s after the last request`,
        );
        expect(Date.now() - idleStarted).toBeGreaterThanOrEqual(
          USER_BROWSER_IDLE_RELEASE_MS - 1_000,
        );

        // The next request reconnects.
        await snapshot();
        expect(await debuggerAttached()).toBe(true);
        expect(await title()).toBe("dark");
      });
    },
    USER_BROWSER_IDLE_RELEASE_MS * 2 + 90_000,
  );
});
