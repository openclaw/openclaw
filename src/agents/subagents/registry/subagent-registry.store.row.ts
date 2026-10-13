import { createHash } from "node:crypto";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";

export type SubagentRunSqliteRow = Selectable<OpenClawStateKyselyDatabase["subagent_runs"]>;

/** Include indexed facts because decoding treats them as authoritative over payload fields. */
export function subagentRunRowVersion(row: SubagentRunSqliteRow | undefined): string | null {
  return row
    ? createHash("sha256")
        .update(
          JSON.stringify([
            row.run_id,
            row.child_session_key,
            row.controller_session_key,
            row.requester_session_key,
            row.requester_store_path ?? null,
            row.controller_store_path ?? null,
            row.created_at,
            row.payload_json,
          ]),
        )
        .digest("hex")
    : null;
}
