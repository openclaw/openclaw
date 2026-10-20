import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fingerprintRuntime from "./desktop-generation-fingerprint.js";
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

const watchPath = vi.hoisted(() =>
  vi.fn<
    (
      watchedPath: string,
      options: { recursive: boolean },
      listener: WatchRegistration["listener"],
    ) => FSWatcher
  >(),
);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: watchPath,
}));
vi.mock("./desktop-generation-fingerprint.js", { spy: true });

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
  const readFingerprint = vi
    .spyOn(fingerprintRuntime, "readMacOSDesktopGenerationFingerprint")
    .mockClear()
    .mockImplementation(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  let watchAttempts = 0;
  const context = createServiceContext(warn, { clearFailure, reportFailure });
  watchPath.mockImplementation((watchedPath, options, listener) => {
    watchAttempts += 1;
    if (watchFailures > 0) {
      watchFailures -= 1;
      throw new Error("watch registration unavailable");
    }
    const watcher = new FakeWatcher();
    registrations.push({ watchedPath, recursive: options.recursive, listener, watcher });
    return watcher as FSWatcher;
  });
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const service = createCodexDesktopGenerationService({ onGenerationChange });
  platform.mockRestore();
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
    vi.restoreAllMocks();
  });

  it("refreshes on acquisition when the stable root cannot be watched", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-unwatched", Infinity);
    current = harness;
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    harness.setFingerprint("updated-without-watcher");
    const next = waitForCodexDesktopGeneration();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toMatchObject({ fingerprint: "updated-without-watcher" });
    expect(harness.watchAttempts).toBe(1);
  });

  it("keeps the stable parent watch and publishes a settled bundle replacement", async () => {
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
    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldArm.every((entry) => entry.watcher.close.mock.calls.length === 0)).toBe(true);
    expect(harness.registrations).toHaveLength(1);
    await vi.waitFor(() => expect(harness.onGenerationChange).toHaveBeenCalledOnce());
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-y",
    });
  });

  it("ignores unrelated applications and refreshes on demand after a watcher error", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-errors");
    current = harness;
    await startAndSettle(harness);
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");

    applications?.listener("rename", "Safari.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(1);

    oldArm[0]?.watcher.emit("error", new Error("watch lost"));
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    harness.setFingerprint("desktop-after-watch-error");
    const next = waitForCodexDesktopGeneration();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toMatchObject({ fingerprint: "desktop-after-watch-error" });
    expect(oldArm[0]?.watcher.close).toHaveBeenCalledOnce();
    expect(harness.registrations).toHaveLength(1);
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

  it.each(["change", "error"])(
    "ignores watcher %s callbacks after scheduler admission closes",
    async (event) => {
      vi.useFakeTimers();
      const harness = createHarness("desktop-closing");
      current = harness;
      await startAndSettle(harness);
      harness.context.scheduler.beginClose();

      const registration = harness.registrations[0]!;
      expect(() => {
        if (event === "change") {
          registration.listener("rename", "ChatGPT.app");
        } else {
          registration.watcher.emit("error", new Error("watch lost during shutdown"));
        }
      }).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.watchAttempts).toBe(1);
      expect(harness.readFingerprint).toHaveBeenCalledOnce();
    },
  );

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
