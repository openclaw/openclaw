import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";
import { detachActiveEmbeddedRun, attachActiveEmbeddedRun } from "./runs.js";

/** Keep manual compaction attached until its raw work and disposal settle. */
export function attachManualCompactionRun(
  params: CompactEmbeddedAgentSessionParams,
  operation: ReplyOperation | undefined,
  onSettled: (cleanup: () => void) => void,
): AbortSignal {
  const controller = new AbortController();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  const handle: EmbeddedAgentQueueHandle = {
    kind: "embedded",
    queueMessage: async () => {},
    isStreaming: () => true,
    isAborted: () => abortSignal.aborted,
    isCompacting: () => true,
    abort: (reason) => controller.abort(reason ?? "user_abort"),
    cancel: (reason) => controller.abort(reason ?? "user_abort"),
  };
  const attachment = attachActiveEmbeddedRun(
    params.sessionId,
    handle,
    params.sessionKey,
    params.sessionFile,
    params.agentId,
    operation,
  );
  onSettled(() =>
    detachActiveEmbeddedRun(
      params.sessionId,
      handle,
      params.sessionKey,
      params.sessionFile,
      undefined,
      attachment,
    ),
  );
  return abortSignal;
}
