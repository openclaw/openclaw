import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../../state/openclaw-agent-db.generated.js";
import {
  type OpenClawAgentDatabaseOptions,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";

type AcpParentStreamDatabase = Pick<OpenClawAgentKyselyDatabase, "acp_parent_stream_events">;

export async function recordAcpParentStreamEventsForTest(
  options: OpenClawAgentDatabaseOptions & {
    sessionId: string;
    runId: string;
    events: Array<{ event: Record<string, unknown>; createdAt: number }>;
  },
): Promise<void> {
  // Seed historical diagnostics: live relays no longer write this table.
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AcpParentStreamDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("acp_parent_stream_events").values(
        options.events.map(({ event, createdAt }, seq) => ({
          session_id: options.sessionId,
          run_id: options.runId,
          seq,
          event_json: JSON.stringify(event),
          created_at: createdAt,
        })),
      ),
    );
  }, options);
}
