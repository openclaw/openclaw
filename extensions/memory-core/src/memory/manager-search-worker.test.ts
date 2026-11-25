import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { forgetMemoryEntries } from "../memory-forget.js";
import * as cpuRuntime from "./manager-cpu-worker-runtime.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
const execFileAsync = promisify(execFile);
const createConfig = (sources: Array<"memory" | "sessions"> = ["memory"]) =>
  fixture.createConfig({
    provider: "none",
    sources,
    sessionMemory: sources.includes("sessions"),
    vectorEnabled: false,
  });
async function indexedManager(cfg = createConfig()) {
  const manager = await fixture.getFreshManager(cfg, "cli");
  await manager.sync({ reason: "test", force: true });
  return manager;
}
const sessionId = "worker-read";
const sessionPath = `sessions/main/${sessionId}.jsonl`;
const seedSession = (content: string, kind = "chat") =>
  fixture.seedSessionTranscript({
    sessionId,
    sessionKey: `agent:main:${kind}:${sessionId}`,
    messages: [{ role: "user", timestamp: Date.now(), content }],
  });
function gateWorker(signal: AbortSignal, fused = false) {
  const ready = createDeferred<void>();
  const release = createDeferred<void>();
  const run = cpuRuntime.runMemoryKeywordSearch;
  const query = vi
    .spyOn(cpuRuntime, "runMemoryKeywordSearch")
    .mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      expect(result.body.rows.some((row) => row.path === sessionPath)).toBe(true);
      if (fused) {
        expect(result.recallData?.sourceMtimes.sessions.has(sessionPath)).toBe(true);
        expect(result.body.rows.every((row) => result.recallData?.rows.has(row.id))).toBe(true);
      }
      ready.resolve();
      await release.promise;
      return result;
    });
  const abort = () => release.resolve();
  signal.addEventListener("abort", abort, { once: true });
  return {
    wait: (search: Promise<unknown>) =>
      Promise.race([
        ready.promise,
        search.then(() => {
          throw new Error("Search settled before its worker result was gated");
        }),
      ]),
    release: abort,
    restore() {
      signal.removeEventListener("abort", abort);
      query.mockRestore();
    },
  };
}
type Manager = Awaited<ReturnType<typeof indexedManager>>;
function expectMissingChunk(manager: Manager) {
  const db = Reflect.get(manager, "db") as DatabaseSync;
  expect(
    db.prepare("SELECT id FROM memory_index_chunks WHERE path = ?").get(sessionPath),
  ).toBeUndefined();
}
async function expectReaders(manager: Manager, word: string) {
  const results = await manager.search(word, { lexicalOnly: true });
  expect(results[0]?.snippet).toContain(word);
  expect((await manager.listTriggerCandidates())[0]?.snippet).toContain(word);
}

it("sees published replacements through reused search and curated readers", async () => {
  const filename = path.join(fixture.paths.workspace, "MEMORY.md");
  await fs.writeFile(filename, "- Remember violetcompass. <!-- trigger: compass -->");
  const manager = await indexedManager();
  await expectReaders(manager, "violetcompass");

  await fs.writeFile(filename, "- Remember ambercompass. <!-- trigger: compass -->");
  await manager.sync({ reason: "replace-after-reader-reuse", force: true });
  await expect(manager.search("violetcompass", { lexicalOnly: true })).resolves.toEqual([]);
  await expectReaders(manager, "ambercompass");
});

it("cancels post-probe metadata reads and releases the generation for publication", async () => {
  await seedSession("Alpha cancellation proof.", "memory");
  const manager = await indexedManager(createConfig(["memory", "sessions"]));
  const caller = new AbortController();
  const reason = new Error("caller cancelled metadata enrichment");
  const run = cpuRuntime.runMemoryRecallMetadata;
  const read = vi.spyOn(cpuRuntime, "runMemoryRecallMetadata").mockImplementationOnce((...args) => {
    const pending = run(...args);
    caller.abort(reason);
    return pending;
  });
  try {
    await expect(manager.search("alpha", { signal: caller.signal })).rejects.toBe(reason);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
  }
  await manager.sync({ reason: "after-cancellation", force: true });
  const results = await manager.search("alpha");
  expect(results.some((result) => result.snippet.includes("Alpha cancellation proof."))).toBe(true);
});

it("drops forgotten hits before metadata enrichment", async ({ signal }) => {
  await seedSession("Private violetfragment.");
  await fs.writeFile(path.join(fixture.paths.memory, "survivor.md"), "Public violetfragment.");
  const cfg = createConfig(["memory", "sessions"]);
  const manager = await indexedManager(cfg);
  const gate = gateWorker(signal);
  const search = manager.search("violetfragment", { lexicalOnly: true, signal });
  try {
    await gate.wait(search);
    await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
    expectMissingChunk(manager);
    gate.release();
    const results = await search;
    expect(results.map((result) => result.path)).toEqual(["memory/survivor.md"]);
  } finally {
    gate.release();
    await search.catch(() => undefined);
    gate.restore();
  }
});

it.for(["completed", "cancelled"] as const)(
  "settles a %s fused search before close and a queued forget",
  async (outcome, { signal }) => {
    await seedSession("Private violetcustody.");
    const cfg = createConfig(["sessions"]);
    const manager = await indexedManager(cfg);
    const caller = new AbortController();
    const cancellation = new Error("cancel fused search during result delivery");
    const gate = gateWorker(signal, true);
    const search = manager.search("violetcustody", {
      lexicalOnly: true,
      sources: ["sessions"],
      signal: AbortSignal.any([signal, caller.signal]),
    });
    void search.catch(() => undefined);
    let forgetting: ReturnType<typeof forgetMemoryEntries> | undefined;
    let closing: Promise<void> | undefined;
    let forgetSettled = false;
    try {
      await gate.wait(search);
      forgetting = forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] }).finally(
        () => {
          forgetSettled = true;
        },
      );
      void forgetting.catch(() => undefined);
      closing = manager.close();
      void closing.catch(() => undefined);
      await expect(manager.search("violetcustody")).rejects.toThrow("manager is closed");
      expect(forgetSettled).toBe(false);
      if (outcome === "cancelled") {
        caller.abort(cancellation);
      }
      gate.release();
      if (outcome === "cancelled") {
        await expect(search).rejects.toBe(cancellation);
      } else {
        expect((await search).map((result) => result.path)).toEqual([sessionPath]);
      }
      await Promise.all([forgetting, closing]);
      gate.restore();

      const reopened = await indexedManager(cfg);
      await expect(
        reopened.search("violetcustody", { lexicalOnly: true, sources: ["sessions"] }),
      ).resolves.toEqual([]);
      const db = Reflect.get(reopened, "db") as DatabaseSync;
      expectMissingChunk(reopened);
      expect(
        db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?").get(sessionId),
      ).toEqual({ session_id: sessionId });
    } finally {
      gate.release();
      await Promise.allSettled([search, forgetting, closing]);
      gate.restore();
    }
  },
);

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
  const manager = await indexedManager();
  const databasePath = manager.status().dbPath;
  if (!databasePath) {
    throw new Error("Expected a persistent memory database");
  }
  const db = memoryIndexFixtureWriter(manager);
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
