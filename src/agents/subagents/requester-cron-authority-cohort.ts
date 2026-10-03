import { getRuntimeConfig } from "../../config/config.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import type { SessionFactsRead } from "../../gateway/session-sharing-preparation.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import { resolveCurrentRequesterSettleBatch } from "./registry/subagent-requester-settle-identity.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./registry/subagent-run-generation.js";

/** The yield cohort and rearm generation whose continuation a requester authority owns. */
type RequesterAuthorityCohort = {
  batch: readonly SubagentRunRecord[];
  runs: ReadonlyMap<string, SubagentRunRecord>;
  rearmGeneration?: number;
};

/**
 * A consumed pause notice detaches its child into its own delivery wave. Every wave
 * stays inside the cohort; ids outside it may only name retired rows.
 */
export function isRequesterAuthorityCohortCurrent(
  cohort: RequesterAuthorityCohort,
  isBound: (entry: SubagentRunRecord) => boolean,
): boolean {
  const batch = resolveCurrentRequesterSettleBatch(cohort.batch, cohort.runs);
  if (
    !batch ||
    batch.some(
      (entry) =>
        entry.killIntent?.suppressTaskDelivery === true ||
        entry.killReconciliation?.suppressTaskDelivery === true,
    ) ||
    batch.every((entry) => entry.suppressCompletionDelivery === true)
  ) {
    return false;
  }
  const cohortRunIds = new Set(cohort.batch.map((entry) => entry.runId));
  return batch.every((entry) => {
    const wake = entry.requesterSettleWake;
    return (
      isBound(entry) &&
      (cohort.rearmGeneration === undefined ||
        (wake?.requesterYieldBatch === true &&
          wake.rearmGeneration === cohort.rearmGeneration &&
          wake.batchRunIds?.includes(entry.runId) === true &&
          wake.batchRunIds.every((runId) => cohortRunIds.has(runId) || !cohort.runs.has(runId))))
    );
  });
}

/** A delivery wave is the cohort members that still list exactly that wave. */
export function isRequesterAuthorityCohortWave(
  cohort: readonly SubagentRunRecord[],
  batch: readonly SubagentRunRecord[],
): boolean {
  const waveRunIds = batch.map((entry) => entry.runId).toSorted();
  return (
    batch.length > 0 &&
    batch.every((entry) => {
      const listed = entry.requesterSettleWake?.batchRunIds?.toSorted();
      return (
        cohort.some((member) => isSameSubagentRunOwner(member, entry)) &&
        listed?.length === waveRunIds.length &&
        listed.every((runId, index) => runId === waveRunIds[index])
      );
    })
  );
}

/**
 * Detach a settled or separately admitted wave. Returns whether other waves still owe
 * delivery; the cohort then keeps their restrictions and revocation checks.
 */
export function detachRequesterAuthorityWave(
  cohort: RequesterAuthorityCohort & { operatorAuthority?: object },
  wave: readonly SubagentRunRecord[],
  bindings: WeakMap<object, unknown>,
): boolean {
  const owed = listOwedRequesterAuthorityMembers(cohort, wave);
  if (owed.length === 0) {
    return false;
  }
  // Detached operator rows keep their binding so a later retry fails closed.
  for (const entry of cohort.operatorAuthority ? [] : cohort.batch) {
    const key = getSubagentRunRuntimeKey(entry);
    if (!owed.includes(entry) && bindings.get(key) === cohort) {
      bindings.delete(key);
    }
  }
  cohort.batch = owed;
  return true;
}

/** The requester session incarnation the authority was captured from is still current. */
export function isRequesterAuthoritySessionCurrent(authority: {
  sessionFacts: SessionFactsRead<PreparedSessionMutationFacts>;
  requesterSessionId: string;
  sessionLifecycleRevision?: string;
}): boolean {
  let session: PreparedSessionMutationFacts["target"];
  try {
    session = authority.sessionFacts.readCurrent(getRuntimeConfig()).target;
  } catch {
    return false;
  }
  return (
    session?.entry.sessionId === authority.requesterSessionId &&
    session.entry.lifecycleRevision === authority.sessionLifecycleRevision &&
    session.entry.archivedAt === undefined
  );
}

type ScopedTurnHolder = { scopedTurns?: number; retired?: true };

/** An admitted pause or wave turn keeps its cohort's resources until the turn ends. */
export function holdRequesterAuthorityTurn(
  cohort: ScopedTurnHolder,
  signal: AbortSignal,
  releaseRetired: () => void,
): void {
  cohort.scopedTurns = (cohort.scopedTurns ?? 0) + 1;
  const end = () => {
    cohort.scopedTurns = (cohort.scopedTurns ?? 1) - 1;
    if (cohort.scopedTurns === 0 && cohort.retired) {
      releaseRetired();
    }
  };
  signal.addEventListener("abort", end, { once: true });
}

/** A completed cohort stops admitting waves while its admitted turns finish. */
export function retireRequesterAuthorityCohort(
  cohort: RequesterAuthorityCohort &
    ScopedTurnHolder & {
      operatorAuthority?: object;
      admittedWaves?: ReadonlyMap<string, RequesterAuthorityWaveReceipt>;
    },
  bindings: WeakMap<object, unknown>,
  isCurrent: () => boolean,
  discard: () => void,
): void {
  if (!isCurrent()) {
    discard();
    return;
  }
  if (cohort.retired) {
    if (!cohort.scopedTurns && !hasUnsettledRequesterAuthorityWaves(cohort)) {
      discard();
    }
    return;
  }
  if (!cohort.scopedTurns && !hasUnsettledRequesterAuthorityWaves(cohort)) {
    discard();
    return;
  }
  cohort.retired = true;
  // Retired operator rows keep their binding so a later retry fails closed.
  for (const entry of cohort.operatorAuthority ? [] : cohort.batch) {
    const key = getSubagentRunRuntimeKey(entry);
    if (bindings.get(key) === cohort) {
      bindings.delete(key);
    }
  }
  cohort.batch = [];
}

/** A paused member's settled notice keeps the cohort for the member's later completion. */
export function isPausedAuthorityMember(
  cohort: RequesterAuthorityCohort,
  entry: SubagentRunRecord,
  rearmGeneration: number,
): boolean {
  return (
    isSameSubagentRunOwner(cohort.runs.get(entry.runId), entry) &&
    entry.pauseReason === "sessions_yield" &&
    entry.requesterSettleWake?.rearmGeneration === rearmGeneration
  );
}

/** Cohort members outside a settled wave that still owe a same-generation wake. */
export function listOwedRequesterAuthorityMembers(
  cohort: RequesterAuthorityCohort,
  settled: readonly SubagentRunRecord[],
): SubagentRunRecord[] {
  return cohort.batch.filter((member) => {
    const current = cohort.runs.get(member.runId);
    return (
      !settled.some((entry) => isSameSubagentRunOwner(entry, member)) &&
      isSameSubagentRunOwner(current, member) &&
      current?.requesterSettleWake?.rearmGeneration === cohort.rearmGeneration
    );
  });
}

export type RequesterAdmissionTarget = {
  runId: string;
  sessionKey: string | undefined;
  sessionId: string | undefined;
  inputProvenance: InputProvenance | undefined;
};

export function matchesRequesterAuthorityAdmissionTarget(
  dispatch: {
    runId: string;
    authority: {
      requesterSessionKey: string;
      requesterSessionId: string;
    } & (
      | { kind: "yield"; batch: readonly Pick<SubagentRunRecord, "childSessionKey">[] }
      | { kind: "followup"; sourceSessionKey: string }
    );
  },
  params: RequesterAdmissionTarget,
): boolean {
  const { authority } = dispatch;
  return (
    dispatch.runId === params.runId &&
    authority.requesterSessionKey === params.sessionKey &&
    authority.requesterSessionId === params.sessionId &&
    params.inputProvenance?.kind === "inter_session" &&
    (authority.kind === "yield"
      ? params.inputProvenance.sourceTool === "subagent_settle" &&
        authority.batch.some(
          (entry) => entry.childSessionKey === params.inputProvenance?.sourceSessionKey,
        )
      : params.inputProvenance.sourceTool === "subagent_announce" &&
        params.inputProvenance.sourceSessionKey === authority.sourceSessionKey)
  );
}

/** Exact admitted-wave receipts allow result replay, never fresh creator admission. */
export function isRequesterAuthorityWaveReplayCurrent(
  authority: RequesterAuthorityCohort &
    Parameters<typeof isRequesterAuthoritySessionCurrent>[0] & {
      operatorAuthority?: { assertCurrent(): void };
      admittedWaves?: ReadonlyMap<string, RequesterAuthorityWaveReceipt>;
    },
  params: {
    batch: readonly SubagentRunRecord[];
    rearmGeneration: number | undefined;
    runId: string;
  },
): boolean {
  if (!authority.operatorAuthority || authority.rearmGeneration !== params.rearmGeneration) {
    return false;
  }
  try {
    authority.operatorAuthority.assertCurrent();
  } catch {
    return false;
  }
  const admitted = authority.admittedWaves?.get(params.runId)?.batch;
  return (
    admitted !== undefined &&
    admitted.length === params.batch.length &&
    admitted.every((member) =>
      params.batch.some(
        (entry) =>
          isSameSubagentRunOwner(entry, member) &&
          isSameSubagentRunOwner(authority.runs.get(member.runId), member) &&
          authority.runs.get(member.runId)?.requesterSettleWake?.rearmGeneration ===
            authority.rearmGeneration &&
          entry.requesterSettleWake?.rearmGeneration === authority.rearmGeneration,
      ),
    ) &&
    isRequesterAuthoritySessionCurrent(authority)
  );
}

export type RequesterAuthorityWaveReceipt = {
  batch: readonly SubagentRunRecord[];
  settled?: true;
};

function hasUnsettledRequesterAuthorityWaves(authority: {
  admittedWaves?: ReadonlyMap<string, RequesterAuthorityWaveReceipt>;
}): boolean {
  return [...(authority.admittedWaves?.values() ?? [])].some((wave) => !wave.settled);
}

/** Delivery acknowledgement releases only the exact admitted wave's custody. */
export function settleRequesterAuthorityWave(
  authority: { admittedWaves?: ReadonlyMap<string, RequesterAuthorityWaveReceipt> },
  batch: readonly SubagentRunRecord[],
): void {
  for (const wave of authority.admittedWaves?.values() ?? []) {
    if (
      wave.batch.every((member) => batch.some((entry) => isSameSubagentRunOwner(entry, member)))
    ) {
      wave.settled = true;
    }
  }
}

/** A non-privileged accepted turn has the same lifetime and receipts as a Cron turn. */
export function acceptRequesterAuthorityWave(
  dispatch: RequesterAuthorityDispatch<
    RequesterAuthorityCohort &
      ScopedTurnHolder & {
        kind: "yield";
        operatorAuthority?: object;
        requesterSessionKey: string;
        requesterSessionId: string;
        admittedWaves?: Map<string, RequesterAuthorityWaveReceipt>;
      }
  >,
  params: RequesterAdmissionTarget,
  signal: AbortSignal,
  bindings: WeakMap<object, unknown>,
  retire: () => void,
): (() => void) | undefined {
  if (
    dispatch.replayOnly ||
    !matchesRequesterAuthorityAdmissionTarget(dispatch, params) ||
    !dispatch.isCurrent()
  ) {
    throw new Error("Requester authority is no longer current");
  }
  signal.throwIfAborted();
  dispatch.consumed = true;
  const scoped = dispatch.pause ?? dispatch.wave;
  if (!scoped) {
    return undefined;
  }
  // This signal is lifecycle-only: it conveys no Cron management entitlement.
  const lifetime = new AbortController();
  const release = () => lifetime.abort();
  signal.addEventListener("abort", release, { once: true });
  scoped.scope = {
    get active() {
      return !lifetime.signal.aborted;
    },
    signal: lifetime.signal,
  };
  holdRequesterAuthorityTurn(dispatch.authority, lifetime.signal, retire);
  if (dispatch.wave) {
    recordRequesterAuthorityWave(
      dispatch.authority,
      dispatch.wave.batch,
      params.runId,
      bindings,
      retire,
    );
  }
  return () => {
    signal.removeEventListener("abort", release);
    release();
  };
}

/** Every accepted wave records the same custody transfer, regardless of tool rights. */
export function recordRequesterAuthorityWave(
  authority: RequesterAuthorityCohort & {
    operatorAuthority?: object;
    admittedWaves?: Map<string, RequesterAuthorityWaveReceipt>;
  },
  batch: readonly SubagentRunRecord[],
  runId: string,
  bindings: WeakMap<object, unknown>,
  retire: () => void,
): void {
  if (authority.operatorAuthority) {
    (authority.admittedWaves ??= new Map()).set(runId, { batch });
  }
  if (!detachRequesterAuthorityWave(authority, batch, bindings)) {
    // The final wave retires admission custody, not already-admitted turns.
    retire();
  }
}

/** Capture the admission guard before storage leaves the dispatch async context. */
export function captureRequesterAuthorityAdmissionAssertion(
  dispatch: Parameters<typeof matchesRequesterAuthorityAdmissionTarget>[0] & {
    replayOnly?: boolean;
    consumed: boolean;
    isCurrent: () => boolean;
  },
  params: RequesterAdmissionTarget,
): () => void {
  if (!matchesRequesterAuthorityAdmissionTarget(dispatch, params)) {
    throw new Error("Requester authority does not own this continuation");
  }
  return () => {
    if (dispatch.replayOnly || (!dispatch.consumed && !dispatch.isCurrent())) {
      throw new Error("Requester authority is no longer current");
    }
  };
}

type ScopedDispatch = { scope?: { active: boolean; signal: AbortSignal }; released?: true };
export type RequesterAuthorityDispatch<Authority> = {
  authority: Authority;
  runId: string;
  isCurrent: () => boolean;
  consumed: boolean;
  replayOnly?: boolean;
  pause?: ScopedDispatch & { entry: SubagentRunRecord };
  wave?: ScopedDispatch & { batch: readonly SubagentRunRecord[] };
};
