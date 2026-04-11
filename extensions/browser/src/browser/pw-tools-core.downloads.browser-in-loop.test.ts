import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";
import { launchOpenClawChrome, stopOpenClawChrome } from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  getPageForTargetId,
} from "./pw-session.js";
import { waitForDownloadViaPlaywright } from "./pw-tools-core.downloads.js";
import { getFreePort } from "./test-port.js";

const LIVE = isLiveTestEnabled();
const describeLive = LIVE ? describe : describe.skip;
const DOWNLOAD_BODY = '{"chuckNorris":"lives"}';
const DOWNLOAD_FILENAME = "chuck.json";
const HEADED_SUPPORTED =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  !!process.env.DISPLAY ||
  !!process.env.WAYLAND_DISPLAY;

type RunningCase = {
  server?: http.Server<typeof http.IncomingMessage>;
  runningBrowser?: Awaited<ReturnType<typeof launchOpenClawChrome>>;
  targetId?: string;
  createdDownloadPath?: string;
};

const runningCases = new Set<RunningCase>();

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
    <a data-testid="download" href="/download" download="${DOWNLOAD_FILENAME}">Download JSON</a>
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

async function runDownloadFlow(headless: boolean): Promise<{ savedPath: string }> {
  const state: RunningCase = {};
  runningCases.add(state);
  try {
    const { server, url } = await startDownloadServer();
    state.server = server;

    const cdpPort = await getFreePort();
    const profileName = `openclaw-download-test-${headless ? "headless" : "headed"}-${cdpPort}`;
    const resolved = resolveBrowserConfig({
      enabled: true,
      headless,
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

    state.runningBrowser = await launchOpenClawChrome(resolved, profile);

    const created = await createPageViaPlaywright({
      cdpUrl: profile.cdpUrl,
      url,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
    state.targetId = created.targetId;

    const page = await getPageForTargetId({ cdpUrl: profile.cdpUrl, targetId: created.targetId });
    await page.locator('[data-testid="download"]').waitFor({ state: "visible", timeout: 10_000 });

    const download = waitForDownloadViaPlaywright({
      cdpUrl: profile.cdpUrl,
      targetId: created.targetId,
      timeoutMs: 15_000,
    });
    await page.locator('[data-testid="download"]').click({ timeout: 10_000 });

    const saved = await download;
    state.createdDownloadPath = saved.path;

    expect(saved.suggestedFilename).toBe(DOWNLOAD_FILENAME);
    expect(saved.url).toContain("/download");
    expect(saved.path).toContain(`${path.sep}downloads${path.sep}`);
    expect(path.dirname(saved.path)).toBe(path.resolve(DEFAULT_DOWNLOAD_DIR));
    expect(path.basename(saved.path)).toMatch(
      new RegExp(`-${DOWNLOAD_FILENAME.replace(".", "\\.")}$`),
    );
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe(DOWNLOAD_BODY);

    return { savedPath: saved.path };
  } finally {
    runningCases.delete(state);
    if (state.targetId && state.runningBrowser) {
      await closePageByTargetIdViaPlaywright({
        cdpUrl: `http://127.0.0.1:${state.runningBrowser.cdpPort}`,
        targetId: state.targetId,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }).catch(() => {});
    }
    await closePlaywrightBrowserConnection().catch(() => {});
    if (state.runningBrowser) {
      await stopOpenClawChrome(state.runningBrowser).catch(() => {});
    }
    if (state.createdDownloadPath) {
      await fs.rm(state.createdDownloadPath, { force: true }).catch(() => {});
    }
    await closeServer(state.server).catch(() => {});
  }
}

afterEach(async () => {
  for (const state of runningCases) {
    if (state.targetId && state.runningBrowser) {
      await closePageByTargetIdViaPlaywright({
        cdpUrl: `http://127.0.0.1:${state.runningBrowser.cdpPort}`,
        targetId: state.targetId,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }).catch(() => {});
    }
    await closePlaywrightBrowserConnection().catch(() => {});
    if (state.runningBrowser) {
      await stopOpenClawChrome(state.runningBrowser).catch(() => {});
    }
    if (state.createdDownloadPath) {
      await fs.rm(state.createdDownloadPath, { force: true }).catch(() => {});
    }
    await closeServer(state.server).catch(() => {});
    runningCases.delete(state);
  }
});

describeLive("pw-tools-core downloads (live)", () => {
  it(
    "downloads via an isolated openclaw browser in fully headless mode",
    { timeout: 90_000 },
    async () => {
      await runDownloadFlow(true);
    },
  );

  it.skipIf(!HEADED_SUPPORTED)(
    "downloads via an isolated openclaw browser in headed mode",
    { timeout: 90_000 },
    async () => {
      await runDownloadFlow(false);
    },
  );
});
