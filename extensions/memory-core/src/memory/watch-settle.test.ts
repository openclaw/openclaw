import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  MEMORY_WATCH_MAX_PATHS,
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

it("keeps a newer event snapshot when an older asynchronous probe finishes", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof fs.stat>>>();
  const stat = vi.spyOn(fs, "stat").mockReturnValue(pending.promise);
  const file = path.resolve("/workspace/memory/note.md");
  try {
    recordMemoryWatchEventPath(queue, file, { size: 1, mtimeMs: 1 });
    const settling = settleMemoryWatchEventPaths(queue);
    recordMemoryWatchEventPath(queue, file, { size: 3, mtimeMs: 3 });
    // Only the fields consumed by the settle owner are needed for this probe.
    pending.resolve({ isDirectory: () => false, size: 2, mtimeMs: 2 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    expect(await settling).toBe(false);
    expect(queue.get(file)).toEqual({ size: 3, mtimeMs: 3 });
  } finally {
    stat.mockRestore();
  }
});

it("aborts accepted settling probes before they can repopulate a closed generation", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof fs.stat>>>();
  const stat = vi.spyOn(fs, "stat").mockReturnValue(pending.promise);
  const controller = new AbortController();
  try {
    recordMemoryWatchEventPath(queue, "/workspace/memory/note.md", { size: 1, mtimeMs: 1 });
    const settling = settleMemoryWatchEventPaths(queue, controller.signal);
    controller.abort(new Error("watcher closed"));
    const rejected = expect(settling).rejects.toThrow("watcher closed");
    pending.resolve({ isDirectory: () => false, size: 2, mtimeMs: 2 } as Awaited<
      ReturnType<typeof fs.stat>
    >);
    await rejected;
    expect(queue.size).toBe(0);
  } finally {
    stat.mockRestore();
  }
});

it("bounds settling snapshots during event bursts", () => {
  const queue: MemoryWatchSettleQueue = new Map();
  for (let i = 0; i < MEMORY_WATCH_MAX_PATHS; i += 1) {
    recordMemoryWatchEventPath(queue, `/workspace/memory/${i}.md`);
  }
  expect(queue.size).toBe(MEMORY_WATCH_MAX_PATHS);
  recordMemoryWatchEventPath(queue, "/workspace/memory/overflow.md");
  expect(queue.size).toBe(0);
});
