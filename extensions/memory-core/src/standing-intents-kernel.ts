import {
  admitStoreSearch,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
  type Generated,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  INTENT_INJECTION_MAX_COUNT,
  needsLiteralIntentCandidates,
  parseStoredTriggerKeywords,
  readKnownCreatorSender,
  rowToIntent,
  standingIntentsFitContext,
  triggerKeywordMatchesPrompt,
  type StandingIntent,
  type StandingIntentMatchInput,
  type StandingIntentOperations,
  type StandingIntentRow,
} from "./standing-intents-model.js";
import { standingIntentSearchSchema } from "./standing-intents-search.js";

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

const lifecycleDeadlines = new WeakMap<
  EngineConnection,
  { observedAt: number; nextDueAt: number; hasActiveIntents: boolean }
>();

export function invalidateStandingIntentLifecycle(db: EngineConnection): void {
  lifecycleDeadlines.delete(db);
}

export function getStandingIntentLifecycleDeadline(db: EngineConnection): number | null {
  return lifecycleDeadlines.get(db)?.nextDueAt ?? null;
}

export function hasNoActiveStandingIntents(db: EngineConnection): boolean {
  return lifecycleDeadlines.get(db)?.hasActiveIntents === false;
}

export function maintainStandingIntentLifecycle(db: EngineConnection, nowMs: number): void {
  const deadline = lifecycleDeadlines.get(db);
  if (deadline && nowMs >= deadline.observedAt && nowMs < deadline.nextDueAt) {
    return;
  }
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
  const readyIds = fired
    .filter(
      (row) =>
        row.last_fired_at !== null && row.last_fired_at + row.cooldown_seconds * 1_000 <= nowMs,
    )
    .map((row) => row.id);
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
  const expiry = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("standing_intents")
      // Binary64 preserves millisecond deadlines without decoding unsafe stored integers.
      .select((eb) =>
        eb.fn.min(eb.cast<number>("expires_at", "double precision")).as("next_expiry"),
      )
      .where("status", "in", ["pending", "armed", "fired"]),
  );
  let nextDueAt = expiry?.next_expiry ?? Infinity;
  for (const row of fired) {
    if (row.last_fired_at !== null) {
      const rearmAt = row.last_fired_at + row.cooldown_seconds * 1_000;
      if (rearmAt > nowMs) {
        nextDueAt = Math.min(nextDueAt, rearmAt);
      }
    }
  }
  lifecycleDeadlines.set(db, {
    observedAt: nowMs,
    nextDueAt,
    hasActiveIntents: expiry?.next_expiry != null,
  });
}

export function createStandingIntentInDatabase(
  db: EngineConnection,
  row: StandingIntentRow,
): StandingIntent {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  invalidateStandingIntentLifecycle(db);
  executeSqliteQuerySync(db, kysely.insertInto("standing_intents").values(row));
  return rowToIntent(row);
}

export function listStandingIntentsInDatabase(
  db: EngineConnection,
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
  db: EngineConnection,
  params: StandingIntentOperations["cancel"]["input"],
): StandingIntent | null {
  const kysely = getNodeSqliteKysely<StandingIntentDatabase>(db);
  invalidateStandingIntentLifecycle(db);
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

function triggerMatchesPrompt(
  row: StandingIntentRow,
  promptTokens: ReadonlySet<string>,
  promptText: string,
): boolean {
  return parseStoredTriggerKeywords(row.trigger_keywords).some((keyword) =>
    triggerKeywordMatchesPrompt(keyword, promptTokens, promptText),
  );
}

export function matchStandingIntentsInDatabase(
  db: EngineConnection,
  params: StandingIntentMatchInput,
): StandingIntent[] {
  const promptTokens = new Set(params.promptTokens);
  const channelScopes = params.channelScopes;
  const ftsQuery = params.ftsQuery;
  const storedSenderScope = params.senderScope;
  const nowMs = params.nowMs ?? Date.now();
  maintainStandingIntentLifecycle(db, nowMs);
  // The lifecycle owner invalidates this absence fact on every write and rollback.
  if (hasNoActiveStandingIntents(db)) {
    return [];
  }
  const kysely = getNodeSqliteKysely<StandingIntentMatchDatabase>(db);
  const search = admitStoreSearch(db, standingIntentSearchSchema(db));
  if (!search.fullText) {
    throw new Error(search.diagnostics.join("; "));
  }
  // `unicode61` folds an unspaced CJK run into one token, so a prompt containing one also needs the
  // scoped rows the index cannot address. Every other prompt keeps index-only selection.
  const candidatePassCount = needsLiteralIntentCandidates(params.promptText) ? 2 : 1;
  let scopedCandidatesQuery = kysely
    .selectFrom("standing_intents as intent")
    .selectAll("intent")
    .where("intent.status", "=", "armed")
    .where("intent.creator_sender", "is not", null)
    .where("intent.expires_at", ">", nowMs)
    .whereRef("intent.fire_count", "<", "intent.max_fires");
  for (const [column, scopes] of [
    ["intent.channel_scope", channelScopes],
    ["intent.sender_scope", storedSenderScope ? [storedSenderScope] : []],
  ] as const) {
    scopedCandidatesQuery =
      scopes.length > 0
        ? scopedCandidatesQuery.where((expression) =>
            expression.or([
              expression(column, "is", null),
              ...scopes.map((scope) => expression(column, "=", scope)),
            ]),
          )
        : scopedCandidatesQuery.where(column, "is", null);
  }
  const indexedCandidatesQuery = (
    isPostgresSqlConnection(db)
      ? scopedCandidatesQuery
      : scopedCandidatesQuery.innerJoin(
          "standing_intents_fts as fts",
          "fts.rowid",
          "intent.intent_key",
        )
  ).where(search.fullText.match(search.text.intents!, ftsQuery));
  const fired: StandingIntent[] = [];
  let scannedCandidates = 0;
  // The literal lane reads the same scoped rows without the index, so it runs last and shares the
  // candidate budget: firing writes `fired`/`done`, which keeps the second lane off a fired row.
  for (let pass = 0; pass < candidatePassCount; pass++) {
    const candidatesQuery = pass === 0 ? indexedCandidatesQuery : scopedCandidatesQuery;
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
      cursor = lastCandidate
        ? { createdAt: lastCandidate.created_at, id: lastCandidate.id }
        : cursor;
      for (const current of candidates) {
        if (fired.length >= INTENT_INJECTION_MAX_COUNT) {
          break;
        }
        // This write transaction's page stays current: firing only changes the selected row.
        if (
          !readKnownCreatorSender(current.creator_sender) ||
          (current.last_fired_at !== null &&
            !(current.last_fired_at + current.cooldown_seconds * 1_000 <= nowMs)) ||
          !triggerMatchesPrompt(current, promptTokens, params.promptText)
        ) {
          continue;
        }
        const nextFireCount = current.fire_count + 1;
        const firedState = {
          fire_count: nextFireCount,
          last_fired_at: nowMs,
          status: nextFireCount >= current.max_fires ? "done" : "fired",
        } satisfies Pick<StandingIntentRow, "fire_count" | "last_fired_at" | "status">;
        const firedIntent = rowToIntent({ ...current, ...firedState });
        if (!standingIntentsFitContext([...fired, firedIntent])) {
          continue;
        }
        invalidateStandingIntentLifecycle(db);
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("standing_intents")
            .set(firedState)
            .where("id", "=", current.id)
            .where("status", "=", "armed"),
        );
        fired.push(firedIntent);
      }
      if (candidates.length < INTENT_MATCH_CANDIDATE_BATCH_SIZE) {
        break;
      }
    }
  }
  return fired;
}
