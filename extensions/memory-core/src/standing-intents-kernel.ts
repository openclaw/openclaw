import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
  type Generated,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  INTENT_INJECTION_MAX_COUNT,
  parseStoredTriggerKeywords,
  readKnownCreatorSender,
  tokenizeIntentText,
  rowToIntent,
  standingIntentsFitContext,
  type StandingIntent,
  type StandingIntentMatchInput,
  type StandingIntentOperations,
  type StandingIntentRow,
} from "./standing-intents-model.js";

const INTENT_MATCH_CANDIDATE_BATCH_SIZE = 32;
const INTENT_MATCH_CANDIDATE_LIMIT = 256;

type StandingIntentDatabase = {
  standing_intents: StandingIntentRow & { intent_key: Generated<number> };
};

type StandingIntentMatchDatabase = StandingIntentDatabase & {
  standing_intents_fts: {
    rowid: number;
    trigger_keywords: string;
  };
};

function shouldRearm(
  row: Pick<StandingIntentRow, "status" | "last_fired_at" | "cooldown_seconds">,
  nowMs: number,
): boolean {
  if (row.status !== "fired" || row.last_fired_at === null) {
    return false;
  }
  return row.last_fired_at + row.cooldown_seconds * 1_000 <= nowMs;
}

export function maintainStandingIntentLifecycle(db: DatabaseSync, nowMs: number): void {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("standing_intents")
      .set({ status: "expired" })
      .where("status", "in", ["pending", "armed", "fired"])
      .where("expires_at", "<=", nowMs),
  );
  const fired = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("standing_intents")
      // Retain every integer column so native range errors still precede rearming.
      .select([
        "intent_key",
        "id",
        "status",
        "expires_at",
        "max_fires",
        "fire_count",
        "cooldown_seconds",
        "last_fired_at",
        "created_at",
      ])
      .where("status", "=", "fired")
      .where("expires_at", ">", nowMs)
      .whereRef("fire_count", "<", "max_fires"),
  ).rows;
  const readyIds = fired.filter((row) => shouldRearm(row, nowMs)).map((row) => row.id);
  if (readyIds.length > 0) {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("standing_intents")
        .set({ status: "armed" })
        .where("id", "in", sqliteStringSet(readyIds))
        .where("status", "=", "fired"),
    );
  }
}

export function createStandingIntentInDatabase(
  db: DatabaseSync,
  row: StandingIntentRow,
): StandingIntent {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  executeSqliteQuerySync(db, kysely.insertInto("standing_intents").values(row));
  return rowToIntent(row);
}

export function listStandingIntentsInDatabase(
  db: DatabaseSync,
  params: StandingIntentOperations["list"]["input"],
): StandingIntent[] {
  const nowMs = params.nowMs ?? Date.now();
  maintainStandingIntentLifecycle(db, nowMs);
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  let query = kysely.selectFrom("standing_intents").selectAll();
  if (params.status) {
    query = query.where("status", "=", params.status);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("created_at", "asc").orderBy("id", "asc"),
  ).rows.map(rowToIntent);
}

export function cancelStandingIntentInDatabase(
  db: DatabaseSync,
  params: StandingIntentOperations["cancel"]["input"],
): StandingIntent | null {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .updateTable("standing_intents")
      .set({ status: "cancelled" })
      .where("id", "=", params.id)
      .where("status", "in", ["pending", "armed", "fired"]),
  );
  if (result.numAffectedRows === 0n) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("standing_intents").selectAll().where("id", "=", params.id),
  );
  return row ? rowToIntent(row) : null;
}

function triggerMatchesPrompt(row: StandingIntentRow, promptTokens: ReadonlySet<string>): boolean {
  return parseStoredTriggerKeywords(row.trigger_keywords)
    .map((keyword) => tokenizeIntentText(keyword))
    .some(
      (keywordTokens) =>
        keywordTokens.length > 0 && keywordTokens.every((token) => promptTokens.has(token)),
    );
}

function scopesMatch(
  row: StandingIntentRow,
  channelScopes: ReadonlySet<string>,
  senderScope: string | undefined,
): boolean {
  return (
    (row.channel_scope === null || channelScopes.has(row.channel_scope)) &&
    (row.sender_scope === null || row.sender_scope === senderScope)
  );
}

function canFire(row: StandingIntentRow, nowMs: number): boolean {
  return (
    row.status === "armed" &&
    row.expires_at > nowMs &&
    row.fire_count < row.max_fires &&
    (row.last_fired_at === null || row.last_fired_at + row.cooldown_seconds * 1_000 <= nowMs)
  );
}

export function matchStandingIntentsInDatabase(
  db: DatabaseSync,
  params: StandingIntentMatchInput,
): StandingIntent[] {
  const promptTokens = new Set(params.promptTokens);
  const channelScopes = new Set(params.channelScopes);
  const ftsQuery = params.ftsQuery;
  const storedSenderScope = params.senderScope;
  const nowMs = params.nowMs ?? Date.now();
  maintainStandingIntentLifecycle(db, nowMs);
  const matchDb = getNodeSqliteKysely<StandingIntentMatchDatabase>(db);
  let candidatesQuery = matchDb
    .selectFrom("standing_intents as intent")
    .innerJoin("standing_intents_fts as fts", "fts.rowid", "intent.intent_key")
    .selectAll("intent")
    .where("fts.trigger_keywords", "match", ftsQuery)
    .where("intent.status", "=", "armed")
    .where("intent.creator_sender", "is not", null)
    .where("intent.expires_at", ">", nowMs)
    .whereRef("intent.fire_count", "<", "intent.max_fires");
  candidatesQuery =
    channelScopes.size > 0
      ? candidatesQuery.where((expression) =>
          expression.or([
            expression("intent.channel_scope", "is", null),
            ...[...channelScopes].map((scope) => expression("intent.channel_scope", "=", scope)),
          ]),
        )
      : candidatesQuery.where("intent.channel_scope", "is", null);
  candidatesQuery = storedSenderScope
    ? candidatesQuery.where((expression) =>
        expression.or([
          expression("intent.sender_scope", "is", null),
          expression("intent.sender_scope", "=", storedSenderScope),
        ]),
      )
    : candidatesQuery.where("intent.sender_scope", "is", null);
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  const fired: StandingIntent[] = [];
  let scannedCandidates = 0;
  let cursor: { createdAt: number; id: string } | undefined;
  while (
    fired.length < INTENT_INJECTION_MAX_COUNT &&
    scannedCandidates < INTENT_MATCH_CANDIDATE_LIMIT
  ) {
    let pageQuery = candidatesQuery;
    const currentCursor = cursor;
    if (currentCursor) {
      pageQuery = pageQuery.where((expression) =>
        expression.or([
          expression("intent.created_at", ">", currentCursor.createdAt),
          expression.and([
            expression("intent.created_at", "=", currentCursor.createdAt),
            expression("intent.id", ">", currentCursor.id),
          ]),
        ]),
      );
    }
    const candidates = executeSqliteQuerySync(
      db,
      pageQuery
        .orderBy("intent.created_at", "asc")
        .orderBy("intent.id", "asc")
        .limit(
          Math.min(
            INTENT_MATCH_CANDIDATE_BATCH_SIZE,
            INTENT_MATCH_CANDIDATE_LIMIT - scannedCandidates,
          ),
        ),
    ).rows;
    if (candidates.length === 0) {
      break;
    }
    const lastCandidate = candidates.at(-1);
    scannedCandidates += candidates.length;
    cursor = lastCandidate ? { createdAt: lastCandidate.created_at, id: lastCandidate.id } : cursor;
    for (const current of candidates) {
      if (fired.length >= INTENT_INJECTION_MAX_COUNT) {
        break;
      }
      // This write transaction's page stays current: firing only changes the selected row.
      if (
        !readKnownCreatorSender(current.creator_sender) ||
        !canFire(current, nowMs) ||
        !scopesMatch(current, channelScopes, storedSenderScope) ||
        !triggerMatchesPrompt(current, promptTokens)
      ) {
        continue;
      }
      const nextFireCount = current.fire_count + 1;
      const firedIntent = rowToIntent({
        ...current,
        fire_count: nextFireCount,
        last_fired_at: nowMs,
        status: nextFireCount >= current.max_fires ? "done" : "fired",
      });
      if (!standingIntentsFitContext([...fired, firedIntent])) {
        continue;
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("standing_intents")
          .set({
            fire_count: nextFireCount,
            last_fired_at: nowMs,
            status: nextFireCount >= current.max_fires ? "done" : "fired",
          })
          .where("id", "=", current.id)
          .where("status", "=", "armed"),
      );
      fired.push(firedIntent);
    }
    if (candidates.length < INTENT_MATCH_CANDIDATE_BATCH_SIZE) {
      break;
    }
  }
  return fired;
}
