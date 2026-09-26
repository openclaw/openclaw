import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import {
  compileSqliteQueryBindings,
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
  insert: (entry: T, ordinal: number) => void,
): void {
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<Record<typeof table, Row>>(db)
      .deleteFrom(table)
      .where("card_id", "=", cardId),
  );
  db.prepare(compiled.sql).run(...bind());
  entries?.forEach(insert);
}

export function insertCard(db: DatabaseSync, card: WorkboardCard): void {
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

  insertChildren(db, "workboard_card_labels", card.id, card.labels, (label, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_labels").values({
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        label: p(() => label),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_events", card.id, card.events, (event, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_events").values({
        id: p(() => event.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        kind: p(() => event.kind),
        at: p(() => event.at),
        from_status: p(() => bindNull(event.fromStatus)),
        to_status: p(() => bindNull(event.toStatus)),
        session_key: p(() => bindNull(event.sessionKey)),
        run_id: p(() => bindNull(event.runId)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_attempts", card.id, metadata?.attempts, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_attempts").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        status: p(() => entry.status),
        started_at: p(() => entry.startedAt),
        ended_at: p(() => bindNull(entry.endedAt)),
        engine: p(() => bindNull(entry.engine)),
        mode: p(() => bindNull(entry.mode)),
        model: p(() => bindNull(entry.model)),
        session_key: p(() => bindNull(entry.sessionKey)),
        run_id: p(() => bindNull(entry.runId)),
        error: p(() => bindNull(entry.error)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_comments", card.id, metadata?.comments, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_comments").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        body: p(() => entry.body),
        created_at: p(() => entry.createdAt),
        updated_at: p(() => bindNull(entry.updatedAt)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_links", card.id, metadata?.links, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_links").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        type: p(() => entry.type),
        target_card_id: p(() => bindNull(entry.targetCardId)),
        title: p(() => bindNull(entry.title)),
        url: p(() => bindNull(entry.url)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_proof", card.id, metadata?.proof, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_proof").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        status: p(() => entry.status),
        label: p(() => bindNull(entry.label)),
        command: p(() => bindNull(entry.command)),
        url: p(() => bindNull(entry.url)),
        note: p(() => bindNull(entry.note)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_artifacts", card.id, metadata?.artifacts, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_artifacts").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        label: p(() => bindNull(entry.label)),
        url: p(() => bindNull(entry.url)),
        path: p(() => bindNull(entry.path)),
        mime_type: p(() => bindNull(entry.mimeType)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(
    db,
    "workboard_card_attachments",
    card.id,
    metadata?.attachments,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_attachments").values({
          id: p(() => entry.id),
          card_id: p(() => entry.cardId),
          ordinal: p(() => ordinal),
          file_name: p(() => entry.fileName),
          byte_size: p(() => entry.byteSize),
          mime_type: p(() => bindNull(entry.mimeType)),
          note: p(() => bindNull(entry.note)),
          created_at: p(() => entry.createdAt),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(
    db,
    "workboard_card_diagnostics",
    card.id,
    metadata?.diagnostics,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_diagnostics").values({
          card_id: p(() => card.id),
          ordinal: p(() => ordinal),
          kind: p(() => entry.kind),
          severity: p(() => entry.severity),
          title: p(() => entry.title),
          detail: p(() => entry.detail),
          first_seen_at: p(() => entry.firstSeenAt),
          last_seen_at: p(() => entry.lastSeenAt),
          count: p(() => entry.count),
          actions_json: p(() => JSON.stringify(entry.actions)),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(
    db,
    "workboard_card_notifications",
    card.id,
    metadata?.notifications,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_notifications").values({
          id: p(() => entry.id),
          card_id: p(() => card.id),
          ordinal: p(() => ordinal),
          kind: p(() => entry.kind),
          message: p(() => entry.message),
          created_at: p(() => entry.createdAt),
          sequence: p(() => bindNull(entry.sequence)),
          session_key: p(() => bindNull(entry.sessionKey)),
          run_id: p(() => bindNull(entry.runId)),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(db, "workboard_worker_logs", card.id, metadata?.workerLogs, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_worker_logs").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        level: p(() => entry.level),
        message: p(() => entry.message),
        created_at: p(() => entry.createdAt),
        session_key: p(() => bindNull(entry.sessionKey)),
        run_id: p(() => bindNull(entry.runId)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
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
