// Browser proof that an attached browser keeps its own download destination.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { publishCdpEndpointOwnership } from "./cdp-endpoint-ownership.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";
import {
  closePlaywrightBrowserConnection,
  getPageForTargetId,
  listPagesViaPlaywright,
} from "./pw-session.js";
import { waitForDownloadViaPlaywright } from "./pw-tools-core.downloads.js";
import { clickViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { navigateViaPlaywright, snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const runChromiumProof = process.env.OPENCLAW_BROWSER_DOWNLOAD_E2E === "1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DOWNLOAD_FILE_NAME = "proof.txt";

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

/** Collapse a multi-line error message so one measurement stays one log line. */
function singleLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function describeErrorOutcome(error: unknown): string {
  if (error instanceof Error) {
    return singleLine(error.message);
  }
  if (error === undefined) {
    return "(none)";
  }
  if (typeof error === "string") {
    return singleLine(error);
  }
  try {
    return singleLine(JSON.stringify(error));
  } catch {
    return "(unserialisable error)";
  }
}

/** Playwright's bundled Chromium, unless the environment pins another binary. */
function resolveChromeExecutable(): string {
  const pinned = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  return pinned ? pinned : getPlaywrightCore().chromium.executablePath();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Terminate a browser this test launched itself, then wait for its exit. */
async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  proc.kill("SIGKILL");
  await exited;
}

async function waitForCdpReady(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome has not bound the debugging port yet; retry until the deadline.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Attached Chrome did not expose CDP on port ${port}`);
}

type AttachedFixture = {
  cdpUrl: string;
  controlled: import("playwright-core").Page;
  downloadUrl: string;
  nativeDownloadsDir: string;
  payload: Buffer;
  ref: string;
  targetId: string;
};

describe.runIf(runChromiumProof)("attached Chromium download ownership", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).toReversed()) {
      await dispose().catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(errors, "Attached Chromium download fixture cleanup failed");
    }
  });

  /**
   * Spawn a Chromium OpenClaw did not launch, seed its native download directory,
   * then attach over CDP. `declareExternal` publishes the attach-only ownership
   * fact before the first connect, exactly like profile admission does.
   */
  async function launchAttachedFixture(opts: {
    declareExternal: boolean;
  }): Promise<AttachedFixture> {
    const rootDir = tempDirs.make("openclaw-attach-only-downloads-");
    const profileDir = path.join(rootDir, "profile");
    const nativeDownloadsDir = path.join(rootDir, "native-downloads");
    await fs.mkdir(path.join(profileDir, "Default"), { recursive: true });
    await fs.mkdir(nativeDownloadsDir, { recursive: true });
    // Chrome reads this profile decoration at startup and keeps ownership of
    // downloads that no CDP client claims.
    await fs.writeFile(
      path.join(profileDir, "Default", "Preferences"),
      JSON.stringify({
        download: { default_directory: nativeDownloadsDir, prompt_for_download: false },
      }),
    );

    const payload = Buffer.from("attached-browser download proof\n");
    const downloadServer = createServer((request, response) => {
      if (request.url === `/${DOWNLOAD_FILE_NAME}`) {
        response.writeHead(200, {
          "content-disposition": `attachment; filename="${DOWNLOAD_FILE_NAME}"`,
          "content-length": String(payload.byteLength),
          "content-type": "text/plain",
        });
        response.end(payload);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<a href="/${DOWNLOAD_FILE_NAME}" download>Download</a>`);
    });
    const downloadPort = await listen(downloadServer);
    cleanup.push(async () => await closeServer(downloadServer));

    const cdpPort = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    if (opts.declareExternal) {
      const profile: ResolvedBrowserProfile = requireValue(
        resolveProfile(
          resolveBrowserConfig({
            profiles: { attach: { driver: "openclaw", attachOnly: true, cdpUrl } },
          }),
          "attach",
        ),
        "attach profile missing",
      );
      publishCdpEndpointOwnership(profile);
    }

    const chrome = spawn(
      resolveChromeExecutable(),
      [
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    cleanup.push(async () => await killProcess(chrome));
    await waitForCdpReady(cdpPort);
    cleanup.push(async () => await closePlaywrightBrowserConnection({ cdpUrl }));

    const pages = await listPagesViaPlaywright({ cdpUrl });
    const targetId = requireValue(pages[0]?.targetId, "attached browser exposed no page target");
    const controlled = await getPageForTargetId({ cdpUrl, targetId });
    await controlled.goto(`http://127.0.0.1:${downloadPort}/`);
    const snapshot = await snapshotRoleViaPlaywright({ cdpUrl, targetId });
    const ref = requireValue(
      Object.entries(snapshot.refs).find(([, entry]) => entry.name === "Download")?.[0],
      "attached page exposed no Download ref",
    );
    return {
      cdpUrl,
      controlled,
      downloadUrl: `http://127.0.0.1:${downloadPort}/${DOWNLOAD_FILE_NAME}`,
      nativeDownloadsDir,
      payload,
      ref,
      targetId,
    };
  }

  function observeDownload(page: import("playwright-core").Page, timeoutMs: number) {
    return page.waitForEvent("download", { timeout: timeoutMs }).then(
      (download) => ({ kind: "download" as const, download }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  }

  it("leaves native downloads with the attached browser and out of Playwright", async () => {
    const fixture = await launchAttachedFixture({ declareExternal: true });
    const downloadOutcome = observeDownload(fixture.controlled, 1500);

    await clickViaPlaywright({
      cdpUrl: fixture.cdpUrl,
      targetId: fixture.targetId,
      ref: fixture.ref,
      timeoutMs: 5_000,
    });

    await vi.waitFor(
      async () => {
        await expect(fs.readdir(fixture.nativeDownloadsDir)).resolves.toContain(DOWNLOAD_FILE_NAME);
      },
      { timeout: 15_000 },
    );
    await expect(
      fs.readFile(path.join(fixture.nativeDownloadsDir, DOWNLOAD_FILE_NAME)),
    ).resolves.toEqual(fixture.payload);
    const outcome = await downloadOutcome;
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" ? outcome.error : undefined).toBeInstanceOf(Error);
  }, 45_000);

  it("keeps Playwright download capture for an undeclared managed endpoint", async () => {
    const fixture = await launchAttachedFixture({ declareExternal: false });
    const downloadOutcome = observeDownload(fixture.controlled, 15_000);

    await clickViaPlaywright({
      cdpUrl: fixture.cdpUrl,
      targetId: fixture.targetId,
      ref: fixture.ref,
      timeoutMs: 5_000,
    });

    const outcome = await downloadOutcome;
    expect(outcome.kind).toBe("download");
    const download = outcome.kind === "download" ? outcome.download : undefined;
    expect(download?.suggestedFilename()).toBe(DOWNLOAD_FILE_NAME);
    await expect(fs.readdir(fixture.nativeDownloadsDir)).resolves.toEqual([]);
  }, 45_000);

  it("records how a direct navigation to a download resolves on an attached browser", async () => {
    const fixture = await launchAttachedFixture({ declareExternal: true });

    const startedAt = Date.now();
    let navigationResult: Awaited<ReturnType<typeof navigateViaPlaywright>> | undefined;
    let navigationError: unknown;
    try {
      navigationResult = await navigateViaPlaywright({
        cdpUrl: fixture.cdpUrl,
        targetId: fixture.targetId,
        url: fixture.downloadUrl,
        timeoutMs: 15_000,
        // Loopback fixture target; the download-capture fallback is the subject here.
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });
    } catch (error) {
      navigationError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    console.info(
      [
        "[attached-navigate]",
        `elapsedMs=${elapsedMs}`,
        `resolved=${navigationResult ? "yes" : "no"}`,
        `download=${navigationResult?.download ? "set" : "unset"}`,
        `error=${navigationError === undefined ? "(none)" : describeErrorOutcome(navigationError)}`,
      ].join(" "),
    );

    await vi.waitFor(
      async () => {
        await expect(fs.readdir(fixture.nativeDownloadsDir)).resolves.toContain(DOWNLOAD_FILE_NAME);
      },
      { timeout: 15_000 },
    );
    expect(navigationResult?.download).toBeUndefined();
    // The ownership guard rejects an externally owned endpoint before navigating. Without it
    // this same call consumes the whole navigation timeout and surfaces page.goto's own
    // download error instead of naming the capability.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  it("bounds a download wait on an attached browser", async () => {
    const fixture = await launchAttachedFixture({ declareExternal: true });

    const startedAt = Date.now();
    let waitError: unknown;
    try {
      await waitForDownloadViaPlaywright({
        cdpUrl: fixture.cdpUrl,
        targetId: fixture.targetId,
        timeoutMs: 3000,
      });
    } catch (error) {
      waitError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    console.info(
      `[attached-download-wait] elapsedMs=${elapsedMs} error=${describeErrorOutcome(waitError)}`,
    );

    expect(waitError).toBeInstanceOf(Error);
    expect(describeErrorOutcome(waitError).length).toBeGreaterThan(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(elapsedMs).toBeLessThanOrEqual(12_000);
  }, 60_000);
});
