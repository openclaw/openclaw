import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_CLAIM_KEY_SEGMENTS = 12;
const MAX_CLAIM_KEY_SEGMENT_LENGTH = 64;

function normalizeClaimKeySegment(raw: string): string {
  return normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CLAIM_KEY_SEGMENT_LENGTH);
}

export function normalizeClaimKey(raw: string): string {
  const segments = raw
    .split(/[./:]+/g)
    .flatMap((segment) => segment.split(/\s+>\s+|\s+::\s+/g))
    .map(normalizeClaimKeySegment)
    .filter(Boolean)
    .slice(0, MAX_CLAIM_KEY_SEGMENTS);
  return segments.join(".");
}

function inferKnownDomainClaimKey(statement: string): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(statement);
  if (
    /\b(active|current|selected)\b/.test(normalized) &&
    /\bcandidate\b/.test(normalized) &&
    /\b(openclaw|meta[- ]?harness|packet)\b/.test(normalized)
  ) {
    return "repo.openclaw.candidate.active";
  }
  if (
    /\b(live[- ]?dramic|live[- ]?dromic)\b/.test(normalized) &&
    /\b(mac|runtime|host)\b/.test(normalized)
  ) {
    return "runtime.livedramic.mac.location";
  }
  return null;
}

export function resolveClaimKey(params: {
  claimKey?: string;
  claimId?: string;
  statement: string;
  pagePath?: string;
  sourcePath?: string;
}): string {
  if (params.claimKey?.trim()) {
    const normalized = normalizeClaimKey(params.claimKey);
    if (normalized) {
      return normalized;
    }
  }

  const knownDomainKey = inferKnownDomainClaimKey(params.statement);
  if (knownDomainKey) {
    return knownDomainKey;
  }

  const stableBasis = [
    params.sourcePath?.trim(),
    params.pagePath?.trim(),
    params.claimId?.trim(),
    params.statement.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const digest = createHash("sha256").update(stableBasis).digest("hex").slice(0, 16);
  return `claim.${digest}`;
}
