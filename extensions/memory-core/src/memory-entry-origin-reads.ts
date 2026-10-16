import type { DatabaseSync } from "node:sqlite";
import { readMemoryEntryOriginsInDatabase } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { withOpenClawAgentDatabaseReadOnly } from "openclaw/plugin-sdk/sqlite-runtime";
import { tableExists } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  MEMORY_SESSION_TOMBSTONE_BATCH_SIZE,
  type MemoryOriginReadInput,
  type MemoryOriginReadOutput,
} from "./memory-entry-origins-task.js";
import { requireMemorySearchDatabase } from "./memory-search-database.js";
import { hasMemorySessionTombstone } from "./memory-session-tombstones.js";

function queryOrigins(
  db: DatabaseSync | undefined,
  request: MemoryOriginReadInput,
): MemoryOriginReadOutput {
  if (request.kind === "origin-rows") {
    return {
      kind: request.kind,
      rows:
        db && tableExists(db, "memory_entry_origins")
          ? readMemoryEntryOriginsInDatabase(db, request)
          : [],
    };
  }
  if (!db) {
    return { kind: request.kind, indices: [] };
  }
  const indices: number[] = [];
  const length = Math.min(request.sessionIds.length, MEMORY_SESSION_TOMBSTONE_BATCH_SIZE);
  for (let index = 0; index < length; index += 1) {
    if (hasMemorySessionTombstone(db, request.agentId, request.sessionIds[index]!)) {
      indices.push(index);
    }
  }
  return {
    kind: request.kind,
    indices,
  };
}

export function readMemoryOriginsInWorker(request: MemoryOriginReadInput): MemoryOriginReadOutput {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => queryOrigins(requireMemorySearchDatabase(db), request),
    {
      agentId: request.agentId,
      path: request.databasePath,
      env: { OPENCLAW_STATE_DIR: request.stateDir },
    },
  );
  return result.found ? result.value : queryOrigins(undefined, request);
}
