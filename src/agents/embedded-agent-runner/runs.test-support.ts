import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  ReplyMessageInjectionOptions,
  ReplyOperation,
} from "../../sessions/session-controller.contracts.js";
import {
  createReplyOperation,
  resolveActiveReplyOperationForSessionId,
} from "../../sessions/session-controller.js";
import {
  bindSessionControllerTarget,
  captureSessionTarget,
  type SessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { getActiveNativeAttempt } from "./run-state.js";
import { attachActiveEmbeddedRun, detachActiveEmbeddedRun } from "./runs.js";
const fixtureOperations = new Set<ReplyOperation>();
/** Native boundary fixtures explicitly reserve their logical turn before publication. */
export function registerTestEmbeddedRun(
  ...args: [
    ...Parameters<typeof attachActiveEmbeddedRun>,
    fixture?: { storeScope?: string; target?: SessionTarget },
  ]
): ReplyOperation {
  const [
    sessionId,
    handle,
    sessionKey,
    sessionFile,
    agentId,
    supplied,
    lifecycleGeneration,
    fixture,
  ] = args;
  let operation = supplied ?? resolveActiveReplyOperationForSessionId(sessionId);
  if (
    !supplied &&
    operation &&
    (operation.result || operation.abortSignal.aborted) &&
    fixtureOperations.delete(operation)
  ) {
    operation.complete();
    operation = undefined;
  }
  const key = sessionKey ?? operation?.key ?? "agent:test:" + sessionId;
  const target =
    fixture?.target ??
    (fixture?.storeScope
      ? undefined
      : operation && getSessionControllerEntryForOperation(operation).target) ??
    captureSessionTarget({
      storeScope:
        fixture?.storeScope ??
        resolveSessionStorePathCore(getRuntimeConfigSnapshot()?.session?.store, {
          agentId: agentId ?? parseAgentSessionKey(key)?.agentId ?? "main",
        }),
      sessionKey: key,
      incarnation: sessionId,
      agentId,
    });
  const created = !operation;
  if (!operation) {
    operation = createReplyOperation({
      sessionKey: key,
      sessionId,
      agentId,
      resetTriggered: false,
      target,
    });
    fixtureOperations.add(operation);
  } else if (getSessionControllerEntryForOperation(operation).target !== target) {
    bindSessionControllerTarget(operation, target);
  }
  try {
    attachActiveEmbeddedRun(
      sessionId,
      handle,
      sessionKey ?? operation.key,
      sessionFile,
      agentId,
      operation,
      lifecycleGeneration,
    );
    return operation;
  } finally {
    // A rejected registration may retire only the reservation made by this call.
    if (created && getActiveNativeAttempt(sessionId) !== handle) {
      fixtureOperations.delete(operation);
      operation.complete();
    }
  }
}
/** Steers a session's active turn the way in-process callers do: through its controller. */
export function steerTestSessionTurn(
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions = {},
) {
  return steerSessionControllerOperation({
    operation: resolveActiveReplyOperationForSessionId(sessionId),
    text,
    options,
  });
}
export function clearTestEmbeddedRun(...args: Parameters<typeof detachActiveEmbeddedRun>): void {
  const [sessionId, handle] = args;
  const operation =
    getActiveNativeAttempt(sessionId) === handle
      ? resolveActiveReplyOperationForSessionId(sessionId)
      : undefined;
  detachActiveEmbeddedRun(...args);
  if (operation && fixtureOperations.delete(operation)) {
    operation.complete();
  }
}
import type { EmbeddedAgentQueueHandle } from "./run-state.js";

type RunHandle = EmbeddedAgentQueueHandle;

export function createEmbeddedRunHandle(
  overrides: {
    abort?: RunHandle["abort"];
    /** Expose guarded V2 injection over queueMessage, as host-authority runtimes do. */
    guarded?: boolean;
    isAbortable?: boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    messageInjection?: RunHandle["messageInjection"];
    runId?: string;
    toolAuthorityFingerprint?: string;
    queueMessage?: RunHandle["queueMessage"];
    supportsQueueMessageImages?: boolean;
    supportsTranscriptCommitWait?: boolean;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply queue/abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  const queueMessage = overrides.queueMessage ?? (async () => {});
  return {
    runId: overrides.runId,
    toolAuthorityFingerprint: overrides.toolAuthorityFingerprint,
    queueMessage,
    ...(overrides.messageInjection ? { messageInjection: overrides.messageInjection } : {}),
    ...(overrides.guarded
      ? {
          messageInjectionV2: {
            version: 2 as const,
            isAvailable: () => true,
            queueMessage: async (
              text: string,
              options: Parameters<RunHandle["queueMessage"]>[1],
              assertCurrent: () => void,
            ) => {
              assertCurrent();
              return queueMessage(text, options);
            },
          },
        }
      : {}),
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isStopped ? { isStopped: overrides.isStopped } : {}),
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
    supportsTranscriptCommitWait: overrides.supportsTranscriptCommitWait,
    abort,
  };
}

type EmbeddedRunsTestApi = {
  resetActiveEmbeddedRuns(): void;
};
function getTestApi(): EmbeddedRunsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunsTestApi")
  ];
  if (!api) {
    throw new Error("embedded runs test API is unavailable");
  }
  return api as EmbeddedRunsTestApi;
}

export const testing = {
  ...getTestApi(),
  resetActiveEmbeddedRuns() {
    getTestApi().resetActiveEmbeddedRuns();
    for (const operation of fixtureOperations) {
      operation.complete();
    }
    fixtureOperations.clear();
  },
};
