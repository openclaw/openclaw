import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeConfig } from "../../config/config.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "../../gateway/session-sharing-preparation.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  captureActiveCronManagementAuthority,
  type CronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { FollowupRequesterAuthority } from "./completion/session-followup-completion.types.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import {
  resolveCurrentRequesterSettleBatch,
  sameRequesterSettleBatch,
} from "./registry/subagent-requester-settle-identity.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./registry/subagent-run-generation.js";
import {
  detachRequesterAuthorityWave,
  holdRequesterAuthorityTurn,
  settleRequesterAuthorityWave,
  type RequesterAuthorityWaveReceipt,
  matchesRequesterAuthorityAdmissionTarget,
  type RequesterAdmissionTarget,
  isRequesterAuthorityCohortCurrent,
  isRequesterAuthorityCohortWave,
  isRequesterAuthoritySessionCurrent,
  isRequesterAuthorityWaveReplayCurrent,
  listOwedRequesterAuthorityMembers,
  isPausedAuthorityMember,
  retireRequesterAuthorityCohort,
} from "./requester-cron-authority-cohort.js";

type RequesterCronAuthority = {
  managementEntitlement?: NonNullable<CronCreatorAuthorityCapability["managementEntitlement"]>;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  releaseOperatorAuthority?: () => void;
  requesterOwner?: CronCreatorAuthorityCapability["requesterOwner"];
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  sessionLifecycleRevision?: string;
  admittedRunId?: string;
  admittedWaves?: Map<string, RequesterAuthorityWaveReceipt>;
  runScopeBound?: true;
  scopedTurns?: number;
  retired?: true;
  active: boolean;
} & (
  | {
      kind: "yield";
      sessionFacts: SessionFactsRead<PreparedSessionMutationFacts>;
      runs: ReadonlyMap<string, SubagentRunRecord>;
      batch: readonly SubagentRunRecord[];
      rearmGeneration?: number;
    }
  | {
      kind: "followup";
      sourceSessionKey: string;
      isFollowupCurrent: () => boolean;
      releaseFollowup: () => void;
    }
);

type RequesterCronAuthorityState = {
  byEntry: WeakMap<object, RequesterCronAuthority>;
  bySession: Map<string, Set<RequesterCronAuthority>>;
};

const state = resolveGlobalSingleton<RequesterCronAuthorityState>(
  Symbol.for("openclaw.subagents.requesterCronAuthority"),
  () => ({ byEntry: new WeakMap(), bySession: new Map() }),
  (value) => {
    for (const entries of value.bySession.values()) {
      for (const entry of entries) {
        entry.active = false;
        entry.releaseOperatorAuthority?.();
        entry.releaseOperatorAuthority = undefined;
        if (entry.kind === "followup") {
          entry.releaseFollowup();
        } else {
          entry.sessionFacts.release();
        }
      }
    }
    value.byEntry = new WeakMap();
    value.bySession.clear();
  },
);

function unbind(authority: RequesterCronAuthority, entry: SubagentRunRecord): void {
  if (state.byEntry.get(getSubagentRunRuntimeKey(entry)) === authority) {
    state.byEntry.delete(getSubagentRunRuntimeKey(entry));
  }
}

function discard(authority: RequesterCronAuthority): void {
  authority.active = false;
  const releaseOperatorAuthority = authority.releaseOperatorAuthority;
  authority.releaseOperatorAuthority = undefined;
  releaseOperatorAuthority?.();
  if (authority.kind === "yield") {
    authority.sessionFacts.release();
  }
  // Pending rows must remember a revoked operator restriction. Forgetting it
  // would let a later retry take the no-captured-operator dispatch path. The
  // weak entry binding retires with its row or an explicitly captured successor.
  if (authority.kind === "yield" && !authority.operatorAuthority) {
    for (const entry of authority.batch) {
      unbind(authority, entry);
    }
  }
  const session = state.bySession.get(authority.requesterSessionKey);
  session?.delete(authority);
  if (session?.size === 0) {
    state.bySession.delete(authority.requesterSessionKey);
  }
  if (authority.kind === "followup") {
    authority.releaseFollowup();
  }
}

/** Cohort completion waits for admitted scoped turns; revocation still discards at once. */
function retire(authority: RequesterCronAuthority): void {
  if (authority.kind !== "yield") {
    discard(authority);
    return;
  }
  retireRequesterAuthorityCohort(
    authority,
    state.byEntry,
    () => isCurrent(authority, false),
    () => discard(authority),
  );
}

function isCurrent(authority: RequesterCronAuthority, cohort = true): boolean {
  try {
    authority.operatorAuthority?.assertCurrent();
  } catch {
    return false;
  }
  if (
    !authority.active ||
    (authority.managementEntitlement?.source === "channel-owner" &&
      !authority.managementEntitlement.isCurrent()) ||
    authority.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
    !state.bySession.get(authority.requesterSessionKey)?.has(authority)
  ) {
    return false;
  }
  if (authority.kind === "followup") {
    return authority.isFollowupCurrent() && authority.requesterOwner?.isCurrent() === true;
  }
  if (!isRequesterAuthoritySessionCurrent(authority)) {
    return false;
  }
  // An admitted run scope owns its turn; later cohort membership no longer applies.
  if (authority.runScopeBound || !cohort) {
    return true;
  }
  return isRequesterAuthorityCohortCurrent(
    authority,
    (entry) => state.byEntry.get(getSubagentRunRuntimeKey(entry)) === authority,
  );
}

export type PreparedRequesterCronAuthority = {
  assertCurrent(): void;
  validate(): Promise<void>;
  bind(params: {
    batch: readonly SubagentRunRecord[];
    runs: ReadonlyMap<string, SubagentRunRecord>;
  }): Promise<{ commit(): void; revoke(): void } | undefined>;
  release(): void | Promise<void>;
};

/** Capture the original session source before registry hydration can yield. */
export function prepareRequesterCronAuthority(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
}): PreparedRequesterCronAuthority | undefined {
  const requesterAgentId = params.requesterAgentId;
  if (!requesterAgentId) {
    return undefined;
  }
  const cronCapture = captureActiveCronManagementAuthority({
    runId: params.requesterTurnRunId,
    sessionKey: params.requesterSessionKey,
    agentId: requesterAgentId,
  });
  const caller = getGatewayToolCallerIdentity();
  const operatorAuthority = caller?.operatorAuthority;
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const runContext = getAgentRunContext(params.requesterTurnRunId);
  // A yield transfers an accepted user's restrictions, not just automation
  // management permission. Keep its source alive even when no Cron tool exists.
  const operatorCapture =
    operatorAuthority &&
    assertCallerCurrent &&
    caller?.agentId === requesterAgentId &&
    caller.sessionKey === params.requesterSessionKey &&
    caller.operationalRunInstance?.runId === params.requesterTurnRunId &&
    caller.approvalAuthority &&
    runContext?.sessionId
      ? {
          sessionId: runContext.sessionId,
          lifecycleGeneration: caller.approvalAuthority.lifecycleGeneration,
          isActive: () => {
            try {
              assertCallerCurrent();
              return getAgentRunContext(params.requesterTurnRunId) === runContext;
            } catch {
              return false;
            }
          },
        }
      : undefined;
  const capture = cronCapture ?? operatorCapture;
  if (!capture || (operatorAuthority && !operatorCapture)) {
    return undefined;
  }
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
  let releaseOperatorAuthority = operatorAuthority?.retain?.();
  let preparedFacts: Promise<SessionFactsRead<PreparedSessionMutationFacts>>;
  try {
    preparedFacts = prepareSessionMutationFacts({
      cfg: getRuntimeConfig(),
      sessionKey: params.requesterSessionKey,
      agentId: requesterAgentId,
      allowMissing: true,
    });
  } catch (error) {
    releaseOperatorAuthority?.();
    throw error;
  }
  // Hydration can fail before this accepted preparation is consumed.
  let readyFacts: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  void preparedFacts.then(
    (facts) => {
      readyFacts = facts;
    },
    () => {},
  );
  let consumed = false;
  let transferred = false;
  let released = false;
  let boundAuthority: RequesterCronAuthority | undefined;
  const assertCaptureCurrent = () => {
    if (!capture.isActive()) {
      throw new Error("Requester authority retired during session preparation");
    }
    operatorAuthority?.assertCurrent();
  };
  const assertCurrent = () => {
    assertCaptureCurrent();
    if ((released && !transferred) || boundAuthority?.active === false) {
      throw new Error("Requester authority retired before yield handoff");
    }
    if (readyFacts) {
      const current = readyFacts.readCurrent(getRuntimeConfig()).target;
      if (
        current?.entry.sessionId !== capture.sessionId ||
        current.entry.archivedAt !== undefined ||
        (boundAuthority &&
          current.entry.lifecycleRevision !== boundAuthority.sessionLifecycleRevision)
      ) {
        throw new Error("Requester session authority changed before yield handoff");
      }
    }
  };
  const releaseFacts = (sessionFacts?: SessionFactsRead<PreparedSessionMutationFacts>) => {
    try {
      if (sessionFacts && !transferred) {
        sessionFacts.release();
      }
    } catch {
      // Cleanup must still release the retained operator authority.
    } finally {
      releaseOperatorAuthority?.();
      releaseOperatorAuthority = undefined;
    }
  };
  return {
    assertCurrent,
    async validate() {
      await preparedFacts;
      assertCurrent();
    },
    async bind({ batch, runs }) {
      if (consumed || released) {
        throw new Error("Requester authority preparation was already consumed");
      }
      consumed = true;
      const sessionFacts = await preparedFacts;
      assertCurrent();
      const session = sessionFacts.readCurrent(getRuntimeConfig()).target;
      if (
        batch.length === 0 ||
        session?.entry.sessionId !== capture.sessionId ||
        session.entry.archivedAt !== undefined
      ) {
        return undefined;
      }
      const authority: RequesterCronAuthority = {
        ...params,
        kind: "yield",
        requesterAgentId,
        requesterSessionId: capture.sessionId,
        managementEntitlement: cronCapture?.managementEntitlement,
        requesterOwner: cronCapture?.requesterOwner,
        operatorAuthority,
        releaseOperatorAuthority,
        lifecycleGeneration: capture.lifecycleGeneration,
        sessionLifecycleRevision: session.entry.lifecycleRevision,
        sessionFacts,
        runs,
        batch: [...batch],
        active: true,
      };
      boundAuthority = authority;
      transferred = true;
      releaseOperatorAuthority = undefined;
      const sessionAuthorities = state.bySession.get(authority.requesterSessionKey) ?? new Set();
      sessionAuthorities.add(authority);
      state.bySession.set(authority.requesterSessionKey, sessionAuthorities);
      return {
        commit: () => {
          assertCurrent();
          const committedBatch = resolveCurrentRequesterSettleBatch(authority.batch, runs);
          if (!committedBatch) {
            throw new Error("Requester automation authority lost its committed child owner");
          }
          authority.batch = committedBatch;
          for (const entry of authority.batch) {
            const previous = state.byEntry.get(getSubagentRunRuntimeKey(entry));
            if (previous && previous !== authority) {
              discard(previous);
            }
            state.byEntry.set(getSubagentRunRuntimeKey(entry), authority);
          }
        },
        revoke: () => discard(authority),
      };
    },
    release() {
      if (released) {
        return undefined;
      }
      released = true;
      if (readyFacts) {
        releaseFacts(readyFacts);
        return undefined;
      }
      return preparedFacts.then(releaseFacts, () => releaseFacts());
    },
  };
}

/** The committed complete cohort, rather than a child result, owns continuation authority. */
export function promoteRequesterCronAuthority(params: {
  requesterTurnRunId: string;
  batch: readonly SubagentRunRecord[];
  rearmGeneration?: number;
}): void {
  const authority = params.batch[0] && state.byEntry.get(getSubagentRunRuntimeKey(params.batch[0]));
  if (!authority || authority.kind !== "yield") {
    return;
  }
  if (
    params.rearmGeneration === undefined ||
    authority.requesterTurnRunId !== params.requesterTurnRunId ||
    !sameRequesterSettleBatch(authority.batch, params.batch) ||
    !isCurrent(authority)
  ) {
    discard(authority);
    return;
  }
  authority.rearmGeneration = params.rearmGeneration;
  if (!isCurrent(authority)) {
    discard(authority);
  }
}

/** Preserve only the registry's committed same-task replacement and its remapped cohort. */
export function replaceRequesterCronAuthorityEntry(params: {
  previous: SubagentRunRecord;
  next: SubagentRunRecord;
  preserve: boolean;
}): void {
  const authority = state.byEntry.get(getSubagentRunRuntimeKey(params.previous));
  if (!authority || authority.kind !== "yield") {
    return;
  }
  if (!params.preserve) {
    discard(authority);
    return;
  }
  authority.batch = authority.batch.map((entry) =>
    isSameSubagentRunOwner(entry, params.previous) ? params.next : entry,
  );
  state.byEntry.delete(getSubagentRunRuntimeKey(params.previous));
  state.byEntry.set(getSubagentRunRuntimeKey(params.next), authority);
  if (!isCurrent(authority)) {
    discard(authority);
  }
}

/** A new direct user turn cannot lend its identity to an older pending batch. */
export function revokeRequesterCronAuthority(sessionKey: string): void {
  for (const authority of state.bySession.get(sessionKey) ?? []) {
    discard(authority);
  }
}

/** Committed outbox cleanup releases only its exact generation, including cancelled batches. */
export function revokeRequesterCronAuthorityBatch(
  batch: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
): void {
  if (rearmGeneration === undefined) {
    return;
  }
  for (const entry of batch) {
    const authority = state.byEntry.get(getSubagentRunRuntimeKey(entry));
    if (authority?.kind === "yield" && authority.rearmGeneration === rearmGeneration) {
      if (isPausedAuthorityMember(authority, entry, rearmGeneration) && isCurrent(authority)) {
        continue;
      }
      settleRequesterAuthorityWave(authority, batch);
      // A settled wave releases only its members while detached waves still owe delivery.
      if (detachRequesterAuthorityWave(authority, batch, state.byEntry) && isCurrent(authority)) {
        continue;
      }
      retire(authority);
    }
  }
}

// A pause or detached wave's turn gets its own scope; the cohort keeps its later waves.
type ScopedDispatch = { scope?: CronCreatorAuthorityCapability; released?: true };
type RequesterCronAuthorityDispatch = {
  authority: RequesterCronAuthority;
  runId: string;
  isCurrent: () => boolean;
  consumed: boolean;
  replayOnly?: boolean;
  pause?: ScopedDispatch & { entry: SubagentRunRecord };
  wave?: ScopedDispatch & { batch: readonly SubagentRunRecord[] };
};
const activeDispatch = new AsyncLocalStorage<RequesterCronAuthorityDispatch>();

export async function withRequesterCronAuthority<T>(
  params: {
    requesterSessionKey: string;
    requesterSessionId: string;
    requesterAgentId?: string;
    batch: readonly SubagentRunRecord[];
    rearmGeneration: number | undefined;
    runId: string;
    isCurrent: () => boolean;
  },
  run: () => Promise<T>,
): Promise<T> {
  const authority = params.batch[0] && state.byEntry.get(getSubagentRunRuntimeKey(params.batch[0]));
  const child = params.batch.length === 1 ? params.batch[0] : undefined;
  const replayOnly =
    authority?.kind === "yield" && isRequesterAuthorityWaveReplayCurrent(authority, params);
  const pause: RequesterCronAuthorityDispatch["pause"] =
    child?.pauseReason === "sessions_yield" && child.requesterSettleWake?.pauseNotice
      ? { entry: child }
      : undefined;
  if (
    !authority ||
    authority.kind !== "yield" ||
    authority.requesterSessionKey !== params.requesterSessionKey ||
    authority.requesterSessionId !== params.requesterSessionId ||
    authority.requesterAgentId !== params.requesterAgentId ||
    authority.rearmGeneration === undefined ||
    authority.rearmGeneration !== params.rearmGeneration ||
    (!replayOnly &&
      !(pause
        ? authority.batch.some((entry) => isSameSubagentRunOwner(entry, pause.entry))
        : isRequesterAuthorityCohortWave(authority.batch, params.batch)))
  ) {
    if (authority?.operatorAuthority) {
      throw new Error("Requester operator authority does not own this continuation");
    }
    return await run();
  }
  const wave: RequesterCronAuthorityDispatch["wave"] = !pause ? { batch: params.batch } : undefined;
  const scoped = pause ?? wave;
  const current = () => {
    if (replayOnly) {
      return isRequesterAuthorityWaveReplayCurrent(authority, params);
    }
    if (scoped?.scope) {
      // An admitted scoped turn keeps operator and session revocation, not other waves' state.
      const { active, signal } = scoped.scope;
      return !scoped.released && active && !signal.aborted && isCurrent(authority, false);
    }
    const pausedEntry = pause && authority.runs.get(pause.entry.runId);
    return (
      isCurrent(authority) &&
      (scoped
        ? !scoped.released &&
          params.isCurrent() &&
          (!pause ||
            (isSameSubagentRunOwner(pausedEntry, pause.entry) &&
              pausedEntry?.pauseReason === "sessions_yield" &&
              Boolean(pausedEntry.requesterSettleWake?.pauseNotice)))
        : authority.runScopeBound === true || params.isCurrent())
    );
  };
  if (!current()) {
    retire(authority);
    if (authority.operatorAuthority) {
      throw new Error("Requester operator authority is no longer current");
    }
    return await run();
  }
  const dispatch: RequesterCronAuthorityDispatch = {
    authority,
    runId: params.runId,
    isCurrent: current,
    consumed: false,
    replayOnly,
    pause,
    wave,
  };
  try {
    if (!authority.operatorAuthority) {
      return await activeDispatch.run(dispatch, run);
    }
    const { withOperatorToolGatewayAuthority } =
      await import("../../gateway/server-plugin-in-process-dispatch.js");
    if (!current()) {
      throw new Error("Requester operator authority is no longer current");
    }
    return await withOperatorToolGatewayAuthority(
      {
        operatorRunAuthority: authority.operatorAuthority,
        scopes: authority.operatorAuthority.scopes,
        assertCurrent: () => {
          if (!current()) {
            throw new Error("Requester operator authority is no longer current");
          }
        },
      },
      () => activeDispatch.run(dispatch, run),
    );
  } finally {
    // The committed settlement owner retires this cohort. A returned delivery
    // failure can still need a retry, just like a thrown transport error.
    if (!isCurrent(authority)) {
      retire(authority);
    }
  }
}

/** Child followup results return the captured owner only to their exact requester. */
export function captureRequesterFollowupAuthority(params: {
  requesterTurnRunId: string;
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  sourceSessionKey: string;
  isCurrent: () => boolean;
  release: () => void;
}): FollowupRequesterAuthority | undefined {
  const capture = captureActiveCronManagementAuthority({
    runId: params.requesterTurnRunId,
    sessionKey: params.requesterSessionKey,
    agentId: params.requesterAgentId,
  });
  if (!capture?.requesterOwner || capture.sessionId !== params.requesterSessionId) {
    return undefined;
  }
  const authority: RequesterCronAuthority = {
    kind: "followup",
    ...params,
    requesterOwner: capture.requesterOwner,
    managementEntitlement: capture.managementEntitlement,
    lifecycleGeneration: capture.lifecycleGeneration,
    isFollowupCurrent: params.isCurrent,
    releaseFollowup: params.release,
    active: true,
  };
  const session = state.bySession.get(params.requesterSessionKey) ?? new Set();
  session.add(authority);
  state.bySession.set(params.requesterSessionKey, session);
  return {
    release: () => {
      // Observation may end before accepted work starts. Its Gateway admission
      // and subsequent run scope, not the result waiter, now own this capture.
      if (authority.admittedRunId === undefined) {
        discard(authority);
      }
    },
    async run<T>(runId: string, run: () => Promise<T>): Promise<T> {
      if (!isCurrent(authority) || authority.admittedRunId !== undefined) {
        throw new Error("Requester followup authority is no longer current");
      }
      // The followup owner retains caller restrictions separately. This scope
      // supplies only the captured channel identity to the returning parent.
      return await activeDispatch.run(
        { authority, runId, isCurrent: () => isCurrent(authority), consumed: false },
        run,
      );
    },
  };
}

export function captureRequesterCronAuthorityAdmissionAssertion(params: RequesterAdmissionTarget) {
  const dispatch = activeDispatch.getStore();
  if (!dispatch || dispatch.consumed || dispatch.authority.kind !== "yield") {
    return undefined;
  }
  if (!matchesRequesterAuthorityAdmissionTarget(dispatch, params)) {
    throw new Error("Requester authority does not own this continuation");
  }
  // Storage can invoke the pre-commit guard outside this dispatch's async context.
  return () => {
    if (dispatch.replayOnly || (!dispatch.consumed && !dispatch.isCurrent())) {
      throw new Error("Requester authority is no longer current");
    }
  };
}

export function consumeRequesterCronAuthorityAdmission(params: RequesterAdmissionTarget):
  | {
      runId: string;
      callerOrigin: { kind: "unknown" };
      managementEntitlement: NonNullable<CronCreatorAuthorityCapability["managementEntitlement"]>;
      requesterOwner?: CronCreatorAuthorityCapability["requesterOwner"];
      isCurrent: () => boolean;
      bindRunScope: (scope: CronCreatorAuthorityCapability) => void;
      release?: () => void;
    }
  | undefined {
  const dispatch = activeDispatch.getStore();
  if (
    !dispatch ||
    dispatch.consumed ||
    dispatch.replayOnly ||
    dispatch.authority.admittedRunId !== undefined ||
    !matchesRequesterAuthorityAdmissionTarget(dispatch, params) ||
    !dispatch.isCurrent()
  ) {
    return undefined;
  }
  dispatch.consumed = true;
  if (!dispatch.authority.managementEntitlement) {
    return undefined;
  }
  // A pause or detached wave owns only its turn; the cohort stays admissible for later waves.
  const scoped = dispatch.pause ?? dispatch.wave;
  if (
    !scoped ||
    (dispatch.wave &&
      dispatch.authority.kind === "yield" &&
      listOwedRequesterAuthorityMembers(dispatch.authority, dispatch.wave.batch).length === 0)
  ) {
    dispatch.authority.admittedRunId = params.runId;
  }
  return {
    runId: params.runId,
    callerOrigin: { kind: "unknown" },
    managementEntitlement: dispatch.authority.managementEntitlement,
    requesterOwner: dispatch.authority.requesterOwner,
    isCurrent: dispatch.isCurrent,
    ...(scoped
      ? {
          release: () => {
            scoped.released = true;
          },
        }
      : dispatch.authority.kind === "followup"
        ? { release: () => discard(dispatch.authority) }
        : {}),
    bindRunScope: (scope) => {
      if (
        dispatch.authority.runScopeBound ||
        scoped?.scope ||
        !dispatch.isCurrent() ||
        scope.runId !== params.runId ||
        scope.isCurrent !== dispatch.isCurrent ||
        scope.managementEntitlement !== dispatch.authority.managementEntitlement ||
        scope.requesterOwner !== dispatch.authority.requesterOwner ||
        scope.callerOrigin.kind !== "unknown" ||
        !scope.active ||
        scope.signal.aborted
      ) {
        throw new Error("Requester automation authority no longer owns this run scope");
      }
      const { authority } = dispatch;
      if (scoped) {
        scoped.scope = scope;
        holdRequesterAuthorityTurn(authority, scope.signal, () => retire(authority));
      }
      // Admission owns a pause turn even after notice consumption; final custody stays with
      // the cohort. A detached wave's turn owns its members while later waves keep theirs.
      if (dispatch.pause) {
        return;
      }
      if (dispatch.wave && authority.kind === "yield") {
        if (authority.operatorAuthority) {
          (authority.admittedWaves ??= new Map()).set(scope.runId, { batch: dispatch.wave.batch });
        }
        if (!detachRequesterAuthorityWave(authority, dispatch.wave.batch, state.byEntry)) {
          // The final wave retires admission custody, not already-admitted turns.
          retire(authority);
        }
        return;
      }
      // Queue acceptance can retire the child outbox before the parent finishes.
      // Its fresh run scope now owns the entitlement and all per-operation grants.
      authority.runScopeBound = true;
      scope.signal.addEventListener("abort", () => retire(authority), { once: true });
    },
  };
}
