import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  captureActiveCronManagementAuthority,
  type CronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";

type RequesterCronAuthority = {
  managementEntitlement: NonNullable<CronCreatorAuthorityCapability["managementEntitlement"]>;
  requesterOwner?: CronCreatorAuthorityCapability["requesterOwner"];
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  sessionLifecycleRevision?: string;
  storePath: string;
  runs: ReadonlyMap<string, SubagentRunRecord>;
  batch: readonly SubagentRunRecord[];
  rearmGeneration?: number;
  admittedRunId?: string;
  runScopeBound?: true;
  active: boolean;
};

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
      }
    }
    value.byEntry = new WeakMap();
    value.bySession.clear();
  },
);

function discard(authority: RequesterCronAuthority): void {
  authority.active = false;
  for (const entry of authority.batch) {
    if (state.byEntry.get(entry) === authority) {
      state.byEntry.delete(entry);
    }
  }
  const session = state.bySession.get(authority.requesterSessionKey);
  session?.delete(authority);
  if (session?.size === 0) {
    state.bySession.delete(authority.requesterSessionKey);
  }
}

function sameBatch(left: readonly SubagentRunRecord[], right: readonly SubagentRunRecord[]) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function isCurrent(authority: RequesterCronAuthority): boolean {
  if (
    !authority.active ||
    (authority.managementEntitlement.source === "channel-owner" &&
      !authority.managementEntitlement.isCurrent()) ||
    authority.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
    !state.bySession.get(authority.requesterSessionKey)?.has(authority)
  ) {
    return false;
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
  const capture = captureActiveCronManagementAuthority({
    runId: params.requesterTurnRunId,
    sessionKey: params.requesterSessionKey,
    agentId: requesterAgentId,
  });
  if (!capture) {
    return undefined;
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
    requesterAgentId,
    requesterSessionId: capture.sessionId,
    managementEntitlement: capture.managementEntitlement,
    requesterOwner: capture.requesterOwner,
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
  if (!authority) {
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
  if (!authority) {
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
    if (authority && authority.rearmGeneration === rearmGeneration) {
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
    authority.requesterSessionKey !== params.requesterSessionKey ||
    authority.requesterSessionId !== params.requesterSessionId ||
    authority.requesterAgentId !== params.requesterAgentId ||
    authority.rearmGeneration === undefined ||
    authority.rearmGeneration !== params.rearmGeneration ||
    !sameBatch(authority.batch, params.batch)
  ) {
    return await run();
  }
  const current = () =>
    isCurrent(authority) && (authority.runScopeBound === true || params.isCurrent());
  if (!current()) {
    discard(authority);
    return await run();
  }
  const dispatch: RequesterCronAuthorityDispatch = {
    authority,
    runId: params.runId,
    isCurrent: current,
    consumed: false,
  };
  try {
    return await activeDispatch.run(dispatch, run);
  } finally {
    // The committed settlement owner retires this cohort. A returned delivery
    // failure can still need a retry, just like a thrown transport error.
    if (!isCurrent(authority)) {
      discard(authority);
    }
  }
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
    }
  | undefined {
  const dispatch = activeDispatch.getStore();
  if (
    !dispatch ||
    dispatch.consumed ||
    dispatch.authority.admittedRunId !== undefined ||
    dispatch.runId !== params.runId ||
    dispatch.authority.requesterSessionKey !== params.sessionKey ||
    dispatch.authority.requesterSessionId !== params.sessionId ||
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_settle" ||
    !dispatch.authority.batch.some(
      (entry) => entry.childSessionKey === params.inputProvenance?.sourceSessionKey,
    ) ||
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
      for (const entry of dispatch.authority.batch) {
        if (state.byEntry.get(entry) === dispatch.authority) {
          state.byEntry.delete(entry);
        }
      }
      dispatch.authority.batch = [];
      scope.signal.addEventListener("abort", () => discard(dispatch.authority), { once: true });
    },
  };
}
