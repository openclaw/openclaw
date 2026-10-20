import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vectorKnnParentEntrypoint } from "./manager-search-knn-runtime.test-support.js";
import type { VectorKnnRequest } from "./manager-search-knn.js";
import { runVectorKnnInSubprocess, vectorToBlob } from "./manager-search-knn.test-support.js";
import { searchVector } from "./manager-search-vector.js";
import { buildMemorySourceFilter } from "./source-filter.js";

const fixtureChildUrl = new URL("./fixtures/manager-search-knn-child.fixture.mjs", import.meta.url);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset().mockImplementation(spawn);
});

function useFixtureChild() {
  const children: childProcess.ChildProcessWithoutNullStreams[] = [];
  const closedChildren = new Set<childProcess.ChildProcessWithoutNullStreams>();
  const liveChildCounts: number[] = [];
  const ready: Promise<unknown[]>[] = [];
  vi.mocked(childProcess.spawn).mockImplementation((_command, _args, options) => {
    const child = spawn(process.execPath, [fileURLToPath(fixtureChildUrl)], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    liveChildCounts.push(children.length - closedChildren.size);
    child.once("close", () => closedChildren.add(child));
    ready.push(once(child.stderr, "data"));
    return child;
  });
  return { children, closedChildren, liveChildCounts, ready };
}

const defaultRequest: VectorKnnRequest = {
  providerModels: ["test-model"],
  queryVec: [1, 0],
  limit: 1,
  snippetMaxChars: 700,
  sourceFilter: { sql: "", params: [] },
};
function run(
  limit = 1,
  options: Omit<Partial<Parameters<typeof runVectorKnnInSubprocess>[0]>, "request"> & {
    request?: Partial<VectorKnnRequest>;
  } = {},
) {
  const { request, ...target } = options;
  return runVectorKnnInSubprocess({
    databasePath: "fixture:ok",
    ...target,
    request: { ...defaultRequest, limit, ...request },
  });
}

const emptyResult = { rows: [], fallbackScanRequired: false };

function insertVectorRow(
  db: DatabaseSync,
  id: string,
  vector: [number, number],
  source: "memory" | "sessions" = "memory",
  text = `text ${id}`,
) {
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, start_line, end_line, text, source, model) VALUES (?, ?, 1, 1, ?, ?, 'test-model')",
  ).run(id, `${source}/${id}.md`, text, source);
  db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
    id,
    vectorToBlob(vector),
  );
}

async function createFileBackedVectorDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-knn-"));
  const databasePath = path.join(directory, "memory.sqlite");
  const db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
  const cleanup = () => {
    if (db.isOpen) {
      db.close();
    }
    fs.rmSync(directory, { force: true, recursive: true });
  };
  try {
    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "sqlite-vec unavailable in test");
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2]);
    `);
    return {
      db,
      databasePath,
      cleanup,
      [Symbol.dispose]: cleanup,
      query: (limit = 1, overrides: Partial<VectorKnnRequest> = {}) =>
        run(limit, { databasePath, request: overrides }),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    vi.mocked(childProcess.spawn).mock.results.map(async (result) => {
      if (result.type !== "return") {
        return;
      }
      const child = result.value;
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("memory vector KNN subprocess boundary", () => {
  it("retires an idle child at the SQLite idle deadline and respawns after a crash", async () => {
    const { children } = useFixtureChild();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await run();
    const idleClosed = once(children[0]!, "close");
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(children[0]!.killed).toBe(false);
    vi.advanceTimersByTime(1);
    await idleClosed;
    vi.useRealTimers();
    await run();
    const crashed = once(children[1]!, "close");
    children[1]!.kill("SIGKILL");
    await crashed;
    await expect(run()).resolves.toEqual(emptyResult);
    expect(children).toHaveLength(3);
  });

  it("serializes same-database requests without letting a queued abort kill active work", async () => {
    const { children } = useFixtureChild();
    const active = run(250);
    const controller = new AbortController();
    const queued = run(1, { signal: controller.signal });
    const rejected = expect(queued).rejects.toThrow("queued cancellation");
    controller.abort(new Error("queued cancellation"));
    await rejected;
    await expect(active).resolves.toEqual(emptyResult);
    await run();
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);
  });

  it("waits for an idle child to exit through EOF before reusing its capacity", async () => {
    const { children, closedChildren, liveChildCounts } = useFixtureChild();
    for (const databasePath of ["fixture:first", "fixture:second"]) {
      await run(1, { databasePath });
    }
    // Make EOF win retirement without changing the real close event.
    vi.spyOn(children[0]!, "kill").mockReturnValueOnce(true);
    await run(1, { databasePath: "fixture:third" });
    expect(children).toHaveLength(3);
    expect(closedChildren.has(children[0]!)).toBe(true);
    expect(liveChildCounts).toEqual([1, 2, 2]);
    expect(children[0]).toMatchObject({ exitCode: 0, signalCode: null });
    expect(
      children.filter((child) => child.exitCode === null && child.signalCode === null),
    ).toHaveLength(2);
  });

  it("admits another database after both busy children finish", async () => {
    const { children, closedChildren, liveChildCounts } = useFixtureChild();
    await Promise.all(
      ["fixture:first", "fixture:second", "fixture:third"].map((databasePath) =>
        run(100, { databasePath }),
      ),
    );
    expect(children).toHaveLength(3);
    expect(children.slice(0, 2).some((child) => closedChildren.has(child))).toBe(true);
    expect(Math.max(...liveChildCounts)).toBe(2);
  });

  it("keeps a standalone parent alive through idle expiry and retirement", async () => {
    const fixtures = await Promise.all([0, 1, 2].map(() => createFileBackedVectorDatabase()));
    try {
      const result = await promisify(childProcess.execFile)(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(vectorKnnParentEntrypoint)),
          JSON.stringify({
            expireIdle: true,
            databasePaths: fixtures.map((fixture) => fixture.databasePath),
            request: defaultRequest,
          }),
        ],
        { timeout: 30_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } },
      );
      expect(result.stdout.trim()).toBe("completed");
    } finally {
      fixtures.forEach((fixture) => fixture.cleanup());
    }
  });

  it("rejects oversized input without spawning or disturbing an idle child", async () => {
    const { children } = useFixtureChild();
    await run();
    await expect(
      run(1, { request: { providerModels: ["x".repeat(1024 * 1024)] } }),
    ).rejects.toThrow("input is too large");
    await run();
    expect(children).toHaveLength(1);
  });

  it("hard-kills and reaps a busy child on caller abort, then admits another query", async () => {
    const { ready, children } = useFixtureChild();
    const controller = new AbortController();
    const result = run(30_000, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow("test KNN deadline");
    await vi.waitFor(() => expect(ready).toHaveLength(1));
    await ready[0];
    const closed = once(children[0]!, "close");
    controller.abort(new Error("test KNN deadline"));
    await rejected;
    expect(await closed).toEqual([null, "SIGKILL"]);
    await expect(run()).resolves.toEqual(emptyResult);
  });

  it("retains both admission slots after cleanup timeout until children close", async () => {
    const { children, ready } = useFixtureChild();
    const controller = new AbortController();
    const results = [0, 1].map((index) =>
      run(30_000, { databasePath: `fixture:ok:${index}`, signal: controller.signal }),
    );
    const rejected = results.map((result) =>
      expect(result).rejects.toMatchObject({ code: "termination-timeout" }),
    );
    await vi.waitFor(() => expect(children).toHaveLength(2));
    await Promise.all(ready);
    const realKills = children.map((child) => child.kill.bind(child));
    const closed = children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        }),
    );
    const killMocks = children.map((child) =>
      vi
        .spyOn(child, "kill")
        .mockReturnValue(false)
        .mockImplementationOnce(() => {
          // Node emits signaling failures synchronously; retirement must not recurse.
          child.emit("error", Object.assign(new Error("fixture kill denied"), { code: "EPERM" }));
          return false;
        }),
    );
    const settled = vi.fn();
    for (const result of results) {
      void result.then(settled, settled);
    }
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      controller.abort(new Error("terminal cleanup test"));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledTimes(2);
      await Promise.all(rejected);
      vi.useRealTimers();
      killMocks.forEach((mock) => expect(mock).toHaveBeenCalledTimes(1));
      const queuedController = new AbortController();
      const queued = run(1, { signal: queuedController.signal });
      const queuedRejection = expect(queued).rejects.toThrow("queued KNN deadline");
      await yieldToEventLoop();
      expect(children).toHaveLength(2);
      queuedController.abort(new Error("queued KNN deadline"));
      await queuedRejection;
    } finally {
      vi.useRealTimers();
      killMocks.forEach((mock) => mock.mockRestore());
      realKills.forEach((kill) => kill("SIGKILL"));
      await Promise.all(closed);
    }
    await expect(run()).resolves.toEqual(emptyResult);
  });

  it("queries the real source child across WAL writer visibility and source filters", async () => {
    // The read-only native query must not boot schema/query-builder runtimes
    // through broad SDK barrels on every search (including packaged children).
    const importGuard = process.versions.bun
      ? `Bun.plugin({
          name: "openclaw-memory-knn-import-guard",
          setup(build) {
            build.onResolve({ filter: /^(?:kysely|typebox)(?:\\/|$)/u }, ({ path: specifier }) => {
              throw new Error("KNN child loaded unrelated runtime: " + specifier);
            });
          },
        });`
      : `import { registerHooks } from "node:module";
        registerHooks({ resolve(specifier, context, nextResolve) {
          if (/^(?:kysely|typebox)(?:\\/|$)/u.test(specifier)) {
            throw new Error("KNN child loaded unrelated runtime: " + specifier);
          }
          return nextResolve(specifier, context);
        } });`;
    vi.mocked(childProcess.spawn).mockImplementation((command, args, options) =>
      spawn(
        command,
        ["--import", `data:text/javascript,${encodeURIComponent(importGuard)}`, ...args],
        options,
      ),
    );
    using fixture = await createFileBackedVectorDatabase();
    try {
      insertVectorRow(fixture.db, "committed", [1, 0]);
      fixture.db.exec("BEGIN IMMEDIATE");
      insertVectorRow(fixture.db, "pending", [0.9, 0.1], "sessions");

      const searchSource = (source: "memory" | "sessions") =>
        fixture.query(2, { sourceFilter: buildMemorySourceFilter("c", [source]) });
      const memoryResult = await searchSource("memory");
      expect(memoryResult.rows.map((row) => row.id)).toEqual(["committed"]);
      expect(memoryResult.fallbackScanRequired).toBe(false);

      const beforeCommit = await searchSource("sessions");
      expect(beforeCommit.rows).toEqual([]);

      fixture.db.exec("COMMIT");
      const afterCommit = await searchSource("sessions");
      expect(afterCommit.rows.map((row) => row.id)).toEqual(["pending"]);
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(fixture.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
    } finally {
      try {
        fixture.db.exec("ROLLBACK");
      } catch {}
    }
  });

  it.each([
    ["malformed", "malformed JSON"],
    ["invalid-row", "returned an invalid result"],
    ["oversized", "stdout exceeded its limit"],
    ["oversized-stderr", "stderr exceeded its limit"],
    ["early-exit", "exited before returning a result (code 7, signal none): fixture KNN failure"],
    ["extra", "extra output"],
  ])("respawns after %s without poisoning the next request", async (mode, message) => {
    const { children } = useFixtureChild();
    await expect(run(1, { request: { providerModels: [`fixture:${mode}`] } })).rejects.toThrow(
      message,
    );
    await expect(run(1, { request: { providerModels: ["fixture:fragmented"] } })).resolves.toEqual(
      emptyResult,
    );
    expect(children).toHaveLength(2);
  });

  it("fails vector recall closed when the subprocess is unavailable", async () => {
    const runFallback = vi.fn(async () => []);
    await expect(
      searchVector({
        providerModel: "test-model",
        queryVec: [1, 0],
        limit: 1,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        runVectorKnn: async () => {
          throw new Error("subprocess unavailable");
        },
        runFallback,
        sourceFilterVec: { sql: "", params: [] },
      }),
    ).rejects.toThrow("subprocess unavailable");
    expect(runFallback).not.toHaveBeenCalled();
  });
  it("reopens a replaced database on the next query in the same child", async () => {
    using original = await createFileBackedVectorDatabase();
    using replacement = await createFileBackedVectorDatabase();
    insertVectorRow(original.db, "original", [1, 0]);
    insertVectorRow(replacement.db, "replacement", [1, 0]);
    expect((await original.query()).rows[0]?.id).toBe("original");
    original.db.close();
    replacement.db.close();
    fs.renameSync(replacement.databasePath, original.databasePath);
    expect((await original.query()).rows[0]?.id).toBe("replacement");
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["NUL-dense", 200, "\0".repeat(3000), 700, "\0".repeat(700)],
    ["oversized", 1, `${"x".repeat(63)}😀${"y".repeat(3 * 1024 * 1024)}`, 64, "x".repeat(63)],
  ] as const)(
    "bounds %s snippets before child serialization",
    async (kind, count, text, snippetMaxChars, expected) => {
      using fixture = await createFileBackedVectorDatabase();
      fixture.db.exec("BEGIN");
      for (let index = 0; index < count; index++) {
        insertVectorRow(
          fixture.db,
          count === 1 ? "oversized" : `nul-${index}`,
          [1, 0],
          "memory",
          text,
        );
      }
      fixture.db.exec("COMMIT");
      const result = await fixture.query(count, { snippetMaxChars });
      expect(result.fallbackScanRequired).toBe(false);
      expect(result.rows).toHaveLength(count);
      expect(result.rows.every((row) => row.text === expected)).toBe(true);
      if (kind === "oversized") {
        expect(result.rows[0]).toMatchObject({ id: "oversized", text: expected });
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2 * 1024 * 1024);
      }
    },
  );
});
