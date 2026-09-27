import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNativeModelParentOwner } from "./native-subagent-model-lookup.js";
import {
  createNativeModelSourceOwner,
  bindNativeChildModelAdmission,
  admitNativeChildModelExecution,
  retainNativeModelSource,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeModelInputRequest,
  NativeModelToolInputRequest,
  NativeModelSourceOwner,
  NativeModelBinding,
  NativeSubagentMonitorClient,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { readThreadParentThreadId, readThreadSpawnSource } from "./native-subagent-task-ids.js";
import { isJsonObject } from "./protocol.js";

/** Equality joins input to one live source; it never grants another source's models. */
export function assertNativeModelInputCompatible(sender: ParentOwner, receiver: ParentOwner): void {
  const input = sender.modelSource?.capture();
  let target: typeof input;
  try {
    target = receiver.modelSource?.capture();
    if (!input || !target || sender.modelExecutionCancelled || receiver.modelExecutionCancelled) {
      throw new Error("Codex active input requires an admitted model source");
    }
    input.assertCurrent();
    target.assertCurrent();
    if (!input.source && !target.source) {
      return;
    }
    const identity = input.source?.sourceIdentity;
    if (!identity || identity !== target.source?.sourceIdentity) {
      throw new Error("Codex active input requires the same admitted model source");
    }
    input.assertCurrent();
    target.assertCurrent();
  } finally {
    target?.release();
    input?.release();
  }
}

type InputDependencies = {
  client: NativeSubagentMonitorClient;
  parents: ReadonlyMap<string, ParentState>;
  knownChildren: ReadonlyMap<string, KnownChild>;
  children: ReadonlyMap<string, ChildState>;
  isCurrent: (state: ParentState) => boolean;
  retainTargetRevision: (threadId: string) => { isCurrent: () => boolean; release: () => void };
  currentModelExecution: (threadId: string) => ParentOwner | undefined;
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>;
  prepareReceiver: (state: ParentState, threadId: string) => boolean;
  registerChildThread: AdmissionDrainDependencies["registerChildThread"];
  admit: (
    state: ParentState,
    owner: ParentOwner,
    request: NativeModelInputRequest,
    count: number,
    preparedOwner: ParentOwner,
  ) => void;
  interruptModelExecution?: (threadId: string, turnId: string) => void;
};

function nativeAgentPath(known: KnownChild | undefined): string | undefined {
  const paths = [...(known?.agentPaths ?? [])].filter((path) =>
    /^\/root(?:\/[a-z0-9_]+)*$/.test(path),
  );
  return paths.length === 1 ? paths[0] : undefined;
}

function nativeRootThreadId(
  threadId: string,
  knownChildren: ReadonlyMap<string, KnownChild>,
): string | undefined {
  const visited = new Set<string>();
  let current = threadId;
  let expectedPath: string | undefined;
  while (!visited.has(current)) {
    visited.add(current);
    const known = knownChildren.get(current);
    const path = nativeAgentPath(known);
    if (!known || !path || (expectedPath && path !== expectedPath)) {
      return undefined;
    }
    if (path === "/root") {
      return current;
    }
    expectedPath = path.slice(0, path.lastIndexOf("/"));
    if (expectedPath === "/root") {
      return known.nativeParentThreadId;
    }
    current = known.nativeParentThreadId;
  }
  return undefined;
}

function resolveInputTarget(
  request: NativeModelToolInputRequest,
  dependencies: InputDependencies,
): string {
  const target = request.target.trim();
  if (
    dependencies.parents.has(target) ||
    dependencies.knownChildren.has(target) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
  ) {
    return target;
  }
  const childParentPaths = new Set(
    [...dependencies.knownChildren.values()]
      .filter((known) => known.nativeParentThreadId === request.threadId)
      .flatMap((known) => {
        const path = nativeAgentPath(known);
        return path ? [path.slice(0, path.lastIndexOf("/"))] : [];
      }),
  );
  const senderPath =
    nativeAgentPath(dependencies.knownChildren.get(request.threadId)) ??
    (childParentPaths.size === 1 ? childParentPaths.values().next().value : undefined);
  const nativeRoot =
    nativeRootThreadId(request.threadId, dependencies.knownChildren) ??
    (senderPath === "/root" ? request.threadId : undefined);
  if (!senderPath || !nativeRoot) {
    throw new Error(
      "Codex native target lineage is not currently identified; use its exact thread ID",
    );
  }
  const path = target.startsWith("/") ? target : `${senderPath}/${target}`;
  if (path === "/root") {
    return nativeRoot;
  }
  const matches = [...dependencies.knownChildren].filter(
    ([threadId, known]) =>
      known.agentPaths.has(path) &&
      nativeRootThreadId(threadId, dependencies.knownChildren) === nativeRoot,
  );
  if (matches.length !== 1) {
    throw new Error("Codex native target is not currently identified; use its exact thread ID");
  }
  return matches[0]![0];
}

/** Qualification is read before the native handler; source custody remains with its existing call. */
export async function prepareNativeModelToolInput(
  request: NativeModelToolInputRequest,
  dependencies: InputDependencies,
): Promise<void> {
  const state =
    dependencies.parents.get(request.threadId) ??
    dependencies.knownChildren.get(request.threadId)?.parent;
  const owner =
    state &&
    resolveNativeModelParentOwner(
      state,
      request.turnId,
      request.threadId,
      dependencies.children,
      dependencies.knownChildren,
    );
  const capture = owner?.modelSource?.capture();
  if (
    !state ||
    !owner ||
    !capture ||
    owner.modelExecutionSettled ||
    owner.modelExecutionCancelled
  ) {
    capture?.release();
    throw new Error("Codex native input requires its exact admitted sender turn");
  }
  let preparedSource: NativeModelSourceOwner | undefined;
  let captureTransferred = false;
  let pendingBinding: NativeModelBinding | undefined;
  let targetRevision: ReturnType<InputDependencies["retainTargetRevision"]> | undefined;
  let assertTargetCurrent: (() => void) | undefined;
  const assertCurrent = () => {
    request.assertCurrent();
    capture.assertCurrent();
    pendingBinding?.assertCurrent();
    assertTargetCurrent?.();
    if (
      !dependencies.isCurrent(state) ||
      owner.modelExecutionSettled ||
      owner.modelExecutionCancelled
    ) {
      throw new Error("Codex native input sender is no longer current");
    }
  };
  try {
    assertCurrent();
    const targetThreadId = resolveInputTarget(request, dependencies);
    targetRevision = dependencies.retainTargetRevision(targetThreadId);
    const targetParent = dependencies.parents.get(targetThreadId);
    const targetChild = dependencies.knownChildren.get(targetThreadId);
    const targetConfiguration = targetChild?.configurationQualification;
    const targetRouting = request.readQualification(targetThreadId);
    assertTargetCurrent = () => {
      if (
        !targetRevision?.isCurrent() ||
        dependencies.parents.get(targetThreadId) !== targetParent ||
        dependencies.knownChildren.get(targetThreadId) !== targetChild ||
        targetChild?.configurationQualification !== targetConfiguration ||
        request.readQualification(targetThreadId) !== targetRouting
      ) {
        throw new Error(
          "Codex native receiver changed during input preparation; retry with its current thread",
        );
      }
      targetConfiguration?.assertCurrent();
      targetRouting?.assertCurrent();
    };
    assertCurrent();
    const { thread } = await dependencies.client.request(
      "thread/read",
      { threadId: targetThreadId, includeTurns: false },
      {
        signal:
          request.signal && capture.source?.signal
            ? AbortSignal.any([request.signal, capture.source.signal])
            : (request.signal ?? capture.source?.signal),
        timeoutMs: 30_000,
        assertCurrent,
      },
    );
    assertCurrent();
    if (
      thread.id !== targetThreadId ||
      !thread.modelProvider ||
      resolveInputTarget(request, dependencies) !== targetThreadId
    ) {
      throw new Error("Codex native target returned a different thread or no provider");
    }
    if (
      thread.status?.type !== "idle" &&
      thread.status?.type !== "notLoaded" &&
      !dependencies.currentModelExecution(targetThreadId)
    ) {
      throw new Error("Codex active input requires the receiver's exact admitted execution");
    }
    const known = dependencies.knownChildren.get(targetThreadId);
    const configurationQualification =
      thread.status?.type === "notLoaded"
        ? owner.configurationQualification
        : !thread.status
          ? undefined
          : dependencies.parents.has(targetThreadId)
            ? request.readQualification(targetThreadId)
            : known?.configurationQualification;
    configurationQualification?.assertCurrent();
    const qualified = configurationQualification?.hasProvider(thread.modelProvider) === true;
    const preparedOwner: ParentOwner = {
      ...owner,
      configurationQualification,
      nativeInputConfiguration: true,
      unqualifiedModelExecution: undefined,
      claimUnqualifiedModelBinding: undefined,
    };
    if (!qualified && capture.source) {
      const source = capture.source;
      const binding = source.bindModelExecution?.(undefined);
      if (!binding) {
        throw new Error("Codex native provider cannot be qualified for this model source");
      }
      pendingBinding = binding;
      preparedOwner.unqualifiedModelExecution = true;
      // The accepted input transfers this guard once; descendants retain the
      // original source and acquire their own execution guard.
      preparedOwner.claimUnqualifiedModelBinding = () => {
        const admitted = pendingBinding;
        pendingBinding = undefined;
        return admitted;
      };
      preparedOwner.interruptModelExecution = dependencies.interruptModelExecution;
      preparedSource = createNativeModelSourceOwner(
        {
          get signal() {
            return source.signal;
          },
          get sourceIdentity() {
            return source.sourceIdentity;
          },
          get modelPolicyRequired() {
            return source.modelPolicyRequired;
          },
          assertCurrent: capture.assertCurrent,
          bindModelExecution: (model) => source.bindModelExecution?.(model),
          release: () => {
            try {
              pendingBinding?.release();
              pendingBinding = undefined;
            } finally {
              capture.release();
            }
          },
        },
        state,
        () => {
          if (!dependencies.isCurrent(state)) {
            throw new Error("Codex native input source owner is no longer current");
          }
        },
        () => {},
      );
      captureTransferred = true;
      preparedOwner.modelSource = preparedSource;
    }
    assertCurrent();
    if (!dependencies.prepareReceiver(state, thread.id)) {
      throw new Error("Codex native input receiver cannot retain this sender's admitted source");
    }
    if (!dependencies.knownChildren.has(thread.id) && !dependencies.parents.has(thread.id)) {
      const metadata = isJsonObject(thread) ? thread : undefined;
      dependencies.registerChildThread(state, thread.id, {
        nativeParentThreadId: readThreadParentThreadId(metadata),
        agentPath: readString(readThreadSpawnSource(metadata), "agent_path"),
      });
    }
    const currentState =
      dependencies.parents.get(request.threadId) ??
      dependencies.knownChildren.get(request.threadId)?.parent;
    const currentOwner =
      currentState &&
      resolveNativeModelParentOwner(
        currentState,
        request.turnId,
        request.threadId,
        dependencies.children,
        dependencies.knownChildren,
      );
    if (
      !currentOwner ||
      currentOwner.modelExecutionSettled ||
      currentOwner.modelExecutionCancelled
    ) {
      throw new Error("Codex native input requires its exact admitted sender turn");
    }
    if (currentState !== state || currentOwner !== owner) {
      throw new Error("Codex native input sender changed during preparation");
    }
    const pendingModelSources = [...dependencies.admissions.values()]
      .flat()
      .filter(
        (entry) =>
          entry.kind === "interaction" && entry.modelSource?.owner.modelSource?.hasOperatorSource,
      ).length;
    dependencies.admit(
      state,
      owner,
      { ...request, targetThreadId },
      pendingModelSources,
      preparedOwner,
    );
  } finally {
    targetRevision?.release();
    preparedSource?.release();
    if (!captureTransferred) {
      capture.release();
    }
  }
}

type AdmissionDrainDependencies = {
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>;
  replaceAdmissions: (turnId: string, remaining: NativeChildAdmissionEvidence[]) => void;
  knownChildren: ReadonlyMap<string, KnownChild>;
  isCurrent: (state: ParentState) => boolean;
  currentChild: (threadId: string) => ChildState | undefined;
  hasRecovery: (state: ParentState, threadId: string) => boolean;
  registerAgentPath: (state: ParentState, threadId: string, path: string) => void;
  registerChildThread: (
    state: ParentState,
    threadId: string,
    options: { agentPath?: string; directOwner?: ParentOwner; nativeParentThreadId?: string },
  ) => ChildState | undefined;
  associateUnregisteredChildInteractions: (state: ParentState, threadId: string) => void;
  admitFollowupChild: (
    known: KnownChild,
    threadId: string,
    owner?: ParentOwner,
  ) => ChildState | undefined;
  observeActivity: (child: ChildState) => void;
};

export function drainNativeChildModelAdmissions(
  state: ParentState,
  owner: ParentOwner,
  turnId: string,
  observeActivity: boolean,
  dependencies: AdmissionDrainDependencies,
): void {
  const pending = dependencies.admissions.get(turnId);
  const ownerIsCurrent = [...state.owners.values()].includes(owner);
  if (
    !pending ||
    !dependencies.isCurrent(state) ||
    (!ownerIsCurrent &&
      !pending.some(
        (entry) =>
          entry.kind === "interaction" &&
          (entry.admittedOwner === owner ||
            entry.modelSource?.owner === owner ||
            (entry.owner === owner && entry.modelSource)),
      ))
  ) {
    return;
  }
  const remaining: NativeChildAdmissionEvidence[] = [];
  const affectedChildren = new Set<string>();
  const unknownChildren = new Set<string>();
  for (const evidence of pending) {
    if (evidence.parentThreadId !== state.parentThreadId) {
      remaining.push(evidence);
      continue;
    }
    if (evidence.kind === "interaction") {
      if (
        !ownerIsCurrent &&
        evidence.admittedOwner !== owner &&
        evidence.modelSource?.owner !== owner &&
        !(evidence.owner === owner && evidence.modelSource)
      ) {
        remaining.push(evidence);
        continue;
      }
      if (ownerIsCurrent) {
        evidence.owner = owner;
        evidence.completionCustody ??= owner.completionCustody?.retain();
        if (!evidence.modelSourceConsumed) {
          evidence.modelSource ??= retainNativeModelSource(evidence.modelOwner ?? owner);
        }
      }
      const known = dependencies.knownChildren.get(evidence.childThreadId);
      if (known && known.parent !== state) {
        continue;
      }
      if (
        !known ||
        (!known.assignment.terminal &&
          !known.assignment.nativeTurnId &&
          !dependencies.currentChild(evidence.childThreadId) &&
          dependencies.hasRecovery(state, evidence.childThreadId))
      ) {
        remaining.push(evidence);
        unknownChildren.add(evidence.childThreadId);
        continue;
      }
      if (evidence.agentPath && !known.agentPaths.has(evidence.agentPath)) {
        dependencies.registerAgentPath(state, evidence.childThreadId, evidence.agentPath);
      }
      const waitingForModel = bindNativeChildModelAdmission(
        evidence,
        known,
        dependencies.currentChild(evidence.childThreadId),
      );
      if (waitingForModel) {
        remaining.push(evidence);
      }
      if (evidence.nativeTurnId) {
        const observed = known.observedTurns.get(evidence.nativeTurnId);
        if (observed) {
          observed.awaitingInteraction = undefined;
        }
        const nativeTurn = known.pendingTurns.find((turn) => turn.turnId === evidence.nativeTurnId);
        if (nativeTurn) {
          if (!nativeTurn.admittedOwner) {
            nativeTurn.admittedOwner = ownerIsCurrent ? owner : evidence.admittedOwner;
            nativeTurn.completionCustody ??= evidence.completionCustody?.retain();
            if (ownerIsCurrent) {
              owner.onDirectChildAccepted?.();
            }
          }
        } else if (
          dependencies.currentChild(evidence.childThreadId)?.nativeTurnId !== evidence.nativeTurnId
        ) {
          continue;
        }
      } else if (ownerIsCurrent || waitingForModel) {
        if (!waitingForModel) {
          remaining.push(evidence);
        }
      } else {
        continue;
      }
      affectedChildren.add(evidence.childThreadId);
      continue;
    }
    if (!ownerIsCurrent) {
      continue;
    }
    const childState = dependencies.registerChildThread(state, evidence.childThreadId, {
      ...(evidence.agentPath === undefined ? {} : { agentPath: evidence.agentPath }),
      directOwner: owner,
      nativeParentThreadId: evidence.nativeParentThreadId,
    });
    if (childState) {
      admitNativeChildModelExecution(
        childState,
        owner,
        dependencies.knownChildren.get(childState.childThreadId),
      );
    }
  }
  dependencies.replaceAdmissions(turnId, remaining);
  for (const threadId of unknownChildren) {
    dependencies.associateUnregisteredChildInteractions(state, threadId);
  }
  for (const threadId of affectedChildren) {
    const known = dependencies.knownChildren.get(threadId);
    if (known?.parent !== state) {
      continue;
    }
    const previous = dependencies.currentChild(threadId);
    const child = dependencies.admitFollowupChild(
      known,
      threadId,
      ownerIsCurrent ? owner : undefined,
    );
    if (observeActivity && child && child !== previous && child.nativeTurnState === "active") {
      dependencies.observeActivity(child);
    }
  }
}
