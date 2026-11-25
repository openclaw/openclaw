import { readFileSync } from "node:fs";
import type { Connection, Table } from "@lancedb/lancedb";
import type { FileLockHandle } from "openclaw/plugin-sdk/file-lock";
import { acquireMemoryTableUsage } from "./lancedb-custody.js";

type MemoryStatsRequest = {
  dbPath: string;
  fileLockUrl?: string;
  storageOptions?: Record<string, string>;
  tableName: string;
  predicate: string;
};

// The child owns uncancellable native calls and only reads existing memory data.
export async function runMemoryStatsReader(
  loadLanceDbModule: typeof import("./lancedb-runtime.js").loadLanceDbModule,
): Promise<void> {
  const input: MemoryStatsRequest = JSON.parse(readFileSync(0, "utf8"));
  let db: Connection | undefined;
  let table: Table | undefined;
  let usage: FileLockHandle | null = null;
  const result: { columns?: string[]; count?: number; error?: string } = {};
  try {
    usage = await acquireMemoryTableUsage(
      input.dbPath,
      input.fileLockUrl ? await import(input.fileLockUrl) : undefined,
    );
    const lancedb = await loadLanceDbModule();
    db = await lancedb.connect(input.dbPath, { storageOptions: input.storageOptions });
    if ((await db.tableNames()).includes(input.tableName)) {
      table = await db.openTable(input.tableName);
      result.columns = (await table.schema()).fields.map((field) => field.name);
      result.count = await table.countRows(input.predicate);
    } else {
      result.count = 0;
    }
  } catch (error) {
    result.error = String(error);
  } finally {
    table?.close();
    db?.close();
    await usage?.release();
  }
  process.stdout.write(JSON.stringify(result));
}
