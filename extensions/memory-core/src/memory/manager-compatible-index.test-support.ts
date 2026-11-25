import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

function withMemoryDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export async function closeCompatibleIndexManagers() {
  const { closeAllMemorySearchManagers } = await import("./index.js");
  await closeAllMemorySearchManagers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

const readChunks = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all();
export const readCompatibleIndexChunks = (dbPath: string) =>
  withMemoryDatabase(dbPath, readChunks, true);

export function seedLegacyMemoryIndex(dbPath: string, identity: object) {
  return withMemoryDatabase(dbPath, (db) => {
    const chunks = readChunks(db);
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get();
    assert(typeof row?.value === "string", "fixture memory metadata is unavailable");
    const meta = JSON.parse(row.value) as MemoryIndexMeta;
    const providerKey = hashText(JSON.stringify(identity));
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
      JSON.stringify({ ...meta, providerKey }),
    );
    db.prepare("UPDATE memory_embedding_cache SET provider_key = ?").run(providerKey);
    return chunks;
  });
}
