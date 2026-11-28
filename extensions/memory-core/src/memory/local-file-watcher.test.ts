import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryFileWatcherOptions } from "./file-watcher.js";
import { LocalMemoryFileWatcher } from "./local-file-watcher.js";
import type {
  LocalWatchCommand,
  LocalWatchEvent,
  MemoryWatchFacts,
} from "./local-watch-protocol.js";

const transport = vi.hoisted(() => ({
  owner: {} as { transport?: unknown },
  createWorker: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-workspace-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/agent-workspace-runtime")>()),
  resolveWorkspaceWorkerUrl: () => new URL("file:///fixture/memory-worker.js"),
  resolveWorkspaceWorkerExecArgv: () => ["--import", "file:///fixture/loader.mjs"],
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>()),
  createSubsystemLogger: () => ({ warn: transport.warn }),
  resolveGlobalSingleton: () => transport.owner,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  createCpuTrackedWorker: transport.createWorker,
}));

class FakeWorker extends EventEmitter {
  commands: LocalWatchCommand[] = [];
  postMessage(command: LocalWatchCommand): void {
    this.commands.push(command);
  }
  terminate = vi.fn(async () => {
    this.emit("exit", 0);
    return 0;
  });
  receive(event: LocalWatchEvent): void {
    this.emit("message", event);
  }
  async flush(...events: LocalWatchEvent[]): Promise<void> {
    events.forEach((event) => this.receive(event));
    await yieldToEventLoop();
  }
}

const workers: FakeWorker[] = [];
const readyFacts: MemoryWatchFacts = {
  capacityDegraded: false,
  health: [
    {
      state: "ready",
      mode: "events",
      directories: 2,
      failure: undefined,
      pollingFallback: false,
      pollIntervalMs: 30_000,
    },
  ],
};

function watcher(options: Partial<MemoryFileWatcherOptions> = {}) {
  const callbacks = {
    onChange: vi.fn<() => void | Promise<void>>(),
    onDirty: vi.fn(),
    onUnavailable: vi.fn(),
    onState: vi.fn(),
  };
  const instance = new LocalMemoryFileWatcher({
    workspaceDir: "/fixture/workspace",
    agentId: "main",
    settings: {
      extraPaths: [],
      multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
      sync: { watchDebounceMs: 0 },
    },
    runInBackgroundContext: AsyncLocalStorage.snapshot(),
    ...callbacks,
    ...options,
  });
  return { instance, ...callbacks };
}

function track<T>(promise: Promise<T>) {
  const result = { settled: false, promise };
  result.promise = promise.finally(() => {
    result.settled = true;
  });
  void result.promise.catch(() => undefined);
  return result;
}

async function indexingWatcher() {
  const indexed = createDeferred<void>();
  const entered = createDeferred<void>();
  const onChange = vi.fn(async () => {
    entered.resolve();
    await indexed.promise;
  });
  const subject = watcher({ onChange });
  const worker = await start(subject.instance);
  worker.receive({ type: "change", id: 1 });
  await entered.promise;
  return { ...subject, worker, onChange, indexed };
}

async function sharedWatchers() {
  const first = watcher();
  const second = watcher();
  const worker = await start(first.instance);
  await start(second.instance, 2);
  return { first, second, worker };
}

async function replaceWatcher() {
  const { instance } = watcher();
  await close(instance, await start(instance));
}

function activeWorker(): FakeWorker {
  const worker = workers.at(-1);
  if (!worker) {
    throw new Error("Expected a started memory worker");
  }
  return worker;
}

async function start(instance: LocalMemoryFileWatcher, id = 1): Promise<FakeWorker> {
  const starting = instance.start();
  const worker = activeWorker();
  worker.receive({ type: "started", id, facts: readyFacts });
  await starting;
  return worker;
}

async function close(
  instance: LocalMemoryFileWatcher,
  worker: FakeWorker,
  id = 1,
  last = true,
): Promise<void> {
  const closing = instance.close();
  await yieldToEventLoop();
  expect(worker.commands).toContainEqual({ type: "close", id });
  worker.receive({ type: "closed", id });
  if (last) {
    await yieldToEventLoop();
    expect(worker.commands.at(-1)).toEqual({ type: "shutdown" });
    worker.emit("exit", 0);
  }
  await closing;
}

beforeEach(() => {
  transport.owner.transport = undefined;
  transport.warn.mockClear();
  transport.createWorker.mockReset().mockImplementation(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
});
afterEach(() => {
  vi.useRealTimers();
  for (const worker of workers.splice(0)) {
    worker.removeAllListeners();
  }
});

it("waits for readiness, publishes facts, and delivers dirty before settled in the owner's context", async () => {
  const context = new AsyncLocalStorage<string>();
  const events: string[] = [];
  const { instance } = context.run("owner", () =>
    watcher({
      onDirty: () => events.push(`dirty:${context.getStore()}`),
      onChange: () => {
        events.push(`change:${context.getStore()}`);
      },
    }),
  );
  const starting = track(instance.start());
  expect(transport.createWorker).toHaveBeenCalledExactlyOnceWith(
    new URL("file:///fixture/memory-worker.js"),
    { execArgv: ["--import", "file:///fixture/loader.mjs"], name: "memory-files" },
  );
  const worker = activeWorker();
  const facts = { ...readyFacts, capacityDegraded: true };
  await worker.flush({ type: "state", id: 1, facts });
  expect(starting.settled).toBe(false);
  expect(instance.health()).toEqual(facts.health);
  expect(instance.capacityDegraded).toBe(true);
  worker.receive({ type: "started", id: 1, facts });
  await starting.promise;
  context.run("transport", () => worker.receive({ type: "dirty", id: 1 }));
  expect(events).toEqual(["dirty:owner"]);
  context.run("transport", () => worker.receive({ type: "change", id: 1 }));
  await yieldToEventLoop();
  expect(events).toEqual(["dirty:owner", "change:owner"]);
  await close(instance, worker);
});

it("drops a queued settled notification when a newer dirty event arrives during indexing", async () => {
  const { instance, worker, onDirty, onChange, indexed } = await indexingWatcher();
  worker.receive({ type: "change", id: 1 });
  worker.receive({ type: "dirty", id: 1 });
  expect(onDirty).toHaveBeenCalledOnce();
  indexed.resolve();
  await yieldToEventLoop();
  expect(onChange).toHaveBeenCalledOnce();
  await worker.flush({ type: "change", id: 1 });
  expect(onChange).toHaveBeenCalledTimes(2);
  await close(instance, worker);
});

it("shares one worker across instances, keeps peers live, and joins final exit before replacement", async () => {
  const { first, second, worker } = await sharedWatchers();
  expect(transport.createWorker).toHaveBeenCalledOnce();
  await close(first.instance, worker, 1, false);
  worker.receive({ type: "dirty", id: 1 });
  worker.receive({ type: "dirty", id: 2 });
  expect(first.onDirty).not.toHaveBeenCalled();
  expect(second.onDirty).toHaveBeenCalledOnce();
  const closing = track(second.instance.close());
  await yieldToEventLoop();
  await worker.flush({ type: "closed", id: 2 });
  expect(worker.commands.at(-1)).toEqual({ type: "shutdown" });
  const replacement = watcher();
  const starting = replacement.instance.start();
  await yieldToEventLoop();
  expect(closing.settled).toBe(false);
  expect(transport.createWorker).toHaveBeenCalledOnce();
  worker.emit("exit", 0);
  await closing.promise;
  await yieldToEventLoop();
  expect(transport.createWorker).toHaveBeenCalledTimes(2);
  const nextWorker = activeWorker();
  nextWorker.receive({ type: "started", id: 1, facts: readyFacts });
  await starting;
  await close(replacement.instance, nextWorker);
});

it("cancels pending startup without requiring readiness and ignores late notifications", async () => {
  const { instance, onDirty, onChange } = watcher();
  const starting = instance.start();
  const worker = activeWorker();
  const closing = instance.close();
  expect(instance.close()).toBe(closing);
  await yieldToEventLoop();
  expect(worker.commands.at(-1)).toEqual({ type: "close", id: 1 });
  worker.receive({ type: "dirty", id: 1 });
  worker.receive({ type: "change", id: 1 });
  worker.receive({ type: "closed", id: 1 });
  await starting;
  await yieldToEventLoop();
  expect(worker.commands.at(-1)).toEqual({ type: "shutdown" });
  expect([onDirty.mock.calls, onChange.mock.calls]).toEqual([[], []]);
  worker.emit("exit", 0);
  await closing;
});

it("rejects startup failure, joins successful cleanup, then permits a new worker", async () => {
  const { instance } = watcher();
  const starting = expect(instance.start()).rejects.toThrow("workspace discovery failed");
  const worker = activeWorker();
  worker.receive({ type: "closed", id: 1, error: "workspace discovery failed" });
  await starting;
  const closing = track(instance.close());
  await yieldToEventLoop();
  expect(worker.commands.at(-1)).toEqual({ type: "shutdown" });
  expect(closing.settled).toBe(false);
  worker.emit("exit", 0);
  await expect(closing.promise).rejects.toMatchObject({ message: "workspace discovery failed" });
  await replaceWatcher();
  expect(transport.createWorker).toHaveBeenCalledTimes(2);
});

it("restores live subscriptions after exit and stops after repeated failures within a minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { first, second, worker } = await sharedWatchers();
  worker.emit("error", new Error("worker crashed"));
  worker.emit("exit", 1);
  expect(first.instance.health()).toMatchObject([{ state: "unavailable" }]);
  expect(first.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({ capacityDegraded: true }),
  );
  expect(second.onUnavailable).toHaveBeenCalledOnce();
  await first.instance.close();
  await vi.advanceTimersByTimeAsync(500);
  const recovered = activeWorker();
  expect(recovered.commands).toHaveLength(1);
  expect(recovered.commands[0]).toMatchObject({ type: "open", id: 2 });
  await recovered.flush({ type: "started", id: 2, facts: readyFacts }, { type: "change", id: 2 });
  expect(second.onChange).toHaveBeenCalledOnce();
  expect(second.instance.capacityDegraded).toBe(false);
  for (const delay of [2_000, 5_000]) {
    activeWorker().emit("exit", 1);
    await vi.advanceTimersByTimeAsync(delay);
    activeWorker().receive({ type: "started", id: 2, facts: readyFacts });
  }
  activeWorker().emit("exit", 1);
  expect(second.instance.health()).toMatchObject([
    {
      state: "unavailable",
      failure: {
        code: "worker-unavailable",
        error: expect.stringContaining("repeated failures"),
      },
    },
  ]);
  expect(transport.warn).toHaveBeenLastCalledWith(expect.stringContaining("restart the Gateway"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(transport.createWorker).toHaveBeenCalledTimes(4);
  const joining = watcher();
  await expect(joining.instance.start()).rejects.toThrow("repeated failures");
  expect(joining.instance.health()).toMatchObject([{ state: "unavailable" }]);
  await joining.instance.close();
  await second.instance.close();
});

it("retries failed startup, expires old crashes, and cancels recovery on final close", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  transport.createWorker.mockImplementationOnce(() => {
    throw new Error("worker could not load");
  });
  const { instance } = watcher();
  const starting = instance.start();
  expect(instance.health()).toMatchObject([{ state: "unavailable" }]);
  await vi.advanceTimersByTimeAsync(500);
  activeWorker().receive({ type: "started", id: 1, facts: readyFacts });
  await starting;
  await vi.advanceTimersByTimeAsync(60_000);
  activeWorker().emit("exit", 1);
  await vi.advanceTimersByTimeAsync(500);
  expect(transport.createWorker).toHaveBeenCalledTimes(3);
  activeWorker().emit("exit", 1);
  await instance.close();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(transport.createWorker).toHaveBeenCalledTimes(3);
  await replaceWatcher();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(transport.createWorker).toHaveBeenCalledTimes(4);
});

it("joins a shared worker failure for subscriptions closing before and after the failure", async () => {
  const { first, second, worker } = await sharedWatchers();
  const firstClose = track(first.instance.close());
  await yieldToEventLoop();
  worker.emit("error", new Error("shared worker failed"));
  const secondClose = track(second.instance.close());
  await yieldToEventLoop();
  expect([firstClose.settled, secondClose.settled]).toEqual([false, false]);
  worker.emit("exit", 1);
  await expect(firstClose.promise).rejects.toMatchObject({ message: "shared worker failed" });
  await expect(secondClose.promise).rejects.toMatchObject({ message: "shared worker failed" });
});

it("joins accepted indexing as well as worker exit when the live worker fails", async () => {
  const { instance, worker, onDirty, onUnavailable, indexed } = await indexingWatcher();
  worker.emit("error", new Error("watch transport failed"));
  const closing = track(instance.close());
  worker.emit("exit", 1);
  await yieldToEventLoop();
  expect(closing.settled).toBe(false);
  expect([onDirty.mock.calls, onUnavailable.mock.calls]).toEqual([[], []]);
  indexed.resolve();
  await closing.promise;
});

it("terminates after failed native cleanup, joins exit, and keeps the cleanup failure sticky", async () => {
  const { instance } = watcher();
  const worker = await start(instance);
  const exiting = createDeferred<void>();
  worker.terminate.mockImplementationOnce(async () => {
    await exiting.promise;
    worker.emit("exit", 0);
    return 0;
  });
  const closing = track(instance.close());
  await yieldToEventLoop();
  await worker.flush({ type: "closed", id: 1, error: "native close failed" });
  expect(worker.commands.at(-1)).toEqual({ type: "shutdown" });
  worker.receive({ type: "shutdown", error: "native close failed" });
  expect(worker.terminate).toHaveBeenCalledOnce();
  await yieldToEventLoop();
  expect(closing.settled).toBe(false);
  const replacement = watcher();
  const starting = expect(replacement.instance.start()).rejects.toThrow("native close failed");
  exiting.resolve();
  await expect(closing.promise).rejects.toMatchObject({ message: "native close failed" });
  await starting;
  await expect(instance.close()).rejects.toThrow("native close failed");
  expect(transport.createWorker).toHaveBeenCalledOnce();
});
