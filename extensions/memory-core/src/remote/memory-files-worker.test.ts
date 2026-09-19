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
    await fs.writeFile(path.join(workspace, "MEMORY.md"), "before\n");
    worker = serveMemoryFiles({ workspace, input, output, watch: true });
    input.write(
      `${JSON.stringify({ agentId: "main", settings: { extraPaths: [], sync: { watchDebounceMs: 10 } } })}\n`,
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await fs.writeFile(path.join(workspace, "MEMORY.md"), "after\n");
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
