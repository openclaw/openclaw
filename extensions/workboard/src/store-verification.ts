import { randomUUID } from "node:crypto";
import {
  WORKBOARD_VERIFICATION_OUTCOMES,
  type WorkboardCard,
  type WorkboardMetadata,
  type WorkboardVerification,
} from "@openclaw/workboard-contract";
import { definedFields } from "../record-fields.js";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";
import type { WorkboardUpdateCardOptions } from "./store-inputs.js";
import {
  normalizeBoundedString,
  normalizeMetadata,
  trimMetadataToBudget,
} from "./store-normalizers.js";

const MAX_VERIFICATIONS = 4;
const MAX_VERIFICATION_TEXT = 300;
const MAX_VERIFICATION_URL = 500;

export function appendVerification(
  card: WorkboardCard,
  verification: WorkboardVerification,
): WorkboardVerification[] {
  return [...(card.metadata?.automation?.verifications ?? []), verification].slice(
    -MAX_VERIFICATIONS,
  );
}

function fitsCardBudget(metadata: WorkboardMetadata): boolean {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8") <= MAX_CARD_METADATA_BYTES;
}

function attachVerifications(metadata: WorkboardMetadata, verifications: WorkboardVerification[]) {
  return { ...metadata, automation: { ...metadata.automation, verifications } };
}

/**
 * Normalizes a metadata patch against the card's metadata without its stored
 * verifications, so ordinary normalization, settlement, and trimming never count them
 * or evict card records to keep them.
 */
export function normalizeWithoutVerifications(
  patch: unknown,
  existing: WorkboardCard,
  options: WorkboardUpdateCardOptions,
): WorkboardMetadata {
  const fallback = { ...existing.metadata };
  if (fallback.automation?.verifications) {
    fallback.automation = { ...fallback.automation };
    delete fallback.automation.verifications;
  }
  return normalizeMetadata(patch, fallback, {
    automationLaunch: options.automationLaunch,
    allowDependencyLinks: options.allowMetadataDependencyLinks !== false,
    preserveProofId: options.preserveProofId,
    preserveNotificationId: options.preserveNotificationId,
  });
}

/**
 * Verifications are store-owned. Normalizing a metadata patch never carries them, so
 * every card write restores the stored list, or the one workboard_verify built, here.
 * Raw metadata therefore cannot add, edit, or drop them.
 *
 * Runs on the finished card metadata: it trims the card's own records to budget first,
 * then fits verifications into the room left, dropping the oldest. They never make the
 * trimmer evict attempts, proof, or anything else.
 */
export function withStoredVerifications(
  metadata: WorkboardMetadata,
  existing: WorkboardCard,
  options: WorkboardUpdateCardOptions,
): WorkboardMetadata {
  const trimmed = trimMetadataToBudget(metadata, options);
  const verifications = [
    ...(options.automationVerifications ?? existing.metadata?.automation?.verifications ?? []),
  ];
  for (; verifications.length > 0; verifications.shift()) {
    const next = attachVerifications(trimmed, verifications);
    if (fitsCardBudget(next)) {
      return next;
    }
  }
  return trimmed;
}

/** Whether one more verification fits beside the card's other records. */
export function verificationFits(card: WorkboardCard, record: WorkboardVerification): boolean {
  return fitsCardBudget(attachVerifications(card.metadata ?? {}, [record]));
}

function cardHasId(entries: readonly { id: string }[] | undefined, id: string | undefined) {
  return !id || Boolean(entries?.some((entry) => entry.id === id));
}

/** A checker's verdict. The checker identity comes from the caller, never the request. */
export function buildVerification(
  card: WorkboardCard,
  input: Record<string, unknown>,
  checkerId: string,
  now: number,
): WorkboardVerification {
  const scope = normalizeBoundedString(input.scope, undefined, MAX_VERIFICATION_TEXT, "scope");
  if (!scope) {
    throw new Error("verification scope is required: say what was checked.");
  }
  const outcome = WORKBOARD_VERIFICATION_OUTCOMES.find((value) => value === input.outcome);
  if (!outcome) {
    throw new Error(`outcome must be one of: ${WORKBOARD_VERIFICATION_OUTCOMES.join(", ")}.`);
  }
  const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
  const artifactId = normalizeBoundedString(input.artifactId, undefined, 120, "artifact id");
  const runId = normalizeBoundedString(input.runId, undefined, 512, "run id");
  if (!cardHasId(card.metadata?.proof, proofId)) {
    throw new Error(`proof not found on card: ${proofId}`);
  }
  if (!cardHasId(card.metadata?.artifacts, artifactId)) {
    throw new Error(`artifact not found on card: ${artifactId}`);
  }
  if (runId && !card.metadata?.attempts?.some((attempt) => attempt.runId === runId)) {
    throw new Error(`run not found on card: ${runId}`);
  }
  const url = normalizeBoundedString(
    input.url,
    undefined,
    MAX_VERIFICATION_URL,
    "verification URL",
  );
  if (url && !/^https?:\/\//i.test(url)) {
    throw new Error("verification URL must start with http:// or https://.");
  }
  const workerIds = [card.agentId, card.sessionKey, card.metadata?.claim?.ownerId];
  return definedFields<WorkboardVerification>({
    id: randomUUID(),
    recordedAt: now,
    checkerId,
    checkedOwnWork: workerIds.includes(checkerId),
    scope,
    outcome,
    proofId,
    artifactId,
    runId,
    note: normalizeBoundedString(input.note, undefined, MAX_VERIFICATION_TEXT, "verification note"),
    url,
  });
}
