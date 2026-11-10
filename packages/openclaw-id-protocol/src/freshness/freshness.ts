// Client freshness rules (freshness/v1). Clients run assessFreshness after
// verifyBindingForPin succeeds and before any socket opens.
//
// A ServerBinding never expires and an equal binding_seq passes the pin check, so a retired K_srv
// plus a Discovery that replays the old descriptor would otherwise reach a client that has not
// seen the newer binding. Freshness closes that: a K_gw-signed MembershipSnapshot for the binding
// being dialed, issued within SNAPSHOT_MAX_AGE_SECONDS and not older than one already seen. It
// names the Gateway's current binding_seq, so a replayed older binding is refused once the
// Gateway has signed a newer one. A replaced server key is retired by that binding_seq alone;
// no list of revoked keys exists. Withheld or stale freshness is refused under the "enforce"
// policy and only reported under "report"; positive evidence of a stale binding always refuses.
//
// Snapshots are ordered only among those signed by the same K_gw. After a re-bind to a new K_gw
// the order restarts with the first snapshot verified under the new binding: the retired key
// may have signed an inflated seq or a future issued_at. The binding_seq high-water carries over.
//
// Only R-signed bindings raise the binding_seq high-water. A snapshot naming a binding_seq
// above the binding it verified under is refused (`snapshot_ahead`) and nothing of it is kept:
// a re-bind always replaces K_gw, so an honest K_gw never names a binding beyond its own, and a
// stolen one must not be able to retire every binding a client could still verify.
import type { Ed25519PublicKey } from "../keys.js";
import type { ProtocolVersions, ServerBindingBody } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyMembershipSnapshot } from "../statements/verify.js";

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

/** What a client keeps per origin. */
export type FreshnessState = {
  claw_id: string;
  /**
   * High-water facts: the newest (seq, issued_at) among verified snapshots signed by `k_gw`,
   * and the highest binding_seq of an R-signed binding verified with one. This unsigned marker
   * only refuses replays/retired bindings; it never supplies membership or protocols for
   * authorization. Only a snapshot verified under a higher binding moves the order to another
   * key. A marker without `k_gw` (stored before per-key order) counts as the current K_gw's;
   * load such markers through {@link clampFreshnessState}.
   */
  snapshot: { seq: number; issued_at: number; binding_seq: number; k_gw?: Ed25519PublicKey } | null;
};

/** Untrusted evidence as served by Discovery (null: not served, or the call failed). */
export type FreshnessEvidence = { snapshot: unknown };

/** Why there is no fresh evidence for this binding. */
export type FreshnessGap =
  | "snapshot_missing"
  | "snapshot_invalid"
  | "snapshot_stale"
  | "snapshot_future"
  | "snapshot_replayed"
  | "snapshot_lagging";

/** Refusal codes of {@link assessFreshness}. */
export type FreshnessRefusal = "stale_binding" | "snapshot_ahead" | "freshness_unavailable";

/** Outcome of {@link assessFreshness}. */
export type FreshnessAssessment = {
  /** The state to store, whatever the verdict. */
  state: FreshnessState;
  /** Verdict for dialing this binding. */
  verdict:
    /**
     * Fresh evidence. `protocols` is the Gateway's signed version list from that snapshot: the
     * only input `selectVersion` may use. Without fresh evidence there is no list; the Gateway's
     * own enforcement is what keeps a client off a version it refuses (docs/versioning.md).
     */
    | { ok: true; fresh: true; snapshotAge: number; protocols: ProtocolVersions }
    | { ok: true; fresh: false; gap: FreshnessGap }
    | { ok: false; code: FreshnessRefusal; detail: string };
};

/** Inputs besides the evidence. */
export type FreshnessContext = {
  /** The binding that verified against the pin. */
  binding: ServerBindingBody;
  /** The client's stored state for this origin, if any. */
  stored: FreshnessState | null;
  /** Unix seconds. */
  now: number;
  policy: FreshnessPolicy;
};

/**
 * Verifies the snapshot evidence, records the newest snapshot seen and decides whether the
 * binding may be dialed.
 */
export async function assessFreshness(
  evidence: FreshnessEvidence,
  ctx: FreshnessContext,
): Promise<FreshnessAssessment> {
  const { binding, now } = ctx;
  const base = ctx.stored?.claw_id === binding.claw_id ? ctx.stored : null;
  const served = evidence.snapshot !== null && evidence.snapshot !== undefined;
  const snapshot = served ? await verifiedSnapshot(evidence.snapshot, binding) : null;
  // A snapshot naming a binding beyond the one it verified under is K_gw's claim alone: refused,
  // and nothing of it is kept (J5).
  if (snapshot && snapshot.binding_seq > binding.binding_seq) {
    return {
      state: base ?? { claw_id: binding.claw_id, snapshot: null },
      verdict: {
        ok: false,
        code: "snapshot_ahead",
        detail: `the snapshot names binding_seq ${snapshot.binding_seq}, Discovery served ${binding.binding_seq}`,
      },
    };
  }
  const storable =
    snapshot && snapshot.issued_at <= now + SNAPSHOT_CLOCK_SKEW_SECONDS ? snapshot : null;
  // A snapshot from the future is never stored: it would make honest snapshots look replayed.
  const state = mergeFreshnessState(base, {
    claw_id: binding.claw_id,
    snapshot: storable
      ? {
          seq: storable.seq,
          issued_at: storable.issued_at,
          binding_seq: binding.binding_seq,
          k_gw: binding.k_gw,
        }
      : null,
  });
  const result = { state };
  // This client verified a newer R-signed binding before: the served one is a replay.
  const highest = base?.snapshot?.binding_seq ?? 0;
  if (highest > binding.binding_seq) {
    return {
      ...result,
      verdict: {
        ok: false,
        code: "stale_binding",
        detail: `binding_seq ${highest} was verified before, Discovery served ${binding.binding_seq}`,
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
      verdict: {
        ok: true,
        fresh: true,
        snapshotAge: now - snapshot!.issued_at,
        protocols: snapshot!.protocols,
      },
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
  protocols: ProtocolVersions;
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
  const { seq, issued_at, binding_seq, protocols } = parsed.statement.body;
  return { seq, issued_at, binding_seq, protocols };
}

// Why the snapshot is not fresh evidence for this binding, or null when it is.
function freshnessGap(
  snapshot: SnapshotFacts | null,
  seen: FreshnessState["snapshot"],
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
  if (seen && (seen.k_gw ?? binding.k_gw) === binding.k_gw && isOlderSnapshot(snapshot, seen)) {
    return "snapshot_replayed";
  }
  if (snapshot.binding_seq < binding.binding_seq) {
    return "snapshot_lagging";
  }
  return null;
}

/** Merge only verified local facts, including evidence retained after a refused refresh. */
export function mergeFreshnessState(
  current: FreshnessState | null | undefined,
  candidate: FreshnessState,
): FreshnessState {
  const before = current?.claw_id === candidate.claw_id ? current.snapshot : null;
  const next = candidate.snapshot;
  if (!before) {
    return candidate;
  }
  if (!next) {
    return { claw_id: candidate.claw_id, snapshot: before };
  }
  // Order is kept per K_gw; a new K_gw's snapshot restarts it only when it verified under a
  // newer R-signed binding (binding_seq comes only from verified bindings).
  const sameKey = (before.k_gw ?? next.k_gw) === next.k_gw;
  const newest = sameKey
    ? isOlderSnapshot(before, next)
      ? next
      : before
    : next.binding_seq > before.binding_seq
      ? next
      : before;
  const k_gw = sameKey ? (next.k_gw ?? before.k_gw) : newest.k_gw;
  return {
    claw_id: candidate.claw_id,
    snapshot: {
      seq: newest.seq,
      issued_at: newest.issued_at,
      binding_seq: Math.max(before.binding_seq, next.binding_seq),
      ...(k_gw ? { k_gw } : {}),
    },
  };
}

/**
 * Loads a marker stored before per-key order (no `k_gw`). Its binding_seq may be a snapshot's
 * claim, so it is capped at `verifiedBindingSeq` (the pin's), and its (seq, issued_at) cannot
 * be attributed to a key, so that order is dropped: kept, it would count as whichever K_gw
 * signs next, and a retired key's inflated seq would block the replacement key for good.
 * Markers with `k_gw` are left alone: their binding_seq is always a binding this client
 * verified, even one it then refused to dial. Accepted edge case: right after the upgrade the
 * current key's older snapshots are not refused as replays until a new one is stored.
 */
export function clampFreshnessState<T extends FreshnessState | null | undefined>(
  state: T,
  verifiedBindingSeq: number,
): T {
  if (!state?.snapshot || state.snapshot.k_gw !== undefined) {
    return state;
  }
  const binding_seq = Math.min(state.snapshot.binding_seq, verifiedBindingSeq);
  return { ...state, snapshot: { seq: 0, issued_at: 0, binding_seq } };
}
