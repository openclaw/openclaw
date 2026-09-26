import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveMemorySearchConfig,
  type MemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";
import { advanceWatchSync } from "./watcher-test-support.js";

const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;
const { createdChokidarWatchers, createdNativeWatchers, watchMock } = await vi.hoisted(async () => {
  const { createMemoryWatcherTestFactories } = await import("./watcher-test-support.js");
  return createMemoryWatcherTestFactories();
});

describe("memory file watcher lifecycle", () => {
  let workspaceDir = "";
  let extraDir = "";
  let originalPlatform: NodeJS.Platform;
  const helperWatchers: MemoryFileWatcher[] = [];

  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    await Promise.all(helperWatchers.splice(0).map((watcher) => watcher.close()));
    createdChokidarWatchers.length = 0;
    createdNativeWatchers.length = 0;
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.test.memoryWatchFactory"));
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.test.memoryNativeWatchFactory"));
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-lifecycle-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.mkdir(extraDir);
    await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
  }

  function createWatcherConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    return {
      plugins: { enabled: false },
      memory: {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          query: { minScore: 0 },
          extraPaths: [extraDir],
          ...overrides,
        },
      },
      agents: { entries: { main: { workspace: workspaceDir } } },
    };
  }

  async function startDirectWatcher() {
    const sync = vi.fn();
    const fileWatcher = new MemoryFileWatcher({
      workspaceDir,
      agentId: "main",
      settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
      onChange: sync,
      onUnavailable: vi.fn(),
    });
    helperWatchers.push(fileWatcher);
    await fileWatcher.start();
    return { fileWatcher, sync };
  }

  async function setupParentWatchLifecycle(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const { sync } = await startDirectWatcher();
    const dir = path.join(workspaceDir, "memory");
    const main = createdNativeWatchers.find((watcher) => watcher.dir === dir);
    const parent = createdNativeWatchers.find((watcher) => watcher.dir === workspaceDir);
    if (!main || !parent) {
      throw new Error("expected a main and parent memory watcher");
    }
    vi.useFakeTimers();
    return { dir, main, parent, sync };
  }

  it("uses native Memory coverage and settling without creating an index manager", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const settings = resolveMemorySearchConfig(createWatcherConfig(), "main");
    if (!settings) {
      throw new Error("memory settings missing");
    }
    const onChange = vi.fn();
    const onDirty = vi.fn();
    const onUnavailable = vi.fn();
    const fileWatcher = new MemoryFileWatcher({
      workspaceDir,
      agentId: "main",
      settings,
      onChange,
      onDirty,
      onUnavailable,
    });
    vi.useFakeTimers();
    try {
      await fileWatcher.start();
      const extraWatcher = createdNativeWatchers.find((entry) => entry.dir === extraDir);
      if (!extraWatcher) {
        throw new Error("extra-path watcher missing");
      }
      await extraWatcher.emit("change", "notes.md");
      expect(onDirty).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
      await advanceWatchSync(onChange, settings.sync.watchDebounceMs);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onUnavailable).not.toHaveBeenCalled();
      await fileWatcher.close();
      expect(createdNativeWatchers.every((entry) => entry.close.mock.calls.length > 0)).toBe(true);
      await extraWatcher.emit("change", "notes.md");
      await vi.advanceTimersByTimeAsync(settings.sync.watchDebounceMs);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await fileWatcher.close();
    }
  });

  it.each(["darwin", "linux"] as const)(
    "covers root replacement during %s parent admission",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const root = path.join(workspaceDir, "memory");
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = fs.stat.bind(fs);
      let pendingParent = true;
      const probe = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          const result = await original(...args);
          if (String(args[0]) === workspaceDir && pendingParent) {
            pendingParent = false;
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
      const onChange = vi.fn();
      const fileWatcher = new MemoryFileWatcher({
        workspaceDir,
        agentId: "main",
        settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
        onChange,
        onUnavailable: vi.fn(),
      });
      vi.useFakeTimers();
      const starting = fileWatcher.start();
      try {
        await entered.promise;
        await fs.rename(root, path.join(workspaceDir, "previous-memory"));
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, "fresh.md"), "fresh");
        resume.resolve();
        await starting;
        const roots = createdNativeWatchers.filter((watcher) => watcher.dir === root);
        expect(roots).toHaveLength(2);
        expect(roots[0]?.close).toHaveBeenCalledOnce();
        expect(roots[1]?.close).not.toHaveBeenCalled();
        await roots[1]!.emit("change", "fresh.md");
        await advanceWatchSync(onChange);
        expect(onChange).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await fileWatcher.close();
        probe.mockRestore();
      }
    },
  );

  it("schedules retained facts once after slow indexing instead of polling a zero debounce", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const onChange = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
    });
    const settings = resolveMemorySearchConfig(createWatcherConfig(), "main")!;
    const fileWatcher = new MemoryFileWatcher({
      workspaceDir,
      agentId: "main",
      settings: { ...settings, sync: { watchDebounceMs: 0 } },
      onChange,
      onUnavailable: vi.fn(),
    });
    await fileWatcher.start();
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const extra = createdNativeWatchers.find((watcher) => watcher.dir === extraDir)!;
      await extra.emit("change", "notes.md");
      await vi.advanceTimersByTimeAsync(0);
      await entered.promise;
      timer.mockClear();
      await extra.emit("change", "notes.md");
      await vi.advanceTimersByTimeAsync(50);
      expect(timer.mock.calls.filter(([, milliseconds]) => milliseconds === 0)).toHaveLength(1);
      expect(onChange).toHaveBeenCalledOnce();
      resume.resolve();
      await Reflect.get(fileWatcher, "settling");
      await advanceWatchSync(onChange, 0);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      resume.resolve();
      await fileWatcher.close();
      timer.mockRestore();
    }
  });

  it.each([
    { platform: "darwin", code: "ENOSPC" },
    { platform: "linux", code: "EMFILE" },
  ] as const)(
    "revokes pending $platform startup probes after $code exhausts watcher capacity",
    async ({ platform, code }) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = fs.stat.bind(fs);
      const stat = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          const result = await original(...args);
          if (String(args[0]) === extraDir) {
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
      const onChange = vi.fn();
      const onDirty = vi.fn();
      const onUnavailable = vi.fn();
      const fileWatcher = new MemoryFileWatcher({
        workspaceDir,
        agentId: "main",
        settings: resolveMemorySearchConfig(createWatcherConfig(), "main")!,
        onChange,
        onDirty,
        onUnavailable,
      });
      vi.useFakeTimers();
      const starting = fileWatcher.start();
      try {
        await entered.promise;
        const first = createdNativeWatchers.find(
          (watcher) => watcher.dir === path.join(workspaceDir, "memory"),
        );
        expect(first).toBeDefined();
        const admitted = createdNativeWatchers.slice();
        first!.emitError(
          Object.assign(new Error("watch capacity exhausted"), { code, syscall: "watch" }),
        );
        expect(fileWatcher.capacityDegraded).toBe(true);
        expect(onUnavailable).toHaveBeenCalledOnce();
        expect(onDirty).toHaveBeenCalledOnce();
        resume.resolve();
        await starting;
        expect(createdNativeWatchers).toHaveLength(admitted.length);
        for (const watcher of admitted) {
          expect(watcher.close).toHaveBeenCalledOnce();
        }
        expect(watchMock).not.toHaveBeenCalled();
        await advanceWatchSync(onChange);
        expect(onChange).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await fileWatcher.close();
        stat.mockRestore();
      }
    },
  );

  it.each(["darwin", "linux"] as const)(
    "restores coverage when the %s parent fails during a missing-root probe",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const root = path.join(workspaceDir, "memory");
      const onChange = vi.fn();
      const fileWatcher = new MemoryFileWatcher({
        workspaceDir,
        agentId: "main",
        settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
        onChange,
        onUnavailable: vi.fn(),
      });
      await fileWatcher.start();
      const main = createdNativeWatchers.find((watcher) => watcher.dir === root)!;
      const parent = createdNativeWatchers.find((watcher) => watcher.dir === workspaceDir)!;
      const fallback = createdChokidarWatchers[0]!;
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = fs.stat.bind(fs);
      const probe = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          if (String(args[0]) === root) {
            entered.resolve();
            await resume.promise;
          }
          return original(...args);
        });
      vi.useFakeTimers();
      try {
        await fs.rmdir(root);
        const pending = parent.emit("rename", "memory");
        await entered.promise;
        parent.emitError(Object.assign(new Error("parent watch failed"), { code: "EIO" }));
        expect(parent.close).toHaveBeenCalledOnce();
        expect(main.close).not.toHaveBeenCalled();
        resume.resolve();
        await pending;
        expect(main.close).toHaveBeenCalledOnce();
        expect(parent.close).toHaveBeenCalledOnce();
        expect(fallback.add).toHaveBeenCalledExactlyOnceWith(root);
        await advanceWatchSync(onChange);
        onChange.mockClear();
        await fs.mkdir(root);
        const note = path.join(root, "fresh.md");
        await fs.writeFile(note, "fresh");
        fallback.emit("add", note, await fs.stat(note));
        await advanceWatchSync(onChange);
        expect(onChange).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        await fileWatcher.close();
        probe.mockRestore();
      }
    },
  );

  it("joins a pending Linux startup scan on close without installing late watchers", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const root = path.join(workspaceDir, "memory");
    await fs.mkdir(path.join(root, "nested"));
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = fs.readdir.bind(fs);
    const read = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await original(...args);
        if (String(args[0]) === root) {
          entered.resolve();
          await resume.promise;
        }
        return entries;
      });
    const fileWatcher = new MemoryFileWatcher({
      workspaceDir,
      agentId: "main",
      settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
      onChange: vi.fn(),
      onUnavailable: vi.fn(),
    });
    const starting = fileWatcher.start();
    try {
      await entered.promise;
      let closed = false;
      const closing = fileWatcher.close().then(() => {
        closed = true;
      });
      expect(createdNativeWatchers).toHaveLength(1);
      expect(createdNativeWatchers[0]?.close).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([starting, closing]);
      expect(createdNativeWatchers).toHaveLength(1);
      expect(watchMock).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await fileWatcher.close();
      read.mockRestore();
    }
  });

  it.each([
    { platform: "darwin", eventSource: "file" },
    { platform: "darwin", eventSource: "parent" },
    { platform: "linux", eventSource: "file" },
    { platform: "linux", eventSource: "parent" },
  ] as const)(
    "shares one completion across a held $platform $eventSource burst and joins it on close",
    async ({ platform, eventSource }) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const root = path.join(workspaceDir, "memory");
      const note = path.join(root, "notes.md");
      await fs.writeFile(note, "note");
      const onDirty = vi.fn();
      const onChange = vi.fn();
      const fileWatcher = new MemoryFileWatcher({
        workspaceDir,
        agentId: "main",
        settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
        onChange,
        onDirty,
        onUnavailable: vi.fn(),
      });
      await fileWatcher.start();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const method = eventSource === "parent" ? "stat" : "lstat";
      const probePath = eventSource === "parent" ? root : note;
      const original: typeof fs.stat = fs[method].bind(fs);
      const probe = vi
        .spyOn(fs, method)
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          if (String(args[0]) === probePath) {
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
      try {
        const eventWatcher = createdNativeWatchers.find(
          (watcher) => watcher.dir === (eventSource === "parent" ? workspaceDir : root),
        )!;
        const emit = () =>
          eventWatcher.emit(
            eventSource === "parent" ? "rename" : "change",
            eventSource === "parent" ? "memory" : "notes.md",
          );
        const pending = emit();
        await entered.promise;
        expect(pending).toBeDefined();
        for (let index = 0; index < 2048; index += 1) {
          expect(emit()).toBe(pending);
        }
        let closed = false;
        const closing = fileWatcher.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(closed).toBe(false);
        expect(
          createdNativeWatchers.every((watcher) => watcher.close.mock.calls.length === 1),
        ).toBe(true);
        resume.resolve();
        await Promise.all([pending, closing]);
        expect(onDirty).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await fileWatcher.close();
        probe.mockRestore();
      }
    },
  );

  it("coalesces an overflowing Linux event generation into directory reconciliation", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const root = path.join(workspaceDir, "memory");
    const note = path.join(root, "notes.md");
    await fs.writeFile(note, "note");
    const removed = path.join(root, "removed-directory");
    await fs.mkdir(removed);
    const onChange = vi.fn();
    const fileWatcher = new MemoryFileWatcher({
      workspaceDir,
      agentId: "main",
      settings: resolveMemorySearchConfig(createWatcherConfig({ extraPaths: [] }), "main")!,
      onChange,
      onUnavailable: vi.fn(),
    });
    await fileWatcher.start();
    const removedWatcher = createdNativeWatchers.find((watcher) => watcher.dir === removed)!;
    expect(removedWatcher).toBeDefined();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = fs.lstat.bind(fs);
    const probe = vi
      .spyOn(fs, "lstat")
      .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const result = await original(...args);
        if (String(args[0]) === note) {
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
    vi.useFakeTimers();
    try {
      const main = createdNativeWatchers.find((watcher) => watcher.dir === root)!;
      const pending = main.emit("change", "notes.md");
      await entered.promise;
      const nested = path.join(root, "new-directory");
      await fs.mkdir(nested);
      await fs.rmdir(removed);
      const events = Array.from({ length: 1025 }, (_, i) => main.emit("rename", `burst-${i}.md`));
      resume.resolve();
      await Promise.all([pending, ...events]);
      expect(createdNativeWatchers.some((watcher) => watcher.dir === nested)).toBe(true);
      expect(removedWatcher.close).toHaveBeenCalledOnce();
      expect(createdNativeWatchers.every((watcher) => !watcher.recursive)).toBe(true);
      expect(probe.mock.calls.length).toBeLessThan(10);
      await advanceWatchSync(onChange);
      expect(onChange).toHaveBeenCalledExactlyOnceWith();
    } finally {
      resume.resolve();
      await fileWatcher.close();
      probe.mockRestore();
    }
  });

  it.each(["darwin", "linux"] as const)(
    "retains the replacement %s parent's queued event when the old parent reports last",
    async (platform) => {
      const { dir, main, parent, sync } = await setupParentWatchLifecycle(platform);
      await fs.rename(dir, path.join(workspaceDir, "first-memory"));
      await fs.mkdir(dir);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = fs.stat.bind(fs);
      let held = false;
      const probe = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          const result = await original(...args);
          if (
            String(args[0]) === dir &&
            !held &&
            createdNativeWatchers.filter((watcher) => watcher.dir === workspaceDir).length === 2
          ) {
            // The replacement parent is attached, but its post-admission probe still
            // holds the old parent open. Return the inode captured before the next rename.
            held = true;
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
      try {
        const firstReplacement = parent.emit("rename", "memory");
        await entered.promise;
        const replacementParent = createdNativeWatchers.filter(
          (watcher) => watcher.dir === workspaceDir,
        )[1]!;
        await fs.rename(dir, path.join(workspaceDir, "second-memory"));
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "fresh.md"), "fresh");
        const newEvent = replacementParent.emit("rename", "memory");
        const oldEvent = parent.emit("rename", "memory");
        resume.resolve();
        await Promise.all([firstReplacement, newEvent, oldEvent]);
        const roots = createdNativeWatchers.filter((watcher) => watcher.dir === dir);
        expect(roots).toHaveLength(3);
        expect(roots[0]?.close).toHaveBeenCalledOnce();
        expect(roots[1]?.close).toHaveBeenCalledOnce();
        expect(roots[2]?.close).not.toHaveBeenCalled();
        expect(parent.close).toHaveBeenCalledOnce();
        expect(replacementParent.close).toHaveBeenCalledOnce();
        expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
        await advanceWatchSync(sync);
        sync.mockClear();
        await main.emit("change", "fresh.md");
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
        expect(sync).not.toHaveBeenCalled();
        await roots[2]!.emit("change", "fresh.md");
        await advanceWatchSync(sync);
      } finally {
        resume.resolve();
        probe.mockRestore();
      }
    },
  );

  it("retains a replacement Linux child's queued event after a late callback from its closed predecessor", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const root = path.join(workspaceDir, "memory");
    const topic = path.join(root, "topic");
    await fs.mkdir(topic);
    const { sync } = await startDirectWatcher();
    const main = createdNativeWatchers.find((watcher) => watcher.dir === root)!;
    const oldChild = createdNativeWatchers.find((watcher) => watcher.dir === topic)!;
    vi.useFakeTimers();

    await fs.rename(topic, path.join(workspaceDir, "previous-topic"));
    await fs.mkdir(topic);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = fs.readdir.bind(fs);
    let held = false;
    const scan = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await original(...args);
        if (
          String(args[0]) === topic &&
          !held &&
          createdNativeWatchers.filter((watcher) => watcher.dir === topic).length === 2
        ) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        return entries;
      });
    try {
      const replacement = main.emit("rename", "topic");
      await entered.promise;
      const newChild = createdNativeWatchers.filter((watcher) => watcher.dir === topic)[1]!;
      const nested = path.join(topic, "new-directory");
      await fs.mkdir(nested);
      await fs.writeFile(path.join(nested, "fresh.md"), "fresh");
      const newEvent = newChild.emit("rename", "new-directory");
      const oldEvent = oldChild.emit("rename", "new-directory");
      resume.resolve();
      await Promise.all([replacement, newEvent, oldEvent]);
      expect(oldChild.close).toHaveBeenCalledOnce();
      expect(newChild.close).not.toHaveBeenCalled();
      const nestedWatcher = createdNativeWatchers.find((watcher) => watcher.dir === nested);
      expect(nestedWatcher).toBeDefined();
      expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
      await advanceWatchSync(sync);
      sync.mockClear();
      await nestedWatcher!.emit("change", "fresh.md");
      await advanceWatchSync(sync);
    } finally {
      resume.resolve();
      scan.mockRestore();
    }
  });

  it.each(["darwin", "linux"] as const)(
    "rejects a retired %s parent after an awaited reattachment probe",
    async (platform) => {
      const { dir, parent } = await setupParentWatchLifecycle(platform);
      await fs.rename(dir, path.join(workspaceDir, "previous-memory"));
      await fs.mkdir(dir);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const original = fs.stat.bind(fs);
      let reads = 0;
      const probe = vi
        .spyOn(fs, "stat")
        .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
          const result = await original(...args);
          if (String(args[0]) === dir && ++reads === 2) {
            entered.resolve();
            await resume.promise;
          }
          return result;
        });
      try {
        const pending = parent.emit("rename", "memory");
        await entered.promise;
        parent.emitError(new Error("parent retired during reattachment"));
        resume.resolve();
        await pending;
        expect(createdNativeWatchers.filter((watcher) => watcher.dir === dir)).toHaveLength(1);
        expect(createdChokidarWatchers[0]?.add).toHaveBeenCalledExactlyOnceWith(dir);
      } finally {
        resume.resolve();
        probe.mockRestore();
      }
    },
  );
});
