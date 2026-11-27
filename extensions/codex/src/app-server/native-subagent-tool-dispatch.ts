import { createAgentHarnessToolExecutionRegistry } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { retainCodexNativeChildToolSource } from "openclaw/plugin-sdk/codex-mcp-projection";
import type {
  ChildState,
  KnownChild,
  NativeModelSource,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { readCodexDynamicToolCallParams } from "./protocol-validators.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";
import type { CodexAttemptPrompt } from "./run-attempt-prompt.js";
import type { CodexServerRequestHandler } from "./server-requests.js";

export type NativeChildDynamicToolExecutor = (input: {
  call: CodexDynamicToolCallParams;
  runId: string;
  source: NativeModelSource;
  signal: AbortSignal;
  assertCurrent: () => void;
  setExecutionTimeoutMs?: (timeoutMs: number | null) => void;
}) => Promise<CodexDynamicToolCallResponse>;

/** Tool authority is minted only for an opted-in attempt, never from a generic model handle. */
export function captureNativeParentToolRegistration({
  runtime,
  attemptTools,
}: CodexAttemptPrompt["context"]) {
  const host = runtime.connection.params.hostCapabilities;
  const executeDynamicTool = attemptTools.executeNativeChildTool;
  return {
    // Omission means unknown; an explicit undefined identifies System model admission.
    ...(host.retainSourceAuthority
      ? {
          modelSource: executeDynamicTool
            ? retainCodexNativeChildToolSource(host)
            : host.retainSourceAuthority(),
        }
      : {}),
    ...(executeDynamicTool
      ? { executeDynamicTool, retainDynamicToolPolicy: runtime.nativeExecutionPolicy.retain }
      : {}),
  };
}

function createChildToolTurn(turnId: string) {
  return {
    turnId,
    controller: new AbortController(),
    executions: createAgentHarnessToolExecutionRegistry<
      CodexDynamicToolCallParams,
      CodexDynamicToolCallResponse
    >((call) => [call.threadId, call.turnId, call.callId]),
  };
}

export type NativeChildToolTurn = ReturnType<typeof createChildToolTurn>;

/** The existing physical-client monitor owns this route, including after foreground teardown. */
export function createNativeChildToolRequestHandler(
  knownChildren: ReadonlyMap<string, KnownChild>,
  currentChild: (id: string) => ChildState | undefined,
  isCurrentParent: (parent: ParentState) => boolean,
): CodexServerRequestHandler {
  return async (request, requestSignal, setExecutionTimeoutMs) => {
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const call = readCodexDynamicToolCallParams(request.params);
    if (!call) {
      return undefined;
    }
    const known = knownChildren.get(call.threadId);
    const child = currentChild(call.threadId);
    const owner = child?.directOwner;
    if (
      !known ||
      !child ||
      !owner?.executeDynamicTool ||
      child.nativeTurnId !== call.turnId ||
      child.nativeParentThreadId !== child.parentThreadId ||
      !isCurrentParent(known.parent)
    ) {
      return undefined;
    }
    const execute = owner.executeDynamicTool;
    const assertCurrent = () => {
      requestSignal?.throwIfAborted();
      if (
        knownChildren.get(call.threadId) !== known ||
        currentChild(call.threadId) !== child ||
        !isCurrentParent(known.parent) ||
        known.turnId !== call.turnId ||
        child.nativeTurnId !== call.turnId ||
        known.nativeLoad?.loaded === false ||
        known.pendingTurns.length ||
        child.directOwner !== owner ||
        child.nativeTurnState !== "active" ||
        child.terminal ||
        child.settledWithoutCompletion ||
        child.cancellationRequested ||
        owner.descendantsCancelled ||
        child.cancelledModelTurnId === call.turnId ||
        (child.completionCustody && !child.completionCustody.isCurrent())
      ) {
        throw new Error("Native child tool call has no current assignment.");
      }
      if (!child.modelExecution || child.modelExecution.owner !== owner) {
        throw new Error("Native child tool call has no matching retained host source.");
      }
      child.modelExecution.assertCurrent();
      known.parent.assignmentStore?.assertCurrent();
    };
    assertCurrent();
    if (child.toolTurn?.turnId !== call.turnId) {
      child.toolTurn?.controller.abort();
      child.toolTurn = createChildToolTurn(call.turnId);
    }
    const { controller, executions } = child.toolTurn;
    const signal = AbortSignal.any([
      controller.signal,
      ...(requestSignal ? [requestSignal] : []),
      ...(child.completionCustody ? [child.completionCustody.signal] : []),
    ]);
    signal.throwIfAborted();
    // Claim before any async admission work. Replayed RPCs join, never dispatch twice.
    return executions.claim(call, async () => {
      await known.parent.assignmentStore?.assertCurrentAsync();
      signal.throwIfAborted();
      assertCurrent();
      const capture = owner.modelSource?.capture();
      try {
        if (!capture?.source) {
          throw new Error("Native child host tool execution requires a retained requester source.");
        }
        return await execute({
          call,
          runId: child.runId,
          source: capture.source,
          signal,
          assertCurrent,
          setExecutionTimeoutMs,
        });
      } finally {
        capture?.release();
      }
    }).execution;
  };
}
