import type { DatabaseSync } from "node:sqlite";
import {
  normalizeWorkboardSessionsBoardSpec,
  type WorkboardCard,
  type WorkboardMetadata,
  type WorkboardExecution,
} from "@openclaw/workboard-contract";
import {
  executeSqliteQueryTakeFirstSync,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { definedFields } from "../record-fields.js";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardCardStore,
  WorkboardCardReadScope,
  WorkboardCardStatsAggregate,
  WorkboardKeyedStore,
  WorkboardOwnerClaimResult,
  WorkboardPersistence,
  WorkboardSubscriptionStore,
} from "./persistence-types.js";
import {
  blobToBase64,
  jsonValue,
  loadCardChildRows,
  numberValue,
  parseJson,
  readAttachment,
  readCard,
  requiredNumber,
  requiredString,
  stringValue,
  type Row,
  type WorkboardCardDatabase,
} from "./sqlite-store-records.js";
import { createWorkboardDatabase } from "./sqlite-store-schema.js";
import { WorkboardSqliteSessionsBoardStore } from "./sqlite-store-sessions-board.js";
import { bindNull, insertCard, prepareWorkboardUpsert } from "./sqlite-store-write.js";
import {
  MAX_WORKER_CONTEXT_PARENTS,
  MAX_WORKER_CONTEXT_RECENT_CARDS,
  workboardCardConsumesOwnerSlot,
  workboardCardSlotOwner,
} from "./store-constants.js";

type SyncStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never;
};
export type WorkboardSqliteKernel = {
  [K in keyof WorkboardPersistence]: SyncStore<WorkboardPersistence[K]>;
} & {
  close(this: void): void;
};

function keyedEntries<T>(rows: Iterable<Row>, read: (row: Row) => T) {
  return Array.from(rows, (row) => ({
    key: requiredString(row, "id"),
    value: read(row),
  }));
}

class WorkboardSqliteCardStore implements SyncStore<WorkboardCardStore> {
  constructor(private readonly db: DatabaseSync) {}

  private matchesUpdatedAt(key: string, expectedUpdatedAt: number): boolean {
    const current = executeSqliteQueryTakeFirstSync(
      this.db,
      getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
        .selectFrom("workboard_cards")
        .select("updated_at")
        .where("id", "=", key),
    );
    return current !== undefined && numberValue(current, "updated_at") === expectedUpdatedAt;
  }

  private validatePayload(key: string, value: PersistedWorkboardCard): void {
    if (value.version !== 1 || value.card.id !== key) {
      throw new Error("invalid workboard card payload");
    }
  }

  register(key: string, value: PersistedWorkboardCard): void {
    this.validatePayload(key, value);
    runSqliteImmediateTransactionSync(this.db, () => insertCard(this.db, value.card));
  }

  registerIfAbsent(key: string, value: PersistedWorkboardCard): boolean {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM workboard_cards WHERE id = ?").get(key)) {
        return false;
      }
      insertCard(this.db, value.card);
      return true;
    });
  }

  registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): boolean {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (!this.matchesUpdatedAt(key, expectedUpdatedAt)) {
        return false;
      }
      insertCard(this.db, value.card);
      return true;
    });
  }

  claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
  ): WorkboardOwnerClaimResult {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      const query = getNodeSqliteKysely<WorkboardCardDatabase>(this.db);
      const current = executeSqliteQueryTakeFirstSync(
        this.db,
        query
          .selectFrom("workboard_cards")
          .selectAll()
          .where("id", "=", key)
          .where("updated_at", "=", expectedUpdatedAt),
      );
      if (!current) {
        return "conflict";
      }
      // Child records cannot occupy an owner slot. Keep lease and owner decisions
      // with the shared policy, after SQLite excludes archived and inactive cards.
      const candidates = query
        .selectFrom("workboard_cards")
        .select(["status", "agent_id", "claim_json", "execution_id", "execution_status"])
        .where("id", "!=", key)
        .where((eb) => eb.or([eb("archived_at", "is", null), eb("archived_at", "=", 0)]))
        .where((eb) =>
          eb.or([
            eb("status", "=", "running"),
            eb.and([eb("execution_id", "!=", ""), eb("execution_status", "=", "running")]),
            eb.and([eb("claim_json", "is not", null), eb("status", "!=", "done")]),
          ]),
        );
      for (const row of iterateSqliteQuerySync(this.db, candidates)) {
        const card = {
          // SAFETY: insertCard persists WorkboardCard.status; this keeps readCard's required-string boundary.
          status: requiredString(row, "status") as WorkboardCard["status"],
          agentId: stringValue(row, "agent_id"),
          // SAFETY: insertCard serializes WorkboardMetadata.claim; this keeps readMetadata's optional JSON boundary.
          metadata: { claim: parseJson(row.claim_json) as WorkboardMetadata["claim"] },
          execution: stringValue(row, "execution_id")
            ? {
                // SAFETY: insertCard persists WorkboardExecution.status; this keeps readExecution's required-string boundary.
                status: requiredString(row, "execution_status") as WorkboardExecution["status"],
              }
            : undefined,
        };
        if (workboardCardConsumesOwnerSlot(card, now) && workboardCardSlotOwner(card) === ownerId) {
          return "owner_busy";
        }
      }
      // Validate the target's stored tree before replacing it, without decoding
      // unrelated cards as an incidental prerequisite for claiming this one.
      readCard(this.db, current);
      insertCard(this.db, value.card);
      return "updated";
    });
  }

  deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): boolean {
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (!this.matchesUpdatedAt(key, expectedUpdatedAt)) {
        return false;
      }
      this.deleteCard(key);
      return true;
    });
  }

  lookup(key: string): PersistedWorkboardCard | undefined {
    const row = this.db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(key);
    return row ? { version: 1, card: readCard(this.db, row) } : undefined;
  }

  delete(key: string): boolean {
    const result = runSqliteImmediateTransactionSync(this.db, () => this.deleteCard(key));
    return result.changes > 0;
  }

  private deleteCard(key: string) {
    this.db
      .prepare(
        `
          DELETE FROM workboard_attachment_blobs
          WHERE attachment_id IN (
            SELECT id FROM workboard_card_attachments WHERE card_id = ?
          )
        `,
      )
      .run(key);
    return this.db.prepare("DELETE FROM workboard_cards WHERE id = ?").run(key);
  }

  private workerContextCardIds(
    scope: Extract<WorkboardCardReadScope, { kind: "worker-context" }>,
  ): string[] {
    const query = getNodeSqliteKysely<WorkboardCardDatabase>(this.db);
    const doneParents = new Set(
      scope.parentIds.length === 0
        ? []
        : Array.from(
            iterateSqliteQuerySync(
              this.db,
              query
                .selectFrom("workboard_cards")
                .select("id")
                .where("id", "in", sqliteStringSet(scope.parentIds))
                .where("status", "=", "done"),
            ),
            (row) => requiredString(row, "id"),
          ),
    );
    const parents = scope.parentIds
      .filter((id) => doneParents.has(id))
      .slice(-MAX_WORKER_CONTEXT_PARENTS);
    const recent = scope.agentId
      ? Array.from(
          iterateSqliteQuerySync(
            this.db,
            query
              .selectFrom("workboard_cards")
              .select("id")
              .where("board_id", "=", scope.boardId)
              .where("agent_id", "=", scope.agentId)
              .where("status", "=", "done")
              .where("id", "!=", scope.cardId)
              // Match the stable updated-time sort after the normal card order.
              .orderBy("updated_at", "desc")
              .orderBy("position", "asc")
              .orderBy("created_at", "asc")
              .orderBy("id", "asc")
              .limit(MAX_WORKER_CONTEXT_RECENT_CARDS),
          ),
          (row) => requiredString(row, "id"),
        )
      : [];
    return [...new Set([...parents, ...recent])];
  }

  entries(scope?: WorkboardCardReadScope): Array<{ key: string; value: PersistedWorkboardCard }> {
    // Selection and hydration must agree if another connection changes a parent or sibling.
    return scope?.kind === "worker-context"
      ? runSqliteDeferredTransactionSync(this.db, () => this.readEntries(scope))
      : this.readEntries(scope);
  }

  private readEntries(
    scope?: WorkboardCardReadScope,
  ): Array<{ key: string; value: PersistedWorkboardCard }> {
    let query = getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
      .selectFrom("workboard_cards")
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("id", "asc");
    if (scope?.kind === "board") {
      query = query.where("board_id", "=", scope.boardId);
    } else if (scope?.kind === "session") {
      // Empty direct keys decode as absent; execution keys require an execution record.
      query = query.where((eb) =>
        eb.or([
          eb("session_key", "=", scope.sessionKey),
          eb.and([
            eb.or([eb("session_key", "is", null), eb("session_key", "=", "")]),
            eb("execution_id", "!=", ""),
            eb("execution_session_key", "=", scope.sessionKey),
          ]),
        ]),
      );
    } else if (scope?.kind === "worker-context") {
      const ids = this.workerContextCardIds(scope);
      if (ids.length === 0) {
        return [];
      }
      query = query.where("id", "in", sqliteStringSet(ids));
    }
    const rows = Array.from(iterateSqliteQuerySync(this.db, query));
    if (scope !== undefined && rows.length === 0) {
      return [];
    }
    // One query per child table for the selected cards instead of one per table per card.
    const preloaded = loadCardChildRows(
      this.db,
      scope === undefined ? undefined : rows.map((row) => requiredString(row, "id")),
    );
    return rows.map((row) => ({
      key: requiredString(row, "id"),
      value: { version: 1, card: readCard(this.db, row, preloaded) },
    }));
  }

  listCardStatuses(ids: readonly string[]): Array<{ id: string; status: string }> {
    if (ids.length === 0) {
      return [];
    }
    const query = getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
      .selectFrom("workboard_cards")
      .select(["id", "status"])
      .where("id", "in", sqliteStringSet(ids));
    return Array.from(iterateSqliteQuerySync(this.db, query), (row) => ({
      id: requiredString(row, "id"),
      status: requiredString(row, "status"),
    }));
  }

  listBoardAggregates() {
    const rows = this.db
      .prepare(
        `
          SELECT
            board_id,
            status,
            COUNT(*) AS total,
            SUM(CASE WHEN archived_at IS NOT NULL AND archived_at <> 0 THEN 1 ELSE 0 END) AS archived,
            MAX(updated_at) AS updated_at
          FROM workboard_cards
          GROUP BY board_id, status
          ORDER BY board_id ASC, status ASC
        `,
      )
      .all();
    return rows.map((row) => ({
      boardId: requiredString(row, "board_id"),
      // SAFETY: insertCard persists the WorkboardCard status unchanged.
      status: requiredString(row, "status") as WorkboardCard["status"],
      total: requiredNumber(row, "total"),
      archived: requiredNumber(row, "archived"),
      updatedAt: requiredNumber(row, "updated_at"),
    }));
  }

  listStatsAggregates(boardId?: string): WorkboardCardStatsAggregate[] {
    let query = getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
      .selectFrom("workboard_cards")
      .select((eb) => [
        "status",
        "agent_id",
        eb.fn.countAll<number>().as("total"),
        eb.fn
          .sum<number>(
            eb
              .case()
              .when(eb.and([eb("archived_at", "is not", null), eb("archived_at", "!=", 0)]))
              .then(1)
              .else(0)
              .end(),
          )
          .as("archived"),
        eb.fn.max<number>("updated_at").as("updated_at"),
        eb.fn
          .min<number>(
            eb
              .case()
              .when(
                eb.and([
                  eb("status", "=", "ready"),
                  eb.or([eb("archived_at", "is", null), eb("archived_at", "=", 0)]),
                ]),
              )
              .then(eb.ref("updated_at"))
              .else(null)
              .end(),
          )
          .as("oldest_ready_at"),
      ])
      .groupBy(["status", "agent_id"]);
    if (boardId !== undefined) {
      query = query.where("board_id", "=", boardId);
    }
    return Array.from(iterateSqliteQuerySync(this.db, query), (row) => ({
      // SAFETY: insertCard persists the normalized WorkboardCard status unchanged.
      status: requiredString(row, "status") as WorkboardCard["status"],
      agentId: stringValue(row, "agent_id"),
      total: requiredNumber(row, "total"),
      archived: requiredNumber(row, "archived"),
      updatedAt: requiredNumber(row, "updated_at"),
      oldestReadyAt: numberValue(row, "oldest_ready_at"),
    }));
  }

  hasCards(boardId: string): boolean {
    return (
      executeSqliteQueryTakeFirstSync(
        this.db,
        getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
          .selectFrom("workboard_cards")
          .select("id")
          .where("board_id", "=", boardId)
          .limit(1),
      ) !== undefined
    );
  }
}

function readBoard(row: Row): PersistedWorkboardBoard {
  const kind = stringValue(row, "kind");
  if (kind !== undefined && kind !== "cards" && kind !== "sessions") {
    throw new Error("invalid workboard board kind");
  }
  // SAFETY: Board registration serializes defaultWorkspace unchanged.
  const defaultWorkspace = parseJson(row.default_workspace_json) as
    | PersistedWorkboardBoard["board"]["defaultWorkspace"]
    | undefined;
  // SAFETY: Board registration serializes orchestration unchanged.
  const orchestration = parseJson(row.orchestration_json) as
    | PersistedWorkboardBoard["board"]["orchestration"]
    | undefined;
  return {
    version: 1,
    board: definedFields({
      id: requiredString(row, "id"),
      ...(kind ? { kind } : {}),
      ...(kind === "sessions"
        ? { sessions: normalizeWorkboardSessionsBoardSpec(parseJson(row.sessions_spec)) }
        : {}),
      name: stringValue(row, "name"),
      description: stringValue(row, "description"),
      icon: stringValue(row, "icon"),
      color: stringValue(row, "color"),
      automationJobId: stringValue(row, "automation_job_id"),
      ...(defaultWorkspace ? { defaultWorkspace } : {}),
      ...(orchestration ? { orchestration } : {}),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
      archivedAt: numberValue(row, "archived_at"),
    }),
  };
}

class WorkboardSqliteBoardStore implements SyncStore<WorkboardKeyedStore<PersistedWorkboardBoard>> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{ workboard_boards: Row }>(db)
      .selectFrom("workboard_boards")
      .selectAll();
  }

  register(key: string, value: PersistedWorkboardBoard): void {
    if (value.version !== 1 || value.board.id !== key) {
      throw new Error("invalid workboard board payload");
    }
    const board = value.board;
    const write = prepareWorkboardUpsert(
      this.db,
      "workboard_boards",
      {
        id: () => board.id,
        name: () => bindNull(board.name),
        description: () => bindNull(board.description),
        icon: () => bindNull(board.icon),
        color: () => bindNull(board.color),
        kind: () => bindNull(board.kind),
        sessions_spec: () =>
          board.kind === "sessions"
            ? jsonValue(normalizeWorkboardSessionsBoardSpec(board.sessions))
            : null,
        automation_job_id: () => bindNull(board.automationJobId),
        default_workspace_json: () => jsonValue(board.defaultWorkspace),
        orchestration_json: () => jsonValue(board.orchestration),
        created_at: () => board.createdAt,
        updated_at: () => board.updatedAt,
        archived_at: () => bindNull(board.archivedAt),
      },
      ["kind", "sessions_spec"],
    );
    runSqliteImmediateTransactionSync(this.db, () => {
      const existing = this.lookup(key)?.board;
      if (existing && (existing.kind ?? "cards") !== (board.kind ?? "cards")) {
        throw new Error("board kind cannot be changed after creation.");
      }
      if (board.kind === "sessions" && !existing) {
        const card = executeSqliteQueryTakeFirstSync(
          this.db,
          getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
            .selectFrom("workboard_cards")
            .select("id")
            .where("board_id", "=", key)
            .limit(1),
        );
        if (key === "default" || card) {
          throw new Error("board kind cannot be changed after creation.");
        }
      }
      // Existing session specs are changed only by sessionsBoard.update, never an appearance upsert.
      write();
    });
  }

  lookup(key: string): PersistedWorkboardBoard | undefined {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("id", "=", key));
    return row ? readBoard(row) : undefined;
  }

  delete(key: string): boolean {
    const result = executeSqliteQuerySync(
      this.db,
      getNodeSqliteKysely<{ workboard_boards: Row }>(this.db)
        .deleteFrom("workboard_boards")
        .where("id", "=", key),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  entries(): Array<{ key: string; value: PersistedWorkboardBoard }> {
    return keyedEntries(
      iterateSqliteQuerySync(this.db, this.rowsQuery.orderBy("id", "asc")),
      readBoard,
    );
  }
}

function readSubscription(row: Row): PersistedWorkboardNotificationSubscription {
  // SAFETY: Subscription registration serializes eventKinds unchanged.
  const eventKinds = parseJson(row.event_kinds_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["eventKinds"]
    | undefined;
  // SAFETY: Subscription registration serializes deliveredEventIds unchanged.
  const deliveredEventIds = parseJson(row.delivered_event_ids_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["deliveredEventIds"]
    | undefined;
  return {
    version: 1,
    subscription: definedFields({
      id: requiredString(row, "id"),
      boardId: requiredString(row, "board_id"),
      cardId: stringValue(row, "card_id"),
      sessionKey: stringValue(row, "session_key"),
      runId: stringValue(row, "run_id"),
      target: stringValue(row, "target"),
      ...(eventKinds ? { eventKinds } : {}),
      lastEventAt: numberValue(row, "last_event_at"),
      lastEventId: stringValue(row, "last_event_id"),
      lastEventSequence: numberValue(row, "last_event_sequence"),
      ...(deliveredEventIds ? { deliveredEventIds } : {}),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
    }),
  };
}

class WorkboardSqliteSubscriptionStore implements SyncStore<WorkboardSubscriptionStore> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(db)
      .selectFrom("workboard_notification_subscriptions")
      .selectAll();
  }

  register(key: string, value: PersistedWorkboardNotificationSubscription): void {
    if (value.version !== 1 || value.subscription.id !== key) {
      throw new Error("invalid workboard notification subscription payload");
    }
    const subscription = value.subscription;
    prepareWorkboardUpsert(this.db, "workboard_notification_subscriptions", {
      id: () => subscription.id,
      board_id: () => subscription.boardId,
      card_id: () => bindNull(subscription.cardId),
      session_key: () => bindNull(subscription.sessionKey),
      run_id: () => bindNull(subscription.runId),
      target: () => bindNull(subscription.target),
      event_kinds_json: () => jsonValue(subscription.eventKinds),
      last_event_at: () => bindNull(subscription.lastEventAt),
      last_event_id: () => bindNull(subscription.lastEventId),
      last_event_sequence: () => bindNull(subscription.lastEventSequence),
      delivered_event_ids_json: () => jsonValue(subscription.deliveredEventIds),
      created_at: () => subscription.createdAt,
      updated_at: () => subscription.updatedAt,
    })();
  }

  lookup(key: string): PersistedWorkboardNotificationSubscription | undefined {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("id", "=", key));
    return row ? readSubscription(row) : undefined;
  }

  delete(key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM workboard_notification_subscriptions WHERE id = ?")
      .run(key);
    return result.changes > 0;
  }

  entries(
    options: Parameters<WorkboardSubscriptionStore["entries"]>[0] = {},
  ): Array<{ key: string; value: PersistedWorkboardNotificationSubscription }> {
    let query = this.rowsQuery;
    if (options.boardId) {
      query = query.where("board_id", "=", options.boardId);
    }
    if (options.cardId) {
      query = query.where("card_id", "=", options.cardId);
    }
    return keyedEntries(
      iterateSqliteQuerySync(this.db, query.orderBy("created_at", "asc").orderBy("id", "asc")),
      readSubscription,
    );
  }
}

function readPersistedAttachment(row: Row): PersistedWorkboardAttachment {
  return {
    version: 1,
    attachment: readAttachment(row),
    contentBase64: blobToBase64(row.content),
  };
}

class WorkboardSqliteAttachmentStore implements SyncStore<
  WorkboardKeyedStore<PersistedWorkboardAttachment>
> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{
      workboard_card_attachments: Row;
      workboard_attachment_blobs: Row;
    }>(db)
      .selectFrom("workboard_card_attachments as a")
      .innerJoin("workboard_attachment_blobs as b", "b.attachment_id", "a.id")
      .selectAll("a")
      .select("b.content");
  }

  register(key: string, value: PersistedWorkboardAttachment): void {
    if (value.version !== 1 || value.attachment.id !== key) {
      throw new Error("invalid workboard attachment payload");
    }
    const attachment = value.attachment;
    this.db
      .prepare(
        `
          INSERT INTO workboard_attachment_blobs (attachment_id, content)
          VALUES (?, ?)
          ON CONFLICT(attachment_id) DO UPDATE SET content = excluded.content
        `,
      )
      .run(attachment.id, Buffer.from(value.contentBase64, "base64"));
  }

  lookup(key: string): PersistedWorkboardAttachment | undefined {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("a.id", "=", key));
    return row ? readPersistedAttachment(row) : undefined;
  }

  delete(key: string): boolean {
    const deleted = runSqliteImmediateTransactionSync(this.db, () => {
      this.db.prepare("DELETE FROM workboard_attachment_blobs WHERE attachment_id = ?").run(key);
      return this.db.prepare("DELETE FROM workboard_card_attachments WHERE id = ?").run(key);
    });
    return deleted.changes > 0;
  }

  entries(): Array<{ key: string; value: PersistedWorkboardAttachment }> {
    // Decode each BLOB before advancing so the list never retains a second full raw payload copy.
    return keyedEntries(
      iterateSqliteQuerySync(
        this.db,
        this.rowsQuery.orderBy("a.created_at", "asc").orderBy("a.id", "asc"),
      ),
      readPersistedAttachment,
    );
  }
}

export function createWorkboardSqliteKernel(
  dbPath: string,
  retainClose?: (close: () => void) => void,
): WorkboardSqliteKernel {
  const { db, close } = createWorkboardDatabase(dbPath, retainClose);
  const boards = new WorkboardSqliteBoardStore(db);
  return {
    cards: new WorkboardSqliteCardStore(db),
    boards,
    sessionsBoard: new WorkboardSqliteSessionsBoardStore(db, boards),
    subscriptions: new WorkboardSqliteSubscriptionStore(db),
    attachments: new WorkboardSqliteAttachmentStore(db),
    close,
  };
}
