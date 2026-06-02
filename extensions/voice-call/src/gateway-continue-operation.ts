import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { TELEPHONY_DEFAULT_TTS_TIMEOUT_MS } from "./telephony-tts.js";

const VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS = 30000;
const VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS = 5 * 60 * 1000;

type VoiceCallContinueOperation =
  | {
      operationId: string;
      status: "pending";
      callId: string;
      startedAtMs: number;
      pollTimeoutMs: number;
    }
  | {
      operationId: string;
      status: "completed";
      callId: string;
      startedAtMs: number;
      completedAtMs: number;
      pollTimeoutMs: number;
      result: { success: true; transcript?: string };
    }
  | {
      operationId: string;
      status: "failed";
      callId: string;
      startedAtMs: number;
      completedAtMs: number;
      pollTimeoutMs: number;
      error: string;
    };

type VoiceCallContinueOperationStartPayload = {
  operationId: string;
  status: "pending";
  pollTimeoutMs: number;
};

type VoiceCallContinueOperationResultPayload =
  | {
      operationId: string;
      status: "pending";
      pollTimeoutMs: number;
    }
  | {
      operationId: string;
      status: "completed";
      result: { success: true; transcript?: string };
    }
  | {
      operationId: string;
      status: "failed";
      error: string;
    };

type VoiceCallContinueOperationRequest = {
  rt: VoiceCallRuntime;
  callId: string;
  message: string;
};

/**
 * Creates a short-lived async operation store for gateway-driven continue-call requests.
 *
 * `start` returns an operation id immediately while the call continues in the
 * background; `read` returns pending state or consumes one terminal result.
 */
export function createVoiceCallContinueOperationStore(params: {
  /** Resolved voice-call config used as fallback for transcript and TTS polling windows. */
  config: VoiceCallConfig;
  /** Core config fallback for global TTS timeout defaults. */
  coreConfig: CoreConfig;
}) {
  const operations = new Map<string, VoiceCallContinueOperation>();

  const resolvePollTimeoutMs = (rt: VoiceCallRuntime): number => {
    // The client waits for both assistant transcript generation and TTS playback
    // preparation, plus a buffer for provider webhook latency.
    const ttsTimeoutMs =
      rt.config.tts?.timeoutMs ??
      params.config.tts?.timeoutMs ??
      params.coreConfig.messages?.tts?.timeoutMs ??
      TELEPHONY_DEFAULT_TTS_TIMEOUT_MS;
    return resolveTimerTimeoutMs(
      (rt.config.transcriptTimeoutMs ?? params.config.transcriptTimeoutMs) +
        ttsTimeoutMs +
        VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS,
      VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS,
    );
  };

  const scheduleCleanup = (operationId: string) => {
    // Completed operations are readable once, but still get a delayed cleanup in
    // case the caller disconnects before polling the terminal state.
    const timer = setTimeout(() => {
      operations.delete(operationId);
    }, VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS);
    timer.unref?.();
  };

  /** Starts an async continue-call operation and returns the poll token plus timeout budget. */
  const start = (
    request: VoiceCallContinueOperationRequest,
  ): VoiceCallContinueOperationStartPayload => {
    const operationId = randomUUID();
    const startedAtMs = Date.now();
    const pollTimeoutMs = resolvePollTimeoutMs(request.rt);
    operations.set(operationId, {
      operationId,
      status: "pending",
      callId: request.callId,
      startedAtMs,
      pollTimeoutMs,
    });

    void request.rt.manager
      .continueCall(request.callId, request.message)
      .then((result) => {
        const current = operations.get(operationId);
        // A poller may have consumed or cleanup may have removed the operation
        // before the async continue call resolves.
        if (!current || current.status !== "pending") {
          return;
        }
        if (!result.success) {
          operations.set(operationId, {
            operationId,
            status: "failed",
            callId: request.callId,
            startedAtMs,
            completedAtMs: Date.now(),
            pollTimeoutMs,
            error: result.error || "continue failed",
          });
          return;
        }
        operations.set(operationId, {
          operationId,
          status: "completed",
          callId: request.callId,
          startedAtMs,
          completedAtMs: Date.now(),
          pollTimeoutMs,
          result: { success: true, transcript: result.transcript },
        });
      })
      .catch((err: unknown) => {
        const current = operations.get(operationId);
        if (!current || current.status !== "pending") {
          return;
        }
        operations.set(operationId, {
          operationId,
          status: "failed",
          callId: request.callId,
          startedAtMs,
          completedAtMs: Date.now(),
          pollTimeoutMs,
          error: formatErrorMessage(err),
        });
      })
      .finally(() => {
        scheduleCleanup(operationId);
      });

    return { operationId, status: "pending", pollTimeoutMs };
  };

  /** Reads an operation state; completed/failed operations are removed after this call. */
  const read = (
    operationId: string,
  ):
    | { ok: true; payload: VoiceCallContinueOperationResultPayload }
    | { ok: false; error: string } => {
    const operation = operations.get(operationId);
    if (!operation) {
      return { ok: false, error: "operation not found" };
    }
    if (operation.status === "pending") {
      return {
        ok: true,
        payload: {
          operationId,
          status: "pending",
          pollTimeoutMs: operation.pollTimeoutMs,
        },
      };
    }
    if (operation.status === "failed") {
      // Terminal states are single-consume so repeated polls cannot replay stale
      // call results after the gateway has already returned them.
      operations.delete(operationId);
      return {
        ok: true,
        payload: {
          operationId,
          status: "failed",
          error: operation.error,
        },
      };
    }
    operations.delete(operationId);
    return {
      ok: true,
      payload: {
        operationId,
        status: "completed",
        result: operation.result,
      },
    };
  };

  return { start, read };
}
