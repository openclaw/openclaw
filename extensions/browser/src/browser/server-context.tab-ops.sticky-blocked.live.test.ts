// Live Chrome/CDP proof: blocked redirect openTab must not sticky-adopt.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import * as cdpModule from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
} from "./server-context.remote-tab-ops.harness.js";

const LIVE = isLiveTestEnabled() || process.env.OPENCLAW_LIVE_BROWSER_STICKY_PROOF === "1";
const CHROME_BIN =
  process.env.OPENCLAW_LIVE_CHROME_BIN?.trim() ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const describeLive = LIVE && fs.existsSync(CHROME_BIN) ? describe : describe.skip;

function pickLanIPv4(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (entry.address.startsWith("192.168.") || entry.address.startsWith("10.")) {
        return entry.address;
      }
    }
  }
  throw new Error("no LAN IPv4 address available for redirect proof");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCdp(cdpPort: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) {
        return;
      }
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error(`Chrome CDP not ready on ${cdpPort}`);
}

async function waitForTargetUrl(
  cdpPort: number,
  targetId: string,
  predicate: (url: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const tabs = (await res.json()) as Array<{ id?: string; url?: string }>;
    const found = tabs.find((tab) => tab.id === targetId);
    const url = found?.url?.trim() ?? "";
    if (url && predicate(url)) {
      return url;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for target ${targetId} URL predicate`);
}

describeLive("browser (live): sticky blocked openTab", () => {
  let chrome: ChildProcess | undefined;
  let redirectServer: http.Server | undefined;
  let userDataDir = "";
  let cdpPort = 0;
  let lanIp = "";
  let redirectPort = 0;
  let cdpUrl = "";

  beforeAll(async () => {
    lanIp = pickLanIPv4();
    redirectServer = await new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/go")) {
          res.writeHead(302, { Location: "http://127.0.0.1:9/" });
          res.end("redirect");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      server.once("error", reject);
      server.listen(0, lanIp, () => resolve(server));
    });
    const addr = redirectServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("redirect server missing address");
    }
    redirectPort = addr.port;

    cdpPort = 19_300 + Math.floor(Math.random() * 200);
    cdpUrl = `http://127.0.0.1:${cdpPort}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sticky-proof-"));
    chrome = spawn(
      CHROME_BIN,
      [
        "--headless=new",
        "--disable-gpu",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    await waitForCdp(cdpPort);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (chrome?.pid) {
      try {
        process.kill(chrome.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => {
      if (!redirectServer) {
        resolve();
        return;
      }
      redirectServer.close(() => {
        resolve();
      });
    });
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Chrome may leave locked extension storage; ignore cleanup.
    }
  });

  it(
    "rejects a LAN→loopback redirect and keeps the previous sticky target",
    { timeout: 60_000 },
    async () => {
      const state = makeState("openclaw");
      state.resolved.profiles.openclaw = {
        cdpPort,
        color: "#FF4500",
      };
      // Allow the LAN redirector host only; final loopback remains blocked.
      state.resolved.ssrfPolicy = { allowedHostnames: [lanIp] };
      (state.profiles as Map<string, unknown>).set("openclaw", {
        profile: { name: "openclaw" },
        running: { pid: chrome?.pid ?? 1, proc: { on: () => {} } },
        lastTargetId: null,
      });

      const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
        "openclaw",
      );

      const good = await openclaw.openTab("about:blank");
      expect(good.targetId).toBeTruthy();
      expect(state.profiles.get("openclaw")?.lastTargetId).toBe(good.targetId);

      const redirectUrl = `http://${lanIp}:${redirectPort}/go`;
      // Create the redirected target with real Chrome first and wait until CDP
      // reports the private final URL. openTab then runs the production
      // discovery + assertBrowserNavigationResultAllowed + sticky-adoption path.
      const blocked = await cdpModule.createTargetViaCdp({
        cdpUrl,
        url: redirectUrl,
        ssrfPolicy: { allowedHostnames: [lanIp] },
      });
      const finalUrl = await waitForTargetUrl(cdpPort, blocked.targetId, (url) =>
        url.startsWith("http://127.0.0.1"),
      );
      expect(finalUrl).toMatch(/^http:\/\/127\.0\.0\.1/);

      vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValueOnce({
        targetId: blocked.targetId,
      });

      await expect(openclaw.openTab(redirectUrl)).rejects.toThrow(/private|blocked|ssrf/i);
      expect(state.profiles.get("openclaw")?.lastTargetId).toBe(good.targetId);
      expect(state.profiles.get("openclaw")?.lastTargetId).not.toBe(blocked.targetId);

      const selected = await openclaw.ensureTabAvailable();
      expect(selected.targetId).toBe(good.targetId);

      console.log(
        JSON.stringify(
          {
            proof: "live-chrome-cdp-sticky-blocked-openTab",
            chrome: "Google Chrome headless CDP",
            redirectRequestHost: "LAN IPv4 (allowlisted)",
            finalUrlHost: "127.0.0.1",
            openTabRejected: true,
            stickyAfterReject: "unchanged-good-target",
            targetlessEnsureTabAvailable: "selected-good-target-not-blocked",
            goodTargetIdPrefix: good.targetId.slice(0, 8),
            blockedTargetIdPrefix: blocked.targetId.slice(0, 8),
            selectedTargetIdPrefix: selected.targetId.slice(0, 8),
            sameStickyTarget: selected.targetId === good.targetId,
          },
          null,
          2,
        ),
      );
    },
  );
});
