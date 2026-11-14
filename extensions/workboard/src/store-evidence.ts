import { randomUUID } from "node:crypto";
import {
  WORKBOARD_VERIFICATION_OUTCOMES,
  type WorkboardCard,
  type WorkboardMetadata,
  type WorkboardObservationOutcome,
  type WorkboardResultClaim,
  type WorkboardResultEvidence,
  type WorkboardResultObservation,
  type WorkboardResultVerification,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { definedFields } from "../record-fields.js";
import { cardRunId } from "./store-card-helpers.js";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";
import type { WorkboardUpdateCardOptions } from "./store-inputs.js";
import {
  normalizeBoundedString,
  normalizeMetadata,
  trimMetadataToBudget,
} from "./store-normalizers.js";

// Evidence lives in automation JSON, outside the metadata trim loop, so it keeps its
// own bounds: the newest few of each kind, then a byte cap on the whole list.
const MAX_EVIDENCE_PER_KIND = 4;
const MAX_EVIDENCE_BYTES = 6 * 1024;
export const MAX_COMPLETION_CLAIMS = 4;
const MAX_EVIDENCE_TEXT = 300;
const MAX_EVIDENCE_URL = 500;

// Per-kind retention keeps one kind (repeated checks, many runs) from evicting another.
export function appendEvidence(
  existing: readonly WorkboardResultEvidence[] | undefined,
  added: readonly WorkboardResultEvidence[],
): WorkboardResultEvidence[] {
  const all = [...(existing ?? []), ...added];
  const kept = all.filter(
    (entry, index) =>
      all.slice(index + 1).filter((later) => later.kind === entry.kind).length <
      MAX_EVIDENCE_PER_KIND,
  );
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), "utf8") > MAX_EVIDENCE_BYTES) {
    kept.shift();
  }
  return kept;
}

function fitsCardBudget(metadata: WorkboardMetadata): boolean {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8") <= MAX_CARD_METADATA_BYTES;
}

function attachEvidence(metadata: WorkboardMetadata, evidence: WorkboardResultEvidence[]) {
  return { ...metadata, automation: { ...metadata.automation, evidence } };
}

/**
 * Ordinary metadata normalization, settlement, and trimming never see stored evidence,
 * so none of them can evict card records to keep it; withStoredEvidence restores
 * what fits once the card's own metadata is final.
 */
export function normalizeWithoutEvidence(
  patch: unknown,
  existing: WorkboardCard,
  options: WorkboardUpdateCardOptions,
): WorkboardMetadata {
  const automation = existing.metadata?.automation;
  if (!automation?.evidence) {
    return normalizeMetadata(patch, existing.metadata, options);
  }
  const ordinary = { ...automation };
  delete ordinary.evidence;
  return normalizeMetadata(patch, { ...existing.metadata, automation: ordinary }, options);
}

/**
 * Evidence is store-owned. Normalizing a metadata patch never carries it, so every
 * card write restores the stored list, or the replacement an evidence writer built,
 * here. Raw metadata therefore cannot add, edit, or drop evidence.
 *
 * Runs on the finished card metadata: it trims the card's own records to budget
 * first, then fits evidence into the room left, dropping its own oldest entries.
 * Evidence never makes the trimmer evict attempts, proof, or anything else.
 */
export function withStoredEvidence(
  metadata: WorkboardMetadata,
  existing: WorkboardCard,
  options: WorkboardUpdateCardOptions,
): WorkboardMetadata {
  const trimmed = trimMetadataToBudget(metadata, options);
  const evidence = [
    ...(options.automationEvidence ?? existing.metadata?.automation?.evidence ?? []),
  ];
  for (; evidence.length > 0; evidence.shift()) {
    const next = attachEvidence(trimmed, evidence);
    if (fitsCardBudget(next)) {
      return next;
    }
  }
  return trimmed;
}

/** Whether one more evidence record fits beside the card's other records. */
export function evidenceFits(card: WorkboardCard, record: WorkboardResultEvidence): boolean {
  return fitsCardBudget(attachEvidence(card.metadata ?? {}, [record]));
}

function cardHasId(entries: readonly { id: string }[] | undefined, id: string | undefined) {
  return !id || Boolean(entries?.some((entry) => entry.id === id));
}

/** Worker claims recorded by workboard_complete; the caller identity is stamped here. */
export function buildCompletionClaims(
  card: WorkboardCard,
  input: unknown,
  claimedBy: string,
  now: number,
): WorkboardResultClaim[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input) || input.length > MAX_COMPLETION_CLAIMS) {
    throw new Error(`claims must be a list of at most ${MAX_COMPLETION_CLAIMS} entries.`);
  }
  const runId = cardRunId(card);
  return input.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const statement = normalizeBoundedString(
      record.statement,
      undefined,
      MAX_EVIDENCE_TEXT,
      "claim statement",
    );
    if (!statement) {
      throw new Error("claim statement is required.");
    }
    const proofId = normalizeBoundedString(record.proofId, undefined, 120, "claim proof id");
    if (!cardHasId(card.metadata?.proof, proofId)) {
      throw new Error(`claim proof not found on card: ${proofId}`);
    }
    return definedFields<WorkboardResultClaim>({
      kind: "claim",
      id: randomUUID(),
      recordedAt: now,
      claimedBy,
      statement,
      proofId,
      runId,
    });
  });
}

function knownWorkerIds(card: WorkboardCard): Set<string> {
  const ids = new Set<string>();
  for (const id of [card.agentId, card.sessionKey, card.metadata?.claim?.ownerId]) {
    if (id) {
      ids.add(id);
    }
  }
  for (const entry of card.metadata?.automation?.evidence ?? []) {
    if (entry.kind === "claim") {
      ids.add(entry.claimedBy);
    }
  }
  return ids;
}

/** A checker's verdict. The checker identity comes from the caller, never the request. */
export function buildVerification(
  card: WorkboardCard,
  input: Record<string, unknown>,
  checkerId: string,
  now: number,
): WorkboardResultVerification {
  const scope = normalizeBoundedString(input.scope, undefined, MAX_EVIDENCE_TEXT, "scope");
  if (!scope) {
    throw new Error("verification scope is required: say what was checked.");
  }
  const outcome = WORKBOARD_VERIFICATION_OUTCOMES.find((value) => value === input.outcome);
  if (!outcome) {
    throw new Error(`outcome must be one of: ${WORKBOARD_VERIFICATION_OUTCOMES.join(", ")}.`);
  }
  const claimId = normalizeBoundedString(input.claimId, undefined, 120, "claim id");
  const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
  const artifactId = normalizeBoundedString(input.artifactId, undefined, 120, "artifact id");
  const runId = normalizeBoundedString(input.runId, undefined, 512, "run id");
  const claims = card.metadata?.automation?.evidence?.filter((entry) => entry.kind === "claim");
  if (!cardHasId(claims, claimId)) {
    throw new Error(`claim not found on card: ${claimId}`);
  }
  if (!cardHasId(card.metadata?.proof, proofId)) {
    throw new Error(`proof not found on card: ${proofId}`);
  }
  if (!cardHasId(card.metadata?.artifacts, artifactId)) {
    throw new Error(`artifact not found on card: ${artifactId}`);
  }
  if (runId && !card.metadata?.attempts?.some((attempt) => attempt.runId === runId)) {
    throw new Error(`run not found on card: ${runId}`);
  }
  const url = normalizeBoundedString(input.url, undefined, MAX_EVIDENCE_URL, "verification URL");
  if (url && !/^https?:\/\//i.test(url)) {
    throw new Error("verification URL must start with http:// or https://.");
  }
  return definedFields<WorkboardResultVerification>({
    kind: "verification",
    id: randomUUID(),
    recordedAt: now,
    checkerId,
    checkedOwnWork: knownWorkerIds(card).has(checkerId),
    scope,
    outcome,
    claimId,
    proofId,
    artifactId,
    runId,
    note: normalizeBoundedString(input.note, undefined, MAX_EVIDENCE_TEXT, "verification note"),
    url,
  });
}

/**
 * A run outcome the session lifecycle reported for the card's linked session.
 * Returns undefined when the card already holds an observation of this run.
 */
export function buildLifecycleObservation(
  card: WorkboardCard,
  input: {
    outcome: WorkboardObservationOutcome;
    sessionKey: string;
    runId: string;
    observedAt: number;
  },
  now: number,
): WorkboardResultObservation | undefined {
  // Run settlement and subagent end can both report one run; the first report wins.
  const duplicate = card.metadata?.automation?.evidence?.some(
    (entry) =>
      entry.kind === "observation" &&
      entry.sessionKey === input.sessionKey &&
      entry.runId === input.runId,
  );
  if (duplicate) {
    return undefined;
  }
  return definedFields<WorkboardResultObservation>({
    kind: "observation",
    id: randomUUID(),
    recordedAt: now,
    observedAt: input.observedAt,
    source: "session-lifecycle",
    outcome: input.outcome,
    sessionKey: input.sessionKey,
    runId: input.runId,
  });
}
