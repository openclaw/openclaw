/**
 * Durable conversational-memory store (Phase 2): immutable append-only `turns`
 * plus thin `spans`/`boxes` metadata, in the per-agent SQLite DB. The accordion
 * flips `boxes.state` only; `turns` is never mutated or deleted. `seq` is assigned
 * monotonically per `session_key` at append time, inside the write transaction.
 */
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";

type TurnsDatabase = Pick<OpenClawAgentKyselyDatabase, "turns" | "spans" | "boxes">;

export type TurnRow = Selectable<OpenClawAgentKyselyDatabase["turns"]>;
export type SpanRow = Selectable<OpenClawAgentKyselyDatabase["spans"]>;
export type BoxRow = Selectable<OpenClawAgentKyselyDatabase["boxes"]>;

/** A box is rendered verbatim when `live`, or as a single summary when `collapsed`. */
export type BoxState = "live" | "collapsed";

/** One turn to append. `seq` is assigned by the store; callers never set it. */
export type NewTurn = {
  role: string;
  content: string;
  contentHash: string;
  idempotencyKey: string;
  ts: number;
  runId?: string | null;
  channel?: string | null;
  noiseClass?: string | null;
};

type SessionScopedOptions = OpenClawAgentDatabaseOptions & { sessionKey: string };

/**
 * Append new turns for a session, idempotently. Duplicates (by `idempotency_key`)
 * are skipped and never consume a `seq`, so the sequence stays gapless. Returns
 * the number of rows actually inserted. Safe to replay an entire turn.
 */
export function appendTurns(options: SessionScopedOptions & { turns: readonly NewTurn[] }): number {
  if (options.turns.length === 0) {
    return 0;
  }
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
    // Pre-filter inside the immediate write transaction (writers are serialized),
    // so seq assignment reflects only genuinely new turns — no gaps on replay.
    const candidateKeys = options.turns.map((turn) => turn.idempotencyKey);
    const existing = new Set(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("turns")
          .select("idempotency_key")
          .where("idempotency_key", "in", candidateKeys),
      ).rows.map((row) => row.idempotency_key),
    );
    // No rows yet → start at 0 so the first append is seq 1.
    const maxRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("turns")
        .select((eb) => eb.fn.max("seq").as("max_seq"))
        .where("session_key", "=", options.sessionKey),
    );
    let seq = maxRow?.max_seq == null ? 0 : Number(maxRow.max_seq);
    let inserted = 0;
    for (const turn of options.turns) {
      if (existing.has(turn.idempotencyKey)) {
        continue;
      }
      seq += 1;
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("turns")
          .values({
            session_key: options.sessionKey,
            seq,
            role: turn.role,
            content: turn.content,
            content_hash: turn.contentHash,
            idempotency_key: turn.idempotencyKey,
            run_id: turn.runId ?? null,
            channel: turn.channel ?? null,
            ts: turn.ts,
            noise_class: turn.noiseClass ?? null,
          })
          // Belt-and-suspenders against a cross-process race the pre-filter missed.
          .onConflict((conflict) => conflict.column("idempotency_key").doNothing()),
      );
      inserted += 1;
    }
    return inserted;
  }, options);
}

/** Read turns for a session in `seq` order, optionally bounded to `[startSeq, endSeq]`. */
export function getTurns(
  options: SessionScopedOptions & { startSeq?: number; endSeq?: number },
): TurnRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
  let query = db.selectFrom("turns").selectAll().where("session_key", "=", options.sessionKey);
  if (options.startSeq != null) {
    query = query.where("seq", ">=", options.startSeq);
  }
  if (options.endSeq != null) {
    query = query.where("seq", "<=", options.endSeq);
  }
  return executeSqliteQuerySync(database.db, query.orderBy("seq", "asc")).rows;
}

/** List spans for a session in `start_seq` order. */
export function listSpans(options: SessionScopedOptions): SpanRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("spans")
      .selectAll()
      .where("session_key", "=", options.sessionKey)
      .orderBy("start_seq", "asc"),
  ).rows;
}

/** List boxes for a session. */
export function listBoxes(options: SessionScopedOptions): BoxRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("boxes").selectAll().where("session_key", "=", options.sessionKey),
  ).rows;
}

/** Upsert a span's metadata (topic/box assignment/noise class). Never touches turns. */
export function upsertSpan(
  options: OpenClawAgentDatabaseOptions & {
    span: {
      spanId: string;
      sessionKey: string;
      startSeq: number;
      endSeq: number;
      topic?: string | null;
      boxId?: string | null;
      noiseClass?: string | null;
    };
  },
): void {
  const span = options.span;
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("spans")
        .values({
          span_id: span.spanId,
          session_key: span.sessionKey,
          start_seq: span.startSeq,
          end_seq: span.endSeq,
          topic: span.topic ?? null,
          box_id: span.boxId ?? null,
          noise_class: span.noiseClass ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("span_id").doUpdateSet({
            start_seq: span.startSeq,
            end_seq: span.endSeq,
            topic: span.topic ?? null,
            box_id: span.boxId ?? null,
            noise_class: span.noiseClass ?? null,
          }),
        ),
    );
  }, options);
}

/** Upsert a box's metadata. State defaults to `live` for a new box. */
export function upsertBox(
  options: OpenClawAgentDatabaseOptions & {
    box: {
      boxId: string;
      sessionKey: string;
      label?: string | null;
      state?: BoxState;
      summary?: string | null;
      importance?: number | null;
      suppressionRollup?: string | null;
      lastActiveSeq?: number | null;
    };
  },
): void {
  const box = options.box;
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("boxes")
        .values({
          box_id: box.boxId,
          session_key: box.sessionKey,
          label: box.label ?? null,
          ...(box.state ? { state: box.state } : {}),
          summary: box.summary ?? null,
          importance: box.importance ?? null,
          suppression_rollup: box.suppressionRollup ?? null,
          last_active_seq: box.lastActiveSeq ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("box_id").doUpdateSet({
            label: box.label ?? null,
            ...(box.state ? { state: box.state } : {}),
            summary: box.summary ?? null,
            importance: box.importance ?? null,
            suppression_rollup: box.suppressionRollup ?? null,
            last_active_seq: box.lastActiveSeq ?? null,
          }),
        ),
    );
  }, options);
}

/** Flip a box's render state. The only mutation collapse/expand ever performs. */
export function setBoxState(
  options: OpenClawAgentDatabaseOptions & { boxId: string; state: BoxState },
): void {
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.updateTable("boxes").set({ state: options.state }).where("box_id", "=", options.boxId),
    );
  }, options);
}

/**
 * Operator/agent manual toggle (tool, gateway, UI). Flips state, and on a manual
 * EXPAND bumps `last_active_seq` to the current conversation head so the auto-collapse
 * dwell (active-tag-set rule) treats the box as freshly active — the override holds
 * until the topic genuinely moves on. A manual COLLAPSE only sets state; the auto rule
 * never re-expands, so nothing can undo it. Returns false when the box does not exist.
 */
export function setBoxStateManual(
  options: SessionScopedOptions & { boxId: string; state: BoxState },
): boolean {
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TurnsDatabase>(database.db);
    const box = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("boxes")
        .select("box_id")
        .where("box_id", "=", options.boxId)
        .where("session_key", "=", options.sessionKey),
    );
    if (box == null) {
      return false;
    }
    if (options.state === "live") {
      const head = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("turns")
          .select((eb) => eb.fn.max("seq").as("max_seq"))
          .where("session_key", "=", options.sessionKey),
      );
      const headSeq = head?.max_seq == null ? null : Number(head.max_seq);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("boxes")
          .set({ state: "live", last_active_seq: headSeq })
          .where("box_id", "=", options.boxId),
      );
      return true;
    }
    executeSqliteQuerySync(
      database.db,
      db.updateTable("boxes").set({ state: "collapsed" }).where("box_id", "=", options.boxId),
    );
    return true;
  }, options);
}
