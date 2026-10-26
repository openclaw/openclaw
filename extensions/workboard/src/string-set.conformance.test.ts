import path from "node:path";
import { sql } from "kysely";
import { withEngineStoreAdmission } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCardChildRows, type WorkboardCardDatabase } from "./sqlite-store-records.js";
import { createWorkboardDatabase } from "./sqlite-store-schema.js";
import { workboardTestDatabaseInput } from "./test/database-config.js";

const postgresInput = workboardTestDatabaseInput();
const selectionCases = [
  { name: "empty", values: [], expected: [] },
  { name: "single", values: ["alpha"], expected: ["alpha"] },
  { name: "duplicates", values: ["beta", "alpha", "beta"], expected: ["alpha", "beta"] },
  { name: "missing", values: ["absent"], expected: [] },
  { name: "mixed", values: ["absent", "beta"], expected: ["beta"] },
];

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !postgresInput)(
    `${engine} Workboard string-set preload`,
    () => {
      let owner: ReturnType<typeof createWorkboardDatabase> | undefined;
      let schema: string | undefined;
      const dirs = useAutoCleanupTempDirTracker((cleanup) =>
        afterAll(async () => {
          try {
            withEngineStoreAdmission(() => owner?.close());
            if (schema && postgresInput) {
              const client = new Client({ connectionString: postgresInput.connection });
              await client.connect();
              try {
                await client.query(`DROP SCHEMA "${schema.replaceAll('"', '""')}" CASCADE`);
              } finally {
                await client.end();
              }
            }
          } finally {
            cleanup();
          }
        }),
      );

      beforeAll(() =>
        withEngineStoreAdmission(() => {
          owner = createWorkboardDatabase(
            path.join(dirs.make("workboard-string-set-"), "workboard.sqlite"),
            undefined,
            engine === "postgres" ? postgresInput : undefined,
          );
          const { db } = owner;
          if (engine === "postgres") {
            const row = db.prepare("SELECT current_schema() AS schema").get();
            if (typeof row?.schema !== "string") {
              throw new Error("Workboard PostgreSQL schema is unavailable");
            }
            schema = row.schema;
          }
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare(
              "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES ('board', 1, 1)",
            ).run();
            for (const [index, id] of ["alpha", "beta", "unrelated"].entries()) {
              db.prepare(
                "INSERT INTO workboard_cards (id, board_id, title, status, priority, position, created_at, updated_at) VALUES (?, 'board', ?, 'todo', 'normal', ?, 1, 1)",
              ).run(id, id, index);
              db.prepare(
                "INSERT INTO workboard_card_events (id, card_id, ordinal, kind, at) VALUES (?, ?, 0, 'created', 1)",
              ).run(`event-${id}`, id);
            }
          });
        }),
      );

      it.each(selectionCases)("preserves $name selection", ({ values, expected }) =>
        withEngineStoreAdmission(() => {
          if (!owner) {
            throw new Error("Workboard fixture is unavailable");
          }
          const { db } = owner;
          // ASCII fixture IDs have the same encoding as the previous PG lowering.
          const previousSet =
            engine === "postgres"
              ? /* kysely-allow-raw: Keep the previous PG lowering as a semantic control. */
                sql<string>`(SELECT value FROM json_array_elements_text(${JSON.stringify(values)}::json) AS value)`
              : sqliteStringSet(values);
          const previous = executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<WorkboardCardDatabase>(db)
              .selectFrom("workboard_card_events")
              .select(["id", "card_id"])
              .where("card_id", "in", previousSet)
              .orderBy("card_id")
              .orderBy("ordinal"),
          ).rows;
          expect(previous).toEqual(expected.map((id) => ({ id: `event-${id}`, card_id: id })));
          const current = loadCardChildRows(db, values).byTable.get("workboard_card_events");
          if (!current) {
            throw new Error("Workboard event preload is missing");
          }
          expect([...current.keys()]).toEqual(expected);
          expect([...current.values()].flat().map((row) => row.id)).toEqual(
            expected.map((id) => `event-${id}`),
          );
        }),
      );
    },
  );
}
