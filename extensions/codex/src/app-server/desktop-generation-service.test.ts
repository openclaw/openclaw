import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

const mocks = vi.hoisted(() => ({
  watch:
    vi.fn<
      (
        path: string,
        options: { recursive: boolean },
        listener: (event: string, file: string | null) => void,
      ) => FSWatcher
    >(),
  read: vi.fn<() => Promise<string>>(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: mocks.watch,
}));
// mock-isolation: use controlled generations without inspecting the installed macOS application.
vi.mock("./desktop-generation-fingerprint.js", () => ({
  readMacOSDesktopGenerationFingerprint: mocks.read,
}));

class TestWatcher extends EventEmitter implements FSWatcher {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

let fingerprint: string;
let watcher: TestWatcher;
let context: OpenClawPluginServiceContextV2;
let service: ReturnType<typeof createCodexDesktopGenerationService>;
let stopped: boolean;
const changed = vi.fn();
const reportFailure = vi.fn();
const warn = vi.fn();
const change = (file: string) => mocks.watch.mock.calls[0]![2]("rename", file);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fingerprint = "before";
  stopped = false;
  watcher = new TestWatcher();
  mocks.read.mockReset().mockImplementation(async () => fingerprint);
  mocks.watch.mockReset().mockImplementation(() => watcher);
  context = {
    config: {},
    stateDir: "/unused",
    scheduler: createTestPluginServiceScheduler(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    serviceHealth: { clearFailure: vi.fn(), reportFailure },
  };
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  service = createCodexDesktopGenerationService({ onGenerationChange: changed });
  platform.mockRestore();
});
async function stop() {
  await service.stop?.(context);
  stopped = true;
}
afterEach(async () => {
  if (!stopped) {
    await stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function start() {
  await service.start(context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.read).toHaveBeenCalledOnce();
}
async function acquire(fingerprintAfter: string) {
  fingerprint = fingerprintAfter;
  const pending = waitForCodexDesktopGeneration();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toMatchObject({ fingerprint: fingerprintAfter });
}

it("refreshes on acquisition when the stable root cannot be watched", async () => {
  mocks.watch.mockImplementation(() => {
    throw new Error("watch registration unavailable");
  });
  await service.start(context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reportFailure).toHaveBeenCalledOnce();
  await acquire("updated-without-watcher");
});

it("keeps the stable parent watch and publishes a settled bundle replacement", async () => {
  await start();
  expect(mocks.watch).toHaveBeenCalledWith(
    "/Applications",
    { recursive: false },
    expect.any(Function),
  );
  changed.mockClear();
  fingerprint = "desktop-y";
  change("ChatGPT.app");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(watcher.close).not.toHaveBeenCalled();
  expect(mocks.watch).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalledWith({ epoch: expect.any(Number), fingerprint });
});

it("ignores unrelated applications and refreshes on demand after a watcher error", async () => {
  await start();
  change("Safari.app");
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.watch).toHaveBeenCalledOnce();
  watcher.emit("error", new Error("watch lost"));
  expect(reportFailure).toHaveBeenCalledOnce();
  await acquire("desktop-after-watch-error");
  expect(watcher.close).toHaveBeenCalledOnce();
});

it("does not publish a generation after service stop during settling", async () => {
  await service.start(context);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
  fingerprint = "desktop-after-stop";
  await vi.advanceTimersByTimeAsync(1_000);
  expect(changed).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});

it.each(["change", "error"])(
  "ignores watcher %s callbacks after scheduler admission closes",
  async (event) => {
    await start();
    context.scheduler.beginClose();
    expect(() =>
      event === "change"
        ? change("ChatGPT.app")
        : watcher.emit("error", new Error("watch lost during shutdown")),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.watch).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledOnce();
  },
);

it("joins an admitted fingerprint read before service retirement completes", async () => {
  const read = createDeferred<string>();
  mocks.read.mockImplementationOnce(() => read.promise);
  await service.start(context);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.read).toHaveBeenCalledOnce();
  const retired = vi.fn();
  const stopping = stop().then(retired);
  try {
    await Promise.resolve();
    expect(retired).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledOnce();
  } finally {
    read.resolve("desktop-after-stop");
    await stopping;
  }
  expect(retired).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});
