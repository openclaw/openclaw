import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitStarted } from "./pw-tools-core.guard-test-support.js";
import {
  getPwToolsCoreSessionMocks,
  getPwToolsCoreNavigationGuardMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

const tmpDirMocks = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));
const chromeMocks = vi.hoisted(() => ({
  getChromeWebSocketEndpoint: vi.fn(async () => ({
    url: "ws://127.0.0.1/devtools/browser/mock",
  })),
}));
const clientFetchMocks = vi.hoisted(() => ({
  resolveBrowserRateLimitMessage: vi.fn(() => undefined),
}));
vi.mock("./chrome.js", () => chromeMocks);
vi.mock("./client-fetch.js", () => clientFetchMocks);

const sessionMocks = getPwToolsCoreSessionMocks();
const navigationGuardMocks = getPwToolsCoreNavigationGuardMocks();

const tmpDirModule = await import("openclaw/plugin-sdk/temp-path");
vi.spyOn(tmpDirModule, "resolvePreferredOpenClawTmpDir").mockImplementation(
  tmpDirMocks.resolvePreferredOpenClawTmpDir,
);
const mod = await import("./pw-tools-core.downloads.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const strictPolicy = { dangerouslyAllowPrivateNetwork: false };
function waitForDownload(
  options: Omit<Parameters<typeof mod.waitForDownloadViaPlaywright>[0], "cdpUrl" | "targetId"> = {},
) {
  return mod.waitForDownloadViaPlaywright({ ...target, timeoutMs: 1000, ...options });
}
function writer(content: string) {
  return vi.fn(async (outPath: string) => {
    await fs.writeFile(outPath, content, "utf8");
  });
}
function downloadEvent(
  saveAs: ReturnType<typeof vi.fn>,
  filename = "file.bin",
  url = `https://example.com/${filename}`,
  cancel = vi.fn(async () => {}),
) {
  return { url: () => url, suggestedFilename: () => filename, saveAs, cancel };
}

describe("pw-tools-core", () => {
  installPwToolsCoreTestHooks();

  beforeEach(() => {
    for (const fn of Object.values({ ...tmpDirMocks, ...chromeMocks, ...clientFetchMocks })) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  function withTempDir<T>(run: (tempDir: string) => Promise<T>) {
    return async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-download-test-"));
      try {
        return await run(tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  }

  function requireSaveAsPath(saveAs: ReturnType<typeof vi.fn>): string {
    const savedPath = saveAs.mock.calls[0]?.[0];
    if (typeof savedPath !== "string") {
      throw new Error("expected download saveAs path");
    }
    return savedPath;
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  }

  function createDownloadEventHarness() {
    const events = new EventEmitter();
    setPwToolsCoreCurrentPage({ on: events.on.bind(events), off: events.off.bind(events) });
    return {
      trigger: (download: unknown) => events.emit("download", download),
      expectArmed: () => expect(events.listenerCount("download")).toBeGreaterThan(0),
      activeHandlerCount: () => events.listenerCount("download"),
    };
  }

  async function expectAtomicDownloadSave(params: {
    saveAs: ReturnType<typeof vi.fn>;
    targetPath: string;
    content: string;
  }) {
    const savedPath = requireSaveAsPath(params.saveAs);
    expect(savedPath).not.toBe(params.targetPath);
    await expectPathMissing(path.dirname(savedPath));
    expect(path.basename(savedPath)).toMatch(/\.part$/);
    expect(await fs.readFile(params.targetPath, "utf8")).toBe(params.content);
    await expectPathMissing(savedPath);
  }

  it.runIf(process.platform !== "win32")(
    "does not write outside the output root when a download parent is swapped after save",
    withTempDir(async (tempDir) => {
      const rootDir = path.join(tempDir, "downloads");
      const targetParent = path.join(rootDir, "race");
      const outsideDir = path.join(tempDir, "outside");
      const targetPath = path.join(targetParent, "file.bin");
      const outsideTargetPath = path.join(outsideDir, "file.bin");
      await fs.mkdir(targetParent, { recursive: true });
      await fs.mkdir(outsideDir);

      const harness = createDownloadEventHarness();
      let parentSwappedBeforeFinalize = false;
      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "race-content", "utf8");
        const beforeSwap = await fs.lstat(targetParent);
        expect(beforeSwap.isDirectory()).toBe(true);
        expect(beforeSwap.isSymbolicLink()).toBe(false);
        await fs.rm(targetParent, { recursive: true, force: true });
        await fs.symlink(outsideDir, targetParent);
        const afterSwap = await fs.lstat(targetParent);
        expect(afterSwap.isSymbolicLink()).toBe(true);
        parentSwappedBeforeFinalize = true;
      });

      const p = waitForDownload({ path: targetPath, rootDir });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(downloadEvent(saveAs));

      await expect(p).rejects.toMatchObject({ code: "not-file" });
      expect(parentSwappedBeforeFinalize).toBe(true);
      expect(saveAs).toHaveBeenCalledOnce();
      await expectPathMissing(outsideTargetPath);
      await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
    }),
  );

  it("releases a cancelled waiter before the next download", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    const controller = new AbortController();
    const cancelled = waitForDownload({ signal: controller.signal });

    await Promise.resolve();
    expect(state.downloadWaiterDepth).toBe(1);
    controller.abort(new Error("request aborted"));
    await expect(cancelled).rejects.toThrow("request aborted");
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);

    const successor = waitForDownload();
    const saveAs = writer("successor-content");
    await Promise.resolve();
    harness.trigger(downloadEvent(saveAs, "successor.bin"));

    await expect(successor).resolves.toMatchObject({ suggestedFilename: "successor.bin" });
    expect(saveAs).toHaveBeenCalledOnce();
  });

  it("lets only the latest overlapping explicit waiter save the download", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    const cancel = vi.fn(async () => {});
    const saveAs = writer("latest-content");
    const first = waitForDownload();
    void first.catch(() => {});
    const latest = waitForDownload();

    await Promise.resolve();
    expect(state.downloadWaiterDepth).toBe(2);
    harness.trigger(downloadEvent(saveAs, "latest.bin", undefined, cancel));

    await expect(first).rejects.toThrow("superseded by another waiter");
    await expect(latest).resolves.toMatchObject({ suggestedFilename: "latest.bin" });
    expect(cancel).not.toHaveBeenCalled();
    expect(saveAs).toHaveBeenCalledOnce();
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it(
    "finishes an admitted clicked download after its caller retires",
    withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();

      const clicked = createDeferred<void>();
      let current = true;
      const click = vi.fn(async () => {
        current = false;
        clicked.resolve();
      });
      setPwToolsCoreCurrentRefLocator({ click });

      const saveAs = writer("report-content");
      const download = downloadEvent(saveAs, "report.pdf");

      const targetPath = path.join(tempDir, " report.pdf ");
      const neighborPath = path.join(tempDir, "report.pdf");
      await fs.writeFile(neighborPath, "existing neighbor");
      const p = mod.downloadViaPlaywright({
        ...target,
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
        ssrfPolicy: strictPolicy,
        assertCurrent: async () => {
          if (!current) {
            throw new Error("Dashboard revoked after click");
          }
        },
      });

      await awaitStarted(clicked.promise, p);
      harness.expectArmed();
      expect(click).toHaveBeenCalledWith({ timeout: 1000, signal: expect.any(AbortSignal) });
      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          ssrfPolicy: strictPolicy,
        }),
      );

      harness.trigger(download);

      const res = await p;
      expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "https://example.com/report.pdf",
        ssrfPolicy: strictPolicy,
        browserProxyMode: undefined,
        signal: undefined,
      });
      await expectAtomicDownloadSave({ saveAs, targetPath, content: "report-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
      await expect(fs.readFile(neighborPath, "utf8")).resolves.toBe("existing neighbor");
    }),
  );

  it.each(["waited", "clicked"])(
    "rejects a policy-denied %s download before saving it",
    async (mode) => {
      await withTempDir(async (tempDir) => {
        const harness = createDownloadEventHarness();
        const targetPath = path.join(tempDir, "metadata.bin");
        const saveAs = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const click = vi.fn(async () => {});
        setPwToolsCoreCurrentRefLocator({ click });
        navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
          new Error("browser navigation blocked by policy"),
        );

        const pending =
          mode === "waited"
            ? waitForDownload({ path: targetPath, ssrfPolicy: strictPolicy })
            : mod.downloadViaPlaywright({
                ...target,
                ref: "e12",
                path: targetPath,
                timeoutMs: 1000,
                ssrfPolicy: strictPolicy,
              });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger(
          downloadEvent(saveAs, "metadata.bin", "http://169.254.169.254/latest/meta-data/", cancel),
        );

        await expect(pending).rejects.toThrow("browser navigation blocked by policy");
        expect(saveAs).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledOnce();
        expect(click).toHaveBeenCalledTimes(mode === "clicked" ? 1 : 0);
        expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
          url: "http://169.254.169.254/latest/meta-data/",
          ssrfPolicy: strictPolicy,
          browserProxyMode: undefined,
          signal: mode === "waited" ? expect.any(AbortSignal) : undefined,
        });
      })();
    },
  );

  it.runIf(process.platform !== "win32")(
    "replaces a hardlink path without overwriting the outside inode",
    withTempDir(async (tempDir) => {
      const outsidePath = path.join(tempDir, "outside.txt");
      await fs.writeFile(outsidePath, "outside-before", "utf8");
      const linkedPath = path.join(tempDir, "linked.txt");
      await fs.link(outsidePath, linkedPath);
      const outsideBefore = await fs.stat(outsidePath);

      const harness = createDownloadEventHarness();
      const saveAs = writer("download-content");
      const p = waitForDownload({ path: linkedPath });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(downloadEvent(saveAs));

      await expect(p).resolves.toMatchObject({ path: linkedPath });
      await expectAtomicDownloadSave({
        saveAs,
        targetPath: linkedPath,
        content: "download-content",
      });
      const outsideAfter = await fs.stat(outsidePath);
      const linkedAfter = await fs.stat(linkedPath);
      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-before");
      expect({ dev: outsideAfter.dev, ino: outsideAfter.ino }).toEqual({
        dev: outsideBefore.dev,
        ino: outsideBefore.ino,
      });
      expect({ dev: linkedAfter.dev, ino: linkedAfter.ino }).not.toEqual({
        dev: outsideAfter.dev,
        ino: outsideAfter.ino,
      });
    }),
  );

  it("sanitizes suggested download filenames to prevent traversal escapes", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const harness = createDownloadEventHarness();
    const saveAs = writer("download-content");
    const pending = waitForDownload();
    await Promise.resolve();
    harness.trigger(downloadEvent(saveAs, "../../../../etc/passwd", "https://example.com/evil"));
    const res = await pending;
    const outPath = requireSaveAsPath(saveAs);
    expect(typeof outPath).toBe("string");
    const expectedRootedDownloadsDir = await fs.realpath(
      path.resolve(path.join(path.sep, "tmp", "openclaw-preferred", "downloads")),
    );
    const relativeStagedPath = path.relative(expectedRootedDownloadsDir, outPath);
    expect(relativeStagedPath.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeStagedPath)).toBe(false);
    await expectPathMissing(path.dirname(outPath));
    await expect(fs.realpath(path.dirname(res.path))).resolves.toBe(expectedRootedDownloadsDir);
    expect(path.basename(outPath)).toContain(path.basename(res.path));
    expect(path.basename(outPath)).toMatch(/\.part$/);
    expect(path.basename(res.path)).toMatch(/-passwd$/);
    await expectPathMissing(outPath);
    await expect(fs.readFile(res.path, "utf8")).resolves.toBe("download-content");
    expect(path.normalize(res.path)).toContain(
      path.normalize(`${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`),
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects implicit downloads when the output directory is a symlink",
    withTempDir(async (tempDir) => {
      const outsideDir = path.join(tempDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(tempDir, "downloads"));
      tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue(tempDir);

      const harness = createDownloadEventHarness();
      const saveAs = writer("should-not-write");
      const p = waitForDownload();

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(downloadEvent(saveAs));

      await expect(p).rejects.toThrow(/output directory/i);
      expect(saveAs).not.toHaveBeenCalled();
      await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
    }),
  );
});
