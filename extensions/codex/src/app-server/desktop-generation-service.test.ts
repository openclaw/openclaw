import type { WatchHealth, WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type WatchRegistration = {
  watchedPath: string;
  options: WatchOptions;
  watcher: WatchSubscription;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createHarness(initialFingerprint: string) {
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  const watchPath = vi.fn(async (watchedPath: string, options: WatchOptions) => {
    let health: WatchHealth = { state: "ready", mode: "events", directories: 2 };
    const close = vi.fn(async () => {
      health = { ...health, state: "closed" };
    });
    const watcher: WatchSubscription = {
      ready: Promise.resolve(),
      setScopes: async () => {},
      reconcile: async () => {},
      health: () => health,
      close,
      [Symbol.asyncDispose]: close,
    };
    registrations.push({ watchedPath, options, watcher, close });
    options.onInvalidate({ reason: "reconcile" });
    options.onHealth?.(health);
    return watcher;
  });
  const service = createCodexDesktopGenerationService(
    { onGenerationChange },
    {
      platform: "darwin",
      readFingerprint,
      resolveWatchPaths: () => ["/Applications", "/Applications/ChatGPT.app"],
      watchPath,
    },
  );
  return {
    service,
    registrations,
    readFingerprint,
    onGenerationChange,
    clearFailure,
    reportFailure,
    warn,
    watchPath,
    context: {
      logger: { warn },
      serviceHealth: { clearFailure, reportFailure },
    },
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start?.(harness.context as never);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(waitForCodexDesktopGeneration()).resolves.toBeDefined();
}

function failWatch(registration: WatchRegistration, message: string): void {
  registration.options.onHealth?.({
    state: "unavailable",
    mode: "events",
    directories: 2,
    failure: { operation: "watch", error: new Error(message) },
  });
}

describe("Codex desktop generation service", () => {
  let service: ReturnType<typeof createCodexDesktopGenerationService> | undefined;

  afterEach(async () => {
    await service?.stop?.({} as never);
    service = undefined;
    vi.useRealTimers();
  });

  it("starts without blocking on convergence and observes only candidate bundles", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-start");
    service = harness.service;

    await service.start?.(harness.context as never);

    expect(harness.registrations).toHaveLength(2);
    expect(harness.registrations[0]).toMatchObject({
      watchedPath: "/Applications",
      options: { scopes: [{ path: "ChatGPT.app", kind: "entry" }] },
    });
    expect(harness.registrations[1]).toMatchObject({
      watchedPath: "/Applications/ChatGPT.app",
      options: { scopes: [{ path: "", kind: "tree", depth: 128 }] },
    });
    expect(harness.clearFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.clearFailure).toHaveBeenCalled();
  });

  it.each(["content", "structural"] as const)(
    "publishes settled %s invalidation without replacing healthy observation",
    async (type) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-x");
      service = harness.service;
      await startAndSettle(harness);
      harness.onGenerationChange.mockClear();
      const arm = harness.registrations[1]!;

      harness.setFingerprint("desktop-y");
      arm.options.onInvalidate({
        reason: "event",
        changes: [{ path: "ChatGPT.app/Contents/Resources/plugin.json", type }],
      });
      await vi.advanceTimersByTimeAsync(1_100);

      expect(arm.close).not.toHaveBeenCalled();
      expect(harness.registrations).toHaveLength(2);
      expect(harness.onGenerationChange).toHaveBeenCalledExactlyOnceWith({
        epoch: expect.any(Number),
        fingerprint: "desktop-y",
      });
    },
  );

  it("invalidates all scopes on overflow and fences callbacks from retired subscriptions", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-overflow");
    service = harness.service;
    await startAndSettle(harness);
    harness.onGenerationChange.mockClear();
    const oldArm = harness.registrations[1]!;
    harness.setFingerprint("desktop-overflow-updated");
    oldArm.options.onInvalidate({ reason: "overflow" });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(harness.onGenerationChange).toHaveBeenCalledOnce();

    failWatch(oldArm, "watch lost");
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(oldArm.close).toHaveBeenCalledOnce();
    expect(harness.registrations).toHaveLength(4);
    oldArm.options.onInvalidate({ reason: "overflow" });
    failWatch(oldArm, "stale watcher");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    expect(harness.reportFailure).toHaveBeenCalledOnce();
  });

  it("joins unavailable subscription retirement before retrying", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-retirement");
    service = harness.service;
    await startAndSettle(harness);
    const retired = deferred<void>();
    const oldArm = harness.registrations[1]!;
    oldArm.close.mockReturnValue(retired.promise);
    failWatch(oldArm, "watch lost");

    await vi.advanceTimersByTimeAsync(100);
    expect(oldArm.close).toHaveBeenCalledOnce();
    expect(harness.registrations).toHaveLength(2);
    retired.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.registrations).toHaveLength(4);
  });

  it("keeps missing bundles healthy and rearms their roots when the parent entry changes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("missing-bundle");
    const actual = harness.watchPath.getMockImplementation()!;
    let missing = true;
    harness.watchPath.mockImplementation(async (watchedPath, options) => {
      if (missing && watchedPath !== "/Applications") {
        throw Object.assign(new Error("root dir not found"), { code: "not-found" });
      }
      return actual(watchedPath, options);
    });
    service = harness.service;
    await startAndSettle(harness);
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.registrations).toHaveLength(1);
    const parent = harness.registrations[0]!;
    missing = false;
    harness.setFingerprint("installed-bundle");
    parent.options.onInvalidate({
      reason: "event",
      changes: [{ path: "ChatGPT.app", type: "structural" }],
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(parent.close).toHaveBeenCalledOnce();
    expect(harness.registrations).toHaveLength(3);
    expect(harness.registrations[2]?.watchedPath).toBe("/Applications/ChatGPT.app");
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "installed-bundle",
    });
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("settles generations while persistent registration failures retry with backoff", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stable");
    harness.watchPath.mockRejectedValue(new Error("watch unavailable"));
    service = harness.service;
    await service.start?.(harness.context as never);
    const first = waitForCodexDesktopGeneration();

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ fingerprint: "desktop-stable" });
    harness.setFingerprint("desktop-updated");
    await vi.advanceTimersByTimeAsync(60_000);

    const attempts = harness.watchPath.mock.calls.filter(
      ([watchedPath]) => watchedPath === "/Applications",
    ).length;
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThan(20);
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-updated",
    });
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(harness.clearFailure).not.toHaveBeenCalled();
  });

  it("joins late Root admission on stop and never publishes after stopping", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    const admission = deferred<WatchSubscription>();
    const createWatch = harness.watchPath.getMockImplementation()!;
    harness.watchPath.mockReturnValueOnce(admission.promise);
    service = harness.service;
    await service.start?.(harness.context as never);
    let stopped = false;
    const stopping = Promise.resolve(service.stop?.({} as never)).then(() => {
      stopped = true;
    });
    service = undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    const [watchedPath, options] = harness.watchPath.mock.calls[0]!;
    const lateReady = deferred<void>();
    const late = { ...(await createWatch(watchedPath, options)), ready: lateReady.promise };
    const close = late.close.bind(late);
    late.close = async () => {
      lateReady.reject(new Error("closed before ready"));
      await close();
    };
    admission.resolve(late);
    await stopping;
    expect(harness.registrations).toHaveLength(2);
    for (const registration of harness.registrations) {
      expect(registration.close).toHaveBeenCalledOnce();
    }
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
  });
});
