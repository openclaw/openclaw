import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_END_CALL_TOOL_NAME } from "../realtime-call-control.js";

const END_CALL_PLAYBACK_TIMEOUT_MS = 2_000;

export type RealtimeEndCallDrainResult = "played" | "interrupted" | "timed-out";
type RealtimeEndCallDrain = {
  completion: Promise<RealtimeEndCallDrainResult>;
  markName: string;
  resolve: (result: RealtimeEndCallDrainResult) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export function createRealtimeEndCallDrain(params: {
  getEstimatedCarrierBufferedMs: () => number;
  pendingMarkAcks: Map<string, () => void>;
  sendMark: (name: string, onSent: (sent: boolean) => void) => void;
}) {
  let outputFenced = false;
  let current: RealtimeEndCallDrain | undefined;
  const settle = (drain: RealtimeEndCallDrain, result: RealtimeEndCallDrainResult): void => {
    if (current !== drain) {
      return;
    }
    if (drain.timer) {
      clearTimeout(drain.timer);
      drain.timer = undefined;
    }
    params.pendingMarkAcks.delete(drain.markName);
    drain.resolve(result);
  };
  return {
    isOutputFenced: () => outputFenced,
    onPlaybackReset: () => {
      if (current) {
        settle(current, "interrupted");
      }
    },
    drainPlaybackBeforeEndCall: (): Promise<RealtimeEndCallDrainResult> => {
      if (current) {
        return current.completion;
      }
      outputFenced = true;
      const markName = `openclaw-end-call-${randomUUID()}`;
      let resolve!: (result: RealtimeEndCallDrainResult) => void;
      const completion = new Promise<RealtimeEndCallDrainResult>((settleResult) => {
        resolve = settleResult;
      });
      const drain: RealtimeEndCallDrain = { completion, markName, resolve };
      current = drain;
      params.sendMark(markName, (sent) => {
        if (current !== drain) {
          return;
        }
        if (!sent) {
          settle(drain, "interrupted");
          return;
        }
        params.pendingMarkAcks.set(markName, () => settle(drain, "played"));
        // A late pacer tick can send overdue audio in a burst. Allow that estimated
        // carrier buffer to play before the missing-acknowledgment grace period.
        const timeoutMs = params.getEstimatedCarrierBufferedMs() + END_CALL_PLAYBACK_TIMEOUT_MS;
        drain.timer = setTimeout(() => settle(drain, "timed-out"), timeoutMs);
        drain.timer.unref?.();
      });
      return completion;
    },
    resumeAfterEndCallDrain: () => {
      outputFenced = false;
      current = undefined;
    },
  };
}

export type RealtimeEndCallBinding = {
  bridge: RealtimeVoiceBridgeSession;
  drainPlaybackBeforeEndCall: () => Promise<RealtimeEndCallDrainResult>;
  endCall: () => void;
  resumeAfterEndCallDrain: () => void;
};

export async function executeRealtimeEndCallTool(params: {
  bridge: RealtimeVoiceBridgeSession;
  bridgeCallId: string;
  callId: string;
  endCall: (callId: string) => Promise<{ success: boolean; error?: string }>;
  getActiveBinding: (callId: string) => RealtimeEndCallBinding | undefined;
  harness: RealtimeVoiceSessionHarness;
  isActiveBridgeOwner: (callId: string, bridge: RealtimeVoiceBridgeSession) => boolean;
  turnId: string;
}): Promise<void> {
  const binding = params.getActiveBinding(params.callId);
  if (
    !binding ||
    binding.bridge !== params.bridge ||
    !params.isActiveBridgeOwner(params.callId, params.bridge)
  ) {
    return;
  }

  const drainResult = await binding.drainPlaybackBeforeEndCall();
  if (
    params.getActiveBinding(params.callId) !== binding ||
    !params.isActiveBridgeOwner(params.callId, params.bridge)
  ) {
    return;
  }
  if (drainResult !== "played") {
    binding.resumeAfterEndCallDrain();
    if (drainResult === "timed-out") {
      console.warn(
        `[voice-call] realtime end-call playback mark timed out callId=${params.callId}`,
      );
    }
    const detail =
      drainResult === "timed-out"
        ? "Farewell playback could not be confirmed before the timeout. Keep the phone call connected and continue with the caller."
        : "The farewell was interrupted before playback completed. Keep the phone call connected and continue with the caller's latest request.";
    const toolResult = buildRealtimeVoiceAgentCancelProviderResult(detail);
    await params.bridge.submitToolResult(
      params.bridgeCallId,
      toolResult,
      drainResult === "interrupted" && params.bridge.bridge.supportsToolResultSuppression !== false
        ? { suppressResponse: true }
        : undefined,
    );
    params.harness.emit({
      type: "tool.result",
      turnId: params.turnId,
      callId: params.bridgeCallId,
      payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: toolResult },
      final: true,
    });
    return;
  }

  let result: { success: boolean; error?: string };
  try {
    result = await params.endCall(params.callId);
  } catch (error) {
    result = { success: false, error: formatErrorMessage(error) };
  }

  if (
    params.getActiveBinding(params.callId) !== binding ||
    !params.isActiveBridgeOwner(params.callId, params.bridge)
  ) {
    return;
  }
  if (!result.success) {
    binding.resumeAfterEndCallDrain();
    const detail = result.error?.trim() || "the telephony provider returned no reason";
    const toolResult = {
      error: `Could not end the current phone call: ${detail}. Tell the caller the call could not be ended and they can hang up or ask you to try again.`,
    };
    await params.bridge.submitToolResult(params.bridgeCallId, toolResult);
    params.harness.emit({
      type: "tool.error",
      turnId: params.turnId,
      callId: params.bridgeCallId,
      payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: toolResult },
      final: true,
    });
    return;
  }

  params.harness.emit({
    type: "tool.result",
    turnId: params.turnId,
    callId: params.bridgeCallId,
    payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: { success: true } },
    final: true,
  });
  binding.endCall();
}
