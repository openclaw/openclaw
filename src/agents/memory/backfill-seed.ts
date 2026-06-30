/**
 * Offline seed stage (Phase 4, 04-02): replay an agent's historical transcripts into the
 * durable `turns` store so the accordion has a real past to organize. This is a thin
 * driver over the EXISTING live-capture builders — `buildCapturedTurns` + `appendTurns` —
 * NOT a second turn-shaping/idempotency implementation. Idempotency parity is structural:
 * the persisted `message` is the same `AgentMessage` the live path hashed, so the durable
 * anchor (and thus the idempotency key) is identical; re-running inserts zero new turns.
 *
 * All of the agent's live transcripts are merged chronologically by `message.timestamp`
 * under ONE unified `agent:{agentId}:main` session_key (operator-CONFIRMED, A1). Only LIVE
 * transcripts are enumerated — `.trajectory.jsonl`, `.deleted`, and `.reset` files are
 * excluded (D-02). The seed cursor records completed files so an interrupted run resumes.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";
import { loadEntriesFromFile } from "../sessions/index.js";
import { readSeedCursor, withEnv, writeSeedCursor } from "./backfill-cursor.js";
import { buildCapturedTurns } from "./turns-capture.js";
import { appendTurns } from "./turns-store.js";

export type BackfillSeedResult = {
  sessionKey: string;
  filesProcessed: number;
  filesSkipped: number;
  inserted: number;
  /** Non-fatal operator notices (e.g. out-of-order seeding); empty on the normal path. */
  warnings: string[];
};

/**
 * Live transcript basenames only, sorted for deterministic processing. Trajectory, deleted,
 * and reset variants are archival/derived and must never seed durable turns (D-02).
 */
export function listLiveTranscripts(transcriptsDir: string): string[] {
  if (!fs.existsSync(transcriptsDir)) {
    return [];
  }
  return fs
    .readdirSync(transcriptsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => !name.endsWith(".trajectory.jsonl"))
    .filter((name) => !name.includes(".deleted"))
    .filter((name) => !name.includes(".reset"))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Ordering key for the chronological merge. Prefer the message's own numeric timestamp
 * (the same field the durable anchor keys off); fall back to the entry's ISO timestamp so
 * a message with only a `responseId` anchor still orders correctly across files. Returns
 * `undefined` when neither yields a real time — such a message has no temporal position, so
 * the caller keeps it in input order at the END of the stream rather than sorting it to the
 * epoch front (no semantic-zero sentinel).
 */
function messageOrderKey(message: AgentMessage, entryTimestamp: string): number | undefined {
  const ts = (message as { timestamp?: unknown }).timestamp;
  if (typeof ts === "number") {
    return ts;
  }
  const parsed = Date.parse(entryTimestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Seed the per-agent durable store from the agent's live transcripts. `transcriptsDir` is
 * injectable for tests; production resolves it from the agent's sessions dir (V4 path
 * safety: the resolver is the only thing that joins agent identity into a path).
 */
export function runBackfillSeed(options: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  transcriptsDir?: string;
}): BackfillSeedResult {
  const agentId = normalizeAgentId(options.agentId);
  const sessionKey = `agent:${agentId}:main`;
  const env = options.env;
  const transcriptsDir =
    options.transcriptsDir ?? resolveSessionTranscriptsDirForAgent(agentId, env);

  const cursor = readSeedCursor({ agentId, sessionKey, ...withEnv(env) });
  const completed = new Set(cursor?.completedFiles ?? []);
  const liveFiles = listLiveTranscripts(transcriptsDir);
  const pending = liveFiles.filter((name) => !completed.has(name));

  // Merge every pending file's messages BEFORE appending, then sort the whole stream
  // chronologically — cross-file interleaving is wrong if each file is appended in isolation.
  // `idx` is the input position: a stable tiebreak for equal timestamps, and the ordering for
  // any message with no usable timestamp (those keep input order at the end of the stream).
  const ordered: { message: AgentMessage; order: number | undefined; idx: number }[] = [];
  for (const name of pending) {
    // readdir basenames cannot traverse out of the resolved dir.
    const entries = loadEntriesFromFile(path.join(transcriptsDir, name));
    for (const entry of entries) {
      if (entry.type !== "message") {
        continue;
      }
      const message = entry.message;
      ordered.push({
        message,
        order: messageOrderKey(message, entry.timestamp),
        idx: ordered.length,
      });
    }
  }
  ordered.sort((a, b) => {
    if (a.order === undefined || b.order === undefined) {
      return (a.order === undefined ? 1 : 0) - (b.order === undefined ? 1 : 0) || a.idx - b.idx;
    }
    return a.order - b.order || a.idx - b.idx;
  });

  const turns = buildCapturedTurns(
    sessionKey,
    ordered.map((item) => item.message),
  );
  const inserted = appendTurns({ agentId, sessionKey, turns, ...withEnv(env) });

  // Bounds of this run's orderable timestamps (loop, not Math.min/max spread — the stream can
  // be very large). Used to advance the cursor and to detect out-of-order seeding below.
  let minSeededTs: number | undefined;
  let maxSeededTs: number | undefined;
  for (const item of ordered) {
    if (item.order === undefined) {
      continue;
    }
    minSeededTs = minSeededTs === undefined ? item.order : Math.min(minSeededTs, item.order);
    maxSeededTs = maxSeededTs === undefined ? item.order : Math.max(maxSeededTs, item.order);
  }

  // appendTurns assigns seq by insertion order, so appending content OLDER than already-seeded
  // turns (e.g. an archived transcript dropped in after a prior run) gives it higher seqs than
  // newer turns. We can't re-sequence in a driver, so surface it instead of corrupting silently.
  const warnings: string[] = [];
  if (
    inserted > 0 &&
    cursor?.lastSeededTs != null &&
    minSeededTs !== undefined &&
    minSeededTs < cursor.lastSeededTs
  ) {
    warnings.push(
      `Seeded ${inserted} turn(s) older than previously-backfilled history; their seq order may ` +
        `be out of sequence. Re-run backfill from a clean state to restore chronological order.`,
    );
  }

  const lastIdempotencyKey =
    turns.length > 0
      ? turns[turns.length - 1].idempotencyKey
      : (cursor?.lastIdempotencyKey ?? null);
  let lastSeededTs = cursor?.lastSeededTs ?? null;
  if (maxSeededTs !== undefined) {
    lastSeededTs = lastSeededTs === null ? maxSeededTs : Math.max(lastSeededTs, maxSeededTs);
  }
  writeSeedCursor({
    agentId,
    sessionKey,
    ...withEnv(env),
    value: {
      completedFiles: [...completed, ...pending].toSorted((a, b) => a.localeCompare(b)),
      lastIdempotencyKey,
      lastSeededTs,
    },
  });

  return {
    sessionKey,
    filesProcessed: pending.length,
    filesSkipped: completed.size,
    inserted,
    warnings,
  };
}
