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

function insertChildren<T>(
  db: DatabaseSync,
  table: (typeof CARD_CHILD_TABLES)[number],
  cardId: string,
  entries: readonly T[] | undefined,
  fields: (entry: T, ordinal: number) => Record<string, () => SQLInputValue>,
): void {
  const deletion = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<Record<typeof table, Row>>(db)
      .deleteFrom(table)
      .where("card_id", "=", cardId),
  );
  db.prepare(deletion.compiled.sql).run(...deletion.bind());
  entries?.forEach((entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((parameter) =>
      getNodeSqliteKysely<WorkboardCardDatabase>(db)
        .insertInto(table)
        .values(
          Object.fromEntries(
            Object.entries(fields(entry, ordinal)).map(([column, read]) => [
              column,
              parameter(read),
            ]),
          ),
        ),
    );
    // Defer payload getters until native preparation succeeds, as for the parent row.
    db.prepare(compiled.sql).run(...bind());
  });
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
  // Keep payload getters and JSON serialization after native statement preparation.
  const parent = compileSqliteQueryBindings<void>((p) =>
    query
      .insertInto("workboard_cards")
      .values({
        id: p(() => card.id),
        board_id: p(() => cardBoardId(card)),
        title: p(() => card.title),
        notes: p(() => bindNull(card.notes)),
        status: p(() => card.status),
        priority: p(() => card.priority),
        agent_id: p(() => bindNull(card.agentId)),
        session_key: p(() => bindNull(card.sessionKey)),
        run_id: p(() => bindNull(card.runId)),
        source_url: p(() => bindNull(card.sourceUrl)),
        position: p(() => card.position),
        created_at: p(() => card.createdAt),
        updated_at: p(() => card.updatedAt),
        started_at: p(() => bindNull(card.startedAt)),
        completed_at: p(() => bindNull(card.completedAt)),
        execution_id: p(() => bindNull(execution?.id)),
        execution_kind: p(() => bindNull(execution?.kind)),
        execution_engine: p(() => bindNull(execution?.engine)),
        execution_mode: p(() => bindNull(execution?.mode)),
        execution_status: p(() => bindNull(execution?.status)),
        execution_model: p(() => bindNull(execution?.model)),
        execution_session_key: p(() => bindNull(execution?.sessionKey)),
        execution_run_id: p(() => bindNull(execution?.runId)),
        execution_started_at: p(() => bindNull(execution?.startedAt)),
        execution_updated_at: p(() => bindNull(execution?.updatedAt)),
        automation_json: p(() => jsonValue(metadata?.automation)),
        claim_json: p(() => jsonValue(metadata?.claim)),
        template_id: p(() => bindNull(metadata?.templateId)),
        archived_at: p(() => bindNull(metadata?.archivedAt)),
        stale_json: p(() => jsonValue(metadata?.stale)),
        lifecycle_status_source_updated_at: p(() =>
          bindNull(metadata?.lifecycleStatusSourceUpdatedAt),
        ),
        failure_count: p(() => bindNull(metadata?.failureCount)),
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) => ({
          board_id: eb.ref("excluded.board_id"),
          title: eb.ref("excluded.title"),
          notes: eb.ref("excluded.notes"),
          status: eb.ref("excluded.status"),
          priority: eb.ref("excluded.priority"),
          agent_id: eb.ref("excluded.agent_id"),
          session_key: eb.ref("excluded.session_key"),
          run_id: eb.ref("excluded.run_id"),
          source_url: eb.ref("excluded.source_url"),
          position: eb.ref("excluded.position"),
          created_at: eb.ref("excluded.created_at"),
          updated_at: eb.ref("excluded.updated_at"),
          started_at: eb.ref("excluded.started_at"),
          completed_at: eb.ref("excluded.completed_at"),
          execution_id: eb.ref("excluded.execution_id"),
          execution_kind: eb.ref("excluded.execution_kind"),
          execution_engine: eb.ref("excluded.execution_engine"),
          execution_mode: eb.ref("excluded.execution_mode"),
          execution_status: eb.ref("excluded.execution_status"),
          execution_model: eb.ref("excluded.execution_model"),
          execution_session_key: eb.ref("excluded.execution_session_key"),
          execution_run_id: eb.ref("excluded.execution_run_id"),
          execution_started_at: eb.ref("excluded.execution_started_at"),
          execution_updated_at: eb.ref("excluded.execution_updated_at"),
          automation_json: eb.ref("excluded.automation_json"),
          claim_json: eb.ref("excluded.claim_json"),
          template_id: eb.ref("excluded.template_id"),
          archived_at: eb.ref("excluded.archived_at"),
          stale_json: eb.ref("excluded.stale_json"),
          lifecycle_status_source_updated_at: eb.ref("excluded.lifecycle_status_source_updated_at"),
          failure_count: eb.ref("excluded.failure_count"),
        })),
      ),
  );
  db.prepare(parent.compiled.sql).run(...parent.bind());

  insertChildren(db, "workboard_card_labels", card.id, card.labels, (label, ordinal) => ({
    card_id: () => card.id,
    ordinal: () => ordinal,
    label: () => label,
  }));
  insertChildren(db, "workboard_card_events", card.id, card.events, (event, ordinal) => ({
    id: () => event.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    kind: () => event.kind,
    at: () => event.at,
    from_status: () => bindNull(event.fromStatus),
    to_status: () => bindNull(event.toStatus),
    session_key: () => bindNull(event.sessionKey),
    run_id: () => bindNull(event.runId),
  }));
  insertChildren(db, "workboard_card_attempts", card.id, metadata?.attempts, (entry, ordinal) => ({
    id: () => entry.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    status: () => entry.status,
    started_at: () => entry.startedAt,
    ended_at: () => bindNull(entry.endedAt),
    engine: () => bindNull(entry.engine),
    mode: () => bindNull(entry.mode),
    model: () => bindNull(entry.model),
    session_key: () => bindNull(entry.sessionKey),
    run_id: () => bindNull(entry.runId),
    error: () => bindNull(entry.error),
  }));
  insertChildren(db, "workboard_card_comments", card.id, metadata?.comments, (entry, ordinal) => ({
    id: () => entry.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    body: () => entry.body,
    created_at: () => entry.createdAt,
    updated_at: () => bindNull(entry.updatedAt),
  }));
  insertChildren(db, "workboard_card_links", card.id, metadata?.links, (entry, ordinal) => ({
    id: () => entry.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    type: () => entry.type,
    target_card_id: () => bindNull(entry.targetCardId),
    title: () => bindNull(entry.title),
    url: () => bindNull(entry.url),
    created_at: () => entry.createdAt,
  }));
  insertChildren(db, "workboard_card_proof", card.id, metadata?.proof, (entry, ordinal) => ({
    id: () => entry.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    status: () => entry.status,
    label: () => bindNull(entry.label),
    command: () => bindNull(entry.command),
    url: () => bindNull(entry.url),
    note: () => bindNull(entry.note),
    created_at: () => entry.createdAt,
  }));
  insertChildren(
    db,
    "workboard_card_artifacts",
    card.id,
    metadata?.artifacts,
    (entry, ordinal) => ({
      id: () => entry.id,
      card_id: () => card.id,
      ordinal: () => ordinal,
      label: () => bindNull(entry.label),
      url: () => bindNull(entry.url),
      path: () => bindNull(entry.path),
      mime_type: () => bindNull(entry.mimeType),
      created_at: () => entry.createdAt,
    }),
  );
  insertChildren(
    db,
    "workboard_card_attachments",
    card.id,
    metadata?.attachments,
    (entry, ordinal) => ({
      id: () => entry.id,
      card_id: () => entry.cardId,
      ordinal: () => ordinal,
      file_name: () => entry.fileName,
      byte_size: () => entry.byteSize,
      mime_type: () => bindNull(entry.mimeType),
      note: () => bindNull(entry.note),
      created_at: () => entry.createdAt,
    }),
  );
  insertChildren(
    db,
    "workboard_card_diagnostics",
    card.id,
    metadata?.diagnostics,
    (entry, ordinal) => ({
      card_id: () => card.id,
      ordinal: () => ordinal,
      kind: () => entry.kind,
      severity: () => entry.severity,
      title: () => entry.title,
      detail: () => entry.detail,
      first_seen_at: () => entry.firstSeenAt,
      last_seen_at: () => entry.lastSeenAt,
      count: () => entry.count,
      actions_json: () => JSON.stringify(entry.actions),
    }),
  );
  insertChildren(
    db,
    "workboard_card_notifications",
    card.id,
    metadata?.notifications,
    (entry, ordinal) => ({
      id: () => entry.id,
      card_id: () => card.id,
      ordinal: () => ordinal,
      kind: () => entry.kind,
      message: () => entry.message,
      created_at: () => entry.createdAt,
      sequence: () => bindNull(entry.sequence),
      session_key: () => bindNull(entry.sessionKey),
      run_id: () => bindNull(entry.runId),
    }),
  );
  insertChildren(db, "workboard_worker_logs", card.id, metadata?.workerLogs, (entry, ordinal) => ({
    id: () => entry.id,
    card_id: () => card.id,
    ordinal: () => ordinal,
    level: () => entry.level,
    message: () => entry.message,
    created_at: () => entry.createdAt,
    session_key: () => bindNull(entry.sessionKey),
    run_id: () => bindNull(entry.runId),
  }));
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
