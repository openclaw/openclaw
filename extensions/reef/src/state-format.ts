import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fromBase64url } from "../protocol/encoding.js";
import { parseVerdict } from "../protocol/guard.js";
import type { ReviewRequest } from "../protocol/pipeline.js";
import type { ReefKeys } from "./types.js";

export const REEF_KEYS_NAMESPACE = "identity";
export const REEF_KEYS_KEY = "keys";
export const REEF_KEYS_MAX_ENTRIES = 1;
export const REEF_KEYS_MIGRATION_NAMESPACE = "identity-migration";
export const REEF_KEYS_MIGRATION_KEY = "keys-json";
export const REEF_KEYS_MIGRATION_MAX_ENTRIES = 1;
export const REEF_DURABLE_MIGRATION_NAMESPACE = "durable-migration";
export const REEF_DURABLE_MIGRATION_KEY = "legacy-files";
export const REEF_DURABLE_MIGRATION_MAX_ENTRIES = 1;
export const REEF_REVIEWS_NAMESPACE = "reviews";
export const REEF_REVIEWS_MAX_ENTRIES = 2_000;
export type ReefReviewRecord = { review: ReviewRequest; approved?: boolean };

export type ReefIdentityMigrationRecord = {
  pending: true;
  identityBindingRequired: boolean;
};
export type ReefDurableMigrationRecord = { pending: true };

export function parseReefReviewRecord(value: unknown): ReefReviewRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isRecord(value.review) ||
    (value.approved !== undefined && typeof value.approved !== "boolean")
  ) {
    throw new Error("invalid Reef review record");
  }
  const review = value.review;
  if (
    typeof review.id !== "string" ||
    typeof review.from !== "string" ||
    typeof review.to !== "string" ||
    (review.direction !== "inbound" && review.direction !== "outbound") ||
    typeof review.bodyHash !== "string" ||
    typeof review.approvalDigest !== "string"
  ) {
    throw new Error("invalid Reef review record");
  }
  return {
    review: {
      id: review.id,
      from: review.from,
      to: review.to,
      direction: review.direction,
      bodyHash: review.bodyHash,
      approvalDigest: review.approvalDigest,
      verdict: parseVerdict(review.verdict),
    },
    ...(value.approved === undefined ? {} : { approved: value.approved }),
  };
}

export function parseReefKeys(value: unknown): ReefKeys {
  if (!value || typeof value !== "object") {
    throw new Error("invalid Reef keys");
  }
  // SAFETY: Every key is checked for canonical 32-byte encoding and the epoch is validated below.
  const keys = value as ReefKeys;
  if (
    fromBase64url(keys.signing?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.signing?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.auditKey ?? "").length !== 32 ||
    fromBase64url(keys.replayKey ?? "").length !== 32 ||
    !Number.isSafeInteger(keys.keyEpoch) ||
    keys.keyEpoch < 1
  ) {
    throw new Error("invalid Reef keys");
  }
  return structuredClone(keys);
}
