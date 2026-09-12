import * as fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerBackend } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const reads = vi.hoisted(() => ({ queries: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/^select\b.*\bfrom "frames"/i.test(sql)) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...bindings) => {
            reads.queries += 1;
            return all(...bindings);
          });
          const get = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...bindings) => {
            reads.queries += 1;
            return get(...bindings);
          });
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
            reads.queries += 1;
            yield* iterate(...bindings);
            return undefined;
          });
        }
        return statement;
      });
      return database;
    },
  };
});

const backends: SqliteWorkerBackend<LogbookOperations>[] = [];
const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => Promise.resolve(backend.close())));
    databases.splice(0).forEach((database) => database.close());
    vi.restoreAllMocks();
    cleanup();
  }),
);
const day = "2026-07-03";

function seedFrames(expired: number) {
  const dataDir = tempDirs.make("logbook-prune-");
  const databasePath = path.join(dataDir, "logbook.sqlite");
  const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
  backends.push(backend);
  const database = new DatabaseSync(databasePath);
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const paths = Array.from({ length: expired + 1 }, (_, index) => {
    const file = path.join(dataDir, "frames", `${index}.jpg`);
    fs.writeFileSync(file, "synthetic frame");
    backend.execute({
      type: "insertFrame",
      input: {
        capturedAtMs: index,
        day,
        path: file,
        screenIndex: 0,
        byteSize: 15,
        contentHash: `frame-${index}`,
        idle: false,
      },
    });
    return file;
  });
  backend.execute({
    type: "replaceCardsInWindow",
    input: {
      day,
      startMs: 0,
      endMs: expired + 2,
      drafts: [1, expired + 1].map((id) => ({
        day,
        startMs: 0,
        endMs: expired + 2,
        title: `Card ${id}`,
        summary: "Retained card",
        detail: "",
        category: "coding",
        distractions: [],
        keyframeId: id,
      })),
    },
  });
  reads.queries = 0;
  return { backend, database, paths };
}

describe("Logbook frame pruning", () => {
  it.each([0, 1, 64, 65, 129])(
    "prunes %i expired frames with bounded reads while retaining recent frames and cards",
    (expired) => {
      const { backend, database, paths } = seedFrames(expired);
      expect(backend.execute({ type: "pruneFrames", input: { olderThanMs: expired } })).toBe(
        expired,
      );
      expect(reads.queries).toBeLessThanOrEqual(1 + Math.ceil(expired / 64));
      expect(reads.queries).toBeGreaterThan(0);
      expect(database.prepare("SELECT id FROM frames ORDER BY id").all()).toEqual([
        { id: expired + 1 },
      ]);
      expect(database.prepare("SELECT keyframe_id FROM cards ORDER BY id").all()).toEqual([
        { keyframe_id: expired === 0 ? 1 : null },
        { keyframe_id: expired + 1 },
      ]);
      expect(paths.map((file) => fs.existsSync(file))).toEqual([
        ...Array<boolean>(expired).fill(false),
        true,
      ]);
    },
  );

  it.each(["missing", "changed"] as const)(
    "rechecks a %s frame after file removal and preserves the transaction outcome across batches",
    async (change) => {
      const expired = 130;
      const { backend, database, paths } = seedFrames(expired);
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fs.rmSync).mockImplementation((file, options) => {
        actual.rmSync(file, options);
        if (file === paths[expired - 1]) {
          if (change === "missing") {
            database.prepare("DELETE FROM frames WHERE id = ?").run(expired);
          } else {
            database.prepare("UPDATE frames SET path = ? WHERE id = ?").run("changed.jpg", expired);
          }
        }
      });
      const prune = () => backend.execute({ type: "pruneFrames", input: { olderThanMs: expired } });
      if (change === "missing") {
        expect(prune()).toBe(expired - 1);
        expect(database.prepare("SELECT id FROM frames ORDER BY id").all()).toEqual([
          { id: expired + 1 },
        ]);
      } else {
        expect(prune).toThrow(`Logbook frame ${expired} changed path while pruning`);
        expect(database.prepare("SELECT count(*) AS count FROM frames").get()).toEqual({
          count: expired + 1,
        });
        expect(database.prepare("SELECT keyframe_id FROM cards ORDER BY id").all()).toEqual([
          { keyframe_id: 1 },
          { keyframe_id: expired + 1 },
        ]);
      }
      expect(paths.map((file) => fs.existsSync(file))).toEqual([
        ...Array<boolean>(expired).fill(false),
        true,
      ]);
    },
  );
});
