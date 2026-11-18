import type {
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolResultContentSource,
} from "./types.js";

type RepetitionGuardPolicy = (model: AgentLoopConfig["model"]) => boolean;
const repetitionGuardByAgent = new WeakMap<object, RepetitionGuardPolicy>();

/** Host policy only: no plugin-facing option or user setting. */
export function setInternalRepetitionGuard(agent: object, policy: RepetitionGuardPolicy): void {
  repetitionGuardByAgent.set(agent, policy);
}

export function getInternalRepetitionGuard(agent: object): RepetitionGuardPolicy | undefined {
  return repetitionGuardByAgent.get(agent);
}

type InternalToolRepeatPolicy = {
  enabled: boolean;
  onVerdict?: NonNullable<AgentLoopConfig["onToolRepeat"]>;
};
const toolRepeatPolicyByAgent = new WeakMap<object, InternalToolRepeatPolicy>();

/** Host policy: `tools.loopDetection.enabled: false` disables the repeat guard for one Agent. */
export function setInternalToolRepeatPolicy(agent: object, policy: InternalToolRepeatPolicy): void {
  toolRepeatPolicyByAgent.set(agent, policy);
}

export function getInternalToolRepeatPolicy(agent: object): InternalToolRepeatPolicy | undefined {
  return toolRepeatPolicyByAgent.get(agent);
}

export type InternalBeforeRequestHook = (
  signal?: AbortSignal,
) => Promise<AgentMessage[] | undefined>;

const beforeRequestByOwner = new WeakMap<object, InternalBeforeRequestHook>();

/** Adopt already committed host messages before any initial or continuation request. */
export function setInternalBeforeRequest(
  owner: object,
  hook: InternalBeforeRequestHook | undefined,
): void {
  if (hook) {
    beforeRequestByOwner.set(owner, hook);
  } else {
    beforeRequestByOwner.delete(owner);
  }
}

export function getInternalBeforeRequest(owner: object): InternalBeforeRequestHook | undefined {
  return beforeRequestByOwner.get(owner);
}

type InternalToolTurnCompletionHook = NonNullable<AgentLoopConfig["completesToolTurn"]>;

const toolTurnCompletionByAgent = new WeakMap<object, InternalToolTurnCompletionHook>();
const toolTurnInputScopeByHook = new WeakMap<InternalToolTurnCompletionHook, object>();

/** Keep the accepted input identity across same-input Agent.continue() calls. */
export function getInternalToolTurnInputScope(hook: InternalToolTurnCompletionHook): object {
  let scope = toolTurnInputScopeByHook.get(hook);
  if (!scope) {
    scope = {};
    toolTurnInputScopeByHook.set(hook, scope);
  }
  return scope;
}

/** Queueing, cancellation and context-only updates do not commit a new input. */
export function commitInternalToolTurnInput(
  hook: InternalToolTurnCompletionHook | undefined,
): void {
  if (hook) {
    toolTurnInputScopeByHook.set(hook, {});
  }
}

type InternalSteeringGetter = NonNullable<AgentLoopConfig["getSteeringMessages"]>;
type InternalSyncSteeringGetter = () => AgentMessage[];
const syncSteeringGetterByCallback = new WeakMap<
  InternalSteeringGetter,
  InternalSyncSteeringGetter
>();

export type InternalSteeringQueueObserver = {
  peek: () => readonly AgentMessage[];
  drainContext?: () => AgentMessage[];
  reserve: (messages: readonly AgentMessage[]) => () => void;
  onChange?: () => void;
  subscribe?: (listener: () => void) => () => void;
};
const steeringQueueObserverByCallback = new WeakMap<
  InternalSteeringGetter,
  InternalSteeringQueueObserver
>();

export type InternalToolExecutionPreparation =
  | {
      kind: "immediate";
      outcome:
        | { kind: "result"; result: AgentToolResult<unknown>; isError: boolean }
        | { kind: "error"; error: unknown };
      dispose: () => void;
    }
  | {
      kind: "ready";
      args: unknown;
      execute: (onImplementationStart?: () => void) => Promise<AgentToolResult<unknown>>;
      dispose: () => void;
    };

export type InternalToolExecutionPreparer = (params: {
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  executionArgs?: unknown[];
}) => Promise<InternalToolExecutionPreparation>;

const toolExecutionPreparerByTool = new WeakMap<object, InternalToolExecutionPreparer>();

type InternalToolResultAcknowledgement = () => void;
const toolResultAcknowledgementByValue = new WeakMap<object, InternalToolResultAcknowledgement>();
const toolResultProvenanceByValue = new WeakMap<object, object>();
const toolResultContentSourceByValue = new WeakMap<object, ToolResultContentSource>();
const toolResultProgressByValue = new WeakMap<object, unknown>();

/** Producer-owned semantic outcome; presentation and runtime receipts remain unchanged. */
export function attachInternalToolResultProgress<T extends object>(value: T, progress: unknown): T {
  toolResultProgressByValue.set(value, progress);
  return value;
}

export function getInternalToolResultProgress(value: object): unknown {
  return toolResultProgressByValue.get(value);
}

export function clearInternalToolResultProgress(value: object): void {
  toolResultProgressByValue.delete(value);
}

/** Copy present private state without clearing a target's existing slot. */
function copyInternalSlot<T>(slots: WeakMap<object, T>, source: object, target: object): void {
  const value = slots.get(source);
  if (value !== undefined) {
    slots.set(target, value);
  }
}

export function setInternalToolTurnCompletion(
  agent: object,
  hook: InternalToolTurnCompletionHook | undefined,
): void {
  if (hook) {
    toolTurnCompletionByAgent.set(agent, hook);
  } else {
    toolTurnCompletionByAgent.delete(agent);
  }
}

export function getInternalToolTurnCompletion(
  agent: object,
): InternalToolTurnCompletionHook | undefined {
  return toolTurnCompletionByAgent.get(agent);
}

/** Attach Agent-owned synchronous draining to the exact public async callback identity. */
export function attachInternalSyncSteeringGetter(
  callback: InternalSteeringGetter,
  syncGetter: InternalSyncSteeringGetter,
  observer?: InternalSteeringQueueObserver,
): InternalSteeringGetter {
  syncSteeringGetterByCallback.set(callback, syncGetter);
  attachInternalSteeringQueueObserver(callback, observer);
  return callback;
}

/** Wrapping a getter must retain observation of its exact underlying queue. */
export function attachInternalSteeringQueueObserver(
  callback: InternalSteeringGetter,
  observer: InternalSteeringQueueObserver | undefined,
): void {
  if (observer) {
    steeringQueueObserverByCallback.set(callback, observer);
  }
}

export function getInternalSteeringQueueObserver(
  callback: InternalSteeringGetter | undefined,
): InternalSteeringQueueObserver | undefined {
  return callback ? steeringQueueObserverByCallback.get(callback) : undefined;
}

export function getInternalSyncSteeringGetter(
  callback: InternalSteeringGetter,
): InternalSyncSteeringGetter | undefined {
  return syncSteeringGetterByCallback.get(callback);
}

/** Attach OpenClaw-owned two-phase execution without changing the public AgentTool shape. */
export function attachInternalToolExecutionPreparer<T extends object>(
  tool: T,
  preparer: InternalToolExecutionPreparer,
): T {
  toolExecutionPreparerByTool.set(tool, preparer);
  return tool;
}

export function getInternalToolExecutionPreparer(
  tool: object,
): InternalToolExecutionPreparer | undefined {
  return toolExecutionPreparerByTool.get(tool);
}

/** Preserve private execution ownership when an adapter replaces a tool object. */
export function copyInternalToolExecutionPreparer<T extends object>(source: object, target: T): T {
  copyInternalSlot(toolExecutionPreparerByTool, source, target);
  return target;
}

/** Keep a destructive tool-side commit behind the result persistence boundary. */
export function attachInternalToolResultAcknowledgement<T extends object>(
  value: T,
  acknowledge: InternalToolResultAcknowledgement,
): T {
  toolResultAcknowledgementByValue.set(value, acknowledge);
  return value;
}

export function attachInternalToolResultProvenance<T extends object>(
  value: T,
  provenance: object | undefined,
): T {
  if (provenance) {
    toolResultProvenanceByValue.set(value, provenance);
  } else {
    toolResultProvenanceByValue.delete(value);
  }
  return value;
}

export function getInternalToolResultProvenance(value: object): object | undefined {
  return toolResultProvenanceByValue.get(value);
}

/**
 * Mark one result or thrown error as carrying content from a nested call whose
 * tool declares a result content source. Dispatchers such as Tool Search and
 * Code Mode use this because their own static declaration cannot describe each
 * call; finalization combines it with the executed tool's declaration.
 */
export function attachInternalToolResultContentSource<T extends object>(
  value: T,
  source: ToolResultContentSource,
): T {
  toolResultContentSourceByValue.set(value, source);
  return value;
}

export function getInternalToolResultContentSource(
  value: object,
): ToolResultContentSource | undefined {
  return toolResultContentSourceByValue.get(value);
}

/** Carry private commit ownership through result transforms and message construction. */
export function copyInternalToolResultState<T extends object>(source: object, target: T): T {
  copyInternalSlot(toolResultAcknowledgementByValue, source, target);
  copyInternalSlot(toolResultProvenanceByValue, source, target);
  copyInternalSlot(toolResultContentSourceByValue, source, target);
  copyInternalSlot(toolResultProgressByValue, source, target);
  return target;
}

/** Commit one tool result after its owning message has attached. */
export function acknowledgeInternalToolResult(value: object): void {
  const acknowledge = toolResultAcknowledgementByValue.get(value);
  if (!acknowledge) {
    return;
  }
  toolResultAcknowledgementByValue.delete(value);
  acknowledge();
}
