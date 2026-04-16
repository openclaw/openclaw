import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./bridge-server.js";
import { isChromeCdpReady, stopOpenClawChrome } from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { getPageForTargetId } from "./pw-session.js";
import { getBrowserTestFetch, type BrowserTestFetch } from "./test-fetch.js";
import { getFreePort } from "./test-port.js";

const LIVE = isLiveTestEnabled();
const describeLive = LIVE ? describe : describe.skip;
const DOWNLOAD_BODY = '{"chuckNorris":"lives"}';
const DOWNLOAD_FILENAME = "chuck.json";
const TEST_AUTH_TOKEN = "openclaw-browser-test-token";

type RunningCase = {
  server?: http.Server;
  bridge?: Awaited<ReturnType<typeof startBrowserBridgeServer>>;
  profileName?: string;
  targetId?: string;
  rawDownloadPath?: string | null;
};

const runningCases = new Set<RunningCase>();
const realFetch: BrowserTestFetch = (input, init) => getBrowserTestFetch()(input, init);

async function authedFetchJson<T>(
  url: string,
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<T> {
  const res = await realFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function startDownloadServer(): Promise<{ server: http.Server; url: string }> {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    if ((req.url ?? "/") === "/download") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${DOWNLOAD_FILENAME}"`,
        "content-length": Buffer.byteLength(DOWNLOAD_BODY),
        "cache-control": "no-store",
      });
      res.end(DOWNLOAD_BODY);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html>
<html>
  <body>
    <a data-testid="download" href="/download">Download JSON</a>
  </body>
</html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { server, url: `http://127.0.0.1:${port}/` };
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForCdpReady(cdpUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeCdpReady(cdpUrl, 1_000, 1_000)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP not ready within ${timeoutMs}ms for ${cdpUrl}`);
}

async function startProfileWhenReady(
  baseUrl: string,
  profileName: string,
  cdpUrl: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await authedFetchJson<{ ok: boolean }>(`${baseUrl}/start?profile=${profileName}`, {
        method: "POST",
      });
      await waitForCdpReady(cdpUrl);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runBrowserToolClickDownloadFlow(): Promise<{
  rawDownloadPath: string | null;
  suggestedFilename: string;
  entriesInManagedDir: string[];
}> {
  const state: RunningCase = {};
  runningCases.add(state);
  try {
    const { server, url } = await startDownloadServer();
    state.server = server;

    const cdpPort = await getFreePort();
    const profileName = `openclaw-download-click-test-${cdpPort}`;
    state.profileName = profileName;
    const resolved = resolveBrowserConfig({
      enabled: true,
      headless: true,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      defaultProfile: profileName,
      profiles: {
        [profileName]: {
          cdpPort,
          color: "#FF4500",
        },
      },
    });
    const profile = resolveProfile(resolved, profileName);
    if (!profile) {
      throw new Error(`failed to resolve ${profileName} profile`);
    }

    state.bridge = await startBrowserBridgeServer({
      resolved,
      authToken: TEST_AUTH_TOKEN,
    });

    await startProfileWhenReady(state.bridge.baseUrl, profileName, profile.cdpUrl);

    const opened = await authedFetchJson<{ targetId: string }>(
      `${state.bridge.baseUrl}/tabs/open?profile=${profileName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      },
    );
    state.targetId = opened.targetId;

    const page = await getPageForTargetId({ cdpUrl: profile.cdpUrl, targetId: opened.targetId });
    await page.locator('[data-testid="download"]').waitFor({ state: "visible", timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await authedFetchJson<{ ok: boolean; targetId: string }>(
      `${state.bridge.baseUrl}/act?profile=${encodeURIComponent(profileName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "click",
          targetId: opened.targetId,
          selector: '[data-testid="download"]',
          timeoutMs: 10_000,
        }),
      },
    );
    const download = await downloadPromise;
    const rawDownloadPath = await download.path();
    state.rawDownloadPath = rawDownloadPath;

    const suggestedFilename = download.suggestedFilename();
    const entriesInManagedDir = await fs.readdir(DEFAULT_DOWNLOAD_DIR).catch(() => []);

    return {
      rawDownloadPath,
      suggestedFilename,
      entriesInManagedDir,
    };
  } finally {
    runningCases.delete(state);
    if (state.bridge && state.profileName) {
      await authedFetchJson<{ ok: boolean }>(
        `${state.bridge.baseUrl}/stop?profile=${state.profileName}`,
        {
          method: "POST",
        },
      ).catch(() => {});
    }
    if (state.bridge) {
      const runtime = state.bridge.state.profiles.get(state.profileName ?? "")?.running;
      await stopBrowserBridgeServer(state.bridge.server).catch(() => {});
      if (runtime) {
        await stopOpenClawChrome(runtime).catch(() => {});
      }
    }
    await closeServer(state.server).catch(() => {});
  }
}

afterEach(async () => {
  for (const state of runningCases) {
    if (state.bridge && state.profileName) {
      await authedFetchJson<{ ok: boolean }>(
        `${state.bridge.baseUrl}/stop?profile=${state.profileName}`,
        {
          method: "POST",
        },
      ).catch(() => {});
    }
    if (state.bridge) {
      const runtime = state.bridge.state.profiles.get(state.profileName ?? "")?.running;
      await stopBrowserBridgeServer(state.bridge.server).catch(() => {});
      if (runtime) {
        await stopOpenClawChrome(runtime).catch(() => {});
      }
    }
    await closeServer(state.server).catch(() => {});
    runningCases.delete(state);
  }
});

describeLive("pw-tools-core downloads via browser-tool seam (live)", () => {
  it(
    "plain browser act click does not leak a Playwright artifact path and lands in the managed download dir",
    { timeout: 90_000 },
    async () => {
      const result = await runBrowserToolClickDownloadFlow();

      expect(result.suggestedFilename).toBe(DOWNLOAD_FILENAME);
      expect(result.rawDownloadPath).toBeTruthy();
      expect(path.normalize(result.rawDownloadPath ?? "")).not.toContain(
        `${path.sep}playwright-artifacts-`,
      );
      expect(path.dirname(path.resolve(result.rawDownloadPath ?? ""))).toBe(
        path.resolve(DEFAULT_DOWNLOAD_DIR),
      );
      expect(path.basename(result.rawDownloadPath ?? "")).toMatch(/-chuck\.json$/);
      await expect(fs.readFile(result.rawDownloadPath ?? "", "utf8")).resolves.toBe(DOWNLOAD_BODY);
      expect(result.entriesInManagedDir).toContain(path.basename(result.rawDownloadPath ?? ""));
    },
  );
});
