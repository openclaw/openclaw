import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import {
  compileSqliteQueryBindings,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  jsonValue,
  type CARD_CHILD_TABLES,
  type Row,
  type WorkboardCardDatabase,
} from "./sqlite-store-records.js";

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

export function bindNull(value: unknown): SQLInputValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value ?? null;
  }
  return JSON.stringify(value);
}

export function prepareWorkboardUpsert(
  db: DatabaseSync,
  table: "workboard_cards" | "workboard_boards" | "workboard_notification_subscriptions",
  fields: Record<string, () => SQLInputValue>,
  preserved: readonly string[] = [],
): () => void {
  const { compiled, bind } = compileSqliteQueryBindings<void>((parameter) =>
    getNodeSqliteKysely<Record<typeof table, Row>>(db)
      .insertInto(table)
      .values(
        Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, parameter(read)])),
      )
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) =>
          Object.fromEntries(
            Object.keys(fields)
              .filter((key) => key !== "id" && !preserved.includes(key))
              .map((key) => [key, eb.ref(`excluded.${key}`)]),
          ),
        ),
      ),
  );
  // Native preparation must precede payload getters and JSON serialization.
  const statement = db.prepare(compiled.sql);
  return () => {
    statement.run(...bind());
  };
}

function insertChildren<T>(
  db: DatabaseSync,
  table: (typeof CARD_CHILD_TABLES)[number],
  cardId: string,
  entries: readonly T[] | undefined,
  fields: Record<string, (entry: T) => SQLInputValue>,
): void {
  const deletion = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<Record<typeof table, Row>>(db)
      .deleteFrom(table)
      .where("card_id", "=", cardId),
  );
  db.prepare(deletion.compiled.sql).run(...deletion.bind());
  if (entries?.length) {
    const { compiled, bind } = compileSqliteQueryBindings<[T, number]>((parameter) =>
      getNodeSqliteKysely<WorkboardCardDatabase>(db)
        .insertInto(table)
        .values({
          ordinal: parameter(([, ordinal]) => ordinal),
          ...Object.fromEntries(
            Object.entries(fields).map(([column, read]) => [
              column,
              parameter(([entry]) => read(entry)),
            ]),
          ),
        }),
    );
    // Defer payload getters until native preparation succeeds, as for the parent row.
    const statement = db.prepare(compiled.sql);
    entries.forEach((entry, ordinal) => statement.run(...bind([entry, ordinal])));
  }
}

export function insertCard(db: DatabaseSync, card: WorkboardCard): void {
  const board = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<{ workboard_boards: { id: string; kind: string | null } }>(db)
      .selectFrom("workboard_boards")
      .select("kind")
      .where("id", "=", cardBoardId(card)),
  );
  if (board?.kind === "sessions") {
    throw new Error("Sessions boards do not hold cards");
  }
  const execution = card.execution;
  const metadata = card.metadata;
  const query = getNodeSqliteKysely<WorkboardCardDatabase>(db);
  prepareWorkboardUpsert(db, "workboard_cards", {
    id: () => card.id,
    board_id: () => cardBoardId(card),
    title: () => card.title,
    notes: () => bindNull(card.notes),
    status: () => card.status,
    priority: () => card.priority,
    agent_id: () => bindNull(card.agentId),
    session_key: () => bindNull(card.sessionKey),
    run_id: () => bindNull(card.runId),
    source_url: () => bindNull(card.sourceUrl),
    position: () => card.position,
    created_at: () => card.createdAt,
    updated_at: () => card.updatedAt,
    started_at: () => bindNull(card.startedAt),
    completed_at: () => bindNull(card.completedAt),
    execution_id: () => bindNull(execution?.id),
    execution_kind: () => bindNull(execution?.kind),
    execution_engine: () => bindNull(execution?.engine),
    execution_mode: () => bindNull(execution?.mode),
    execution_status: () => bindNull(execution?.status),
    execution_model: () => bindNull(execution?.model),
    execution_session_key: () => bindNull(execution?.sessionKey),
    execution_run_id: () => bindNull(execution?.runId),
    execution_started_at: () => bindNull(execution?.startedAt),
    execution_updated_at: () => bindNull(execution?.updatedAt),
    automation_json: () => jsonValue(metadata?.automation),
    claim_json: () => jsonValue(metadata?.claim),
    template_id: () => bindNull(metadata?.templateId),
    archived_at: () => bindNull(metadata?.archivedAt),
    stale_json: () => jsonValue(metadata?.stale),
    lifecycle_status_source_updated_at: () => bindNull(metadata?.lifecycleStatusSourceUpdatedAt),
    failure_count: () => bindNull(metadata?.failureCount),
  })();

  insertChildren(db, "workboard_card_labels", card.id, card.labels, {
    card_id: () => card.id,
    label: (label) => label,
  });
  insertChildren(db, "workboard_card_events", card.id, card.events, {
    id: (event) => event.id,
    card_id: () => card.id,
    kind: (event) => event.kind,
    at: (event) => event.at,
    from_status: (event) => bindNull(event.fromStatus),
    to_status: (event) => bindNull(event.toStatus),
    session_key: (event) => bindNull(event.sessionKey),
    run_id: (event) => bindNull(event.runId),
  });
  insertChildren(db, "workboard_card_attempts", card.id, metadata?.attempts, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    status: (entry) => entry.status,
    started_at: (entry) => entry.startedAt,
    ended_at: (entry) => bindNull(entry.endedAt),
    engine: (entry) => bindNull(entry.engine),
    mode: (entry) => bindNull(entry.mode),
    model: (entry) => bindNull(entry.model),
    session_key: (entry) => bindNull(entry.sessionKey),
    run_id: (entry) => bindNull(entry.runId),
    error: (entry) => bindNull(entry.error),
  });
  insertChildren(db, "workboard_card_comments", card.id, metadata?.comments, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    body: (entry) => entry.body,
    created_at: (entry) => entry.createdAt,
    updated_at: (entry) => bindNull(entry.updatedAt),
  });
  insertChildren(db, "workboard_card_links", card.id, metadata?.links, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    type: (entry) => entry.type,
    target_card_id: (entry) => bindNull(entry.targetCardId),
    title: (entry) => bindNull(entry.title),
    url: (entry) => bindNull(entry.url),
    created_at: (entry) => entry.createdAt,
  });
  insertChildren(db, "workboard_card_proof", card.id, metadata?.proof, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    status: (entry) => entry.status,
    label: (entry) => bindNull(entry.label),
    command: (entry) => bindNull(entry.command),
    url: (entry) => bindNull(entry.url),
    note: (entry) => bindNull(entry.note),
    created_at: (entry) => entry.createdAt,
  });
  insertChildren(db, "workboard_card_artifacts", card.id, metadata?.artifacts, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    label: (entry) => bindNull(entry.label),
    url: (entry) => bindNull(entry.url),
    path: (entry) => bindNull(entry.path),
    mime_type: (entry) => bindNull(entry.mimeType),
    created_at: (entry) => entry.createdAt,
  });
  insertChildren(db, "workboard_card_attachments", card.id, metadata?.attachments, {
    id: (entry) => entry.id,
    card_id: (entry) => entry.cardId,
    file_name: (entry) => entry.fileName,
    byte_size: (entry) => entry.byteSize,
    mime_type: (entry) => bindNull(entry.mimeType),
    note: (entry) => bindNull(entry.note),
    created_at: (entry) => entry.createdAt,
  });
  insertChildren(db, "workboard_card_diagnostics", card.id, metadata?.diagnostics, {
    card_id: () => card.id,
    kind: (entry) => entry.kind,
    severity: (entry) => entry.severity,
    title: (entry) => entry.title,
    detail: (entry) => entry.detail,
    first_seen_at: (entry) => entry.firstSeenAt,
    last_seen_at: (entry) => entry.lastSeenAt,
    count: (entry) => entry.count,
    actions_json: (entry) => JSON.stringify(entry.actions),
  });
  insertChildren(db, "workboard_card_notifications", card.id, metadata?.notifications, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    kind: (entry) => entry.kind,
    message: (entry) => entry.message,
    created_at: (entry) => entry.createdAt,
    sequence: (entry) => bindNull(entry.sequence),
    session_key: (entry) => bindNull(entry.sessionKey),
    run_id: (entry) => bindNull(entry.runId),
  });
  insertChildren(db, "workboard_worker_logs", card.id, metadata?.workerLogs, {
    id: (entry) => entry.id,
    card_id: () => card.id,
    level: (entry) => entry.level,
    message: (entry) => entry.message,
    created_at: (entry) => entry.createdAt,
    session_key: (entry) => bindNull(entry.sessionKey),
    run_id: (entry) => bindNull(entry.runId),
  });
  const protocolDelete = compileSqliteQueryBindings<void>((p) =>
    query.deleteFrom("workboard_worker_protocol").where(
      "card_id",
      "=",
      p(() => card.id),
    ),
  );
  db.prepare(protocolDelete.compiled.sql).run(...protocolDelete.bind());
  if (metadata?.workerProtocol) {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_worker_protocol").values({
        card_id: p(() => card.id),
        state: p(() => metadata.workerProtocol!.state),
        updated_at: p(() => metadata.workerProtocol!.updatedAt),
        detail: p(() => bindNull(metadata.workerProtocol!.detail)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  }
}
