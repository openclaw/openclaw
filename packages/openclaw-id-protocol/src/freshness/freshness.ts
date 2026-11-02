// Client revocation and freshness rules (freshness/v1). Clients run assessFreshness after
// verifyBindingForPin succeeds and before any socket opens.
//
// A ServerBinding never expires and an equal binding_seq passes the pin check, so a retired K_srv
// plus a Discovery that replays the old descriptor would otherwise reach a client that has not
// seen the newer binding. Two authenticated inputs close that:
// - Revocations: owner-signed Revocation statements (verified against the pinned anchor) and the
//   revoked[] list of the claw's K_gw-signed MembershipSnapshot. Both only ever add to a set the
//   client keeps for good; nobody can remove a revocation by withholding it later.
// - Freshness: a K_gw-signed MembershipSnapshot for the binding being dialed, issued within
//   SNAPSHOT_MAX_AGE_SECONDS and not older than one already seen. It names the Gateway's current
//   binding_seq, so a replayed older binding is refused once the Gateway has signed a newer one.
// Withheld or stale freshness is refused under the "enforce" policy and only reported under
// "report"; learned revocations and positive evidence of a stale binding always refuse.
import { fingerprint, type KeyFingerprint } from "../keys.js";
import type { ServerBindingBody } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  verifyMembershipSnapshot,
  verifyOwnerStatement,
  type TrustAnchor,
} from "../statements/verify.js";

/** Oldest snapshot a client accepts as fresh evidence, seconds. */
export const SNAPSHOT_MAX_AGE_SECONDS = 3 * 3600;
/** Longest the Gateway waits between re-signing its snapshot, seconds (even when nothing changed). */
export const SNAPSHOT_REPUBLISH_SECONDS = 3600;
/** Tolerated clock skew for a snapshot's issued_at, seconds. */
export const SNAPSHOT_CLOCK_SKEW_SECONDS = 300;

/** "enforce": dial only with fresh evidence. "report": dial anyway and record the gap. */
export type FreshnessPolicy = "enforce" | "report";

/** The order of snapshots: by seq, then issued_at. */
export type SnapshotOrder = { seq: number; issued_at: number };

/** True when `a` is strictly older than `b` (by seq, then issued_at). */
export function isOlderSnapshot(a: SnapshotOrder, b: SnapshotOrder): boolean {
  return a.seq < b.seq || (a.seq === b.seq && a.issued_at < b.issued_at);
}

/** What a client keeps per origin. Only grows. */
export type RevocationState = {
  claw_id: string;
  /** Every revoked key fingerprint learned from an authenticated source. */
  revoked: KeyFingerprint[];
  /** Newest verified snapshot seen: snapshots older than this are replays. */
  snapshot: { seq: number; issued_at: number; binding_seq: number } | null;
};

/** Untrusted evidence as served by Discovery (null: not served, or the call failed). */
export type FreshnessEvidence = { snapshot: unknown; revocations: unknown[] | null };

/** Why there is no fresh evidence for this binding. */
export type FreshnessGap =
  | "snapshot_missing"
  | "snapshot_invalid"
  | "snapshot_stale"
  | "snapshot_future"
  | "snapshot_replayed"
  | "snapshot_lagging";

/** Outcome of {@link assessFreshness}. */
export type FreshnessAssessment = {
  /** The state to store, whatever the verdict: learned revocations stick. */
  state: RevocationState;
  /** Fingerprints learned in this call that the stored state did not have. */
  learned: KeyFingerprint[];
  /** Verdict for dialing this binding. */
  verdict:
    | { ok: true; fresh: true; snapshotAge: number }
    | { ok: true; fresh: false; gap: FreshnessGap }
    | {
        ok: false;
        code: "server_key_revoked" | "stale_binding" | "freshness_unavailable";
        detail: string;
      };
};

/** Inputs besides the evidence. */
export type FreshnessContext = {
  /** The binding that verified against the pin, and the anchor it verified under. */
  binding: ServerBindingBody;
  anchor: TrustAnchor;
  /** The client's stored state for this origin, if any. */
  stored: RevocationState | null;
  /** Unix seconds. */
  now: number;
  policy: FreshnessPolicy;
};

/** The revocations stored for a claw (empty when the stored state belongs to another claw). */
export function knownRevocations(
  stored: RevocationState | null,
  clawId: string,
): Set<KeyFingerprint> {
  return new Set(stored?.claw_id === clawId ? stored.revoked : []);
}

/**
 * Verifies the evidence, merges authenticated revocations into the stored state and decides
 * whether the binding may be dialed. When `learned` is non-empty the caller re-runs
 * verifyBindingForPin with the merged set (a device-signed binding's chain may be what was
 * revoked).
 */
export async function assessFreshness(
  evidence: FreshnessEvidence,
  ctx: FreshnessContext,
): Promise<FreshnessAssessment> {
  const { binding, now } = ctx;
  const base = ctx.stored?.claw_id === binding.claw_id ? ctx.stored : null;
  const known = knownRevocations(base, binding.claw_id);
  const learned = new Set<KeyFingerprint>();
  const isRevoked = (fp: KeyFingerprint) => known.has(fp) || learned.has(fp);
  // Owner-signed revocations count under the pinned anchor whatever Discovery says about them.
  for (const raw of evidence.revocations ?? []) {
    const parsed = parseStatement(raw, "Revocation");
    if (!parsed.ok) {
      continue;
    }
    const verified = await verifyOwnerStatement(parsed.statement, ctx.anchor, { now, isRevoked });
    if (verified.ok && !known.has(parsed.statement.body.target_fp)) {
      learned.add(parsed.statement.body.target_fp);
    }
  }
  // The Gateway's snapshot: revoked[] is K_gw-attested, and it can only tighten.
  const served = evidence.snapshot !== null && evidence.snapshot !== undefined;
  const snapshot = served ? await verifiedSnapshot(evidence.snapshot, binding) : null;
  for (const fp of snapshot?.revoked ?? []) {
    if (!known.has(fp)) {
      learned.add(fp);
    }
  }
  const storable =
    snapshot && snapshot.issued_at <= now + SNAPSHOT_CLOCK_SKEW_SECONDS ? snapshot : null;
  const state: RevocationState = {
    claw_id: binding.claw_id,
    revoked: [...known, ...learned],
    // A snapshot from the future is never stored: it would make every honest snapshot look replayed.
    snapshot: newestSnapshot(base?.snapshot ?? null, storable),
  };
  const result = { state, learned: [...learned] };
  // Revoked server keys refuse whatever the policy.
  for (const key of [binding.k_srv, binding.k_gw]) {
    if (isRevoked(await fingerprint(key))) {
      return {
        ...result,
        verdict: {
          ok: false,
          code: "server_key_revoked",
          detail: "the binding's server key is revoked",
        },
      };
    }
  }
  // The Gateway has signed a newer binding than the one served: positive evidence of a replay.
  const highest = Math.max(snapshot?.binding_seq ?? 0, base?.snapshot?.binding_seq ?? 0);
  if (highest > binding.binding_seq) {
    return {
      ...result,
      verdict: {
        ok: false,
        code: "stale_binding",
        detail: `the Gateway signed binding_seq ${highest}, Discovery served ${binding.binding_seq}`,
      },
    };
  }
  const gap =
    served && !snapshot
      ? "snapshot_invalid"
      : freshnessGap(snapshot, base?.snapshot ?? null, binding, now);
  if (gap === null) {
    return {
      ...result,
      verdict: { ok: true, fresh: true, snapshotAge: now - snapshot!.issued_at },
    };
  }
  if (ctx.policy === "enforce") {
    return { ...result, verdict: { ok: false, code: "freshness_unavailable", detail: gap } };
  }
  return { ...result, verdict: { ok: true, fresh: false, gap } };
}

type SnapshotFacts = {
  seq: number;
  issued_at: number;
  binding_seq: number;
  revoked: KeyFingerprint[];
};

// The snapshot's facts when it is well formed and signed by this binding's K_gw for this claw.
async function verifiedSnapshot(
  raw: unknown,
  binding: ServerBindingBody,
): Promise<SnapshotFacts | null> {
  const parsed = parseStatement(raw, "MembershipSnapshot");
  if (!parsed.ok) {
    return null;
  }
  const verified = await verifyMembershipSnapshot(parsed.statement, binding);
  if (!verified.ok) {
    return null;
  }
  const { seq, issued_at, binding_seq, revoked } = parsed.statement.body;
  return { seq, issued_at, binding_seq, revoked };
}

// Why the snapshot is not fresh evidence for this binding, or null when it is.
function freshnessGap(
  snapshot: SnapshotFacts | null,
  seen: RevocationState["snapshot"],
  binding: ServerBindingBody,
  now: number,
): FreshnessGap | null {
  if (!snapshot) {
    return "snapshot_missing";
  }
  if (snapshot.issued_at > now + SNAPSHOT_CLOCK_SKEW_SECONDS) {
    return "snapshot_future";
  }
  if (snapshot.issued_at < now - SNAPSHOT_MAX_AGE_SECONDS) {
    return "snapshot_stale";
  }
  if (seen && isOlderSnapshot(snapshot, seen)) {
    return "snapshot_replayed";
  }
  if (snapshot.binding_seq < binding.binding_seq) {
    return "snapshot_lagging";
  }
  return null;
}

// The newer of the stored marker and a verified snapshot (by seq, then issued_at).
function newestSnapshot(
  seen: RevocationState["snapshot"],
  snapshot: SnapshotFacts | null,
): RevocationState["snapshot"] {
  if (!snapshot) {
    return seen;
  }
  const marker = {
    seq: snapshot.seq,
    issued_at: snapshot.issued_at,
    binding_seq: snapshot.binding_seq,
  };
  return seen && !isOlderSnapshot(seen, marker) ? seen : marker;
}
