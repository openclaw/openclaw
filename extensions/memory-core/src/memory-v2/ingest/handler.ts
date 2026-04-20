import type { DatabaseSync } from "node:sqlite";
import { memoryRefId } from "../ref.js";
import { getByRefId, upsertRecord } from "../sidecar-repo.js";
import { type DedupeOptions, findLexicalDuplicate, upsertIngestText } from "./dedupe.js";
import { type Candidate, extractCandidates } from "./extract.js";
import { ensureIngestSchema } from "./ingest-schema.js";
import { normalizeForMatch } from "./normalize.js";
import { looksLikeSecret } from "./secret-filter.js";
import { synthesizeConversationRef } from "./synthetic-ref.js";

export type IngestEvent = {
  messages: unknown[];
  success: boolean;
};

export type IngestContext = {
  sessionId?: string;
};

export type IngestDeps = {
  db: DatabaseSync;
  now: () => number;
  dedupeOptions?: DedupeOptions;
};

export type IngestOutcome = {
  candidatesConsidered: number;
  inserted: number;
  deduped: number;
  filteredAsSecret: number;
  skippedReason?: "no_user_text" | "turn_failed" | "no_session_id";
};

const EMPTY_OUTCOME: IngestOutcome = {
  candidatesConsidered: 0,
  inserted: 0,
  deduped: 0,
  filteredAsSecret: 0,
};

// Pure ingest entry point. Synchronous on top of node:sqlite; the caller is
// responsible for invoking inside a fire-and-forget hook. Never throws on
// malformed messages — caller still wraps in try/catch for safety.
export function runIngest(event: IngestEvent, ctx: IngestContext, deps: IngestDeps): IngestOutcome {
  if (!event.success) {
    return { ...EMPTY_OUTCOME, skippedReason: "turn_failed" };
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return { ...EMPTY_OUTCOME, skippedReason: "no_session_id" };
  }
  const located = findLastUserText(event.messages);
  if (!located) {
    return { ...EMPTY_OUTCOME, skippedReason: "no_user_text" };
  }

  const candidates = extractCandidates(located.text);
  if (candidates.length === 0) {
    return { ...EMPTY_OUTCOME };
  }

  ensureIngestSchema(deps.db);
  const now = deps.now();
  const outcome: IngestOutcome = {
    candidatesConsidered: candidates.length,
    inserted: 0,
    deduped: 0,
    filteredAsSecret: 0,
  };

  for (const candidate of candidates) {
    if (looksLikeSecret(candidate.text)) {
      outcome.filteredAsSecret++;
      continue;
    }
    writeCandidate({
      db: deps.db,
      sessionId,
      messageIndex: located.index,
      candidate,
      now,
      dedupeOptions: deps.dedupeOptions,
      outcome,
    });
  }
  return outcome;
}

function writeCandidate(params: {
  db: DatabaseSync;
  sessionId: string;
  messageIndex: number;
  candidate: Candidate;
  now: number;
  dedupeOptions: DedupeOptions | undefined;
  outcome: IngestOutcome;
}): void {
  const { db, sessionId, messageIndex, candidate, now, dedupeOptions, outcome } = params;
  const ref = synthesizeConversationRef({
    sessionId,
    messageIndex,
    candidateText: candidate.text,
  });
  const refId = memoryRefId(ref);
  const normalized = normalizeForMatch(candidate.text);

  // Stage A: same synthetic ref already present → bump last_seen_at only.
  const existing = getByRefId(db, refId);
  if (existing) {
    upsertRecord(db, ref, { lastSeenAt: now }, now);
    upsertIngestText(db, refId, normalized);
    outcome.deduped++;
    return;
  }

  // Stage B: lexical duplicate of a different ref of the same memory_type.
  const dup = findLexicalDuplicate({
    db,
    memoryType: candidate.memoryType,
    candidateText: candidate.text,
    now,
    options: dedupeOptions,
  });
  if (dup) {
    db.prepare(`UPDATE memory_v2_records SET last_seen_at = ? WHERE ref_id = ?`).run(
      now,
      dup.refId,
    );
    outcome.deduped++;
    return;
  }

  // Insert.
  upsertRecord(
    db,
    ref,
    {
      memoryType: candidate.memoryType,
      importance: candidate.importance,
      salience: candidate.importance,
      confidence: candidate.confidence,
      status: "active",
      sourceKind: "conversation",
      sourceRef: `${sessionId}:${messageIndex}`,
      lastSeenAt: now,
    },
    now,
  );
  upsertIngestText(db, refId, normalized);
  outcome.inserted++;
}

type LocatedText = { index: number; text: string };

// Walks the message array from the end and returns the last user-role
// message's plain-text content. Tolerates shapes used by both the Anthropic
// ContentBlock array form and the simple {role, content: string} form.
export function findLastUserText(messages: readonly unknown[]): LocatedText | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isObject(msg)) {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role !== "user") {
      continue;
    }
    const text = extractTextContent((msg as { content?: unknown }).content);
    if (text === null || text.trim().length === 0) {
      continue;
    }
    return { index: i, text };
  }
  return null;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isObject(block)) {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
