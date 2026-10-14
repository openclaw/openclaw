import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { withAuthProfileCredentialWrite } from "../../state/user-model-account-authority.js";
import {
  AGENT_AUTH_CELLS,
  AUTH_PROFILE_PRIMARY_ROW_KEY,
  SHARED_AUTH_CELL_KEYS,
  type AgentAuthProfileDatabase,
  type SharedAuthProfileDatabase,
} from "./sqlite-json.js";
import { recordAuthProfileNativeCommit } from "./store-update-commit.js";

/** Write one canonical auth cell on the caller's admitted transaction connection. */
export function writeAuthProfileJsonCell(
  database: EngineConnection,
  target: "store" | "state",
  kind: "agent" | "shared-state",
  payload: unknown,
): void {
  recordAuthProfileNativeCommit(database);
  const value = JSON.stringify(payload);
  const now = Date.now();
  const query =
    kind === "shared-state"
      ? getNodeSqliteKysely<SharedAuthProfileDatabase>(database)
          .insertInto("config_machine_state")
          .values({
            state_key: SHARED_AUTH_CELL_KEYS[target],
            value_json: value,
            updated_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.column("state_key").doUpdateSet({ value_json: value, updated_at_ms: now }),
          )
      : target === "store"
        ? getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
            .insertInto("auth_profile_store")
            .values({ store_key: AUTH_PROFILE_PRIMARY_ROW_KEY, store_json: value, updated_at: now })
            .onConflict((conflict) =>
              conflict.column("store_key").doUpdateSet({ store_json: value, updated_at: now }),
            )
        : getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
            .insertInto("auth_profile_state")
            .values({ state_key: AUTH_PROFILE_PRIMARY_ROW_KEY, state_json: value, updated_at: now })
            .onConflict((conflict) =>
              conflict.column("state_key").doUpdateSet({ state_json: value, updated_at: now }),
            );
  const write = () => executeSqliteQuerySync(database, query);
  if (target === "store") {
    withAuthProfileCredentialWrite(database, payload, write);
  } else {
    write();
  }
}

export function deleteAuthProfileJsonCell(
  database: EngineConnection,
  target: "store" | "state",
  kind: "agent" | "shared-state",
): void {
  recordAuthProfileNativeCommit(database);
  const cell = AGENT_AUTH_CELLS[target];
  const query =
    kind === "shared-state"
      ? getNodeSqliteKysely<SharedAuthProfileDatabase>(database)
          .deleteFrom("config_machine_state")
          .where("state_key", "=", SHARED_AUTH_CELL_KEYS[target])
      : getNodeSqliteKysely<AgentAuthProfileDatabase>(database)
          .deleteFrom(cell.table)
          .where(cell.key, "=", AUTH_PROFILE_PRIMARY_ROW_KEY);
  const write = () => executeSqliteQuerySync(database, query);
  if (target === "store") {
    withAuthProfileCredentialWrite(database, undefined, write);
  } else {
    write();
  }
}
