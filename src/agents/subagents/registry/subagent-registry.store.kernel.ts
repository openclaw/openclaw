import { getPostgresPhysicalFacts } from "../../../infra/database-engine/physical-facts.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../../../infra/sqlite-schema-facts.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { recordSessionStateEventsInDatabase } from "../../../sessions/session-state-events.kernel.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import { ensureColumn, readTableColumns } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
// Eight bound columns per row keep each statement within 1,024 parameters.
const MAX_SUBAGENT_UPSERT_ROWS = 128;

export function hasParentStoreColumns(db: EngineConnection): boolean {
  const schema = getPostgresPhysicalFacts(db) ?? getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Subagent rows require admitted schema facts");
  }
  const columns = readTableColumns(db, "subagent_runs");
  return columns.has("requester_store_path") && columns.has("controller_store_path");
}

/** Applies selected row changes inside the caller's transaction. */
export function writeSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  values: readonly SubagentRunSqliteRow[],
  deleteRunIds: readonly string[],
  removal?: { reason: string; terminalRows?: ReadonlyMap<string, SubagentRunRecord> },
): void {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  if (values.length > 0 && !hasParentStoreColumns(db)) {
    ensureColumn(db, "subagent_runs", "requester_store_path TEXT");
    ensureColumn(db, "subagent_runs", "controller_store_path TEXT");
  }
  for (let offset = 0; offset < values.length; offset += MAX_SUBAGENT_UPSERT_ROWS) {
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("subagent_runs")
        .values(values.slice(offset, offset + MAX_SUBAGENT_UPSERT_ROWS))
        .onConflict((conflict) =>
          conflict.column("run_id").doUpdateSet((eb) => ({
            child_session_key: eb.ref("excluded.child_session_key"),
            controller_session_key: eb.ref("excluded.controller_session_key"),
            requester_session_key: eb.ref("excluded.requester_session_key"),
            requester_store_path: eb.ref("excluded.requester_store_path"),
            controller_store_path: eb.ref("excluded.controller_store_path"),
            created_at: eb.ref("excluded.created_at"),
            payload_json: eb.ref("excluded.payload_json"),
          })),
        ),
    );
  }
  if (deleteRunIds.length > 0) {
    const removed = executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds).returningAll(),
    ).rows;
    const now = Date.now();
    // A removal and its terminal receipt commit together, including native completion retirement.
    recordSessionStateEventsInDatabase(
      db,
      removed.map((row) => {
        const entry = removal?.terminalRows?.get(row.run_id) ?? rowToSubagentRunRecord(row);
        const delivery = entry?.delivery;
        const outcome =
          delivery?.status === "delivered" || delivery?.status === "suspended"
            ? delivery.status
            : "discarded";
        return {
          now,
          event: {
            kind: "child_delivery_removed" as const,
            actorType: "system" as const,
            sessionKey: row.requester_session_key,
            sessionId: entry?.completionRequesterSessionId,
            agentId:
              entry?.requesterAgentId ??
              parseAgentSessionKey(row.requester_session_key)?.agentId ??
              "main",
            runId: row.run_id,
            summary: `Subagent delivery ${outcome}; registry row removed`,
            payload: {
              outcome,
              reason:
                delivery?.discardReason ??
                delivery?.suspendedReason ??
                removal?.reason ??
                "owner_released",
              previousStatus: delivery?.status,
              childSessionKey: row.child_session_key,
              deliveredAt: delivery?.deliveredAt,
              suspendedAt: delivery?.suspendedAt,
              lastError: delivery?.lastError ?? delivery?.discardedPayloadSummary?.lastError,
            },
          },
        };
      }),
    );
  }
}
