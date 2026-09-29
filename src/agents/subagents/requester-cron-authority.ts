import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
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
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";

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
  runScopeBound?: true;
  active: boolean;
} & (
  | {
      kind: "yield";
      storePath: string;
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
  byEntry: WeakMap<SubagentRunRecord, RequesterCronAuthority>;
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
        }
      }
    }
    value.byEntry = new WeakMap();
    value.bySession.clear();
  },
);

function discard(authority: RequesterCronAuthority): void {
  authority.active = false;
  const releaseOperatorAuthority = authority.releaseOperatorAuthority;
  authority.releaseOperatorAuthority = undefined;
  releaseOperatorAuthority?.();
  // Pending rows must remember a revoked operator restriction. Forgetting it
  // would let a later retry take the no-captured-operator dispatch path. The
  // weak entry binding retires with its row or an explicitly captured successor.
  if (authority.kind === "yield" && !authority.operatorAuthority) {
    for (const entry of authority.batch) {
      if (state.byEntry.get(entry) === authority) {
        state.byEntry.delete(entry);
      }
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

function sameBatch(left: readonly SubagentRunRecord[], right: readonly SubagentRunRecord[]) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function isCurrent(authority: RequesterCronAuthority): boolean {
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
  const session = loadSessionEntryReadOnly({
    storePath: authority.storePath,
    sessionKey: authority.requesterSessionKey,
  });
  if (
    session?.sessionId !== authority.requesterSessionId ||
    session.lifecycleRevision !== authority.sessionLifecycleRevision ||
    session.archivedAt !== undefined
  ) {
    return false;
  }
  if (authority.runScopeBound) {
    return true;
  }
  if (
    authority.batch.some(
      (entry) =>
        entry.killIntent?.suppressTaskDelivery === true ||
        entry.killReconciliation?.suppressTaskDelivery === true,
    ) ||
    authority.batch.every((entry) => entry.suppressCompletionDelivery === true)
  ) {
    return false;
  }
  const batchRunIds = authority.batch.map((entry) => entry.runId).toSorted();
  return authority.batch.every((entry) => {
    const wake = entry.requesterSettleWake;
    return (
      authority.runs.get(entry.runId) === entry &&
      state.byEntry.get(entry) === authority &&
      (authority.rearmGeneration === undefined ||
        (wake?.requesterYieldBatch === true &&
          wake.rearmGeneration === authority.rearmGeneration &&
          wake.batchRunIds?.length === batchRunIds.length &&
          wake.batchRunIds.every((runId, index) => runId === batchRunIds[index])))
    );
  });
}

/** Prepare while the exact original run is live; commit only after yield intent persists. */
export function captureRequesterCronAuthority(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  batch: readonly SubagentRunRecord[];
  runs: ReadonlyMap<string, SubagentRunRecord>;
}): { commit: () => void; revoke: () => void } | undefined {
  const requesterAgentId = params.requesterAgentId;
  if (!requesterAgentId || params.batch.length === 0) {
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
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
    agentId: requesterAgentId,
  });
  const session = loadSessionEntryReadOnly({ storePath, sessionKey: params.requesterSessionKey });
  if (session?.sessionId !== capture.sessionId || session.archivedAt !== undefined) {
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
    releaseOperatorAuthority: operatorAuthority?.retain?.(),
    lifecycleGeneration: capture.lifecycleGeneration,
    sessionLifecycleRevision: session.lifecycleRevision,
    storePath,
    batch: [...params.batch],
    active: true,
  };
  const sessionAuthorities = state.bySession.get(authority.requesterSessionKey) ?? new Set();
  sessionAuthorities.add(authority);
  state.bySession.set(authority.requesterSessionKey, sessionAuthorities);
  return {
    commit: () => {
      if (!authority.active || !capture.isActive()) {
        discard(authority);
        return;
      }
      for (const entry of authority.batch) {
        const previous = state.byEntry.get(entry);
        if (previous) {
          discard(previous);
        }
        state.byEntry.set(entry, authority);
      }
    },
    revoke: () => discard(authority),
  };
}

/** The committed complete cohort, rather than a child result, owns continuation authority. */
export function promoteRequesterCronAuthority(params: {
  requesterTurnRunId: string;
  batch: readonly SubagentRunRecord[];
  rearmGeneration?: number;
}): void {
  const authority = params.batch[0] && state.byEntry.get(params.batch[0]);
  if (!authority || authority.kind !== "yield") {
    return;
  }
  if (
    params.rearmGeneration === undefined ||
    authority.requesterTurnRunId !== params.requesterTurnRunId ||
    !sameBatch(authority.batch, params.batch) ||
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
  const authority = state.byEntry.get(params.previous);
  if (!authority || authority.kind !== "yield") {
    return;
  }
  if (!params.preserve) {
    discard(authority);
    return;
  }
  authority.batch = authority.batch.map((entry) =>
    entry === params.previous ? params.next : entry,
  );
  state.byEntry.delete(params.previous);
  state.byEntry.set(params.next, authority);
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
    const authority = state.byEntry.get(entry);
    if (authority?.kind === "yield" && authority.rearmGeneration === rearmGeneration) {
      discard(authority);
    }
  }
}

type RequesterCronAuthorityDispatch = {
  authority: RequesterCronAuthority;
  runId: string;
  isCurrent: () => boolean;
  consumed: boolean;
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
  const authority = params.batch[0] && state.byEntry.get(params.batch[0]);
  if (
    !authority ||
    authority.kind !== "yield" ||
    authority.requesterSessionKey !== params.requesterSessionKey ||
    authority.requesterSessionId !== params.requesterSessionId ||
    authority.requesterAgentId !== params.requesterAgentId ||
    authority.rearmGeneration === undefined ||
    authority.rearmGeneration !== params.rearmGeneration ||
    !sameBatch(authority.batch, params.batch)
  ) {
    if (authority?.operatorAuthority) {
      throw new Error("Requester operator authority does not own this continuation");
    }
    return await run();
  }
  const current = () =>
    isCurrent(authority) && (authority.runScopeBound === true || params.isCurrent());
  if (!current()) {
    discard(authority);
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
      discard(authority);
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
}) {
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

export function consumeRequesterCronAuthorityAdmission(params: {
  runId: string;
  sessionKey: string | undefined;
  sessionId: string | undefined;
  inputProvenance: InputProvenance | undefined;
}):
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
    !dispatch.authority.managementEntitlement ||
    dispatch.consumed ||
    dispatch.authority.admittedRunId !== undefined ||
    dispatch.runId !== params.runId ||
    dispatch.authority.requesterSessionKey !== params.sessionKey ||
    dispatch.authority.requesterSessionId !== params.sessionId ||
    params.inputProvenance?.kind !== "inter_session" ||
    (dispatch.authority.kind === "yield"
      ? params.inputProvenance.sourceTool !== "subagent_settle" ||
        !dispatch.authority.batch.some(
          (entry) => entry.childSessionKey === params.inputProvenance?.sourceSessionKey,
        )
      : params.inputProvenance.sourceTool !== "subagent_announce" ||
        params.inputProvenance.sourceSessionKey !== dispatch.authority.sourceSessionKey) ||
    !dispatch.isCurrent()
  ) {
    return undefined;
  }
  dispatch.consumed = true;
  dispatch.authority.admittedRunId = params.runId;
  return {
    runId: params.runId,
    callerOrigin: { kind: "unknown" },
    managementEntitlement: dispatch.authority.managementEntitlement,
    requesterOwner: dispatch.authority.requesterOwner,
    isCurrent: dispatch.isCurrent,
    ...(dispatch.authority.kind === "followup"
      ? { release: () => discard(dispatch.authority) }
      : {}),
    bindRunScope: (scope) => {
      if (
        dispatch.authority.runScopeBound ||
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
      // Queue acceptance can retire the child outbox before the parent finishes.
      // Its fresh run scope now owns the entitlement and all per-operation grants.
      dispatch.authority.runScopeBound = true;
      if (dispatch.authority.kind === "yield") {
        for (const entry of dispatch.authority.batch) {
          if (state.byEntry.get(entry) === dispatch.authority) {
            state.byEntry.delete(entry);
          }
        }
        dispatch.authority.batch = [];
      }
      scope.signal.addEventListener("abort", () => discard(dispatch.authority), { once: true });
    },
  };
}
