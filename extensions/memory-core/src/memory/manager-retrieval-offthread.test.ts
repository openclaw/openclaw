import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const benchmark = process.env.OPENCLAW_MEMORY_RETRIEVAL_BENCH === "1";
const baseline = process.env.OPENCLAW_MEMORY_RETRIEVAL_BENCH_PHASE === "baseline";
const now = Date.parse("2026-09-01T00:00:00Z");

function seedCorpus(db: DatabaseSync, chunks: number): void {
  const curated = Math.min(1024, chunks / 2);
  // The benchmark uses the published schema and its real FTS triggers. Ten
  // chunks per source represents a large index without 50,000 filesystem writes.
  db.exec(`CREATE TEMP TABLE retrieval_fixture (n INTEGER PRIMARY KEY, path TEXT, source TEXT);
    WITH RECURSIVE numbers(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ${chunks}
    ) INSERT INTO retrieval_fixture
    SELECT n,
      CASE WHEN n < ${curated / 2} THEN 'MEMORY.md'
           WHEN n < ${curated} THEN 'USER.md'
           WHEN (n / 10) % 5 = 0 THEN 'sessions/session-' || (n / 10) || '.jsonl'
           ELSE 'memory/archive-' || (n / 10) || '.md' END,
      CASE WHEN n >= ${curated} AND (n / 10) % 5 = 0 THEN 'sessions' ELSE 'memory' END
    FROM numbers;
    BEGIN;
    INSERT OR REPLACE INTO memory_index_sources(path, source, hash, mtime, size)
    SELECT path, source, 'fixture-hash',
      CASE WHEN source = 'sessions' THEN ${now - 30 * 86_400_000} ELSE ${now} END,
      4000 FROM retrieval_fixture GROUP BY path, source;`);
  db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
    SELECT printf('fixture-%06d', n), path, source, n % 10 + 1, n % 10 + 1,
      'fixture-hash', 'mock-embed',
      CASE WHEN n % 5 = 0 THEN 'Alpha violet preference for the archive.'
           ELSE 'Beta amber context for the archive.' END || ' Record ' || n,
      ?, ${now}
    FROM retrieval_fixture`).run(encodeMemoryEmbedding([1, 0, 0, 0]));
  db.exec(`INSERT INTO memory_index_chunk_recall_metadata(chunk_id, importance, triggers, project_key)
    SELECT printf('fixture-%06d', n), n % 10 + 1, 'when reviewing archives',
      CASE WHEN n % 3 = 0 THEN 'project-a' WHEN n % 3 = 1 THEN 'project-b' ELSE NULL END
    FROM retrieval_fixture;
    INSERT INTO memory_index_chunk_provenance(chunk_id, origin_class, session_kind, observed_at, supersedes_key)
    SELECT printf('fixture-%06d', n),
      CASE WHEN n % 7 = 0 THEN 'untrusted' ELSE 'owner' END,
      'interactive', ${now}, 'archive-preference'
    FROM retrieval_fixture;
    COMMIT;
    DROP TABLE retrieval_fixture;`);
}

function observeMainThreadSql(db: DatabaseSync) {
  let milliseconds = 0;
  let statements = 0;
  const sql: string[] = [];
  const timed = <T>(run: () => T): T => {
    const started = performance.now();
    try {
      return run();
    } finally {
      milliseconds += performance.now() - started;
    }
  };
  const prepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    sql.push(query);
    const statement = timed(() => prepare(query));
    return new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (key === "iterate") {
            statements += 1;
            const iterator: ReturnType<typeof statement.iterate> = timed(() =>
              Reflect.apply(value, target, args),
            );
            return {
              [Symbol.iterator]() {
                return this;
              },
              next: () => timed(() => iterator.next()),
              return: () => timed(() => iterator.return?.() ?? { done: true, value: undefined }),
            };
          }
          if (key !== "all" && key !== "get" && key !== "run") {
            return Reflect.apply(value, target, args);
          }
          statements += 1;
          return timed(() => Reflect.apply(value, target, args));
        };
      },
    });
  });
  const exec = db.exec.bind(db);
  const execSpy = vi.spyOn(db, "exec").mockImplementation((query) => {
    statements += 1;
    sql.push(query);
    return timed(() => exec(query));
  });
  return {
    read: () => ({ milliseconds, statements, sql }),
    reset: () => {
      milliseconds = 0;
      statements = 0;
      sql.length = 0;
    },
    restore: () => {
      prepareSpy.mockRestore();
      execSpy.mockRestore();
    },
  };
}

describe("memory retrieval thread ownership", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("offloads ranked retrieval with bounded session-only metadata reads", async () => {
    const cfg = fixture.createConfig({
      vectorEnabled: false,
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const manager = await fixture.getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    expect(manager.status().fts?.available).toBe(true);
    const db = (manager as unknown as { db: DatabaseSync }).db;
    seedCorpus(db, benchmark ? 50_000 : 64);
    const date = vi.spyOn(Date, "now").mockReturnValue(now);
    const operations = [
      {
        name: "lexical",
        run: () => manager.search("violet", { lexicalOnly: true, maxResults: 12 }),
      },
      {
        name: "fallback",
        run: () => manager.search("violet absentphrase", { lexicalOnly: true, maxResults: 12 }),
      },
      { name: "hybrid-scan", run: () => manager.search("alpha", { maxResults: 12 }) },
      {
        name: "sessions",
        run: () =>
          manager.search("violet", { lexicalOnly: true, maxResults: 12, sources: ["sessions"] }),
      },
      {
        name: "triggers",
        run: () => manager.listTriggerCandidates({ limit: 12, activeProjectKeys: ["project-a"] }),
      },
      {
        name: "projects",
        run: () =>
          manager.listCuratedProjectCandidates({ limit: 12, activeProjectKeys: ["project-a"] }),
      },
    ];
    const observer = observeMainThreadSql(db);
    const golden: Record<string, unknown> = {};
    try {
      for (const operation of operations) {
        // Warm the existing worker and prepared statements before timing steady state.
        observer.reset();
        const results = await operation.run();
        const warmupIterations = benchmark ? 10 : 1;
        for (let index = 1; index < warmupIterations; index += 1) {
          await operation.run();
        }
        const firstSql = [...observer.read().sql];
        expect(results.length, operation.name).toBeGreaterThan(0);
        expect(
          results.some((result) => result.importance !== undefined),
          operation.name,
        ).toBe(true);
        expect(
          results.some((result) => result.provenance?.originClass === "owner"),
          operation.name,
        ).toBe(true);
        golden[operation.name] = results;
        observer.reset();
        const iterations = benchmark ? 100 : 1;
        const elapsedSamples: number[] = [];
        const activeSamples: number[] = [];
        const cpuSamples: number[] = [];
        let repeated = results;
        for (let index = 0; index < iterations; index += 1) {
          const utilization = performance.eventLoopUtilization();
          const cpuStart = benchmark ? process.threadCpuUsage() : undefined;
          const started = performance.now();
          repeated = await operation.run();
          elapsedSamples.push(performance.now() - started);
          activeSamples.push(performance.eventLoopUtilization(utilization).active);
          if (cpuStart) {
            const cpu = process.threadCpuUsage(cpuStart);
            cpuSamples.push((cpu.user + cpu.system) / 1000);
          }
        }
        const measured = observer.read();
        expect(repeated).toEqual(results);
        if (benchmark) {
          elapsedSamples.sort((a, b) => a - b);
          activeSamples.sort((a, b) => a - b);
          cpuSamples.sort((a, b) => a - b);
          const mean = (samples: number[]) =>
            samples.reduce((total, sample) => total + sample, 0) / iterations;
          const percentile = (samples: number[], fraction: number) =>
            samples[Math.ceil(iterations * fraction) - 1];
          console.log(
            "MEMORY_RETRIEVAL_BENCH",
            JSON.stringify({
              phase: baseline ? "baseline" : "candidate",
              operation: operation.name,
              chunks: 50_000,
              warmupIterations,
              iterations,
              mainThreadSqlMs: measured.milliseconds / iterations,
              mainThreadStatements: measured.statements / iterations,
              mainThreadCpuMs: mean(cpuSamples),
              mainThreadCpuP50Ms: percentile(cpuSamples, 0.5),
              mainThreadActiveMs: mean(activeSamples),
              mainThreadActiveP50Ms: percentile(activeSamples, 0.5),
              mainThreadActiveP95Ms: percentile(activeSamples, 0.95),
              endToEndMs: mean(elapsedSamples),
              endToEndP50Ms: percentile(elapsedSamples, 0.5),
              endToEndP95Ms: percentile(elapsedSamples, 0.95),
            }),
          );
        }
        if (!baseline && operation.name === "sessions") {
          expect(measured.statements / iterations).toBe(2);
        } else if (baseline) {
          expect(
            measured.statements,
            `${operation.name} must observe its retained synchronous SQLite execution`,
          ).toBeGreaterThan(0);
          expect(measured.milliseconds, operation.name).toBeGreaterThan(0);
        } else {
          expect(
            firstSql,
            `${operation.name} first retrieval must not execute main-thread SQL`,
          ).toEqual([]);
          expect(measured.sql, `${operation.name} must not execute SQL on the main thread`).toEqual(
            [],
          );
        }
      }
      if (benchmark) {
        console.log(
          "MEMORY_RETRIEVAL_GOLDEN",
          createHash("sha256")
            .update(
              JSON.stringify(golden, (_key, value: unknown) => {
                if (value && typeof value === "object" && !Array.isArray(value)) {
                  return Object.fromEntries(
                    Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)),
                  );
                }
                return value;
              }),
            )
            .digest("hex"),
        );
      }
    } finally {
      observer.restore();
      date.mockRestore();
    }
  });
});
