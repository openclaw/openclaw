// Browser tests cover pw tools core.waits next download saves it plugin behavior.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let mod: Pick<
  typeof import("./pw-tools-core.downloads.js"),
  "downloadViaPlaywright" | "waitForDownloadViaPlaywright"
>;
let tmpDirModule: typeof import("openclaw/plugin-sdk/temp-path");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };

describe("pw-tools-core", () => {
  installPwToolsCoreTestHooks();

  beforeAll(async () => {
    vi.doMock("./pw-session.js", () => sessionMocks);
    vi.doMock("./chrome.js", () => chromeMocks);
    tmpDirModule = await import("openclaw/plugin-sdk/temp-path");
    vi.spyOn(tmpDirModule, "resolvePreferredOpenClawTmpDir").mockImplementation(
      tmpDirMocks.resolvePreferredOpenClawTmpDir,
    );
    mod = await import("./pw-tools-core.downloads.js");
  });

  beforeEach(() => {
    for (const fn of Object.values(tmpDirMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(chromeMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(clientFetchMocks)) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-download-test-"));
    try {
      return await run(tempDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  function requireSaveAsPath(saveAs: ReturnType<typeof vi.fn>): string {
    const [call] = saveAs.mock.calls;
    if (!call) {
      throw new Error("expected download saveAs call");
    }
    const [savedPath] = call;
    if (typeof savedPath !== "string") {
      throw new Error("expected download saveAs path");
    }
    return savedPath;
  }

  async function waitForImplicitDownloadOutput(params: {
    downloadUrl: string;
    suggestedFilename: string;
  }) {
    const harness = createDownloadEventHarness();
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "download-content", "utf8");
    });

    const p = mod.waitForDownloadViaPlaywright({
      ...target,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    harness.trigger({
      url: () => params.downloadUrl,
      suggestedFilename: () => params.suggestedFilename,
      saveAs,
    });

    const res = await p;
    const outPath = requireSaveAsPath(saveAs);
    return { res, outPath };
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
    expect(path.basename(savedPath)).toContain(path.basename(params.targetPath));
    expect(path.basename(savedPath)).toMatch(/\.part$/);
    expect(await fs.readFile(params.targetPath, "utf8")).toBe(params.content);
    await expectPathMissing(savedPath);
  }

  it("waits for the next download and atomically finalizes explicit output paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "nested", "deeper", "file.bin");

      type DownloadFixture = {
        url: () => string;
        suggestedFilename: () => string;
        saveAs: (outPath: string) => Promise<void>;
      };
      const saveAs = vi.fn(async function (this: DownloadFixture, outPath: string) {
        expect(this).toBe(download);
        await fs.writeFile(outPath, "file-content", "utf8");
      });
      const download: DownloadFixture = {
        url: () => "https://example.com/file.bin",
        suggestedFilename: () => "file.bin",
        saveAs,
      };

      const p = mod.waitForDownloadViaPlaywright({
        ...target,
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(download);

      const res = await p;
      await expectAtomicDownloadSave({ saveAs, targetPath, content: "file-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not write outside the output root when a download parent is swapped after save",
    async () => {
      await withTempDir(async (tempDir) => {
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

        const p = mod.waitForDownloadViaPlaywright({
          ...target,
          path: targetPath,
          rootDir,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        await expect(p).rejects.toMatchObject({ code: "not-file" });
        expect(parentSwappedBeforeFinalize).toBe(true);
        expect(saveAs).toHaveBeenCalledOnce();
        await expectPathMissing(outsideTargetPath);
        await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
      });
    },
  );

  it("releases a cancelled waiter before the next download", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    const controller = new AbortController();
    const cancelled = mod.waitForDownloadViaPlaywright({
      ...target,
      timeoutMs: 1000,
      signal: controller.signal,
    });

    await Promise.resolve();
    expect(state.downloadWaiterDepth).toBe(1);
    controller.abort(new Error("request aborted"));
    await expect(cancelled).rejects.toThrow("request aborted");
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);

    const successor = mod.waitForDownloadViaPlaywright({
      ...target,
      timeoutMs: 1000,
    });
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "successor-content", "utf8");
    });
    await Promise.resolve();
    harness.trigger({
      url: () => "https://example.com/successor.bin",
      suggestedFilename: () => "successor.bin",
      saveAs,
    });

    await expect(successor).resolves.toMatchObject({ suggestedFilename: "successor.bin" });
    expect(saveAs).toHaveBeenCalledOnce();
  });

  it("lets only the latest overlapping explicit waiter save the download", async () => {
    const harness = createDownloadEventHarness();
    const state = sessionMocks.ensurePageState();
    const cancel = vi.fn(async () => {});
    const saveAs = vi.fn(async (outPath: string) => {
      await fs.writeFile(outPath, "latest-content", "utf8");
    });

    const first = mod.waitForDownloadViaPlaywright({
      ...target,
      timeoutMs: 1000,
    });
    void first.catch(() => {});
    const latest = mod.waitForDownloadViaPlaywright({
      ...target,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(state.downloadWaiterDepth).toBe(2);
    harness.trigger({
      url: () => "https://example.com/latest.bin",
      suggestedFilename: () => "latest.bin",
      saveAs,
      cancel,
    });

    await expect(first).rejects.toThrow("superseded by another waiter");
    await expect(latest).resolves.toMatchObject({ suggestedFilename: "latest.bin" });
    expect(cancel).not.toHaveBeenCalled();
    expect(saveAs).toHaveBeenCalledOnce();
    expect(state.downloadWaiterDepth).toBe(0);
    expect(harness.activeHandlerCount()).toBe(0);
  });

  it("finishes an admitted clicked download after its caller retires", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();

      const clicked = createDeferred<void>();
      let current = true;
      const click = vi.fn(async () => {
        current = false;
        clicked.resolve();
      });
      setPwToolsCoreCurrentRefLocator({ click });

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "report-content", "utf8");
      });
      const download = {
        url: () => "https://example.com/report.pdf",
        suggestedFilename: () => "report.pdf",
        saveAs,
      };

      const targetPath = path.join(tempDir, "report.pdf");
      const p = mod.downloadViaPlaywright({
        ...target,
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        assertCurrent: async () => {
          if (!current) {
            throw new Error("Dashboard revoked after click");
          }
        },
      });

      await Promise.race([
        clicked.promise,
        p.then(() => {
          throw new Error("Download completed before its trigger");
        }),
      ]);
      harness.expectArmed();
      expect(click).toHaveBeenCalledWith({ timeout: 1000, signal: expect.any(AbortSignal) });
      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        }),
      );

      harness.trigger(download);

      const res = await p;
      expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "https://example.com/report.pdf",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        browserProxyMode: undefined,
        signal: undefined,
      });
      await expectAtomicDownloadSave({ saveAs, targetPath, content: "report-content" });
      await expect(fs.realpath(res.path)).resolves.toBe(await fs.realpath(targetPath));
    });
  });

  it("rejects a policy-denied waited download before saving it", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "metadata.bin");
      const saveAs = vi.fn(async () => {});
      const cancel = vi.fn(async () => {});
      navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        new Error("browser navigation blocked by policy"),
      );

      const pending = mod.waitForDownloadViaPlaywright({
        ...target,
        path: targetPath,
        timeoutMs: 1000,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger({
        url: () => "http://169.254.169.254/latest/meta-data/",
        suggestedFilename: () => "metadata.bin",
        saveAs,
        cancel,
      });

      await expect(pending).rejects.toThrow("browser navigation blocked by policy");
      expect(saveAs).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url: "http://169.254.169.254/latest/meta-data/",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        browserProxyMode: undefined,
        signal: expect.any(AbortSignal),
      });
    });
  });

  it("propagates a policy-denied clicked download before saving it", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const click = vi.fn(async () => {});
      const saveAs = vi.fn(async () => {});
      const cancel = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ click });
      navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        new Error("browser navigation blocked by policy"),
      );

      const pending = mod.downloadViaPlaywright({
        ...target,
        ref: "e12",
        path: path.join(tempDir, "metadata.bin"),
        timeoutMs: 1000,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger({
        url: () => "http://169.254.169.254/latest/meta-data/",
        suggestedFilename: () => "metadata.bin",
        saveAs,
        cancel,
      });

      await expect(pending).rejects.toThrow("browser navigation blocked by policy");
      expect(click).toHaveBeenCalledOnce();
      expect(saveAs).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it.runIf(process.platform !== "win32")(
    "replaces a hardlink path without overwriting the outside inode",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsidePath = path.join(tempDir, "outside.txt");
        await fs.writeFile(outsidePath, "outside-before", "utf8");
        const linkedPath = path.join(tempDir, "linked.txt");
        await fs.link(outsidePath, linkedPath);
        const outsideBefore = await fs.stat(outsidePath);

        const harness = createDownloadEventHarness();
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "download-content", "utf8");
        });
        const p = mod.waitForDownloadViaPlaywright({
          ...target,
          path: linkedPath,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

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
      });
    },
  );

  it("sanitizes suggested download filenames to prevent traversal escapes", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/evil",
      suggestedFilename: "../../../../etc/passwd",
    });
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
    async () => {
      await withTempDir(async (tempDir) => {
        const outsideDir = path.join(tempDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.symlink(outsideDir, path.join(tempDir, "downloads"));
        tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue(tempDir);

        const harness = createDownloadEventHarness();
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "should-not-write", "utf8");
        });

        const p = mod.waitForDownloadViaPlaywright({
          ...target,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        await expect(p).rejects.toThrow(/output directory/i);
        expect(saveAs).not.toHaveBeenCalled();
        await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
      });
    },
  );
});
