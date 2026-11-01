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

const producers = new Map<EmbeddedAgentQueueHandle, { finish(): Promise<void> }>();

type OperationIdentity = Pick<
  Parameters<typeof createReplyOperation>[0],
  "sessionKey" | "sessionId" | "agentId" | "upstreamAbortSignal"
>;
function operationFor(identity: OperationIdentity, storeScope: string) {
  return createReplyOperation({
    ...identity,
    resetTriggered: false,
    target: captureSessionTarget({ ...identity, incarnation: identity.sessionId, storeScope }),
  });
}

// Cleanup follows actual producer settlement, including rejection, on every exit path.
function ownProducer(run: (finished: Promise<void>) => Promise<void>, cleanup: () => void) {
  const finished = createDeferred();
  const settled = run(finished.promise).finally(cleanup);
  const finish = () => {
    finished.resolve();
    return settled;
  };
  onTestFinished(finish);
  return { finish, settled };
}

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
  const operation = operationFor(
    { sessionKey, sessionId, agentId, upstreamAbortSignal: signal },
    storePath ?? resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId }),
  );
  const abort = handle.abort;
  const producer = ownProducer(
    (finished) => finished,
    () => {
      clearNative(sessionId, handle, sessionKey);
      operation.complete();
      producers.delete(handle);
    },
  );
  handle.abort = (...args) => {
    try {
      abort(...args);
    } finally {
      void producer.finish();
    }
  };
  registerNative(sessionId, handle, sessionKey, undefined, agentId, operation);
  producers.set(handle, producer);
}

export async function detachActiveEmbeddedRun(
  _sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  _sessionKey: string,
) {
  await producers.get(handle)?.finish();
}

/** Own a real producer so Stop joins its completion, not a fabricated abort receipt. */
export function startControlProducer(
  sessionKey: string,
  sessionId: string,
  storePath: string,
  onCancel: () => void | Promise<void> = () => {},
  runId?: string,
) {
  const operation = operationFor({ sessionKey, sessionId, agentId: "main" }, storePath);
  const cancelled = createDeferred();
  const cancel = vi.fn(() => cancelled.resolve());
  const backend = { kind: "embedded" as const, runId, isStreaming: () => true, cancel };
  operation.attachBackend(backend);
  const producer = ownProducer(
    async (finished) => {
      if (await Promise.race([cancelled.promise.then(() => true), finished.then(() => false)])) {
        await onCancel();
      }
    },
    () => operation.complete(),
  );
  return { operation, backend, cancel, ...producer };
}
