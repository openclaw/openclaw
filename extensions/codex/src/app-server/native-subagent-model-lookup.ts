import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type {
  ChildState,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeModelSourceRequest,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";

export function waitForNativeModelSourceChange(
  state: ParentState,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const remove = () => {
      state.modelSourceWaiters?.delete(changed);
      signal?.removeEventListener("abort", aborted);
    };
    const changed = () => {
      remove();
      resolve();
    };
    const aborted = () => {
      remove();
      reject(toErrorObject(signal?.reason, "Codex model source capture was aborted"));
    };
    (state.modelSourceWaiters ??= new Set()).add(changed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function matchingNativeModelCause(
  owner: ParentOwner,
  request: NativeModelSourceRequest,
): boolean {
  return Boolean(
    owner.turnId && (owner.turnId === request.parentTurnId || owner.turnId === request.rootTurnId),
  );
}

export function matchingNativeModelAdmissions(
  request: NativeModelSourceRequest,
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>,
  parentThreadId?: string,
): Array<Extract<NativeChildAdmissionEvidence, { kind: "interaction" }>> {
  return [...admissions.values()]
    .flat()
    .filter(
      (entry): entry is Extract<NativeChildAdmissionEvidence, { kind: "interaction" }> =>
        entry.kind === "interaction" &&
        (parentThreadId === undefined || entry.parentThreadId === parentThreadId) &&
        entry.childThreadId === request.threadId &&
        (entry.modelSourceRequiresInference ||
          !(entry.modelSourceTurnId ?? entry.nativeTurnId) ||
          (entry.modelSourceTurnId ?? entry.nativeTurnId) === request.turnId) &&
        entry.modelSource !== undefined &&
        matchingNativeModelCause(entry.modelSource.owner, request),
    );
}

export function findUnqualifiedNativeModelParent(
  request: NativeModelSourceRequest,
  parents: ReadonlyMap<string, ParentState>,
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>,
): ParentState | undefined {
  const candidates = new Set(
    matchingNativeModelAdmissions(request, admissions).flatMap((entry) => {
      const state = parents.get(entry.parentThreadId);
      return state && entry.modelSource?.owner.unqualifiedModelExecution ? [state] : [];
    }),
  );
  for (const state of parents.values()) {
    if (
      [...state.owners.values()].some(
        (owner) =>
          owner.unqualifiedModelExecution &&
          !owner.modelExecutionCancelled &&
          !owner.modelExecutionSettled &&
          matchingNativeModelCause(owner, request),
      )
    ) {
      candidates.add(state);
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export function currentNativeModelExecution(
  threadId: string,
  parents: ReadonlyMap<string, ParentState>,
  knownChildren: ReadonlyMap<string, KnownChild>,
  children: ReadonlyMap<string, ChildState>,
): ParentOwner | undefined {
  const state = parents.get(threadId);
  if (state) {
    if ([...state.owners.values()].some((owner) => !owner.turnId)) {
      throw new Error("Codex active input requires the receiver turn to be bound");
    }
    const owners = [...state.owners.values()].filter(
      (owner) => owner.turnId && !owner.modelExecutionSettled,
    );
    if (owners.length > 1) {
      throw new Error("Codex active input requires an unambiguous receiver turn");
    }
    return owners[0];
  }
  const known = knownChildren.get(threadId);
  const child = known ? children.get(known.assignment.runId) : undefined;
  const owners = new Set<ParentOwner>();
  if (child && !child.terminal && !child.settledWithoutCompletion && child.modelExecution) {
    owners.add(child.modelExecution.executionOwner);
  }
  for (const pending of known?.pendingTurns ?? []) {
    if (pending.modelSource && (!pending.state || pending.state === "active")) {
      owners.add(pending.modelSource.executionOwner);
    }
  }
  if (owners.size > 1) {
    throw new Error("Codex active input requires an unambiguous receiver turn");
  }
  return owners.values().next().value;
}

/** A native image header names only a turn; it cannot choose its source thread. */
export function resolveNativeModelThreadId(
  turnId: string,
  parents: ReadonlyMap<string, ParentState>,
  knownChildren: ReadonlyMap<string, KnownChild>,
  children: ReadonlyMap<string, ChildState>,
  isCurrent: (state: ParentState) => boolean,
): string | undefined {
  const candidates = new Map<ParentOwner, string>();
  const add = (threadId: string, owner: ParentOwner | undefined) => {
    if (
      owner?.turnId === turnId &&
      !owner.modelExecutionSettled &&
      !owner.modelExecutionCancelled
    ) {
      candidates.set(owner, threadId);
    }
  };
  for (const state of parents.values()) {
    if (isCurrent(state)) {
      for (const owner of state.owners.values()) {
        add(state.parentThreadId, owner);
      }
    }
  }
  for (const [threadId, known] of knownChildren) {
    if (!isCurrent(known.parent)) {
      continue;
    }
    const child = children.get(known.assignment.runId);
    if (
      child &&
      !child.terminal &&
      !child.settledWithoutCompletion &&
      (!child.nativeTurnState || child.nativeTurnState === "active")
    ) {
      add(threadId, child.modelExecution?.executionOwner);
    }
    for (const pending of known.pendingTurns) {
      if (!pending.state || pending.state === "active") {
        add(threadId, pending.modelSource?.executionOwner);
      }
    }
  }
  if (candidates.size !== 1) {
    return undefined;
  }
  const candidate = candidates.entries().next().value;
  const capture = (() => {
    try {
      return candidate?.[0].modelSource?.capture();
    } catch {
      return undefined;
    }
  })();
  if (!capture) {
    return undefined;
  }
  try {
    capture.assertCurrent();
    return candidate?.[1];
  } catch {
    return undefined;
  } finally {
    capture.release();
  }
}

export function resolveNativeModelParentOwner(
  state: ParentState,
  turnIdInput: string | undefined,
  nativeParentThreadId: string,
  children: ReadonlyMap<string, ChildState>,
  knownChildren: ReadonlyMap<string, KnownChild>,
): ParentOwner | undefined {
  const turnId = turnIdInput?.trim();
  if (!turnId) {
    return undefined;
  }
  if (nativeParentThreadId !== state.parentThreadId) {
    const assignment = knownChildren.get(nativeParentThreadId)?.assignment;
    const child = assignment ? children.get(assignment.runId) : undefined;
    return child?.nativeTurnId === turnId && !child.terminal
      ? child.modelExecution?.executionOwner
      : undefined;
  }
  const owners = [...state.owners.values()].filter((owner) => owner.turnId === turnId);
  if (!owners.length) {
    for (const child of children.values()) {
      if (
        child.parentThreadId === state.parentThreadId &&
        child.nativeTurnId === turnId &&
        !child.terminal &&
        child.modelExecution
      ) {
        owners.push(child.modelExecution.executionOwner);
      }
    }
  }
  return owners.length === 1 ? owners[0] : undefined;
}
