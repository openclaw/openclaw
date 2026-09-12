import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { forgetMemoryEntries } from "../memory-forget.js";
import * as cpuRuntime from "./manager-cpu-worker-runtime.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
const execFileAsync = promisify(execFile);

it("discards a worker hit forgotten before authoritative metadata enrichment", async ({
  signal,
}) => {
  const sessionId = "forgotten-worker-read";
  const sessionPath = `sessions/main/${sessionId}.jsonl`;
  await fixture.seedSessionTranscript({
    sessionId,
    sessionKey: `agent:main:chat:${sessionId}`,
    messages: [{ role: "user", timestamp: Date.now(), content: "Private violetfragment." }],
  });
  await fs.writeFile(path.join(fixture.paths.memory, "survivor.md"), "Public violetfragment.");
  const cfg = fixture.createConfig({
    provider: "none",
    sources: ["memory", "sessions"],
    sessionMemory: true,
    vectorEnabled: false,
  });
  const manager = await fixture.getFreshManager(cfg, "cli");
  await manager.sync({ reason: "index-before-forget", force: true });
  const ready = createDeferred<void>();
  const release = createDeferred<void>();
  const run = cpuRuntime.runMemoryKeywordSearch;
  const query = vi
    .spyOn(cpuRuntime, "runMemoryKeywordSearch")
    .mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      expect(result.body.rows.some((row) => row.path === sessionPath)).toBe(true);
      ready.resolve();
      await release.promise;
      return result;
    });
  const abort = () => release.resolve();
  signal.addEventListener("abort", abort, { once: true });
  const search = manager.search("violetfragment", { lexicalOnly: true, signal });
  try {
    await Promise.race([
      ready.promise,
      search.then(() => {
        throw new Error("Search settled before its worker result was gated");
      }),
    ]);
    await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db.prepare("SELECT id FROM memory_index_chunks WHERE path = ?").get(sessionPath),
    ).toBeUndefined();
    release.resolve();
    const results = await search;
    expect(results.map((result) => result.path)).toEqual(["memory/survivor.md"]);
  } finally {
    signal.removeEventListener("abort", abort);
    release.resolve();
    await search.catch(() => undefined);
    query.mockRestore();
  }
});

async function tryIndependentWriter(databasePath: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { DatabaseSync } from 'node:sqlite';
     const db = new DatabaseSync(process.argv[1], { timeout: 0 });
     try {
       db.exec('BEGIN IMMEDIATE');
       db.exec('ROLLBACK');
       process.stdout.write('acquired');
     } catch (error) {
       if (!/database is locked/.test(String(error))) throw error;
       process.stdout.write('busy');
     } finally { db.close(); }`,
    databasePath,
  ]);
  return result.stdout;
}

it("keeps the owner's SQLite writer lock across worker reads and reader close", async () => {
  await fs.writeFile(path.join(fixture.paths.memory, "worker-lock.md"), "Axolotl lock proof.");
  const manager = await fixture.getFreshManager(
    fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
    "cli",
  );
  await manager.sync({ reason: "test", force: true });
  const databasePath = manager.status().dbPath;
  if (!databasePath) {
    throw new Error("Expected a persistent memory database");
  }
  const db = Reflect.get(manager, "db") as DatabaseSync;
  db.exec("BEGIN IMMEDIATE");
  try {
    expect(await tryIndependentWriter(databasePath)).toBe("busy");
    const results = await manager.search("axolotl", { lexicalOnly: true });
    expect(results.some((result) => result.path === "memory/worker-lock.md")).toBe(true);
    // POSIX locks belong to the process: an unsafe descriptor close in another
    // thread could silently release this owner's lock even though its transaction remains open.
    expect(await tryIndependentWriter(databasePath)).toBe("busy");
  } finally {
    db.exec("ROLLBACK");
  }
  expect(await tryIndependentWriter(databasePath)).toBe("acquired");
});
