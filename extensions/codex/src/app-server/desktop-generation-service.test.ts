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
}

const watchPath = vi.hoisted(() =>
  vi.fn<
    (
      watchedPath: string,
      options: { recursive: boolean },
      listener: (eventType: string, filename: string | Buffer | null) => void,
    ) => FSWatcher
  >(),
);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: watchPath,
}));
vi.mock("./desktop-generation-fingerprint.js", { spy: true });

let current: ReturnType<typeof createHarness> | undefined;
function createHarness(initialFingerprint: string, initialWatchFailures = 0) {
  vi.useFakeTimers();
  watchPath.mockClear();
  let watchFailures = initialWatchFailures;
  let fingerprint = initialFingerprint;
  const watcher = new FakeWatcher();
  const readFingerprint = vi
    .spyOn(fingerprintRuntime, "readMacOSDesktopGenerationFingerprint")
    .mockClear()
    .mockImplementation(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  const context: OpenClawPluginServiceContextV2 = {
    config: {},
    stateDir: "/unused",
    scheduler: createTestPluginServiceScheduler(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    serviceHealth: { clearFailure: vi.fn(), reportFailure },
  };
  watchPath.mockImplementation(() => {
    if (watchFailures > 0) {
      watchFailures -= 1;
      throw new Error("watch registration unavailable");
    }
    return watcher as FSWatcher;
  });
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const service = createCodexDesktopGenerationService({ onGenerationChange });
  platform.mockRestore();
  const harness = {
    service,
    context,
    watcher,
    change: (filename: string) => watchPath.mock.calls[0]![2]("rename", filename),
    readFingerprint,
    onGenerationChange,
    reportFailure,
    warn,
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
  current = harness;
  return harness;
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start(harness.context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(harness.readFingerprint).toHaveBeenCalledOnce();
  expect(watchPath).toHaveBeenCalledWith(
    "/Applications",
    { recursive: false },
    expect.any(Function),
  );
}

describe("Codex desktop generation service", () => {
  afterEach(async () => {
    if (current) {
      await current.service.stop?.(current.context);
    }
    current = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes on acquisition when the stable root cannot be watched", async () => {
    const harness = createHarness("desktop-unwatched", Infinity);
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    harness.setFingerprint("updated-without-watcher");
    const next = waitForCodexDesktopGeneration();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toMatchObject({ fingerprint: "updated-without-watcher" });
    expect(watchPath).toHaveBeenCalledTimes(1);
  });

  it("keeps the stable parent watch and publishes a settled bundle replacement", async () => {
    const harness = createHarness("desktop-x");
    await startAndSettle(harness);
    harness.onGenerationChange.mockClear();
    harness.setFingerprint("desktop-y");
    harness.change("ChatGPT.app");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.watcher.close).not.toHaveBeenCalled();
    expect(watchPath).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.onGenerationChange).toHaveBeenCalledOnce());
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-y",
    });
  });

  it("ignores unrelated applications and refreshes on demand after a watcher error", async () => {
    const harness = createHarness("desktop-errors");
    await startAndSettle(harness);
    harness.change("Safari.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(watchPath).toHaveBeenCalledOnce();

    harness.watcher.emit("error", new Error("watch lost"));
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    harness.setFingerprint("desktop-after-watch-error");
    const next = waitForCodexDesktopGeneration();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toMatchObject({ fingerprint: "desktop-after-watch-error" });
    expect(harness.watcher.close).toHaveBeenCalledOnce();
    expect(watchPath).toHaveBeenCalledOnce();
  });

  it("does not publish a generation after service stop during settling", async () => {
    const harness = createHarness("desktop-stop");
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
      const harness = createHarness("desktop-closing");
      await startAndSettle(harness);
      harness.context.scheduler.beginClose();

      expect(() => {
        if (event === "change") {
          harness.change("ChatGPT.app");
        } else {
          harness.watcher.emit("error", new Error("watch lost during shutdown"));
        }
      }).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watchPath).toHaveBeenCalledTimes(1);
      expect(harness.readFingerprint).toHaveBeenCalledOnce();
    },
  );

  it("joins an admitted fingerprint read before service retirement completes", async () => {
    const harness = createHarness("desktop-in-flight");
    const read = createDeferred<string>();
    harness.readFingerprint.mockImplementationOnce(() => read.promise);
    await harness.service.start(harness.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.readFingerprint).toHaveBeenCalledOnce();

    const retired = vi.fn();
    const stopping = Promise.resolve(harness.service.stop?.(harness.context)).then(retired);
    try {
      await Promise.resolve();
      expect(retired).not.toHaveBeenCalled();
      expect(harness.watcher.close).toHaveBeenCalledOnce();
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
