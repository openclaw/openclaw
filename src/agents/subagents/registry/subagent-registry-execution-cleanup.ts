import {
  captureChatAbortExecution,
  isCurrentChatAbortExecution,
} from "../../../gateway/chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../../../gateway/chat-abort.types.js";
import {
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { captureExecRequestCancellation } from "../../bash-process-control.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../../embedded-agent-runner/runs.js";
import { retireRequesterFollowupAuthority } from "../requester-cron-authority.js";
import {
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { resolveControllerSessionKey } from "./subagent-registry-read-topology.js";
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

export function captureSubagentEmbeddedExecution(entry: SubagentRunRecord) {
  if (resolveSubagentChildAuthority(entry).status === "mismatch") {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwnerByRunId(entry.runId);
  return owner?.sessionKey === entry.childSessionKey &&
    (!entry.childSessionIdentity?.sessionId ||
      owner.sessionId === entry.childSessionIdentity.sessionId)
    ? owner
    : undefined;
}

export async function captureSubagentReplyExecution(entry: SubagentRunRecord) {
  const authority = resolveSubagentChildAuthority(entry);
  if (authority.status === "mismatch") {
    return undefined;
  }
  const [{ resolveReplyOperationsForSession }, { getAttachedBackend }] = await Promise.all([
    import("../../../auto-reply/reply/reply-run-registry.registry.js"),
    import("../../../auto-reply/reply/reply-run-registry.state.js"),
  ]);
  const current = () =>
    resolveReplyOperationsForSession({
      agentId: authority.childAgentId,
      sessionKeys: [entry.childSessionKey],
      sessionId: entry.childSessionIdentity?.sessionId,
    }).find(
      (operation) =>
        operation.key === entry.childSessionKey &&
        getAttachedBackend(operation)?.runId === entry.runId,
    );
  const operation = current();
  if (!operation) {
    return undefined;
  }
  const backend = getAttachedBackend(operation);
  const isCurrent = () => current() === operation && getAttachedBackend(operation) === backend;
  return {
    sessionId: operation.sessionId,
    settlement: operation.ownerSettlement,
    isCurrent,
    abort: () => isCurrent() && operation.abortByUser(),
  };
}

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
      sessionId:
        resolveSubagentChildAuthority(entry).status === "legacy-unverified"
          ? (entry.childSessionIdentity?.sessionId ??
            context.chatAbortControllers.get(entry.runId)?.sessionId)
          : params.session.entry?.sessionId,
      lifecycleGeneration: entry.execution.lifecycleGeneration,
    });
  return context && execution
    ? { entry, resolver, context, runId: entry.runId, execution }
    : undefined;
}

/** Retire execution authority while its raw owner still supplies cleanup observation. */
export function retireSubagentGatewayBinding(observed: SubagentRunRecord): void {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  retireRequesterFollowupAuthority(entry);
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
    observation.sessionLifecycleRevision === session?.lifecycleRevision
    ? observation
    : undefined;
}

function hasRetainedControllerExecution(entry: SubagentRunRecord): boolean {
  const retained = executionCleanups.get(getSubagentRunRuntimeKey(entry));
  const cleanup = getSubagentExecutionCleanup(
    entry,
    entry.childSessionIdentity ??
      (retained && {
        sessionId: retained.sessionId,
        lifecycleRevision: retained.sessionLifecycleRevision,
      }),
  );
  if (cleanup && !cleanup.settlement.cleanupSettled) {
    return true;
  }
  const context = getGatewayContextResolver(entry)?.();
  const execution = context?.chatAbortControllers.get(entry.runId);
  return Boolean(
    execution &&
    execution.kind === "agent" &&
    execution.sessionKey === entry.childSessionKey &&
    (!entry.childSessionIdentity || execution.sessionId === entry.childSessionIdentity.sessionId) &&
    (entry.execution.lifecycleGeneration === undefined ||
      execution.lifecycleGeneration === entry.execution.lifecycleGeneration) &&
    execution.executionSettlement &&
    !execution.executionSettlement.cleanupSettled,
  );
}

/** Snapshot topology before cancellation awaits; terminal timestamps never prove cleanup. */
export function captureSubagentRetainedWork() {
  const children = new Map<string, SubagentRunRecord[]>();
  for (const entry of subagentRuns.values()) {
    const key = resolveControllerSessionKey(entry);
    const group = children.get(key) ?? [];
    group.push(entry);
    children.set(key, group);
  }
  const hasRetainedWork = (entry: SubagentRunRecord, visited = new Set<string>()): boolean => {
    if (visited.has(entry.runId)) {
      return false;
    }
    visited.add(entry.runId);
    const childAgentId = resolveSubagentChildAgentId(entry);
    return (
      entry.execution.status !== "terminal" ||
      typeof entry.execution.endedAt !== "number" ||
      entry.pauseReason === "sessions_yield" ||
      Boolean(entry.requesterSettleWake) ||
      Boolean(
        entry.killIntent || entry.killReconciliation || entry.collectorLaunchCleanupPending,
      ) ||
      captureSubagentEmbeddedExecution(entry) !== undefined ||
      hasRetainedControllerExecution(entry) ||
      captureExecRequestCancellation({
        runId: entry.runId,
        sessionKey: entry.childSessionKey,
        sessionId: entry.childSessionIdentity?.sessionId,
        agentId: childAgentId,
      }).owners.length > 0 ||
      (children.get(entry.childSessionKey) ?? []).some(
        (child) =>
          (!childAgentId ||
            (parseAgentSessionKey(resolveControllerSessionKey(child))?.agentId ??
              child.requesterAgentId) === childAgentId) &&
          hasRetainedWork(child, visited),
      )
    );
  };
  return (entry: SubagentRunRecord) => hasRetainedWork(entry);
}
