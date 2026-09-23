import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { releaseCompletionCustody } from "./native-subagent-admission-custody.js";
import type { CodexNativeSubagentCloseOwner } from "./native-subagent-close-owner.js";
import { CodexNativeSubagentDeliveryReceipts } from "./native-subagent-delivery-receipts.js";
import {
  createNativeModelSourceOwner,
  notifyNativeModelSourceWaiters,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  NativeModelMapping,
  NativeModelBinding,
  NativeModelSource,
  NativeSubagentMonitorRuntime,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentSubmissionOwner } from "./native-subagent-submission-owner.js";

export type NativeParentRegistration = Pick<
  ParentState,
  | "parentThreadId"
  | "requesterSessionKey"
  | "taskRuntimeScope"
  | "historyOwner"
  | "submissionStore"
  | "agentId"
> &
  Pick<
    ParentOwner,
    | "claimDirectChild"
    | "rejectPendingDirectChild"
    | "onDirectChildAccepted"
    | "configurationQualification"
  > & {
    /** Explicit undefined records System; omission leaves model custody unknown. */
    modelSource?: NativeModelSource;
    unqualifiedModelExecution?: true;
    onUnqualifiedModelCancelled?: (reason: unknown) => void;
  };

type ParentDependencies = {
  states: Map<string, ParentState>;
  children: ReadonlyMap<string, ChildState>;
  isClosed: () => boolean;
  isRetired: (state: ParentState) => boolean;
  runtime: Pick<NativeSubagentMonitorRuntime, "captureAgentHarnessCompletionCustody">;
  prepare: (state: ParentState) => void;
  reconcile: (state: ParentState, owner: ParentOwner) => Promise<void>;
  submissions: Pick<CodexNativeSubagentSubmissionOwner, "restore" | "bind" | "drain">;
  closes: Pick<CodexNativeSubagentCloseOwner, "bind" | "prune" | "settlements">;
  deliverPending: (state: ParentState, child: ChildState) => Promise<void>;
  deliverDetached: (state: ParentState) => void;
  drainAdmissions: (state: ParentState, owner: ParentOwner, turnId: string) => void;
  clearAdmissions: () => void;
  prune: (state: ParentState) => void;
  interruptModelExecution?: (threadId: string, turnId: string) => void;
};

export function observeNativeParentTurn(
  state: ParentState,
  method: string,
  turnId: string | undefined,
): void {
  if (!turnId || !state.owners.size) {
    return;
  }
  if (method === "turn/started") {
    state.turnIds.add(turnId);
  } else if (method === "turn/completed") {
    for (const owner of state.owners.values()) {
      if (owner.turnId === turnId) {
        owner.modelExecutionSettled = true;
        owner.nativeReviewRequirement = undefined;
      }
    }
    if ([...state.owners.values()].some((owner) => owner.modelSource && !owner.turnId)) {
      (state.completedModelTurnsBeforeBinding ??= new Set()).add(turnId);
    }
  }
}

/** Registers one foreground admission without owning later admissions to the same thread. */
export function registerNativeSubagentParent(
  params: NativeParentRegistration,
  dependencies: ParentDependencies,
): {
  bindTurn: (turnId: string, mapping?: NativeModelMapping) => void;
  unregister: () => Promise<void>;
} {
  const parentThreadId = params.parentThreadId.trim();
  if (!parentThreadId) {
    throw new Error("Codex native subagent monitor requires a parent thread id");
  }
  if (dependencies.isClosed()) {
    throw new Error("Codex native subagent monitor is closed");
  }
  let state = dependencies.states.get(parentThreadId);
  if (
    state?.requesterSessionKey &&
    params.requesterSessionKey &&
    state.requesterSessionKey !== params.requesterSessionKey
  ) {
    throw new Error(`Codex thread ${parentThreadId} is already bound to another session`);
  }
  if (!state) {
    state = {
      parentThreadId,
      owners: new Map(),
      turnIds: new Set(),
      deliveryReceipts: new CodexNativeSubagentDeliveryReceipts(),
    };
    dependencies.states.set(parentThreadId, state);
  }
  state.requesterSessionKey ??= params.requesterSessionKey;
  state.taskRuntimeScope ??= params.taskRuntimeScope;
  state.historyOwner ??= params.historyOwner;
  state.submissionStore ??= params.submissionStore;
  state.agentId ??= params.agentId;
  const registeredState = state;
  const ownerKey = Symbol("codex-native-subagent-owner");
  let owner: ParentOwner = {
    configurationQualification: params.configurationQualification,
    unqualifiedModelExecution: params.modelSource ? params.unqualifiedModelExecution : undefined,
    interruptModelExecution: dependencies.interruptModelExecution,
    claimDirectChild: params.claimDirectChild,
    rejectPendingDirectChild: params.rejectPendingDirectChild,
    onDirectChildAccepted: params.onDirectChildAccepted,
  };
  if (Object.hasOwn(params, "modelSource")) {
    owner.modelSource = createNativeModelSourceOwner(
      params.modelSource,
      state,
      () => {
        if (
          dependencies.isClosed() ||
          dependencies.isRetired(registeredState) ||
          dependencies.states.get(parentThreadId) !== registeredState
        ) {
          throw new Error("Codex native model source owner is no longer current");
        }
      },
      () => dependencies.prune(registeredState),
    );
  }
  state.owners.set(ownerKey, owner);
  let rootModelBinding: NativeModelBinding | undefined;
  let cancellationReported = false;
  let interruptedTurnId: string | undefined;
  const cancelUnqualifiedRoot = () => {
    owner.modelExecutionCancelled = true;
    // Disposal releases guards without turning client closure into explicit cancellation.
    if (dependencies.isClosed()) {
      return;
    }
    if (!cancellationReported) {
      cancellationReported = true;
      params.onUnqualifiedModelCancelled?.(
        rootModelBinding?.signal.reason ??
          new Error("Codex unqualified model execution authority was revoked"),
      );
    }
    if (owner.turnId && interruptedTurnId !== owner.turnId) {
      interruptedTurnId = owner.turnId;
      dependencies.interruptModelExecution?.(parentThreadId, owner.turnId);
    }
  };
  const releaseRootModelBinding = () => {
    rootModelBinding?.signal.removeEventListener("abort", cancelUnqualifiedRoot);
    rootModelBinding?.release();
    rootModelBinding = undefined;
  };
  try {
    owner.completionCustody = params.taskRuntimeScope
      ? dependencies.runtime.captureAgentHarnessCompletionCustody(params.taskRuntimeScope)
      : undefined;
    if (owner.unqualifiedModelExecution && params.modelSource) {
      rootModelBinding = params.modelSource.bindModelExecution?.(undefined);
      if (!rootModelBinding) {
        throw new Error("Codex unqualified parent requires an operator model execution guard");
      }
      rootModelBinding.signal.addEventListener("abort", cancelUnqualifiedRoot, { once: true });
      if (rootModelBinding.signal.aborted) {
        cancelUnqualifiedRoot();
      }
    }
    dependencies.prepare(state);
    for (const child of dependencies.children.values()) {
      if (child.parentThreadId === parentThreadId && child.pendingCompletion) {
        void dependencies.deliverPending(state, child);
      }
    }
    // History recovery remains independent of the foreground start path.
    void dependencies.reconcile(state, owner).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
        parentThreadId,
        error: formatErrorMessage(error),
      });
    });
    dependencies.submissions.restore(state, owner);
  } catch (error) {
    releaseRootModelBinding();
    state.owners.delete(ownerKey);
    releaseCompletionCustody(owner);
    owner.modelSource?.release();
    dependencies.prune(registeredState);
    throw error;
  }
  let registered = true;
  let settlement: Promise<void> | undefined;
  return {
    bindTurn: (turnIdInput, mapping) => {
      const turnId = turnIdInput.trim();
      if (!turnId || dependencies.states.get(parentThreadId) !== registeredState) {
        return;
      }
      let current = registeredState.owners.get(ownerKey);
      if (
        !current ||
        [...registeredState.owners.values()].some(
          (other) => other !== current && other.turnId === turnId,
        )
      ) {
        return;
      }
      if (current.turnId && current.turnId !== turnId) {
        current = {
          ...current,
          modelMapping: undefined,
          modelExecutionCancelled: undefined,
          modelExecutionSettled: registeredState.completedModelTurnsBeforeBinding?.has(turnId)
            ? true
            : undefined,
          nativeReviewRequirement: undefined,
        };
        owner = current;
        registeredState.owners.set(ownerKey, current);
      }
      if (!current.turnId && registeredState.completedModelTurnsBeforeBinding?.has(turnId)) {
        current.modelExecutionSettled = true;
      }
      current.turnId = turnId;
      if (![...registeredState.owners.values()].some((candidate) => !candidate.turnId)) {
        registeredState.completedModelTurnsBeforeBinding = undefined;
      }
      if (mapping && !current.modelMapping) {
        current.modelMapping = Object.freeze({
          nativeModel: Object.freeze({ ...mapping.nativeModel }),
          authorizedModel: Object.freeze({ ...mapping.authorizedModel }),
        });
      } else if (
        mapping &&
        current.modelMapping &&
        (mapping.nativeModel.provider !== current.modelMapping.nativeModel.provider ||
          mapping.nativeModel.model !== current.modelMapping.nativeModel.model ||
          mapping.authorizedModel.provider !== current.modelMapping.authorizedModel.provider ||
          mapping.authorizedModel.model !== current.modelMapping.authorizedModel.model)
      ) {
        throw new Error("Codex native turn already has a different admitted model mapping");
      }
      if (cancellationReported || rootModelBinding?.signal.aborted) {
        cancelUnqualifiedRoot();
      }
      dependencies.submissions.bind(registeredState, turnId);
      registeredState.turnIds.add(turnId);
      dependencies.closes.bind(registeredState, turnId);
      dependencies.drainAdmissions(registeredState, current, turnId);
      dependencies.clearAdmissions();
      notifyNativeModelSourceWaiters(registeredState);
    },
    unregister: () => {
      if (!registered) {
        return settlement ?? Promise.resolve();
      }
      registered = false;
      releaseRootModelBinding();
      releaseCompletionCustody(owner);
      owner.nativeReviewRequirement = undefined;
      const current = dependencies.states.get(parentThreadId);
      if (current === registeredState) {
        current.owners.delete(ownerKey);
        dependencies.closes.prune(current);
        if (owner.turnId) {
          current.turnIds.delete(owner.turnId);
        }
        if (current.owners.size === 0) {
          current.turnIds.clear();
          current.deliveryReceipts = new CodexNativeSubagentDeliveryReceipts();
        }
        if (![...current.owners.values()].some((candidate) => !candidate.turnId)) {
          current.completedModelTurnsBeforeBinding = undefined;
        }
        dependencies.clearAdmissions();
        dependencies.deliverDetached(current);
      }
      owner.modelSource?.release();
      notifyNativeModelSourceWaiters(registeredState);
      dependencies.prune(registeredState);
      settlement = Promise.allSettled([
        dependencies.submissions.drain(registeredState),
        ...dependencies.closes.settlements(registeredState),
      ]).then(() => {});
      return settlement;
    },
  };
}
