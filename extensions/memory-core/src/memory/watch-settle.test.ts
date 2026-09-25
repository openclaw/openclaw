import fs from "node:fs/promises";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe/root";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MEMORY_WATCH_MAX_PATHS,
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchFile,
  type MemoryWatchSettleQueue,
} from "./watch-settle.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let authority: Root;
let file: MemoryWatchFile;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "memory-settling" });
  await fs.writeFile(path.join(state.workspaceDir, "note.md"), "one");
  authority = await root(state.workspaceDir, { symlinks: "reject" });
  file = { root: authority, relative: "note.md", sample: true };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await state.cleanup();
});

it("keeps newer event snapshots when older guarded probes finish", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  const opened = await authority.open("note.md");
  const pending = createDeferred<typeof opened>();
  vi.spyOn(authority, "open").mockReturnValue(pending.promise);
  recordMemoryWatchEventPath(queue, file, { size: 1, mtimeMs: 1 });
  const settling = settleMemoryWatchEventPaths(queue);
  recordMemoryWatchEventPath(queue, file, { size: 3, mtimeMs: 3 });
  pending.resolve(opened);
  expect(await settling).toBe(false);
  expect(queue.get(path.join(authority.rootDir, "note.md"))?.snapshot).toEqual({
    size: 3,
    mtimeMs: 3,
  });
});

it("aborts accepted probes without repopulating a closed generation and disposes the handle", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  const opened = await authority.open("note.md");
  const dispose = vi.spyOn(opened, Symbol.asyncDispose);
  const pending = createDeferred<typeof opened>();
  vi.spyOn(authority, "open").mockReturnValue(pending.promise);
  const controller = new AbortController();
  recordMemoryWatchEventPath(queue, file, { size: 1, mtimeMs: 1 });
  const settling = settleMemoryWatchEventPaths(queue, controller.signal);
  controller.abort(new Error("watcher closed"));
  const rejected = expect(settling).rejects.toThrow("watcher closed");
  pending.resolve(opened);
  await rejected;
  expect(queue.size).toBe(0);
  expect(dispose).toHaveBeenCalledOnce();
});

it("takes a later sample when the dirty hint carried no baseline", async () => {
  vi.useFakeTimers();
  const queue: MemoryWatchSettleQueue = new Map();
  const opened = await authority.open("note.md");
  const firstClosed = createDeferred<void>();
  const originalDispose = opened[Symbol.asyncDispose].bind(opened);
  vi.spyOn(opened, Symbol.asyncDispose).mockImplementation(async () => {
    await originalDispose();
    firstClosed.resolve();
  });
  const open = vi.spyOn(authority, "open").mockResolvedValueOnce(opened);
  recordMemoryWatchEventPath(queue, file);
  const settling = settleMemoryWatchEventPaths(queue);
  await firstClosed.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledOnce();
  await fs.writeFile(path.join(state.workspaceDir, "note.md"), "longer second write");
  await vi.advanceTimersByTimeAsync(100);
  expect(await settling).toBe(false);
  expect(open).toHaveBeenCalledTimes(2);
  expect(queue.size).toBe(1);
});

it("does not follow a contained alias even though Root.stat would", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  await fs.symlink("note.md", path.join(state.workspaceDir, "alias.md"));
  const open = vi.spyOn(authority, "open");
  recordMemoryWatchEventPath(queue, { ...file, relative: "alias.md" });
  expect(await settleMemoryWatchEventPaths(queue)).toBe(true);
  expect(open).toHaveBeenCalledWith("./alias.md", {
    symlinks: "reject",
  });
  await expect(open.mock.results[0]!.value).rejects.toBeDefined();
});

it("waits for disposal and retains actual handle-close failure", async () => {
  const queue: MemoryWatchSettleQueue = new Map();
  const opened = await authority.open("note.md");
  await opened[Symbol.asyncDispose]();
  const failure = new Error("handle disposal failed");
  vi.spyOn(opened, Symbol.asyncDispose).mockRejectedValue(failure);
  vi.spyOn(authority, "open").mockResolvedValue(opened);
  recordMemoryWatchEventPath(queue, file, { size: 1, mtimeMs: 1 });
  await expect(settleMemoryWatchEventPaths(queue)).rejects.toMatchObject({ cause: failure });
});

it("bounds snapshots and explicitly reports overflow to the broad-invalidation owner", () => {
  const queue: MemoryWatchSettleQueue = new Map();
  for (let i = 0; i < MEMORY_WATCH_MAX_PATHS; i++) {
    expect(recordMemoryWatchEventPath(queue, { ...file, relative: i + ".md" })).toBe(true);
  }
  expect(queue.size).toBe(MEMORY_WATCH_MAX_PATHS);
  expect(recordMemoryWatchEventPath(queue, { ...file, relative: "overflow.md" })).toBe(false);
  expect(queue.size).toBe(0);
});
