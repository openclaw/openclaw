import { vi } from "vitest";

export function createMemoryWatcherTestFactories() {
  const chokidarKey = Symbol.for("openclaw.test.memoryWatchFactory");
  const nativeKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
  type ChokidarEvent = "add" | "change" | "unlink" | "unlinkDir" | "error" | "ready";
  type ChokidarCallback = (...args: unknown[]) => void;
  function createMockChokidarWatcher() {
    const handlers = new Map<ChokidarEvent, ChokidarCallback[]>();
    const onceHandlers = new Map<ChokidarEvent, ChokidarCallback[]>();
    const watcher = {
      watchedEntries: {} as Record<string, string[]>,
      on: vi.fn((event: ChokidarEvent, callback: ChokidarCallback) => {
        handlers.set(event, [...(handlers.get(event) ?? []), callback]);
        return watcher;
      }),
      once: vi.fn((event: ChokidarEvent, callback: ChokidarCallback) => {
        onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), callback]);
        return watcher;
      }),
      add: vi.fn((_path: string | string[]) => watcher),
      close: vi.fn(async () => undefined),
      getWatched: vi.fn(() => watcher.watchedEntries),
      emit: (event: ChokidarEvent, ...args: unknown[]) => {
        for (const callback of handlers.get(event) ?? []) {
          callback(...args);
        }
        const callbacks = onceHandlers.get(event) ?? [];
        onceHandlers.delete(event);
        for (const callback of callbacks) {
          callback(...args);
        }
      },
    };
    return watcher;
  }

  type NativeEvent = "error";
  type NativeCallback = (eventType: string, filename: string | null) => void | Promise<void>;
  type NativeErrorCallback = (err: Error) => void;
  function createMockNativeWatcher(
    dir: string,
    options: { recursive?: boolean },
    listener: NativeCallback,
  ) {
    const errorHandlers: NativeErrorCallback[] = [];
    const watcher = {
      dir,
      options,
      recursive: options.recursive === true,
      listener,
      on: vi.fn((event: NativeEvent, callback: NativeErrorCallback) => {
        if (event === "error") {
          errorHandlers.push(callback);
        }
        return watcher;
      }),
      close: vi.fn(() => undefined),
      emit: (eventType: string, filename: string | null) => {
        return listener(eventType, filename);
      },
      emitError: (err: Error) => {
        for (const handler of errorHandlers) {
          handler(err);
        }
      },
    };
    return watcher;
  }

  const chokidarWatchers: Array<ReturnType<typeof createMockChokidarWatcher>> = [];
  const nativeWatchers: Array<ReturnType<typeof createMockNativeWatcher>> = [];
  const failingDir = { current: null as string | null };

  const result = {
    createdChokidarWatchers: chokidarWatchers,
    createdNativeWatchers: nativeWatchers,
    memoryLoggerWarn: vi.fn(),
    watchMock: vi.fn(() => {
      const watcher = createMockChokidarWatcher();
      chokidarWatchers.push(watcher);
      return watcher;
    }),
    nativeWatchMock: vi.fn(
      (dir: string, options: { recursive?: boolean }, listener: NativeCallback) => {
        if (failingDir.current && dir === failingDir.current) {
          throw new Error("simulated native fs.watch creation failure");
        }
        const watcher = createMockNativeWatcher(dir, options, listener);
        nativeWatchers.push(watcher);
        return watcher;
      },
    ),
    nativeWatchMockFailingDir: failingDir,
  };
  (globalThis as Record<PropertyKey, unknown>)[chokidarKey] = result.watchMock;
  (globalThis as Record<PropertyKey, unknown>)[nativeKey] = result.nativeWatchMock;
  return result;
}

export async function advanceWatchSync(
  sync: { mockImplementationOnce: (callback: () => Promise<void>) => unknown },
  milliseconds = 1_500,
) {
  const observed = Promise.withResolvers<void>();
  sync.mockImplementationOnce(async () => observed.resolve());
  await vi.advanceTimersByTimeAsync(milliseconds);
  await observed.promise;
}
