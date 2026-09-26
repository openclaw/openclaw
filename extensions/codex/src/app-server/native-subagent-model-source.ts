import {
  matchingNativeModelAdmissions,
  matchingNativeModelCause as matchingCause,
  findUnqualifiedNativeModelParent,
  waitForNativeModelSourceChange as waitForModelSourceChange,
} from "./native-subagent-model-lookup.js";
import type {
  ChildState,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeModelExecution,
  NativeModelBinding,
  NativeModelSource,
  NativeModelSourceCapture,
  NativeModelSourceCustody,
  NativeModelSourceOwner,
  NativeModelSourceRequest,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";

export const MAX_PENDING_CHILD_ADMISSION_EVIDENCE = 32;

export function notifyNativeModelSourceWaiters(state: ParentState): void {
  const waiters = [...(state.modelSourceWaiters ?? [])];
  state.modelSourceWaiters?.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

export function notifyNativeModelSourceChange(method: string, states: Iterable<ParentState>): void {
  if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
    return;
  }
  for (const state of states) {
    notifyNativeModelSourceWaiters(state);
  }
}

/** One issued source is shared only by its extant parent, accepted work, and dispatches. */
export function createNativeModelSourceOwner(
  source: NativeModelSource | undefined,
  state: ParentState,
  assertCurrent: () => void,
  onReleased: () => void,
): NativeModelSourceOwner {
  let references = 1;
  let foregroundReleased = false;
  state.modelSourceReferences = (state.modelSourceReferences ?? 0) + 1;
  const assertSource = () => {
    if (references === 0) {
      throw new Error("Codex native model source is released");
    }
    assertCurrent();
    source?.assertCurrent();
  };
  const release = () => {
    references -= 1;
    state.modelSourceReferences = (state.modelSourceReferences ?? 1) - 1;
    try {
      if (references === 0) {
        source?.release();
      }
    } finally {
      onReleased();
    }
  };
  return {
    hasOperatorSource: source !== undefined,
    capture: () => {
      assertSource();
      references += 1;
      state.modelSourceReferences = (state.modelSourceReferences ?? 0) + 1;
      let released = false;
      return {
        source,
        assertCurrent: () => {
          if (released) {
            throw new Error("Codex native model source capture is released");
          }
          assertSource();
        },
        release: () => {
          if (!released) {
            released = true;
            release();
          }
        },
      };
    },
    release: () => {
      if (!foregroundReleased) {
        foregroundReleased = true;
        release();
      }
    },
  };
}

export function retainNativeModelSource(
  owner: ParentOwner | undefined,
): NativeModelSourceCustody | undefined {
  const capture = owner?.modelSource?.capture();
  return capture && owner
    ? { owner, assertCurrent: capture.assertCurrent, release: capture.release }
    : undefined;
}

export function retainNativeModelExecution(
  owner: ParentOwner | undefined,
  turnId: string | undefined,
  threadId: string,
  completionCustody = owner?.completionCustody,
): NativeModelExecution | undefined {
  const capture = owner?.modelSource?.capture();
  if (!owner || !capture) {
    return undefined;
  }
  const nativeOwner: ParentOwner = {
    modelSource: owner.modelSource,
    modelMapping: owner.modelMapping,
    configurationQualification: owner.configurationQualification,
    unqualifiedModelExecution: owner.unqualifiedModelExecution,
    interruptModelExecution: owner.interruptModelExecution,
  };
  try {
    nativeOwner.completionCustody = completionCustody?.retain();
  } catch (error) {
    capture.release();
    throw error;
  }
  if (owner.unqualifiedModelExecution && owner.modelExecutionCancelled) {
    nativeOwner.modelExecutionCancelled = true;
  }
  let binding: NativeModelBinding | undefined;
  try {
    binding =
      owner.claimUnqualifiedModelBinding?.() ??
      (owner.unqualifiedModelExecution
        ? capture.source?.bindModelExecution?.(undefined)
        : undefined);
  } catch {
    nativeOwner.modelExecutionCancelled = true;
  }
  if (owner.unqualifiedModelExecution && !binding) {
    nativeOwner.modelExecutionCancelled = true;
  }
  const signal = binding?.signal;
  let interrupted = false;
  let released = false;
  const cancel = () => {
    nativeOwner.modelExecutionCancelled = true;
    if (!released && !interrupted && nativeOwner.turnId) {
      interrupted = true;
      owner.interruptModelExecution?.(threadId, nativeOwner.turnId);
    }
  };
  const bindTurn = (id: string) => {
    nativeOwner.turnId = id;
    if (signal?.aborted || nativeOwner.modelExecutionCancelled) {
      cancel();
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted || nativeOwner.modelExecutionCancelled) {
    cancel();
  }
  if (turnId) {
    bindTurn(turnId);
  }
  return {
    owner,
    executionOwner: nativeOwner,
    bindTurn,
    assertCurrent: () => {
      capture.assertCurrent();
      if (nativeOwner.modelExecutionCancelled) {
        throw new Error("Codex native model execution was cancelled");
      }
      binding?.assertCurrent();
    },
    release: () => {
      if (!released) {
        released = true;
        signal?.removeEventListener("abort", cancel);
        try {
          binding?.release();
        } finally {
          try {
            nativeOwner.completionCustody?.release();
          } finally {
            nativeOwner.completionCustody = undefined;
            capture.release();
          }
        }
      }
    },
  };
}

export function releaseNativeModelExecution(child: ChildState): void {
  const execution = child.modelExecution;
  child.modelExecution = undefined;
  if (execution) {
    if (execution.executionOwner.modelExecutionCancelled) {
      child.cancelledModelTurnId = execution.executionOwner.turnId;
    }
    execution.executionOwner.modelExecutionSettled = true;
    execution.executionOwner.nativeReviewRequirement = undefined;
  }
  execution?.release();
}

export function releaseNativeDirectChild(child: ChildState): void {
  const release = child.releaseDirectChild;
  child.releaseDirectChild = undefined;
  child.directOwner = undefined;
  release?.();
}

export function admitNativeChildModelExecution(
  child: ChildState,
  owner: ParentOwner,
  known: KnownChild | undefined,
): void {
  if (known) {
    known.configurationQualification = owner.configurationQualification;
  }
  child.modelExecution ??= retainNativeModelExecution(
    owner,
    child.nativeTurnId,
    child.childThreadId,
  );
  owner.onDirectChildAccepted?.();
}

export function consumeNativeChildModelAdmission(
  evidence: Extract<NativeChildAdmissionEvidence, { kind: "interaction" }>,
): void {
  const source = evidence.modelSource;
  evidence.modelSource = undefined;
  evidence.modelSourceConsumed = true;
  source?.release();
}

export function releasePendingNativeModelInputs(
  threadId: string,
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>,
): void {
  for (const entries of admissions.values()) {
    for (const evidence of entries) {
      if (evidence.kind === "interaction" && evidence.childThreadId === threadId) {
        consumeNativeChildModelAdmission(evidence);
      }
    }
  }
}

/** Transfers only a receipt's exact model turn; tool pairing has its own turn ID. */
export function bindNativeChildModelAdmission(
  evidence: Extract<NativeChildAdmissionEvidence, { kind: "interaction" }>,
  known: KnownChild,
  child: ChildState | undefined,
): boolean {
  const source = evidence.modelSource;
  if (!source) {
    return false;
  }
  if (evidence.modelSourceRequiresInference) {
    return true;
  }
  source.assertCurrent();
  const turnId = evidence.modelSourceTurnId ?? evidence.nativeTurnId;
  if (!turnId) {
    return true;
  }
  const pending = known.pendingTurns.find((entry) => entry.turnId === turnId);
  if (pending) {
    if (!pending.state || pending.state === "active") {
      pending.completionCustody ??= evidence.completionCustody?.retain();
      pending.modelSource ??= retainNativeModelExecution(
        source.owner,
        turnId,
        evidence.childThreadId,
        evidence.completionCustody,
      );
    }
  } else if (child?.nativeTurnId === turnId) {
    if (!child.terminal && !child.settledWithoutCompletion) {
      child.completionCustody ??= evidence.completionCustody?.retain();
      child.modelExecution ??= retainNativeModelExecution(
        source.owner,
        turnId,
        evidence.childThreadId,
        evidence.completionCustody,
      );
    }
  } else {
    return true;
  }
  consumeNativeChildModelAdmission(evidence);
  return false;
}

export function closeNativeModelChild(
  threadId: string | undefined,
  knownChildren: ReadonlyMap<string, KnownChild>,
  children: ReadonlyMap<string, ChildState>,
  prune: (state: ParentState) => void,
): void {
  const known = threadId ? knownChildren.get(threadId) : undefined;
  if (!known) {
    return;
  }
  const child = children.get(known.assignment.runId);
  if (child) {
    releaseNativeModelExecution(child);
  }
  for (const pending of known.pendingTurns) {
    pending.modelSource?.release();
    pending.modelSource = undefined;
  }
  prune(known.parent);
}

export function releaseNativeParentModelSources(
  state: ParentState,
  children: Iterable<KnownChild>,
): void {
  for (const owner of state.owners.values()) {
    owner.modelSource?.release();
  }
  for (const known of children) {
    if (known.parent === state) {
      for (const pending of known.pendingTurns) {
        pending.modelSource?.release();
        pending.modelSource = undefined;
      }
    }
  }
}

export function associateNativeChildInteraction(
  known: KnownChild,
  threadId: string,
  nativeTurnId: string,
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>,
  drain: (owner: ParentOwner, turnId: string) => void,
): void {
  for (const [parentTurnId, pending] of admissions) {
    const interaction = pending.find(
      (evidence) =>
        evidence.kind === "interaction" &&
        evidence.parentThreadId === known.parent.parentThreadId &&
        evidence.childThreadId === threadId &&
        !evidence.nativeTurnId,
    );
    if (interaction?.kind !== "interaction") {
      continue;
    }
    interaction.nativeTurnId = nativeTurnId;
    const observed = known.observedTurns.get(nativeTurnId);
    if (observed) {
      observed.awaitingInteraction = undefined;
    }
    const owner = interaction.owner ?? interaction.modelSource?.owner;
    if (owner) {
      drain(owner, parentTurnId);
    }
    return;
  }
}

type ModelSourceDependencies = {
  parents: ReadonlyMap<string, ParentState>;
  children: ReadonlyMap<string, ChildState>;
  knownChildren: ReadonlyMap<string, KnownChild>;
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>;
  isCurrent: (state: ParentState) => boolean;
  assertInputCurrent: (threadId: string, owner: ParentOwner) => void;
  hasPendingInput: (request: NativeModelSourceRequest) => boolean;
  onExecutionAdmitted: (known: KnownChild, threadId: string) => void;
  registerChildExecution: (
    state: ParentState,
    request: NativeModelSourceRequest,
    agentPath?: string,
    completionCustody?: ParentOwner["completionCustody"],
  ) => void;
};

function captureExecutionOwner(
  owner: ParentOwner,
  assertInputCurrent: () => void,
): NativeModelSourceCapture | undefined {
  if (owner.modelExecutionCancelled) {
    throw new Error("Codex native model execution was cancelled");
  }
  const capture = owner.modelSource?.capture();
  if (!capture) {
    return undefined;
  }
  let released = false;
  const reviewRequirement = (owner.nativeReviewRequirement ??= { required: false });
  const assertCurrent = () => {
    capture.assertCurrent();
    if (owner.modelExecutionCancelled) {
      throw new Error("Codex native model execution was cancelled");
    }
    assertInputCurrent();
  };
  return {
    ...capture,
    modelMapping: owner.modelMapping,
    get nativeReviewRequired() {
      return reviewRequirement.required;
    },
    recordNativeReviewRequirement: (required) => {
      assertCurrent();
      if (required) {
        reviewRequirement.required = true;
      }
    },
    assertCurrent,
    cancel: () => {
      if (!released) {
        owner.modelExecutionCancelled = true;
      }
    },
    release: () => {
      released = true;
      capture.release();
    },
  };
}

function executionOwner(
  request: NativeModelSourceRequest,
  state: ParentState,
  dependencies: ModelSourceDependencies,
): ParentOwner | undefined {
  if (state.parentThreadId === request.threadId) {
    return [...state.owners.values()].find(
      (owner) => owner.turnId === request.turnId && !owner.modelExecutionSettled,
    );
  }
  const admitted = matchingNativeModelAdmissions(
    request,
    dependencies.admissions,
    state.parentThreadId,
  );
  const owners = new Set(
    admitted.flatMap((entry) => (entry.modelSource ? [entry.modelSource.owner] : [])),
  );
  const admittedOwner = owners.size === 1 ? owners.values().next().value : undefined;
  if (
    !dependencies.knownChildren.has(request.threadId) &&
    admittedOwner?.unqualifiedModelExecution &&
    request.parentThreadId
  ) {
    for (const entry of admitted) {
      entry.modelSource?.assertCurrent();
    }
    dependencies.registerChildExecution(
      state,
      request,
      admitted[0]?.agentPath,
      admitted[0]?.completionCustody,
    );
  }
  const known = dependencies.knownChildren.get(request.threadId);
  if (
    known?.parent !== state ||
    (request.parentThreadId && request.parentThreadId !== known.nativeParentThreadId)
  ) {
    return undefined;
  }
  const child = dependencies.children.get(known.assignment.runId);
  const execution = child?.modelExecution;
  if (
    child &&
    !child.terminal &&
    !child.settledWithoutCompletion &&
    execution &&
    (!child.nativeTurnId || child.nativeTurnId === request.turnId)
  ) {
    if (!execution.executionOwner.turnId && matchingCause(execution.owner, request)) {
      execution.bindTurn(request.turnId);
    }
    if (execution.executionOwner.turnId === request.turnId) {
      if (!child.nativeTurnId && !known.assignment.unanchored) {
        // Direct spawn already retained this execution before turn/started.
        // Pin the admitted inference locator on that same initial assignment.
        child.nativeTurnId = request.turnId;
        known.assignment.nativeTurnId = request.turnId;
      }
      return execution.executionOwner;
    }
  }
  const pending = known.pendingTurns.find((turn) => turn.turnId === request.turnId);
  if (pending?.state && pending.state !== "active") {
    return undefined;
  }
  if (
    pending?.modelSource &&
    ((!request.parentTurnId && !request.rootTurnId) ||
      matchingCause(pending.modelSource.owner, request))
  ) {
    return pending.modelSource.executionOwner;
  }
  // Native inference can arrive before its turn/started notification. Only an
  // already accepted interaction with matching causal IDs can supply that turn.
  const owner = admittedOwner;
  if (!owner || (child?.nativeTurnId === request.turnId && child.modelExecution)) {
    return undefined;
  }
  for (const entry of admitted) {
    entry.modelSource?.assertCurrent();
  }
  const completionCustody = admitted[0]?.completionCustody;
  const modelSource = retainNativeModelExecution(
    owner,
    request.turnId,
    request.threadId,
    completionCustody,
  );
  if (!modelSource) {
    return undefined;
  }
  if (
    child &&
    (!child.nativeTurnId || child.nativeTurnId === request.turnId) &&
    !child.terminal &&
    !child.settledWithoutCompletion &&
    !known.assignment.unanchored
  ) {
    // An admitted inference carries the exact initial child turn even when its
    // turn/started notification was lost. Never recover this locator by history subtraction.
    child.nativeTurnId = request.turnId;
    known.assignment.nativeTurnId = request.turnId;
    child.modelExecution = modelSource;
    child.completionCustody ??= completionCustody?.retain();
  } else if (pending) {
    pending.modelSource = modelSource;
    pending.completionCustody ??= completionCustody?.retain();
  } else {
    known.pendingTurns.push({
      turnId: request.turnId,
      state: undefined,
      modelSource,
      completionCustody: completionCustody?.retain(),
    });
  }
  for (const entry of admitted) {
    if (entry.kind === "interaction" && entry.modelSource?.owner === owner) {
      consumeNativeChildModelAdmission(entry);
    }
  }
  if (pending?.state === "active" || child?.nativeTurnId === request.turnId) {
    dependencies.onExecutionAdmitted(known, request.threadId);
  }
  return modelSource.executionOwner;
}

export async function captureNativeModelSource(
  request: NativeModelSourceRequest,
  dependencies: ModelSourceDependencies,
): Promise<NativeModelSourceCapture | undefined> {
  for (;;) {
    request.signal?.throwIfAborted();
    const parent = request.parentThreadId
      ? dependencies.knownChildren.get(request.parentThreadId)
      : undefined;
    const state =
      dependencies.parents.get(request.threadId) ??
      dependencies.knownChildren.get(request.threadId)?.parent ??
      (request.parentThreadId ? dependencies.parents.get(request.parentThreadId) : undefined) ??
      parent?.parent ??
      findUnqualifiedNativeModelParent(request, dependencies.parents, dependencies.admissions);
    if (!state || !dependencies.isCurrent(state)) {
      return undefined;
    }
    if (
      state.parentThreadId === request.threadId &&
      [...state.owners.values()].some(
        (owner) => owner.turnId === request.turnId && owner.modelExecutionSettled,
      )
    ) {
      return undefined;
    }
    const owner = executionOwner(request, state, dependencies);
    if (owner) {
      dependencies.assertInputCurrent(request.threadId, owner);
      return captureExecutionOwner(owner, () =>
        dependencies.assertInputCurrent(request.threadId, owner),
      );
    }
    const parentExecution = parent
      ? dependencies.children.get(parent.assignment.runId)?.modelExecution?.executionOwner
      : undefined;
    const known = dependencies.knownChildren.get(request.threadId);
    const child = known ? dependencies.children.get(known.assignment.runId) : undefined;
    const observedChildTurn =
      known?.observedTurns.has(request.turnId) || child?.nativeTurnId === request.turnId;
    const pending = [...state.owners.values()].some(
      (candidate) =>
        candidate.modelSource &&
        (state.parentThreadId === request.threadId
          ? !candidate.turnId
          : observedChildTurn && (!candidate.turnId || matchingCause(candidate, request))),
    );
    const unqualified = [
      ...state.owners.values(),
      ...(parentExecution ? [parentExecution] : []),
    ].filter(
      (candidate) =>
        candidate.unqualifiedModelExecution &&
        !candidate.modelExecutionCancelled &&
        !candidate.modelExecutionSettled &&
        matchingCause(candidate, request),
    );
    const immediate = unqualified.filter((candidate) => candidate.turnId === request.parentTurnId);
    const waitingOwners = immediate.length > 0 ? immediate : unqualified;
    const waitingOwner = waitingOwners.length === 1 ? waitingOwners[0] : undefined;
    if (waitingOwner) {
      const capture = waitingOwner.modelSource?.capture();
      let binding: NativeModelBinding | undefined;
      try {
        binding = capture?.source?.bindModelExecution?.(undefined);
        if (!binding) {
          return undefined;
        }
        binding.assertCurrent();
        await waitForModelSourceChange(
          state,
          request.signal ? AbortSignal.any([request.signal, binding.signal]) : binding.signal,
        );
      } finally {
        binding?.release();
        capture?.release();
      }
      continue;
    }
    if (
      !pending &&
      !dependencies.hasPendingInput(request) &&
      !(observedChildTurn && parentExecution && matchingCause(parentExecution, request))
    ) {
      return undefined;
    }
    await waitForModelSourceChange(state, request.signal);
  }
}
