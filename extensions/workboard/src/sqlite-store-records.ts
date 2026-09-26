import type { DatabaseSync } from "node:sqlite";
import type {
  WorkboardArtifact,
  WorkboardAttachment,
  WorkboardCard,
  WorkboardComment,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardExecution,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardProof,
  WorkboardRunAttempt,
  WorkboardWorkerLog,
} from "@openclaw/workboard-contract";
import {
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
export type Row = Record<string, unknown>;

export function jsonValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return JSON.parse(value);
}

export function stringValue(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(row: Row, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

export function requiredString(row: Row, key: string): string {
  const value = stringValue(row, key);
  if (!value) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

export function requiredNumber(row: Row, key: string): number {
  const value = numberValue(row, key);
  if (value === undefined) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

function optional<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

export function asBlobContent(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

export function blobToBase64(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (typeof value === "string") {
    return Buffer.from(value).toString("base64");
  }
  return "";
}

// Every child table a card row expands into. Reading one card issues one query per
// entry here; reading the whole board that way is a query per card per table, which
// is why the batch read path preloads them instead.
export const CARD_CHILD_TABLES = [
  "workboard_card_labels",
  "workboard_card_events",
  "workboard_card_attempts",
  "workboard_card_comments",
  "workboard_card_links",
  "workboard_card_proof",
  "workboard_card_artifacts",
  "workboard_card_attachments",
  "workboard_worker_logs",
  "workboard_card_diagnostics",
  "workboard_card_notifications",
] as const;

export type WorkboardCardDatabase = Record<
  (typeof CARD_CHILD_TABLES)[number] | "workboard_cards" | "workboard_worker_protocol",
  Row
>;

/**
 * Child rows for a whole batch of cards, grouped by card id.
 *
 * Present only on the batch read path. `lookup` passes none and keeps issuing the
 * per-card queries, which is already the cheapest shape for a single card.
 */
type CardChildRows = {
  byTable: Map<string, Map<string, Row[]>>;
  workerProtocol: Map<string, Row>;
};

function groupByCardId(rows: Iterable<Row>): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const cardId = stringValue(row, "card_id");
    if (!cardId) {
      continue;
    }
    const bucket = grouped.get(cardId);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(cardId, [row]);
    }
  }
  return grouped;
}

export function loadCardChildRows(db: DatabaseSync, cardIds?: string[]): CardChildRows {
  // Group raw rows only: every preload must finish before card decoding can fail.
  const query = getNodeSqliteKysely<WorkboardCardDatabase>(db);
  // Scope to captured IDs so a concurrent board move cannot discard a selected card's children.
  const selectedIds = cardIds ? sqliteStringSet(cardIds) : undefined;
  const byTable = new Map<string, Map<string, Row[]>>();
  for (const table of CARD_CHILD_TABLES) {
    // Same order the per-card query produces, so grouped buckets stay ordinal-sorted.
    let rows = query
      .selectFrom(table)
      .selectAll()
      .orderBy("card_id", "asc")
      .orderBy("ordinal", "asc");
    if (selectedIds) {
      rows = rows.where("card_id", "in", selectedIds);
    }
    byTable.set(table, groupByCardId(iterateSqliteQuerySync(db, rows)));
  }
  const workerProtocol = new Map<string, Row>();
  let protocols = query.selectFrom("workboard_worker_protocol").selectAll();
  if (selectedIds) {
    protocols = protocols.where("card_id", "in", selectedIds);
  }
  for (const row of iterateSqliteQuerySync(db, protocols)) {
    const cardId = stringValue(row, "card_id");
    if (cardId) {
      workerProtocol.set(cardId, row);
    }
  }
  return { byTable, workerProtocol };
}

function childRows(
  db: DatabaseSync,
  table: string,
  cardId: string,
  preloaded?: CardChildRows,
): Row[] {
  const cached = preloaded?.byTable.get(table);
  if (cached) {
    const rows = cached.get(cardId) ?? [];
    // Each table is read once per card. Release the raw rows as the decoded card
    // is built instead of retaining both complete representations of the board.
    cached.delete(cardId);
    return rows;
  }
  // Finish native extraction before decoding; a later row can contain the first error.
  return db.prepare(`SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`).all(cardId);
}

function workerProtocolRow(
  db: DatabaseSync,
  cardId: string,
  preloaded?: CardChildRows,
): Row | undefined {
  if (preloaded) {
    const row = preloaded.workerProtocol.get(cardId);
    preloaded.workerProtocol.delete(cardId);
    return row;
  }
  return db.prepare("SELECT * FROM workboard_worker_protocol WHERE card_id = ?").get(cardId);
}

function readLabels(db: DatabaseSync, cardId: string, preloaded?: CardChildRows): string[] {
  return childRows(db, "workboard_card_labels", cardId, preloaded).flatMap((row) => {
    const label = stringValue(row, "label");
    return label ? [label] : [];
  });
}

function readEvents(
  db: DatabaseSync,
  cardId: string,
  preloaded?: CardChildRows,
): WorkboardEvent[] | undefined {
  const events = childRows(db, "workboard_card_events", cardId, preloaded).map((row) => {
    const event: WorkboardEvent = {
      id: requiredString(row, "id"),
      // SAFETY: insertChildren persists the event kind from WorkboardEvent.
      kind: requiredString(row, "kind") as WorkboardEvent["kind"],
      at: requiredNumber(row, "at"),
    };
    const fromStatus = stringValue(row, "from_status");
    const toStatus = stringValue(row, "to_status");
    const sessionKey = stringValue(row, "session_key");
    const runId = stringValue(row, "run_id");
    if (fromStatus) {
      // SAFETY: Event status transitions are persisted from WorkboardEvent without translation.
      event.fromStatus = fromStatus as WorkboardEvent["fromStatus"];
    }
    if (toStatus) {
      // SAFETY: Event status transitions are persisted from WorkboardEvent without translation.
      event.toStatus = toStatus as WorkboardEvent["toStatus"];
    }
    if (sessionKey) {
      event.sessionKey = sessionKey;
    }
    if (runId) {
      event.runId = runId;
    }
    return event;
  });
  return events.length > 0 ? events : undefined;
}

function readExecution(row: Row): WorkboardExecution | undefined {
  const id = stringValue(row, "execution_id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    // SAFETY: insertCard persists the execution mode from WorkboardExecution.
    mode: requiredString(row, "execution_mode") as WorkboardExecution["mode"],
    // SAFETY: insertCard persists the execution status from WorkboardExecution.
    status: requiredString(row, "execution_status") as WorkboardExecution["status"],
    ...(stringValue(row, "execution_engine")
      ? { engine: stringValue(row, "execution_engine") }
      : {}),
    ...(stringValue(row, "execution_model") ? { model: stringValue(row, "execution_model") } : {}),
    ...(stringValue(row, "execution_session_key")
      ? { sessionKey: stringValue(row, "execution_session_key") }
      : {}),
    ...(stringValue(row, "execution_run_id")
      ? { runId: stringValue(row, "execution_run_id") }
      : {}),
    startedAt: requiredNumber(row, "execution_started_at"),
    updatedAt: requiredNumber(row, "execution_updated_at"),
  };
}

export function readAttachment(row: Row): WorkboardAttachment {
  return {
    id: requiredString(row, "id"),
    cardId: requiredString(row, "card_id"),
    createdAt: requiredNumber(row, "created_at"),
    fileName: requiredString(row, "file_name"),
    byteSize: requiredNumber(row, "byte_size"),
    ...(stringValue(row, "mime_type") ? { mimeType: stringValue(row, "mime_type") } : {}),
    ...(stringValue(row, "note") ? { note: stringValue(row, "note") } : {}),
  };
}

function readMetadata(
  db: DatabaseSync,
  row: Row,
  preloaded?: CardChildRows,
): WorkboardMetadata | undefined {
  const cardId = requiredString(row, "id");
  const attempts = childRows(db, "workboard_card_attempts", cardId, preloaded).map((child) => {
    const entry: WorkboardRunAttempt = {
      id: requiredString(child, "id"),
      // SAFETY: Attempt rows preserve WorkboardRunAttempt.status.
      status: requiredString(child, "status") as WorkboardRunAttempt["status"],
      startedAt: requiredNumber(child, "started_at"),
    };
    const endedAt = numberValue(child, "ended_at");
    const engine = stringValue(child, "engine");
    const mode = stringValue(child, "mode");
    const model = stringValue(child, "model");
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    const error = stringValue(child, "error");
    if (endedAt !== undefined) {
      entry.endedAt = endedAt;
    }
    if (engine) {
      // SAFETY: Attempt rows preserve WorkboardRunAttempt.engine.
      entry.engine = engine as WorkboardRunAttempt["engine"];
    }
    if (mode) {
      // SAFETY: Attempt rows preserve WorkboardRunAttempt.mode.
      entry.mode = mode as WorkboardRunAttempt["mode"];
    }
    if (model) {
      entry.model = model;
    }
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    if (error) {
      entry.error = error;
    }
    return entry;
  });
  const comments = childRows(db, "workboard_card_comments", cardId, preloaded).map((child) => {
    const entry: WorkboardComment = {
      id: requiredString(child, "id"),
      body: requiredString(child, "body"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const updatedAt = numberValue(child, "updated_at");
    if (updatedAt !== undefined) {
      entry.updatedAt = updatedAt;
    }
    return entry;
  });
  const links = childRows(db, "workboard_card_links", cardId, preloaded).map((child) => {
    const entry: WorkboardLink = {
      id: requiredString(child, "id"),
      // SAFETY: Link rows preserve WorkboardLink.type.
      type: requiredString(child, "type") as WorkboardLink["type"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const targetCardId = stringValue(child, "target_card_id");
    const title = stringValue(child, "title");
    const url = stringValue(child, "url");
    if (targetCardId) {
      entry.targetCardId = targetCardId;
    }
    if (title) {
      entry.title = title;
    }
    if (url) {
      entry.url = url;
    }
    return entry;
  });
  const proof = childRows(db, "workboard_card_proof", cardId, preloaded).map((child) => {
    const entry: WorkboardProof = {
      id: requiredString(child, "id"),
      // SAFETY: Proof rows preserve WorkboardProof.status.
      status: requiredString(child, "status") as WorkboardProof["status"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const command = stringValue(child, "command");
    const url = stringValue(child, "url");
    const note = stringValue(child, "note");
    if (label) {
      entry.label = label;
    }
    if (command) {
      entry.command = command;
    }
    if (url) {
      entry.url = url;
    }
    if (note) {
      entry.note = note;
    }
    return entry;
  });
  const artifacts = childRows(db, "workboard_card_artifacts", cardId, preloaded).map((child) => {
    const entry: WorkboardArtifact = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const url = stringValue(child, "url");
    const artifactPath = stringValue(child, "path");
    const mimeType = stringValue(child, "mime_type");
    if (label) {
      entry.label = label;
    }
    if (url) {
      entry.url = url;
    }
    if (artifactPath) {
      entry.path = artifactPath;
    }
    if (mimeType) {
      entry.mimeType = mimeType;
    }
    return entry;
  });
  const attachments = childRows(db, "workboard_card_attachments", cardId, preloaded).map(
    readAttachment,
  );
  const workerLogs = childRows(db, "workboard_worker_logs", cardId, preloaded).map((child) => {
    const entry: WorkboardWorkerLog = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
      // SAFETY: Worker log rows preserve WorkboardWorkerLog.level.
      level: requiredString(child, "level") as WorkboardWorkerLog["level"],
      message: requiredString(child, "message"),
    };
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    return entry;
  });
  const diagnostics = childRows(db, "workboard_card_diagnostics", cardId, preloaded).map(
    (child) => ({
      // SAFETY: Diagnostic rows preserve WorkboardDiagnostic.kind.
      kind: requiredString(child, "kind") as WorkboardDiagnostic["kind"],
      // SAFETY: Diagnostic rows preserve WorkboardDiagnostic.severity.
      severity: requiredString(child, "severity") as WorkboardDiagnostic["severity"],
      title: requiredString(child, "title"),
      detail: requiredString(child, "detail"),
      firstSeenAt: requiredNumber(child, "first_seen_at"),
      lastSeenAt: requiredNumber(child, "last_seen_at"),
      count: requiredNumber(child, "count"),
      // SAFETY: insertChildren serializes the diagnostic actions unchanged.
      actions: (parseJson(child.actions_json) as WorkboardDiagnostic["actions"] | undefined) ?? [],
    }),
  );
  const notifications = childRows(db, "workboard_card_notifications", cardId, preloaded).map(
    (child) => {
      const entry: WorkboardNotification = {
        id: requiredString(child, "id"),
        // SAFETY: Notification rows preserve WorkboardNotification.kind.
        kind: requiredString(child, "kind") as WorkboardNotification["kind"],
        createdAt: requiredNumber(child, "created_at"),
        message: requiredString(child, "message"),
      };
      const sequence = numberValue(child, "sequence");
      const sessionKey = stringValue(child, "session_key");
      const runId = stringValue(child, "run_id");
      if (sequence !== undefined) {
        entry.sequence = sequence;
      }
      if (sessionKey) {
        entry.sessionKey = sessionKey;
      }
      if (runId) {
        entry.runId = runId;
      }
      return entry;
    },
  );
  const protocol = workerProtocolRow(db, cardId, preloaded);
  // SAFETY: insertCard serializes WorkboardMetadata.automation unchanged.
  const automation = parseJson(row.automation_json) as WorkboardMetadata["automation"] | undefined;
  // SAFETY: insertCard serializes WorkboardMetadata.claim unchanged.
  const claim = parseJson(row.claim_json) as WorkboardMetadata["claim"] | undefined;
  // SAFETY: insertCard serializes WorkboardMetadata.stale unchanged.
  const stale = parseJson(row.stale_json) as WorkboardMetadata["stale"] | undefined;
  const lifecycleStatusSourceUpdatedAt = numberValue(row, "lifecycle_status_source_updated_at");
  return optional({
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(proof.length > 0 ? { proof } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(workerLogs.length > 0 ? { workerLogs } : {}),
    ...(protocol
      ? {
          workerProtocol: {
            // SAFETY: Protocol rows preserve WorkboardMetadata.workerProtocol.state.
            state: requiredString(protocol, "state") as NonNullable<
              WorkboardMetadata["workerProtocol"]
            >["state"],
            updatedAt: requiredNumber(protocol, "updated_at"),
            ...(stringValue(protocol, "detail") ? { detail: stringValue(protocol, "detail") } : {}),
          },
        }
      : {}),
    ...(automation ? { automation } : {}),
    ...(claim ? { claim } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    ...(stringValue(row, "template_id")
      ? {
          // SAFETY: insertCard persists the WorkboardMetadata template identifier.
          templateId: stringValue(row, "template_id") as WorkboardMetadata["templateId"],
        }
      : {}),
    ...(numberValue(row, "archived_at") !== undefined
      ? { archivedAt: numberValue(row, "archived_at") }
      : {}),
    ...(stale ? { stale } : {}),
    ...(lifecycleStatusSourceUpdatedAt !== undefined ? { lifecycleStatusSourceUpdatedAt } : {}),
    ...(numberValue(row, "failure_count") !== undefined
      ? { failureCount: numberValue(row, "failure_count") }
      : {}),
  });
}

export function readCard(db: DatabaseSync, row: Row, preloaded?: CardChildRows): WorkboardCard {
  const card: WorkboardCard = {
    id: requiredString(row, "id"),
    title: requiredString(row, "title"),
    // SAFETY: insertCard persists the WorkboardCard status unchanged.
    status: requiredString(row, "status") as WorkboardCard["status"],
    // SAFETY: insertCard persists the WorkboardCard priority unchanged.
    priority: requiredString(row, "priority") as WorkboardCard["priority"],
    labels: readLabels(db, requiredString(row, "id"), preloaded),
    position: requiredNumber(row, "position"),
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
  };
  const metadata = readMetadata(db, row, preloaded);
  const events = readEvents(db, card.id, preloaded);
  const execution = readExecution(row);
  return {
    ...card,
    ...(stringValue(row, "notes") ? { notes: stringValue(row, "notes") } : {}),
    ...(stringValue(row, "agent_id") ? { agentId: stringValue(row, "agent_id") } : {}),
    ...(stringValue(row, "session_key") ? { sessionKey: stringValue(row, "session_key") } : {}),
    ...(stringValue(row, "run_id") ? { runId: stringValue(row, "run_id") } : {}),
    ...(stringValue(row, "task_id") ? { taskId: stringValue(row, "task_id") } : {}),
    ...(stringValue(row, "source_url") ? { sourceUrl: stringValue(row, "source_url") } : {}),
    ...(execution ? { execution } : {}),
    ...(numberValue(row, "started_at") !== undefined
      ? { startedAt: numberValue(row, "started_at") }
      : {}),
    ...(numberValue(row, "completed_at") !== undefined
      ? { completedAt: numberValue(row, "completed_at") }
      : {}),
    ...(events ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
