import {
  captureChatAbortExecution,
  isCurrentChatAbortExecution,
} from "../../../gateway/chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.types.js";
import {
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

type ExecutionCleanupObservation = {
  readonly sessionId: string;
  readonly sessionLifecycleRevision: string | undefined;
  readonly settlement: NonNullable<ChatAbortControllerEntry["executionSettlement"]>;
  matchesRecord(): boolean;
  isCurrent(): boolean;
  isSelf(): boolean;
};

// Immutable row publications preserve their existing physical execution owner.
const executionCleanups = new WeakMap<object, ExecutionCleanupObservation>();

export function captureSubagentExecution(params: {
  entry: SubagentRunRecord;
  session: SubagentKillSession;
}) {
  const entry = getCurrentSubagentRunOwner(subagentRuns, params.entry) ?? params.entry;
  const resolver = getGatewayContextResolver(entry);
  const context = resolver?.();
  const execution =
    context &&
    captureChatAbortExecution({
      entries: context.chatAbortControllers,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      sessionId: params.session.entry?.sessionId,
      lifecycleGeneration: entry.execution.lifecycleGeneration,
    });
  return context && execution
    ? { entry, resolver, context, runId: entry.runId, execution }
    : undefined;
}

/** Retire execution authority while its raw owner still supplies cleanup observation. */
export function retireSubagentGatewayBinding(observed: SubagentRunRecord): void {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  const key = getSubagentRunRuntimeKey(entry);
  const resolver = getGatewayContextResolver(entry);
  try {
    const context = resolver?.();
    const execution = context?.chatAbortControllers.get(entry.runId);
    const settlement = execution?.executionSettlement;
    const { runId, childSessionKey, generation, createdAt } = entry;
    const lifecycleGeneration = entry.execution.lifecycleGeneration;
    if (
      !resolver ||
      !context ||
      !execution ||
      !settlement ||
      settlement.cleanupSettled ||
      execution.kind !== "agent" ||
      execution.sessionKey !== childSessionKey ||
      (entry.childSessionIdentity !== undefined &&
        execution.sessionId !== entry.childSessionIdentity.sessionId) ||
      (lifecycleGeneration !== undefined && execution.lifecycleGeneration !== lifecycleGeneration)
    ) {
      return;
    }
    const { sessionId, lifecycleGeneration: executionGeneration } = execution;
    const recordSessionId = entry.childSessionIdentity?.sessionId;
    const sessionLifecycleRevision = entry.childSessionIdentity?.lifecycleRevision;
    const currentEntry = () => getCurrentSubagentRunOwner(subagentRuns, entry) ?? entry;
    const matchesRecord = () => {
      const current = currentEntry();
      return (
        current.runId === runId &&
        current.childSessionKey === childSessionKey &&
        current.generation === generation &&
        current.createdAt === createdAt &&
        current.execution.lifecycleGeneration === lifecycleGeneration &&
        current.childSessionIdentity?.sessionId === recordSessionId &&
        current.childSessionIdentity?.lifecycleRevision === sessionLifecycleRevision
      );
    };
    const observation: ExecutionCleanupObservation = {
      sessionId,
      sessionLifecycleRevision,
      settlement,
      matchesRecord,
      isSelf: () => isCurrentChatAbortExecution(execution),
      isCurrent: () => {
        const current = context.chatAbortControllers.get(runId);
        return (
          matchesRecord() &&
          getGatewayContextResolver(currentEntry()) === undefined &&
          resolver() === context &&
          execution.sessionKey === childSessionKey &&
          execution.sessionId === sessionId &&
          execution.lifecycleGeneration === executionGeneration &&
          execution.executionSettlement === settlement &&
          (current === execution || (current === undefined && settlement.cleanupSettled))
        );
      },
    };
    executionCleanups.set(key, observation);
    const release = () => {
      if (settlement.cleanupSettled && executionCleanups.get(key) === observation) {
        executionCleanups.delete(key);
      }
    };
    void settlement.completion.then(release, release);
  } finally {
    clearGatewayContextResolver(entry);
  }
}

export function getSubagentExecutionCleanup(
  observed: SubagentRunRecord,
  session: SubagentRunRecord["childSessionIdentity"],
): ExecutionCleanupObservation | undefined {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  const observation = executionCleanups.get(getSubagentRunRuntimeKey(entry));
  return observation?.sessionId === session?.sessionId &&
    observation?.matchesRecord() &&
    (observation.sessionLifecycleRevision === undefined ||
      observation.sessionLifecycleRevision === session?.lifecycleRevision)
    ? observation
    : undefined;
}
