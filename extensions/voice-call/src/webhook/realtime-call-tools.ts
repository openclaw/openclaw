import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_END_CALL_TOOL_NAME,
  REALTIME_VOICE_STAY_SILENT_TOOL_NAME,
} from "../realtime-call-control.js";

/** One invocation of a built-in call-control tool on the bridge that owns the call. */
type BuiltInToolCall = {
  bridge: RealtimeVoiceBridgeSession;
  bridgeCallId: string;
  turnId: string;
  harness: RealtimeVoiceSessionHarness;
};

/** Hangs up for the end-call tool, or tells the model the call could not be ended. */
export async function runEndCallTool(
  call: BuiltInToolCall & {
    /** Whether the bridge still owns the call; a replaced bridge reports nothing. */
    ownsCall: () => boolean;
    endCall: () => Promise<{ success: boolean; error?: string }>;
    /** Closes the provider session and the carrier stream after a successful hangup. */
    closeStream: () => void;
  },
): Promise<void> {
  let result: { success: boolean; error?: string };
  try {
    result = await call.endCall();
  } catch (error) {
    result = { success: false, error: formatErrorMessage(error) };
  }
  if (!call.ownsCall()) {
    return;
  }
  if (!result.success) {
    const detail = result.error?.trim() || "the telephony provider returned no reason";
    const toolResult = {
      error: `Could not end the current phone call: ${detail}. Tell the caller the call could not be ended and they can hang up or ask you to try again.`,
    };
    await call.bridge.submitToolResult(call.bridgeCallId, toolResult);
    call.harness.emit({
      type: "tool.error",
      turnId: call.turnId,
      callId: call.bridgeCallId,
      payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: toolResult },
      final: true,
    });
    return;
  }
  call.harness.emit({
    type: "tool.result",
    turnId: call.turnId,
    callId: call.bridgeCallId,
    payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: { success: true } },
    final: true,
  });
  call.closeStream();
}

/** The model heard speech that was not meant for it: answer with silence and keep listening. */
export async function passOverBackgroundSpeech(
  call: BuiltInToolCall & { callId: string },
): Promise<void> {
  console.log(`[voice-call] Realtime background passed over callId=${call.callId}`);
  const result = { ok: true };
  // Silence is the whole point: this result must not start a reply.
  await call.bridge.submitToolResult(call.bridgeCallId, result, { suppressResponse: true });
  call.harness.emit({
    type: "tool.result",
    turnId: call.turnId,
    callId: call.bridgeCallId,
    payload: { name: REALTIME_VOICE_STAY_SILENT_TOOL_NAME, result },
    final: true,
  });
}
