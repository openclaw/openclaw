import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import { serveMemoryFiles } from "./memory-files-worker.js";

it("streams native file notifications and closes the watcher when its input closes", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-files-watch-"));
  const input = new PassThrough();
  const output = new PassThrough();
  let events = "";
  output.on("data", (data: Buffer) => {
    events += data.toString("utf8");
  });
  const started = vi.spyOn(MemoryFileWatcher.prototype, "start");
  const closed = vi.spyOn(MemoryFileWatcher.prototype, "close");
  let worker: Promise<void> | undefined;
  try {
    await fs.mkdir(path.join(workspace, "memory"));
    await fs.writeFile(path.join(workspace, "memory", "notes.md"), "before\n");
    worker = serveMemoryFiles({ workspace, input, output, watch: true });
    input.write(
      `${JSON.stringify({ agentId: "main", settings: { extraPaths: [], sync: { watchDebounceMs: 10 } } })}\n`,
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await started.mock.results[0]?.value;
    // Discard earlier change notifications without losing unavailable diagnostics.
    events = events.replaceAll('"change"\n', "");
    await fs.writeFile(path.join(workspace, "memory", "notes.md"), "after\n");
    await vi.waitFor(() => expect(events).toContain('"change"\n'), { timeout: 10_000 });
    input.end();
    await worker;
    expect(closed).toHaveBeenCalledOnce();
    expect(events).not.toContain("unavailable");
  } finally {
    input.end();
    await worker;
    started.mockRestore();
    closed.mockRestore();
    output.destroy();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

it("closes remote watch admission while startup is waiting on a filesystem probe", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-files-watch-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const originalStat = fs.stat.bind(fs);
  const probe = vi
    .spyOn(fs, "stat")
    .mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const result = await originalStat(...args);
      if (String(args[0]) === path.join(workspace, "memory")) {
        entered.resolve();
        await resume.promise;
      }
      return result;
    });
  // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the intercepted watcher owner.
  const originalClose = MemoryFileWatcher.prototype.close;
  const close = vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
    this: MemoryFileWatcher,
  ) {
    closing.resolve();
    return originalClose.call(this);
  });
  let worker: Promise<void> | undefined;
  try {
    await fs.mkdir(path.join(workspace, "memory"));
    worker = serveMemoryFiles({ workspace, input, output, watch: true });
    input.write(
      `${JSON.stringify({ agentId: "main", settings: { extraPaths: [], sync: { watchDebounceMs: 10 } } })}\n`,
    );
    await entered.promise;
    input.end();
    await closing.promise;
    resume.resolve();
    await worker;
    expect(close).toHaveBeenCalledOnce();
    expect(output.read()).toBeNull();
  } finally {
    resume.resolve();
    input.end();
    await worker;
    probe.mockRestore();
    close.mockRestore();
    output.destroy();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
