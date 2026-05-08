import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";

export type AcpParentStreamEventRow = {
  runId: string;
  seq: number;
  event: Record<string, unknown>;
  createdAt: number;
};

export type RecordAcpParentStreamEventOptions = OpenClawAgentDatabaseOptions & {
  runId: string;
  event: Record<string, unknown>;
  createdAt?: number;
};

type AcpParentStreamEventSqlRow = {
  run_id: string;
  seq: number | bigint;
  event_json: string;
  created_at: number | bigint;
};

type AcpParentStreamDatabase = Pick<OpenClawAgentKyselyDatabase, "acp_parent_stream_events">;

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function parseEventRow(row: AcpParentStreamEventSqlRow): AcpParentStreamEventRow | null {
  try {
    const parsed = JSON.parse(row.event_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return {
      runId: row.run_id,
      seq: toNumber(row.seq),
      event: parsed as Record<string, unknown>,
      createdAt: toNumber(row.created_at),
    };
  } catch {
    return null;
  }
}

export function recordAcpParentStreamEvent(options: RecordAcpParentStreamEventOptions): number {
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AcpParentStreamDatabase>(database.db);
    const current = executeSqliteQueryTakeFirstSync<{ seq?: number | bigint }>(
      database.db,
      db
        .selectFrom("acp_parent_stream_events")
        .select(["seq"])
        .where("run_id", "=", options.runId)
        .orderBy("seq", "desc")
        .limit(1),
    );
    const nextSeq = toNumber(current?.seq ?? 0) + 1;
    const createdAt = options.createdAt ?? Date.now();
    executeSqliteQuerySync(
      database.db,
      db.insertInto("acp_parent_stream_events").values({
        run_id: options.runId,
        seq: nextSeq,
        event_json: JSON.stringify(options.event),
        created_at: createdAt,
      }),
    );
    return nextSeq;
  }, options);
}

export function listAcpParentStreamEvents(
  options: OpenClawAgentDatabaseOptions & { runId: string },
): AcpParentStreamEventRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AcpParentStreamDatabase>(database.db);
  const rows = executeSqliteQuerySync<AcpParentStreamEventSqlRow>(
    database.db,
    db
      .selectFrom("acp_parent_stream_events")
      .select(["run_id", "seq", "event_json", "created_at"])
      .where("run_id", "=", options.runId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const parsed = parseEventRow(row);
    return parsed ? [parsed] : [];
  });
}
