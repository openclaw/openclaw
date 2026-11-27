import * as fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSqliteWorkerBackend } from "./store.worker.js";
import {
  DAY as day,
  cardDraft,
  frameInput,
  readRows,
  useLogbookFixture,
} from "./test-fixtures.test-support.js";

const reads = vi.hoisted(() => ({ queries: 0 }));
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
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

const { makeDir, defer } = useLogbookFixture("logbook-prune-");

function seedFrames(expired: number) {
  const dataDir = makeDir();
  const databasePath = path.join(dataDir, "logbook.sqlite");
  const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
  defer(() => backend.close());
  const paths = Array.from({ length: expired + 1 }, (_, index) => {
    const file = path.join(dataDir, "frames", `${index}.jpg`);
    fs.writeFileSync(file, "synthetic frame");
    backend.execute({
      type: "insertFrame",
      input: frameInput({ capturedAtMs: index, path: file }),
    });
    return file;
  });
  backend.execute({
    type: "replaceCardsInWindow",
    input: {
      day,
      startMs: 0,
      endMs: expired + 2,
      drafts: [1, expired + 1].map((id) => cardDraft({ startMs: id - 1, endMs: id })),
    },
  });
  reads.queries = 0;
  return { backend, databasePath, paths };
}

it.each([0, 129])(
  "prunes %i expired frames with bounded reads while retaining recent frames and cards",
  (expired) => {
    const { backend, databasePath, paths } = seedFrames(expired);
    expect(backend.execute({ type: "pruneFrames", input: { olderThanMs: expired } })).toBe(expired);
    expect(reads.queries).toBeLessThanOrEqual(1 + Math.ceil(expired / 64));
    expect(reads.queries).toBeGreaterThan(0);
    expect(readRows(databasePath, "SELECT id FROM frames ORDER BY id")).toEqual([
      { id: expired + 1 },
    ]);
    expect(readRows(databasePath, "SELECT keyframe_id FROM cards ORDER BY id")).toEqual([
      { keyframe_id: expired === 0 ? 1 : null },
      { keyframe_id: expired + 1 },
    ]);
    expect(paths.map((file) => fs.existsSync(file))).toEqual([
      ...Array<boolean>(expired).fill(false),
      true,
    ]);
  },
);
