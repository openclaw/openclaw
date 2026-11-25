import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspectWorkboardCardOrphans } from "@openclaw/workboard-contract";
import {
  assertSqliteIntegrity,
  backupDoctorSqliteRepair,
} from "openclaw/plugin-sdk/doctor-repair-runtime";
import { syncDirectory } from "openclaw/plugin-sdk/file-access-runtime";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

function hasDatabase(databasePath: string): boolean {
  const stat = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) {
    throw new Error("Workboard orphan repair requires a regular database file.");
  }
  return stat !== undefined;
}

function requireOrphanPlan(database: DatabaseSync) {
  const plan = inspectWorkboardCardOrphans(database);
  if (!plan) {
    throw new Error(
      "Workboard orphan repair refused unrelated foreign-key violations or an unrecognized card-child constraint or trigger.",
    );
  }
  return plan;
}

export function detectWorkboardCardOrphans(databasePath: string) {
  if (!hasDatabase(databasePath)) {
    return null;
  }
  using database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  const { count } = requireOrphanPlan(database);
  return count > 0 ? { preview: [`Workboard has ${count} orphaned card rows.`] } : null;
}

function orphanPredicate(table: string): string {
  // Table names come from the Workboard recovery allowlist, never from row payloads.
  return `"${table}".card_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workboard_cards WHERE workboard_cards.id = "${table}".card_id
  )`;
}

function* orphanExport(database: DatabaseSync, tables: readonly string[]) {
  for (const table of tables) {
    const statement = database.prepare(
      `SELECT * FROM "${table}" WHERE ${orphanPredicate(table)} ORDER BY rowid`,
    );
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      yield `${JSON.stringify({ table, row }, (_key, value: unknown) =>
        typeof value === "bigint"
          ? value.toString()
          : value instanceof Uint8Array
            ? { base64: Buffer.from(value).toString("base64") }
            : value,
      )}\n`;
    }
  }
}

/** Explicit Doctor repair; the host holds the exclusive state maintenance lock. */
export async function repairWorkboardCardOrphans(databasePath: string) {
  if (!hasDatabase(databasePath)) {
    return { changes: [], warnings: [] };
  }
  // Do not cascade into otherwise healthy rows if a future schema adds dependents.
  // The full post-check rejects any new or remaining FK violation before commit.
  using database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(databasePath), {
    enableForeignKeyConstraints: false,
  });
  if (requireOrphanPlan(database).count === 0) {
    return { changes: [], warnings: [] };
  }
  const backup = await backupDoctorSqliteRepair(databasePath, "workboard-card-orphans");
  const directory = path.dirname(backup);
  try {
    const savedHash = createHash("sha256");
    using preserved = openNodeSqliteDatabase(backup, { readOnly: true });
    {
      await using output = await fs.promises.open(
        path.join(directory, "orphan-rows.jsonl"),
        "wx",
        0o600,
      );
      for (const line of orphanExport(preserved, requireOrphanPlan(preserved).tables)) {
        await output.writeFile(line);
        savedHash.update(line);
      }
      await output.sync();
    }
    if ((await syncDirectory(directory)).status === "unsupported" && process.platform !== "win32") {
      throw new Error("Could not synchronize the Workboard recovery directory.");
    }
    database.exec("PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
    const count = runSqliteImmediateTransactionSync(database, () => {
      const plan = requireOrphanPlan(database);
      const currentHash = createHash("sha256");
      for (const line of orphanExport(database, plan.tables)) {
        currentHash.update(line);
      }
      if (currentHash.digest("hex") !== savedHash.digest("hex")) {
        throw new Error("Workboard orphan rows changed after the pre-repair backup.");
      }
      let deleted = 0;
      for (const table of plan.tables) {
        deleted += Number(
          database.prepare(`DELETE FROM "${table}" WHERE ${orphanPredicate(table)}`).run().changes,
        );
      }
      if (deleted !== plan.count) {
        throw new Error("Workboard repair would delete an unexpected number of rows.");
      }
      assertSqliteIntegrity(database, databasePath);
      return deleted;
    });
    return {
      changes: [
        `Recovered ${count} orphaned Workboard card rows; backup and row export: ${directory}`,
      ],
      warnings: [],
    };
  } catch (error) {
    throw new Error(
      `Workboard orphan repair did not complete; retained backup: ${backup}. ${String(error)}`,
      {
        cause: error,
      },
    );
  }
}
