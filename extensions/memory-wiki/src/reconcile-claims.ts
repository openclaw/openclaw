import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClaimKey, resolveClaimKey } from "./claim-key.js";

export type ReconcileClaimStatus = "current" | "stale" | "contested" | "superseded";

export type ReconcileClaimInput = {
  claim_id?: string;
  claim_key?: string;
  statement: string;
  status?: string;
  source_path?: string;
  source_repo?: string;
  source_commit?: string;
  source_class?: string;
  authority_tier?: number;
  asserted_at?: string;
  extracted_at?: string;
  valid_from?: string;
  valid_until?: string | null;
  supersedes?: string[];
  superseded_by?: string[];
  confidence?: number;
  page_path?: string;
};

export type ReconciledClaim = Required<
  Pick<
    ReconcileClaimInput,
    | "claim_id"
    | "claim_key"
    | "statement"
    | "source_class"
    | "authority_tier"
    | "asserted_at"
    | "extracted_at"
    | "valid_from"
    | "supersedes"
    | "superseded_by"
  >
> & {
  status: ReconcileClaimStatus;
  valid_until: string | null;
  source_path?: string;
  source_repo?: string;
  source_commit?: string;
  confidence?: number;
  page_path?: string;
};

const STATUS_ALIASES = new Map<string, ReconcileClaimStatus>([
  ["current", "current"],
  ["supported", "current"],
  ["active", "current"],
  ["stale", "stale"],
  ["expired", "stale"],
  ["contested", "contested"],
  ["contradicted", "contested"],
  ["refuted", "contested"],
  ["superseded", "superseded"],
]);

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function normalizeStatus(status?: string): ReconcileClaimStatus {
  return STATUS_ALIASES.get(normalizeLowercaseStringOrEmpty(status)) ?? "current";
}

function parseTime(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value?: string | null): string | undefined {
  const parsed = parseTime(value);
  return parsed === null ? undefined : new Date(parsed).toISOString();
}

function compareClaimTime(left: ReconciledClaim, right: ReconciledClaim): number {
  const leftMs =
    parseTime(left.valid_from) ?? parseTime(left.asserted_at) ?? parseTime(left.extracted_at) ?? 0;
  const rightMs =
    parseTime(right.valid_from) ??
    parseTime(right.asserted_at) ??
    parseTime(right.extracted_at) ??
    0;
  return leftMs - rightMs;
}

function normalizeStatement(statement: string): string {
  return normalizeLowercaseStringOrEmpty(statement).replace(/\s+/g, " ").trim();
}

function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.filter((value) => value.trim()).map((value) => value.trim())),
  ].toSorted();
}

function createFallbackClaimId(claim: ReconcileClaimInput): string {
  const basis = [claim.claim_key, claim.page_path, claim.source_path, claim.statement]
    .filter(Boolean)
    .join("\n");
  return `claim.${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function normalizeSourceClass(sourceClass?: string): string {
  return normalizeClaimKey(sourceClass ?? "source").replace(/\./g, "_") || "source";
}

function normalizeClaim(claim: ReconcileClaimInput): ReconciledClaim {
  const assertedAt = normalizeTimestamp(claim.asserted_at) ?? FALLBACK_TIMESTAMP;
  const extractedAt = normalizeTimestamp(claim.extracted_at) ?? assertedAt;
  const validFrom = normalizeTimestamp(claim.valid_from) ?? assertedAt;
  return {
    claim_id: claim.claim_id?.trim() || createFallbackClaimId(claim),
    claim_key: resolveClaimKey({
      claimKey: claim.claim_key,
      claimId: claim.claim_id,
      statement: claim.statement,
      pagePath: claim.page_path,
      sourcePath: claim.source_path,
    }),
    statement: claim.statement.trim(),
    status: normalizeStatus(claim.status),
    ...(claim.source_path ? { source_path: claim.source_path } : {}),
    ...(claim.source_repo ? { source_repo: claim.source_repo } : {}),
    ...(claim.source_commit ? { source_commit: claim.source_commit } : {}),
    source_class: normalizeSourceClass(claim.source_class),
    authority_tier:
      Number.isInteger(claim.authority_tier) && claim.authority_tier !== undefined
        ? claim.authority_tier
        : 0,
    asserted_at: assertedAt,
    extracted_at: extractedAt,
    valid_from: validFrom,
    valid_until:
      claim.valid_until === null ? null : (normalizeTimestamp(claim.valid_until) ?? null),
    supersedes: uniqueSorted(claim.supersedes ?? []),
    superseded_by: uniqueSorted(claim.superseded_by ?? []),
    ...(typeof claim.confidence === "number" && Number.isFinite(claim.confidence)
      ? { confidence: claim.confidence }
      : {}),
    ...(claim.page_path ? { page_path: claim.page_path } : {}),
  };
}

function markSuperseded(older: ReconciledClaim, newer: ReconciledClaim) {
  older.status = "superseded";
  older.superseded_by = uniqueSorted([...older.superseded_by, newer.claim_id]);
  newer.supersedes = uniqueSorted([...newer.supersedes, older.claim_id]);
}

function markContested(left: ReconciledClaim, right: ReconciledClaim) {
  if (left.status !== "superseded") {
    left.status = "contested";
  }
  if (right.status !== "superseded") {
    right.status = "contested";
  }
}

export function reconcileClaims(params: {
  claims: ReconcileClaimInput[];
  now?: Date;
}): ReconciledClaim[] {
  const nowMs = (params.now ?? new Date()).getTime();
  const reconciled = params.claims.map(normalizeClaim);

  for (const claim of reconciled) {
    const validUntilMs = parseTime(claim.valid_until);
    if (validUntilMs !== null && validUntilMs <= nowMs) {
      claim.status = "stale";
    }
  }

  const byKey = new Map<string, ReconciledClaim[]>();
  for (const claim of reconciled) {
    const group = byKey.get(claim.claim_key) ?? [];
    group.push(claim);
    byKey.set(claim.claim_key, group);
  }

  for (const group of byKey.values()) {
    const active = group
      .filter((claim) => claim.status !== "stale")
      .toSorted((left, right) => compareClaimTime(left, right));

    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const older = active[i];
        const newer = active[j];
        if (
          !older ||
          !newer ||
          normalizeStatement(older.statement) === normalizeStatement(newer.statement)
        ) {
          continue;
        }
        if (newer.authority_tier > older.authority_tier && compareClaimTime(older, newer) <= 0) {
          markSuperseded(older, newer);
          continue;
        }
        if (newer.authority_tier === older.authority_tier) {
          markContested(older, newer);
        }
      }
    }
  }

  return reconciled;
}
