import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createWorkboardSqliteStores } from "./test/database-config.js";

it("recovers Workboard after its slot fails with another client retaining the actor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workboard-recovery-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);
  const capture = vi.spyOn(Worker.prototype, "postMessage");
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const sibling = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  try {
    await Promise.all([stores.ready, sibling.ready]);
    const board = {
      version: 1 as const,
      board: { id: "ops", name: "Operations", createdAt: 1, updatedAt: 1 },
    };
    await stores.boards.register("ops", board);
    const openRequestIndex = capture.mock.calls.findIndex(
      ([request]) => request?.type === "open" && request.databasePath === dbPath,
    );
    const worker = capture.mock.contexts[openRequestIndex];
    assert(worker instanceof Worker, "Workboard worker was not opened");
    worker.emit("error", new Error("database is locked"));
    await expect(stores.boards.lookup("ops")).resolves.toEqual(board);
    await expect(sibling.boards.lookup("ops")).resolves.toEqual(board);
    await stores.boards.delete("ops");
    await expect(stores.boards.lookup("ops")).resolves.toBeUndefined();
  } finally {
    capture.mockRestore();
    await Promise.all([stores.close(), sibling.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
