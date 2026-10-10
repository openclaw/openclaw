import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
/**
 * Causal attribution for subagent runs orphaned by a gateway death.
 *
 * A run that was in flight when the gateway process disappeared is only
 * discovered later, when a fresh boot sweeps the registry. The reap timestamp
 * is therefore an arbitrarily late clock reading: it includes however long the
 * host stayed down. Describing the run's lifetime with it produces a confident
 * lie — a 5-minute run that died in a 34-minute outage reads as a 40-minute
 * run, which is exactly the evidence that talked one earlier investigation into
 * diagnosing a timeout on a run whose timeout was disabled.
 *
 * This module turns boot-lifecycle history that is already persisted into a
 * specific, causal message. It records what it observed and what it merely
 * bounded, and it never computes elapsed time from the reap.
 */
import {
  type GatewayBootLifecycleSegment,
  isInferredHostBootId,
  readGatewayBootLifecycleSegments,
} from "../../../infra/gateway-boot-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentOrphanCause =
  /** Host boot id changed across the gap: the machine went down under us. */
  | "host_reboot"
  /** Host boot id held across the gap: the gateway process alone died. */
  | "gateway_process_death"
  /** The boot ended abruptly, but host continuity cannot be established. */
  | "gateway_restart";

type SubagentOrphanDeathEvidence =
  /** The run's own last recorded activity. A lower bound on the death. */
  | "last_activity"
  /** The successor boot's start. An upper bound on the death. */
  | "successor_boot_start";

type SubagentOrphanElapsedBound = "at_least" | "at_most";

export type SubagentOrphanAttribution = {
  cause: SubagentOrphanCause;
  /** The boot that owned the run and did not stop cleanly. */
  priorBootId: string;
  /** When the gateway came back. */
  restartedAtMs: number;
  /** Best evidence for when the run actually stopped executing. */
  diedAtMs: number;
  diedAtEvidence: SubagentOrphanDeathEvidence;
  /** Lifetime measured from the death, never from the reap. */
  elapsedMs: number;
  elapsedBound: SubagentOrphanElapsedBound;
  /** Interval between the death bound and restart, not measured downtime. */
  restartGapMs: number;
  /** True when uptime-derived boot evidence forces a generic restart cause. */
  hostContinuityInferred: boolean;
  hasRecordedOutput: boolean;
};

/**
 * A boot ended abruptly when it recorded neither a completion time nor an
 * outcome. Every deliberate stop — clean, forced, planned, safe-mode — writes
 * at least one of the two, so a clean shutdown can never be misattributed here.
 */
function isAbruptGatewayBootEnd(segment: GatewayBootLifecycleSegment): boolean {
  return segment.completedAtMs === null && segment.outcome === null;
}

function resolveHostContinuity(
  prior: GatewayBootLifecycleSegment,
  successor: GatewayBootLifecycleSegment,
): { cause: SubagentOrphanCause; inferred: boolean } {
  if (!prior.hostBootId || !successor.hostBootId) {
    return { cause: "gateway_restart", inferred: false };
  }
  const inferred =
    isInferredHostBootId(prior.hostBootId) || isInferredHostBootId(successor.hostBootId);
  if (inferred) {
    // Uptime buckets are useful forensic hints, but equal buckets are not
    // collision-free host identities and unequal buckets can reflect clock
    // discipline. Never turn either relationship into a categorical reboot
    // or process-death claim.
    return { cause: "gateway_restart", inferred: true };
  }
  return {
    cause: prior.hostBootId === successor.hostBootId ? "gateway_process_death" : "host_reboot",
    inferred: false,
  };
}

/**
 * Picks the strongest available evidence for when the run stopped executing.
 * Preference order is by how tightly each bounds the death, not by convenience.
 */
function resolveDeathEvidence(params: {
  successor: GatewayBootLifecycleSegment;
  runStartedAtMs: number;
  lastActivityAtMs?: number;
}): { diedAtMs: number; evidence: SubagentOrphanDeathEvidence; bound: SubagentOrphanElapsedBound } {
  const lastActivityAtMs = params.lastActivityAtMs;
  // Strictly after the start: the start itself says nothing about how long the
  // run survived, and treating it as evidence would report a 0s lifetime — a
  // more confident claim than the honest "at most, up to the restart".
  if (
    typeof lastActivityAtMs === "number" &&
    Number.isFinite(lastActivityAtMs) &&
    lastActivityAtMs > params.runStartedAtMs &&
    lastActivityAtMs <= params.successor.startedAtMs
  ) {
    return { diedAtMs: lastActivityAtMs, evidence: "last_activity", bound: "at_least" };
  }
  // The gateway was certainly gone by the time its successor started. That is a
  // real bound; the reap timestamp is not one at all.
  return {
    diedAtMs: params.successor.startedAtMs,
    evidence: "successor_boot_start",
    bound: "at_most",
  };
}

/**
 * Correlates an orphaned run against boot history.
 *
 * Returns null when the evidence does not support a claim — no boot owned the
 * run, the owning boot is still running, or the owning boot stopped in a way
 * somebody recorded. Callers keep their existing wording in that case rather
 * than inventing a cause.
 */
export function resolveSubagentOrphanAttribution(params: {
  runStartedAtMs: number;
  lastActivityAtMs?: number;
  hasRecordedOutput?: boolean;
  boots: readonly GatewayBootLifecycleSegment[];
  currentBootId?: string;
}): SubagentOrphanAttribution | null {
  if (!Number.isFinite(params.runStartedAtMs)) {
    return null;
  }
  const boots = params.boots.toSorted((left, right) => left.startedAtMs - right.startedAtMs);
  let priorIndex = -1;
  for (let index = 0; index < boots.length; index += 1) {
    const segment = boots[index];
    if (segment && segment.startedAtMs <= params.runStartedAtMs) {
      priorIndex = index;
    }
  }
  const prior = priorIndex >= 0 ? boots[priorIndex] : undefined;
  if (!prior) {
    return null;
  }
  // The live boot cannot have orphaned its own in-flight work by restarting.
  if (params.currentBootId && prior.bootId === params.currentBootId) {
    return null;
  }
  if (!isAbruptGatewayBootEnd(prior)) {
    return null;
  }
  const successor = boots[priorIndex + 1];
  if (!successor) {
    return null;
  }
  if (
    typeof params.lastActivityAtMs === "number" &&
    params.lastActivityAtMs > successor.startedAtMs
  ) {
    // Run-written activity after the successor boot disproves that this run
    // died with the prior boot. Preserve the generic recovery wording.
    return null;
  }

  const death = resolveDeathEvidence({
    successor,
    runStartedAtMs: params.runStartedAtMs,
    lastActivityAtMs: params.lastActivityAtMs,
  });
  const continuity = resolveHostContinuity(prior, successor);
  return {
    cause: continuity.cause,
    priorBootId: prior.bootId,
    restartedAtMs: successor.startedAtMs,
    diedAtMs: death.diedAtMs,
    diedAtEvidence: death.evidence,
    elapsedMs: Math.max(0, death.diedAtMs - params.runStartedAtMs),
    elapsedBound: death.bound,
    restartGapMs: Math.max(0, successor.startedAtMs - death.diedAtMs),
    hostContinuityInferred: continuity.inferred,
    hasRecordedOutput: params.hasRecordedOutput === true,
  };
}

/** formatDurationCompact drops sub-second and zero spans; a duration clause still needs words. */
function describeDuration(ms: number): string {
  return formatDurationCompact(ms) ?? "under 1s";
}

/**
 * Describes what the boot rows say separated the two gateways. The clause
 * carries no timestamp: only the successor's start is recorded, and the prior
 * boot's end is bounded elsewhere in the message rather than pinned here.
 */
function describeCause(attribution: SubagentOrphanAttribution): string {
  switch (attribution.cause) {
    case "host_reboot":
      return "the host rebooted under it";
    case "gateway_process_death":
      return "the gateway process died while the host stayed up";
    default:
      return "host continuity could not be established";
  }
}

function describeElapsed(attribution: SubagentOrphanAttribution): string {
  const duration = describeDuration(attribution.elapsedMs);
  if (attribution.elapsedBound === "at_least") {
    return `at least ${duration}`;
  }
  if (attribution.elapsedBound === "at_most") {
    return `at most ${duration}`;
  }
  return duration;
}

function describeEvidence(attribution: SubagentOrphanAttribution): string {
  switch (attribution.diedAtEvidence) {
    case "last_activity":
      return "from the run's last recorded activity";
    default:
      return "bounded by the next boot's start";
  }
}

/**
 * Renders the attribution as the run's recorded error. Every clause is
 * something the database can back: when the successor gateway started, what
 * separated it from the boot that owned the run, which boot that was, the
 * bounded run lifetime, and the interval from its last recorded activity to the
 * restart. Neither message cardinality nor exact downtime is known.
 *
 * The only recorded instant here is the restart, so it is the only one named.
 * The prior gateway's death has no timestamp of its own — an outage of any
 * length can sit between the two — so the message says the boot ended at an
 * unrecorded earlier time and leaves the quantitative bound to the run clauses.
 */
export function formatSubagentOrphanErrorMessage(attribution: SubagentOrphanAttribution): string {
  const restartedAt = new Date(attribution.restartedAtMs).toISOString();
  const inferredNote = attribution.hostContinuityInferred
    ? " [host boot identity derived from uptime; restart cause kept generic]"
    : "";
  const output = attribution.hasRecordedOutput
    ? "output recorded in the run registry"
    : "no output recorded in the run registry";
  const restartGap =
    attribution.diedAtEvidence === "successor_boot_start"
      ? ""
      : `; the restart came ${describeDuration(attribution.restartGapMs)} after the run's last recorded activity`;
  return (
    `gateway restarted at ${restartedAt} ` +
    `(previous boot ${attribution.priorBootId} ended without a clean stop at an unrecorded earlier time); ` +
    `${describeCause(attribution)}; ` +
    `run orphaned after ${describeElapsed(attribution)} ${describeEvidence(attribution)}, ` +
    `${output}${restartGap}${inferredNote}`
  );
}

// Boot rows only change when the gateway boots, so the sweeper reads them once
// and reuses the snapshot instead of hitting the state DB per orphaned run.
const BOOT_SEGMENT_CACHE_TTL_MS = 60_000;
// Boot lifecycle rows are pruned at 24h; look back far enough to see all of them.
const BOOT_SEGMENT_LOOKBACK_MS = 48 * 60 * 60_000;
// Attribution needs the complete retained window. The shared reader defaults to
// 64 for ordinary diagnostics, which can omit the owning boot after a rapid
// crash/restart sequence.
const BOOT_SEGMENT_ATTRIBUTION_LIMIT = 2_147_483_647;
let cachedBootSegments: { loadedAtMs: number; segments: GatewayBootLifecycleSegment[] } | undefined;
// A sweep can orphan several runs at once. Without this, every one of them
// would queue its own read worker task for the same rows on a cold cache.
let inFlightBootSegments: Promise<GatewayBootLifecycleSegment[]> | undefined;

/**
 * Serves the sweeper's boot history. The query runs on the shared-state read
 * worker, so a cold or expired cache never opens SQLite on the gateway's own
 * thread; callers must treat the run they are inspecting as stale across the
 * await and re-check it before writing.
 */
export async function loadGatewayBootSegmentsForAttribution(
  nowMs = Date.now(),
  options?: { forceRefresh?: boolean },
): Promise<GatewayBootLifecycleSegment[]> {
  if (
    !options?.forceRefresh &&
    cachedBootSegments &&
    nowMs - cachedBootSegments.loadedAtMs < BOOT_SEGMENT_CACHE_TTL_MS
  ) {
    return cachedBootSegments.segments;
  }
  if (!options?.forceRefresh && inFlightBootSegments) {
    return inFlightBootSegments;
  }
  const load = readGatewayBootLifecycleSegments({
    sinceMs: nowMs - BOOT_SEGMENT_LOOKBACK_MS,
    limit: BOOT_SEGMENT_ATTRIBUTION_LIMIT,
  }).then((segments) => {
    cachedBootSegments = { loadedAtMs: nowMs, segments };
    return segments;
  });
  inFlightBootSegments = load;
  try {
    return await load;
  } finally {
    if (inFlightBootSegments === load) {
      inFlightBootSegments = undefined;
    }
  }
}

/**
 * The run's last recorded activity, used as a lower bound on its death.
 *
 * Only timestamps written *by the run* count. The reap time and the archive
 * deadline are clock readings taken by whoever found the corpse.
 */
export function resolveSubagentRunLastActivityMs(entry: SubagentRunRecord): number | undefined {
  const candidates = [
    entry.completion?.capturedAt,
    entry.completion?.fallbackCapturedAt,
    entry.execution.interruptedAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  // Deliberately excludes execution.startedAt: the start is when the clock
  // began, not proof the run was still alive at any later point.
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/**
 * Captured primary and fallback text are alternative snapshots, not message
 * records. Their absence says nothing about uncaptured transcript output.
 */
export function hasRecordedSubagentOutput(entry: SubagentRunRecord): boolean {
  return Boolean(
    entry.completion?.resultText?.trim() || entry.completion?.fallbackResultText?.trim(),
  );
}
