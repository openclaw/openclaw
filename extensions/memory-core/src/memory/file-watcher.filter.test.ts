import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";
import { advanceWatchSync } from "./watcher-test-support.js";

const { createdChokidarWatchers, createdNativeWatchers } = await vi.hoisted(async () => {
  const { createMemoryWatcherTestFactories } = await import("./watcher-test-support.js");
  return createMemoryWatcherTestFactories();
});

describe("memory file watcher filtering", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const originalPlatform = process.platform;
  let watcher: MemoryFileWatcher | undefined;

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    createdChokidarWatchers.length = 0;
    createdNativeWatchers.length = 0;
  });
  afterAll(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.test.memoryWatchFactory"));
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.test.memoryNativeWatchFactory"));
  });

  it.each(["darwin", "linux", "chokidar"] as const)(
    "filters irrelevant removals but preserves indexable removals through %s",
    async (transport) => {
      Object.defineProperty(process, "platform", {
        value: transport === "chokidar" ? "freebsd" : transport,
        configurable: true,
      });
      const workspaceDir = tempDirs.make("memory-watch-filter-");
      const extraDir = path.join(workspaceDir, "extra");
      for (const dir of [
        "memory",
        "extra/notes",
        "extra/data",
        "extra/archive/report.json",
        "extra/media",
      ]) {
        await fs.mkdir(path.join(workspaceDir, dir), { recursive: true });
      }
      const onDirty = vi.fn();
      const onChange = vi.fn();
      watcher = new MemoryFileWatcher({
        workspaceDir,
        agentId: "main",
        settings: {
          extraPaths: [
            { path: extraDir, pattern: "notes/*.md" },
            { path: extraDir, pattern: "archive/**/*.md" },
            { path: extraDir, pattern: "media/*" },
            { path: workspaceDir, pattern: "other/**/*.md" },
          ],
          multimodal: { enabled: true, modalities: ["image"], maxFileBytes: 1024 },
          sync: { watchDebounceMs: 1500 },
        },
        onDirty,
        onChange,
        onUnavailable: vi.fn(),
      });
      await watcher.start();
      vi.useFakeTimers();

      const emit = async (relativePath: string, directory = false) => {
        const absolutePath = path.join(workspaceDir, relativePath);
        if (transport === "chokidar") {
          createdChokidarWatchers[0]!.emit(directory ? "unlinkDir" : "unlink", absolutePath);
          return;
        }
        const watchRoot = transport === "linux" ? path.dirname(absolutePath) : workspaceDir;
        const native = createdNativeWatchers.findLast(
          (entry) => entry.dir === watchRoot && entry.recursive === (transport === "darwin"),
        );
        expect(native).toBeDefined();
        await native!.emit("rename", path.relative(watchRoot, absolutePath));
      };

      for (const relativePath of [
        "extra/data/state.json",
        "extra/notes/write.tmp",
        "extra/data/skip.md",
        ...(transport === "chokidar" ? ["extra/archive/state.json"] : []),
      ]) {
        const file = path.join(workspaceDir, relativePath);
        await fs.writeFile(file, "temporary");
        await fs.unlink(file);
        await emit(relativePath);
      }
      await fs.rmdir(path.join(extraDir, "data"));
      await emit("extra/data", true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(onDirty).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();

      for (const relativePath of [
        "extra/notes/keep.md",
        "extra/media/PHOTO.PNG",
        "MEMORY.md",
        "USER.md",
        "memory/keep.md",
      ]) {
        const file = path.join(workspaceDir, relativePath);
        await fs.writeFile(file, "indexed");
        await fs.unlink(file);
        await emit(relativePath);
      }
      await fs.writeFile(path.join(extraDir, "archive/report.json/nested.md"), "indexed");
      await fs.rm(path.join(extraDir, "archive/report.json"), { recursive: true });
      await emit("extra/archive/report.json", true);
      expect(onDirty).toHaveBeenCalledTimes(6);
      await advanceWatchSync(onChange);
      expect(onChange).toHaveBeenCalledOnce();
    },
  );
});
