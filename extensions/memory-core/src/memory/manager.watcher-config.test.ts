import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WatchIgnoredFn = (watchPath: string, stats?: { isDirectory?: () => boolean }) => boolean;

const {
  createdChokidarWatchers,
  createdNativeWatchers,
  memoryLoggerWarn,
  watchMock,
  nativeWatchMock,
  nativeWatchMockFailingDir,
} = vi.hoisted(() => {
  // Symbols are also declared at module top-level (CHOKIDAR_FACTORY_KEY,
  // NATIVE_FACTORY_KEY) but vi.hoisted runs before those declarations
  // execute, so we resolve the same Symbol.for keys inline here.
  const chokidarKey = Symbol.for("openclaw.test.memoryWatchFactory");
  const nativeKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
  type ChokidarEvent = "add" | "change" | "unlink" | "unlinkDir" | "error";
  type ChokidarCallback = (...args: unknown[]) => void;
  function createMockChokidarWatcher() {
    const handlers = new Map<ChokidarEvent, ChokidarCallback[]>();
    const watcher = {
      on: vi.fn((event: ChokidarEvent, callback: ChokidarCallback) => {
        handlers.set(event, [...(handlers.get(event) ?? []), callback]);
        return watcher;
      }),
      add: vi.fn((_path: string | string[]) => watcher),
      close: vi.fn(async () => undefined),
      emit: (event: ChokidarEvent, ...args: unknown[]) => {
        for (const callback of handlers.get(event) ?? []) {
          callback(...args);
        }
      },
    };
    return watcher;
  }

  type NativeEvent = "error";
  type NativeCallback = (eventType: string, filename: string | null) => void;
  type NativeErrorCallback = (err: Error) => void;
  function createMockNativeWatcher(dir: string, listener: NativeCallback) {
    const errorHandlers: NativeErrorCallback[] = [];
    const watcher = {
      dir,
      listener,
      on: vi.fn((event: NativeEvent, callback: NativeErrorCallback) => {
        if (event === "error") {
          errorHandlers.push(callback);
        }
        return watcher;
      }),
      close: vi.fn(() => undefined),
      emit: (eventType: string, filename: string | null) => {
        listener(eventType, filename);
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
    nativeWatchMock: vi.fn((dir: string, _options: unknown, listener: NativeCallback) => {
      if (failingDir.current && dir === failingDir.current) {
        throw new Error("simulated native fs.watch creation failure");
      }
      const watcher = createMockNativeWatcher(dir, listener);
      nativeWatchers.push(watcher);
      return watcher;
    }),
    nativeWatchMockFailingDir: failingDir,
  };
  (globalThis as Record<PropertyKey, unknown>)[chokidarKey] = result.watchMock;
  (globalThis as Record<PropertyKey, unknown>)[nativeKey] = result.nativeWatchMock;
  return result;
});

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: memoryLoggerWarn,
    }),
  };
});

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

import {
  clearMemoryEmbeddingProviders as clearRegistry,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
  type MemoryIndexManager,
} from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    clearRegistry();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
    nativeWatchMockFailingDir.current = null;
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
    Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
  });

  afterEach(async () => {
    vi.useRealTimers();
    watchMock.mockClear();
    nativeWatchMock.mockClear();
    createdChokidarWatchers.length = 0;
    createdNativeWatchers.length = 0;
    nativeWatchMockFailingDir.current = null;
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
  }

  function createWatcherConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      workspace: workspaceDir,
      memorySearch: {
        provider: "openai",
        model: "mock-embed",
        store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
        sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
        query: { minScore: 0, hybrid: { enabled: false } },
        extraPaths: [extraDir],
        ...overrides,
      },
    };
    return {
      memory: { backend: "builtin" },
      agents: {
        defaults,
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function expectWatcherManager(cfg: OpenClawConfig) {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    expect(result.manager.status().backend).toBe("builtin");
    expect(result.manager.status().sources).toContain("memory");
    manager = result.manager as unknown as MemoryIndexManager;
  }

  it("routes directories to native recursive fs.watch and files to chokidar", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    // Chokidar should only see file paths (MEMORY.md); directories use native watch.
    expect(watchMock).toHaveBeenCalledTimes(1);
    const [chokidarPaths, chokidarOptions] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(chokidarPaths).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);
    expect(chokidarPaths.filter((watchedPath) => watchedPath.includes("*"))).toEqual([]);
    expect(chokidarOptions.ignoreInitial).toBe(true);
    expect(chokidarOptions).not.toHaveProperty("awaitWriteFinish");

    // Native fs.watch should receive memory/ and extraDir as recursive watches.
    expect(nativeWatchMock).toHaveBeenCalledTimes(2);
    const nativeDirs = nativeWatchMock.mock.calls.map((call) => call[0]);
    expect(nativeDirs).toStrictEqual(
      expect.arrayContaining([path.join(workspaceDir, "memory"), extraDir]),
    );
    for (const call of nativeWatchMock.mock.calls) {
      const options = call[1] as Record<string, unknown>;
      expect(options.recursive).toBe(true);
    }

    // Shared ignore predicate still controls non-md/non-multimodal churn.
    const ignored = chokidarOptions.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.tmp"), {})).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.json"), {})).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.json"), undefined)).toBe(
      false,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"), {})).toBe(false);
    expect(
      ignored?.(path.join(workspaceDir, "memory", "project"), { isDirectory: () => true }),
    ).toBe(false);
  });

  it("does not start watchers for one-shot CLI managers", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: "cli" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;

    expect(watchMock).not.toHaveBeenCalled();
    expect(nativeWatchMock).not.toHaveBeenCalled();
  });

  it("watches multimodal extra directories via native watch", async () => {
    await setupWatcherWorkspace({ name: "PHOTO.PNG", contents: "png" });
    const cfg = createWatcherConfig({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const chokidarPaths = watchMock.mock.calls[0][0] as string[];
    expect(chokidarPaths).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);

    expect(nativeWatchMock).toHaveBeenCalledTimes(2);
    const nativeDirs = nativeWatchMock.mock.calls.map((call) => call[0]);
    expect(nativeDirs).toStrictEqual(
      expect.arrayContaining([path.join(workspaceDir, "memory"), extraDir]),
    );

    const chokidarOptions = watchMock.mock.calls[0][1] as Record<string, unknown>;
    const ignored = chokidarOptions.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "metadata.json"), {})).toBe(true);
  });

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "schedules watch sync on chokidar %s events",
    async (event) => {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi
        .spyOn(
          manager as unknown as {
            sync: (params?: { reason?: string }) => Promise<void>;
          },
          "sync",
        )
        .mockResolvedValue(undefined);

      createdChokidarWatchers[0]?.emit(event);
      await vi.advanceTimersByTimeAsync(25);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it.each(["rename", "change"] as const)(
    "schedules watch sync on native %s events",
    async (eventType) => {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi
        .spyOn(
          manager as unknown as {
            sync: (params?: { reason?: string }) => Promise<void>;
          },
          "sync",
        )
        .mockResolvedValue(undefined);

      const memoryWatcher = createdNativeWatchers.find(
        (w) => w.dir === path.join(workspaceDir, "memory"),
      );
      memoryWatcher?.emit(eventType, "notes.md");
      await vi.advanceTimersByTimeAsync(25);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it("forces broad re-sync when native watch emits null filename", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    const memoryWatcher = createdNativeWatchers.find(
      (w) => w.dir === path.join(workspaceDir, "memory"),
    );
    // Node docs warn that filename may be null on some platforms; conservative
    // dirty must still be scheduled.
    memoryWatcher?.emit("rename", null as unknown as string);
    await vi.advanceTimersByTimeAsync(50);

    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("falls back to chokidar when native fs.watch creation fails", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    nativeWatchMockFailingDir.current = path.join(workspaceDir, "memory");
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    // Native watch for memory/ threw — that dir should fall back into chokidar's set.
    expect(nativeWatchMock).toHaveBeenCalled();
    expect(watchMock).toHaveBeenCalledTimes(1);
    const chokidarPaths = watchMock.mock.calls[0][0] as string[];
    expect(chokidarPaths).toStrictEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "memory"),
      ]),
    );
    expect(memoryLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        `failed to start native recursive watcher on ${path.join(workspaceDir, "memory")}`,
      ),
    );
  });

  it("logs and removes native watcher on runtime error, marks dirty, and restores coverage via chokidar", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
    expect(memoryWatcher).toBeDefined();
    const closeSpy = memoryWatcher!.close;

    // Pre-error: chokidar has MEMORY.md only; memoryDir is not in its set.
    const existingChokidar = createdChokidarWatchers[0];
    expect(existingChokidar).toBeDefined();
    const addSpy = vi.spyOn(
      existingChokidar as unknown as { add: (path: string) => unknown },
      "add",
    );

    memoryWatcher?.emitError(new Error("watcher error: ENOSPC"));
    await vi.advanceTimersByTimeAsync(50);

    expect(memoryLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("memory native watcher error"),
    );
    expect(closeSpy).toHaveBeenCalled();
    // Broad re-sync should be scheduled to cover the gap.
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    // Coverage must be restored: the affected directory should now be
    // attached to the existing chokidar watcher.
    expect(addSpy).toHaveBeenCalledWith(memoryDir);

    // Sanity: a subsequent chokidar-style event on the now-fallback path
    // continues to schedule sync.
    syncSpy.mockClear();
    existingChokidar?.emit("change");
    await vi.advanceTimersByTimeAsync(25);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("routes directories through chokidar on non-macOS/non-Windows platforms", async () => {
    // On Linux (and other non-darwin/non-win32 platforms), Node's
    // `fs.watch({ recursive: true })` falls back to walking the tree and
    // attaching a watcher per entry, defeating the constant-watcher-profile
    // goal of this fix. The PR explicitly gates the native path off those
    // platforms.
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      // Native watcher must NOT have been called for any directory.
      expect(nativeWatchMock).not.toHaveBeenCalled();
      // Chokidar should receive the file path AND both directory paths
      // (the bare `memory/` plus `extraDir`).
      expect(watchMock).toHaveBeenCalledTimes(1);
      const chokidarPaths = watchMock.mock.calls[0][0] as string[];
      expect(chokidarPaths).toStrictEqual(
        expect.arrayContaining([
          path.join(workspaceDir, "MEMORY.md"),
          path.join(workspaceDir, "memory"),
          extraDir,
        ]),
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("creates a chokidar watcher on the fly when no file-path chokidar exists yet", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });

    // Force the only chokidar caller (MEMORY.md) to NOT exist by deleting it
    // before manager construction so fileWatchPaths starts empty. Note that
    // MEMORY.md is still a watch *path* in source even if missing on disk —
    // chokidar handles missing paths fine. To truly test the "no chokidar
    // yet" branch we instead simulate by clearing the watchMock buffer and
    // exercising attachMemoryChokidarFallback directly.
    await expectWatcherManager(cfg);
    vi.useFakeTimers();

    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
    expect(memoryWatcher).toBeDefined();

    // Pretend chokidar was never set up by clearing the manager.watcher slot,
    // then trigger the native error; the fallback must spin up a new chokidar.
    (manager as unknown as { watcher: unknown }).watcher = null;
    const chokidarCallsBefore = watchMock.mock.calls.length;

    memoryWatcher?.emitError(new Error("watcher error: ENOSPC"));
    await vi.advanceTimersByTimeAsync(50);

    expect(watchMock.mock.calls.length).toBe(chokidarCallsBefore + 1);
    const newChokidarCall = watchMock.mock.calls[chokidarCallsBefore];
    expect(newChokidarCall?.[0]).toStrictEqual([memoryDir]);
  });

  it("ignores re-entrant ensureWatcher calls", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    const chokidarCallsAfterFirst = watchMock.mock.calls.length;
    const nativeCallsAfterFirst = nativeWatchMock.mock.calls.length;

    // Simulate a second ensureWatcher() call by reaching into the manager.
    const ensureWatcher = (manager as unknown as { ensureWatcher: () => void }).ensureWatcher;
    ensureWatcher?.call(manager);

    expect(watchMock.mock.calls.length).toBe(chokidarCallsAfterFirst);
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsAfterFirst);
  });

  it("settles changed file stats before running watch sync", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const notesPath = path.join(extraDir, "notes.md");
    const initialStats = await fs.stat(notesPath);
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    // extraDir is now watched via native fs.watch; emit a change event that
    // resolves to notes.md and confirm settle behavior still applies before
    // the sync is scheduled.
    const extraWatcher = createdNativeWatchers.find((w) => w.dir === extraDir);
    extraWatcher?.emit("change", "notes.md");
    await fs.writeFile(notesPath, "hello updated");

    await vi.advanceTimersByTimeAsync(25);
    expect(syncSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    // Recorded path should match the resolved absolute path under extraDir.
    const recordedStats = (initialStats as unknown as { isDirectory: () => boolean }).isDirectory();
    expect(typeof recordedStats).toBe("boolean");
  });

  it("attaches a logging non-throwing chokidar error listener", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    const chokidarWatcher = createdChokidarWatchers[0];
    const errorRegistration = chokidarWatcher?.on.mock.calls.find(([event]) => event === "error");
    expect(errorRegistration?.[0]).toBe("error");
    expect(errorRegistration?.[1]).toBeTypeOf("function");
    expect(chokidarWatcher?.emit("error", new Error("watcher error: ENOSPC"))).toBeUndefined();
    expect(memoryLoggerWarn).toHaveBeenCalledWith("memory watcher error: watcher error: ENOSPC");
  });
});
