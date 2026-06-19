import { promises as fs } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";

export type SqliteSnapshotResult = {
  readonly userVersion: number;
};

export async function createVacuumedSqliteSnapshot(params: {
  readonly sourcePath: string;
  readonly targetPath: string;
}): Promise<SqliteSnapshotResult> {
  await fs.rm(params.targetPath, { force: true });
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(params.sourcePath, {
    allowExtension: true,
    readOnly: true,
  });
  let userVersion: number;
  try {
    source.exec("PRAGMA busy_timeout = 30000;");
    userVersion = readSqliteUserVersion(source);
    // Loading sqlite-vec keeps vec0-backed memory indexes vacuumable while
    // VACUUM INTO removes deleted-page remnants before the snapshot is stored.
    await loadSqliteVecExtension({ db: source });
    source.prepare("VACUUM INTO ?").run(params.targetPath);
  } finally {
    source.close();
  }
  await fs.chmod(params.targetPath, 0o600);
  return { userVersion };
}

export function verifySqliteDatabaseIntegrity(databasePath: string): readonly string[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check;").all() as Array<{ integrity_check: string }>;
    const messages = rows.map((row) => row.integrity_check);
    if (messages.length !== 1 || messages[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${databasePath}: ${messages.join("; ")}`);
    }
    return messages;
  } finally {
    db.close();
  }
}

function readSqliteUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version;").get() as { user_version: number | bigint };
  const value = row.user_version;
  return typeof value === "bigint" ? Number(value) : value;
}
