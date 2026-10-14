import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

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

function createServiceContext(
  warn: OpenClawPluginServiceContextV2["logger"]["warn"],
  serviceHealth: NonNullable<OpenClawPluginServiceContextV2["serviceHealth"]>,
): OpenClawPluginServiceContextV2 {
  return {
    config: {},
    stateDir: "/unused",
    scheduler: createTestPluginServiceScheduler(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    serviceHealth,
  };
}

function createHarness(initialFingerprint: string, initialWatchFailures = 0) {
  let watchFailures = initialWatchFailures;
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  let watchAttempts = 0;
  const context = createServiceContext(warn, { clearFailure, reportFailure });
  const service = createCodexDesktopGenerationService(
    { onGenerationChange },
    {
      platform: "darwin",
      readFingerprint,
      resolveWatchPaths: () => ["/Applications", "/Applications/ChatGPT.app"],
      pathExists: () => true,
      watchPath: (watchedPath, options, listener) => {
        watchAttempts += 1;
        if (watchFailures > 0) {
          watchFailures -= 1;
          throw new Error("watch registration unavailable");
        }
        const watcher = new FakeWatcher();
        registrations.push({ watchedPath, recursive: options.recursive, listener, watcher });
        return watcher as FSWatcher;
      },
    },
  );
  return {
    service,
    context,
    registrations,
    readFingerprint,
    onGenerationChange,
    clearFailure,
    reportFailure,
    warn,
    get watchAttempts() {
      return watchAttempts;
    },
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start(harness.context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(harness.readFingerprint).toHaveBeenCalledOnce();
}

describe("Codex desktop generation service", () => {
  let current:
    | {
        service: ReturnType<typeof createCodexDesktopGenerationService>;
        context: OpenClawPluginServiceContextV2;
      }
    | undefined;

  afterEach(async () => {
    if (current) {
      await current.service.stop?.(current.context);
    }
    current = undefined;
    vi.useRealTimers();
  });

  it.each([1, Infinity])(
    "retries failed watch registration once (%s failures)",
    async (failures) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-rearm", failures);
      current = harness;
      await harness.service.start(harness.context);
      expect(harness.watchAttempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(harness.watchAttempts).toBe(4);
      expect(harness.registrations).toHaveLength(failures === 1 ? 3 : 0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.watchAttempts).toBe(4);
      if (failures === Infinity) {
        harness.setFingerprint("updated-without-watcher");
        const next = waitForCodexDesktopGeneration();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await next).toMatchObject({ fingerprint: "updated-without-watcher" });
        expect(harness.watchAttempts).toBe(4);
      }
    },
  );

  it("rearms stable directory watches and publishes a settled root replacement", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-x");
    current = harness;
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
  });

  it("ignores unrelated application events and recovers a watcher error", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-errors");
    current = harness;
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

  it("does not publish a generation after service stop during settling", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    current = harness;
    await harness.service.start(harness.context);

    await harness.service.stop?.(harness.context);
    current = undefined;
    expect(vi.getTimerCount()).toBe(0);
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).not.toHaveBeenCalled();
  });

  it("joins an admitted fingerprint read before service retirement completes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-in-flight");
    const read = createDeferred<string>();
    harness.readFingerprint.mockImplementationOnce(() => read.promise);
    current = harness;
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.readFingerprint).toHaveBeenCalledOnce();

    const retired = vi.fn();
    const stopping = Promise.resolve(harness.service.stop?.(harness.context)).then(retired);
    try {
      await Promise.resolve();
      expect(retired).not.toHaveBeenCalled();
      expect(
        harness.registrations.every(({ watcher }) => watcher.close.mock.calls.length === 1),
      ).toBe(true);
    } finally {
      read.resolve("desktop-after-stop");
      await stopping;
    }
    current = undefined;
    expect(retired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
  });
});
