import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as desktopAppPaths from "./desktop-app-paths.js";
import {
  createCodexDesktopGenerationService,
  isCodexDesktopGenerationCurrent,
  readCodexDesktopGenerationCandidates,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";
import * as managedDesktopInstallation from "./managed-desktop-installation.js";

class FakeWatcher extends EventEmitter {
  close = vi.fn();
  ref = vi.fn(() => this);
  unref = vi.fn(() => this);
}

type WatchRegistration = {
  watchedPath: string;
  recursive: boolean;
  listener: (eventType: string, filename: string | Buffer | null) => void;
  watcher: FakeWatcher;
};

function createHarness(
  initialFingerprint: string,
  resolveWatchPaths = () => ["/Applications", "/Applications/ChatGPT.app"],
) {
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const resolveCandidates = vi.fn(async () =>
    desktopAppPaths.resolveMacOSDesktopCodexAppPathCandidates("darwin"),
  );
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  const service = createCodexDesktopGenerationService(
    { onGenerationChange },
    {
      platform: "darwin",
      readFingerprint,
      resolveCandidates,
      resolveWatchPaths,
      pathExists: () => true,
      watchPath: (watchedPath, options, listener) => {
        const watcher = new FakeWatcher();
        registrations.push({ watchedPath, recursive: options.recursive, listener, watcher });
        return watcher as FSWatcher;
      },
    },
  );
  return {
    service,
    registrations,
    readFingerprint,
    resolveCandidates,
    onGenerationChange,
    clearFailure,
    reportFailure,
    warn,
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start?.({
    logger: { warn: harness.warn },
    serviceHealth: {
      clearFailure: harness.clearFailure,
      reportFailure: harness.reportFailure,
    },
  } as never);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledTimes(2));
}

describe("Codex desktop generation service", () => {
  let service: ReturnType<typeof createCodexDesktopGenerationService> | undefined;

  afterEach(async () => {
    await service?.stop?.({} as never);
    service = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts without blocking on initial convergence", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-start");
    service = harness.service;

    await service.start?.({
      logger: { warn: harness.warn },
      serviceHealth: {
        clearFailure: harness.clearFailure,
        reportFailure: harness.reportFailure,
      },
    } as never);

    expect(harness.registrations).toHaveLength(2);
    expect(
      harness.registrations.map(({ watchedPath, recursive }) => [watchedPath, recursive]),
    ).toEqual([
      ["/Applications", false],
      ["/Applications/ChatGPT.app", true],
    ]);
    expect(harness.clearFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.clearFailure).toHaveBeenCalledOnce());
  });

  it("rearms stable directory watches and publishes a settled root replacement", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-x");
    service = harness.service;
    await startAndSettle(harness);
    harness.onGenerationChange.mockClear();
    harness.clearFailure.mockClear();
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");
    expect(applications).toBeDefined();

    harness.setFingerprint("desktop-y");
    applications?.listener("rename", "ChatGPT.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(oldArm.every((entry) => entry.watcher.close.mock.calls.length === 1)).toBe(true);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.onGenerationChange).toHaveBeenCalledOnce());
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-y",
    });

    applications?.listener("rename", "ChatGPT.app");
    oldArm[0]?.watcher.emit("error", new Error("stale watcher"));
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("ignores unrelated application events and recovers a watcher error", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-errors");
    service = harness.service;
    await startAndSettle(harness);
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");

    applications?.listener("rename", "Safari.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(2);

    oldArm[0]?.watcher.emit("error", new Error("watch lost"));
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.clearFailure).toHaveBeenCalledTimes(2));
  });

  function managedWatchFixture() {
    const managedRoot = "/Users/test/Library/Application Support/OpenClaw/Codex";
    const appBundlePath = path.join(managedRoot, "versions/selected/ChatGPT.app");
    vi.spyOn(managedDesktopInstallation, "resolveCodexManagedDesktopRoot").mockReturnValue(
      managedRoot,
    );
    vi.spyOn(desktopAppPaths, "resolveMacOSDesktopCodexAppPathCandidates").mockReturnValue([
      {
        appName: "ChatGPT.app",
        appBundlePath,
        appServerCommandPath: path.join(appBundlePath, "Contents/Resources/codex"),
        bundledMarketplacePath: path.join(
          appBundlePath,
          "Contents/Resources/plugins/openai-bundled",
        ),
        computerUseServiceAppPaths: [],
      },
    ]);
    return { managedRoot, appBundlePath };
  }

  it("keeps the selected generation current while a managed update is staged", async () => {
    vi.useFakeTimers();
    const { managedRoot, appBundlePath } = managedWatchFixture();
    const harness = createHarness("managed-selected", () => [managedRoot, appBundlePath]);
    service = harness.service;
    await startAndSettle(harness);
    const generation = await waitForCodexDesktopGeneration();
    const root = harness.registrations.find((entry) => entry.watchedPath === managedRoot);

    for (const filename of [
      ".download-update/archive.zip",
      "versions/staged/ChatGPT.app/Contents/Resources/codex",
      "versions/selected-other/ChatGPT.app/Contents/Resources/codex",
      ".selected.json.tmp",
      "selected.json.lock",
    ]) {
      root?.listener("change", filename);
      expect(isCodexDesktopGenerationCurrent(generation), filename).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.registrations).toHaveLength(2);
    expect(harness.readFingerprint).toHaveBeenCalledTimes(2);
  });

  it.each(["selected bundle through root", "selected bundle watch"])(
    "invalidates the selected generation for %s changes",
    async (changedArtifact) => {
      vi.useFakeTimers();
      const { managedRoot, appBundlePath } = managedWatchFixture();
      const harness = createHarness("managed-before", () => [managedRoot, appBundlePath]);
      service = harness.service;
      await startAndSettle(harness);
      const generation = await waitForCodexDesktopGeneration();
      harness.onGenerationChange.mockClear();
      const watchedPath = changedArtifact === "selected bundle watch" ? appBundlePath : managedRoot;
      const registration = harness.registrations.find((entry) => entry.watchedPath === watchedPath);
      const filename = path.relative(
        watchedPath,
        path.join(appBundlePath, "Contents/Resources/codex"),
      );

      harness.setFingerprint("managed-after");
      registration?.listener("rename", Buffer.from(filename));

      expect(isCodexDesktopGenerationCurrent(generation)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(harness.registrations).toHaveLength(4);
      expect(harness.onGenerationChange).toHaveBeenCalledOnce();
      expect(harness.onGenerationChange).toHaveBeenCalledWith({
        epoch: expect.any(Number),
        fingerprint: "managed-after",
      });
    },
  );

  it("rearms a missing managed root from its ancestor without reacting to staging", async () => {
    vi.useFakeTimers();
    const { managedRoot } = managedWatchFixture();
    vi.mocked(desktopAppPaths.resolveMacOSDesktopCodexAppPathCandidates).mockReturnValue([]);
    const ancestor = path.dirname(path.dirname(managedRoot));
    let watchPaths = [ancestor];
    const harness = createHarness("before-install", () => watchPaths);
    service = harness.service;
    await startAndSettle(harness);
    const generation = await waitForCodexDesktopGeneration();
    const registration = harness.registrations[0];

    registration?.listener("rename", "OtherApp/settings.json");
    registration?.listener("change", "OpenClaw/Codex/.download-update/archive.zip");
    expect(isCodexDesktopGenerationCurrent(generation)).toBe(true);

    watchPaths = [managedRoot];
    registration?.listener("rename", "OpenClaw");
    expect(isCodexDesktopGenerationCurrent(generation)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(harness.registrations.at(-1)?.watchedPath).toBe(managedRoot);
    expect(harness.registrations.at(-1)?.watchedPath).toBe(managedRoot);
  });

  it("observes an external selection commit on the next acquisition without polling or rehashing unchanged rows", async () => {
    vi.useFakeTimers();
    const { appBundlePath } = managedWatchFixture();
    const harness = createHarness("selected-old");
    service = harness.service;
    await startAndSettle(harness);
    const oldGeneration = await waitForCodexDesktopGeneration();
    const oldCandidates = readCodexDesktopGenerationCandidates(oldGeneration);
    expect(oldCandidates?.[0]?.appBundlePath).toBe(appBundlePath);
    await waitForCodexDesktopGeneration();
    expect(harness.readFingerprint).toHaveBeenCalledTimes(2);
    harness.onGenerationChange.mockClear();
    harness.setFingerprint("selected-new");
    const nextCandidate = {
      ...oldCandidates![0]!,
      appBundlePath: `${appBundlePath}-next`,
      appServerCommandPath: `${appBundlePath}-next/Contents/Resources/codex`,
    };
    harness.resolveCandidates.mockResolvedValue([nextCandidate]);
    const next = waitForCodexDesktopGeneration();
    await vi.advanceTimersByTimeAsync(1_100);
    const nextGeneration = await next;
    expect(nextGeneration?.fingerprint).toBe("selected-new");
    expect(isCodexDesktopGenerationCurrent(oldGeneration)).toBe(false);
    expect(readCodexDesktopGenerationCandidates(oldGeneration)).toBeUndefined();
    expect(readCodexDesktopGenerationCandidates(nextGeneration)).toEqual([nextCandidate]);
    expect(oldCandidates?.[0]?.appBundlePath).toBe(appBundlePath);
    expect(harness.onGenerationChange).toHaveBeenCalledOnce();
  });

  it("settles the current generation while persistent watcher registration retries", async () => {
    vi.useFakeTimers();
    let fingerprint = "desktop-stable";
    const readFingerprint = vi.fn(async () => fingerprint);
    const onGenerationChange = vi.fn();
    const clearFailure = vi.fn();
    const reportFailure = vi.fn();
    const warn = vi.fn();
    const watchPath = vi.fn(
      (
        _watchedPath: string,
        _options: { recursive: boolean },
        _listener: (eventType: string, filename: string | Buffer | null) => void,
      ): FSWatcher => {
        throw new Error("watch unavailable");
      },
    );
    service = createCodexDesktopGenerationService(
      { onGenerationChange },
      {
        platform: "darwin",
        readFingerprint,
        resolveCandidates: async () => [],
        resolveWatchPaths: () => ["/Applications"],
        pathExists: () => true,
        watchPath,
      },
    );
    await service.start?.({
      logger: { warn },
      serviceHealth: { clearFailure, reportFailure },
    } as never);
    let settled = false;
    void waitForCodexDesktopGeneration().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
    fingerprint = "desktop-updated";
    await vi.advanceTimersByTimeAsync(60_000);

    expect(watchPath.mock.calls.length).toBeGreaterThan(2);
    expect(watchPath.mock.calls.length).toBeLessThan(20);
    expect(readFingerprint.mock.calls.length).toBeGreaterThan(2);
    expect(onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-updated",
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(clearFailure).not.toHaveBeenCalled();
  });

  it("does not resurrect a stopped service after its initial selection read resolves", async () => {
    const harness = createHarness("not-admitted");
    service = harness.service;
    let resolveSelection!: (
      value: readonly desktopAppPaths.MacOSDesktopCodexAppPathCandidate[],
    ) => void;
    harness.resolveCandidates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const starting = service.start?.({ logger: { warn: harness.warn } } as never);
    await service.stop?.({} as never);
    resolveSelection([]);
    await starting;
    expect(harness.registrations).toEqual([]);
    expect(harness.readFingerprint).not.toHaveBeenCalled();
    expect(await waitForCodexDesktopGeneration()).toBeUndefined();
  });

  it("does not publish a generation after service stop during settling", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    service = harness.service;
    await service.start?.({
      logger: { warn: harness.warn },
      serviceHealth: {
        clearFailure: harness.clearFailure,
        reportFailure: harness.reportFailure,
      },
    } as never);
    await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());

    await service.stop?.({} as never);
    service = undefined;
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
  });
});
