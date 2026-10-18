import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import type { EmbeddedAgentQueueHandle } from "../../embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun as registerNative,
  detachActiveEmbeddedRun as clearNative,
} from "../../embedded-agent-runner/runs.js";

const producers = new Map<EmbeddedAgentQueueHandle, { finish(): void; settled: Promise<void> }>();

/** The fixture owns an actual async producer; cancellation does not fabricate its receipt. */
export function attachActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
  storePath?: string,
  signal?: AbortSignal,
  explicitAgentId?: string,
) {
  const agentId = explicitAgentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    agentId,
    resetTriggered: false,
    upstreamAbortSignal: signal,
    target: captureSessionTarget({
      sessionKey,
      incarnation: sessionId,
      agentId,
      storeScope:
        storePath ?? resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId }),
    }),
  });
  const finished = createDeferred();
  const abort = handle.abort;
  handle.abort = (...args) => {
    try {
      abort(...args);
    } finally {
      finished.resolve();
    }
  };
  registerNative(sessionId, handle, sessionKey, undefined, agentId, operation);
  const settled = (async () => {
    try {
      await finished.promise;
    } finally {
      clearNative(sessionId, handle, sessionKey);
      operation.complete();
      producers.delete(handle);
    }
  })();
  producers.set(handle, { finish: () => finished.resolve(), settled });
  onTestFinished(async () => {
    finished.resolve();
    await settled;
  });
}

export async function detachActiveEmbeddedRun(
  _sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  _sessionKey: string,
) {
  const producer = producers.get(handle);
  producer?.finish();
  await producer?.settled;
}

/** Own a real producer so Stop joins its completion, not a fabricated abort receipt. */
export function startControlProducer(
  sessionKey: string,
  sessionId: string,
  storePath: string,
  onCancel: () => void | Promise<void> = () => {},
  runId?: string,
) {
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    agentId: "main",
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId: "main",
      incarnation: sessionId,
    }),
  });
  const cancelled = createDeferred();
  const finished = createDeferred();
  const cancel = vi.fn(() => cancelled.resolve());
  operation.attachBackend({ kind: "embedded", runId, isStreaming: () => true, cancel });
  const settled = (async () => {
    try {
      const wasCancelled = await Promise.race([
        cancelled.promise.then(() => true),
        finished.promise.then(() => false),
      ]);
      if (wasCancelled) {
        await onCancel();
      }
    } finally {
      operation.complete();
    }
  })();
  onTestFinished(async () => {
    finished.resolve();
    await settled;
  });
  return { operation, cancel, settled };
}
