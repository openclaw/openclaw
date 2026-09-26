import { PassThrough, Writable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import { MemoryWatchPolicy } from "../memory/watch-policy.js";
import { serveMemoryFiles } from "./memory-files-worker.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("../memory/watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watch }));
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const request =
  JSON.stringify({
    agentId: "main",
    settings: {
      extraPaths: [],
      multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
      sync: { watchDebounceMs: 10 },
    },
  }) + "\n";
beforeEach(async () => {
  observer.reset();
  state = await createOpenClawTestState({ label: "memory-files-watch" });
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await state.cleanup();
});

it("streams settled host notifications and joins observation when its input closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let events = "";
  output.on("data", (data: Buffer) => {
    events += data.toString("utf8");
  });
  const ready = createDeferred<void>();
  observer.created = () => ready.resolve();
  const worker = serveMemoryFiles({ workspace: state.workspaceDir, input, output, watch: true });
  try {
    input.write(request);
    await ready.promise;
    observer.observations[0]!.dirty();
    expect(events).toBe("");
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toBe('"change"\n');
    input.end();
    await worker;
    expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
    observer.observations[0]!.dirty();
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toBe('"change"\n');
  } finally {
    input.end();
    await worker;
    output.destroy();
  }
});

it("revokes remote admission while startup is awaiting filesystem discovery", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  const closing = createDeferred<void>();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted owner.
  const original = MemoryWatchPolicy.prototype.observations;
  let admissionSignal: AbortSignal | undefined;
  vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementation(async function (
    this: MemoryWatchPolicy,
    signal,
  ) {
    const groups = await original.call(this, signal);
    admissionSignal = signal;
    entered.resolve();
    await resume.promise;
    return groups;
  });
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted owner.
  const originalClose = MemoryFileWatcher.prototype.close;
  vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
    this: MemoryFileWatcher,
  ) {
    closing.resolve();
    return originalClose.call(this);
  });
  const worker = serveMemoryFiles({ workspace: state.workspaceDir, input, output, watch: true });
  try {
    input.write(request);
    await entered.promise;
    input.end();
    await closing.promise;
    expect(admissionSignal?.aborted).toBe(true);
    let joined = false;
    void worker.then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    resume.resolve();
    await worker;
    expect(observer.watch).not.toHaveBeenCalled();
    expect(output.read()).toBeNull();
  } finally {
    resume.resolve();
    input.end();
    await worker;
    output.destroy();
  }
});

it.each(["input end", "output error"] as const)(
  "joins observation and backpressured stdout after %s",
  async (ending) => {
    const input = new PassThrough();
    const ready = createDeferred<void>();
    const written = createDeferred<void>();
    const physical = createDeferred<void>();
    const retired = createDeferred<void>();
    const closing = createDeferred<void>();
    observer.created = () => ready.resolve();
    observer.closeBarrier = physical.promise;
    let blocked = true;
    const callbacks: Array<(error?: Error | null) => void> = [];
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        written.resolve();
        if (blocked) {
          callbacks.push(callback);
        } else {
          callback();
        }
      },
    });
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted owner.
    const originalClose = MemoryFileWatcher.prototype.close;
    vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
      this: MemoryFileWatcher,
    ) {
      closing.resolve();
      const pending = originalClose.call(this);
      void pending.then(retired.resolve, retired.reject);
      return pending;
    });
    const worker = serveMemoryFiles({ workspace: state.workspaceDir, input, output, watch: true });
    let finished = false;
    void worker.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      input.write(request);
      await ready.promise;
      observer.observations[0]!.dirty();
      await vi.advanceTimersByTimeAsync(10);
      await written.promise;
      expect(output.writableNeedDrain).toBe(true);
      const failure = new Error("Memory stdout failed");
      if (ending === "output error") {
        output.destroy(failure);
      } else {
        input.end();
      }
      await closing.promise;
      expect(finished).toBe(false);
      physical.resolve();
      await retired.promise;
      if (ending === "input end") {
        expect(finished).toBe(false);
        blocked = false;
        callbacks.splice(0).forEach((callback) => callback());
        await worker;
        expect(output.writableLength).toBe(0);
      } else {
        await expect(worker).rejects.toMatchObject({ errors: [failure] });
      }
      expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
    } finally {
      physical.resolve();
      blocked = false;
      callbacks.splice(0).forEach((callback) => callback());
      input.end();
      await worker.catch(() => {});
      output.destroy();
    }
  },
);
