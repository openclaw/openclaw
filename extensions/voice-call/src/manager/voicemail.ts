import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildCallVoicemailSpeechInstructions,
  resolveCallVoicemailMessage,
} from "../call-brief.js";
import { TerminalStates, type CallRecord } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { updateCall } from "./mutations.js";
import { endCall } from "./outbound.js";
import { addTranscriptEntry } from "./state.js";

type DetectedPlaybackContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "storePath"
  | "stateRuntime"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "notifyHangupTimers"
  | "endCallOperations"
  | "mutationQueue"
  | "isStopping"
  | "beforeCarrierPlayback"
  | "playRealtimeVoicemail"
  | "onCallUpdated"
  | "beforeCallEnd"
>;

/** Realtime speech owns voicemail when connected; carrier Say/Hangup is the fallback. */
export async function playDetectedCallMessage(
  ctx: DetectedPlaybackContext,
  call: CallRecord,
  kind: "voicemail" | "notify",
): Promise<void> {
  const current = () =>
    ctx.activeCalls.get(call.callId) === call &&
    !TerminalStates.has(call.state) &&
    !ctx.isStopping();
  if (!current()) {
    return;
  }
  const statusKey = kind === "voicemail" ? "voicemailStatus" : "notifyStatus";
  const errorKey = kind === "voicemail" ? "voicemailError" : "notifyError";
  const message =
    kind === "voicemail" ? resolveCallVoicemailMessage(call) : call.metadata?.initialMessage;
  try {
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("Call message is unavailable");
    }
    if (
      !(await updateCall(ctx, call, (next) => {
        next.metadata = { ...next.metadata, [statusKey]: "playing" };
        delete next.metadata.initialMessage;
        addTranscriptEntry(next, "bot", message);
      })) ||
      !current()
    ) {
      return;
    }
    const realtimePlayback =
      kind === "voicemail"
        ? ctx.playRealtimeVoicemail?.(call.callId, buildCallVoicemailSpeechInstructions(call))
        : undefined;
    if (realtimePlayback) {
      await realtimePlayback;
      if (!current()) {
        return;
      }
      const ended = await endCall(ctx, call.callId, { reason: "voicemail" });
      if (!ended.success) {
        throw new Error(ended.error ?? "Voicemail hangup failed");
      }
      return;
    }
    await ctx.beforeCarrierPlayback?.(call.callId);
    if (!current()) {
      return;
    }
    if (!ctx.provider?.playMessageAndHangup || !call.providerCallId) {
      throw new Error("Carrier message playback is unavailable");
    }
    await ctx.provider.playMessageAndHangup({
      callId: call.callId,
      providerCallId: call.providerCallId,
      text: message,
    });
  } catch (error) {
    if (current()) {
      await updateCall(ctx, call, (next) => {
        next.metadata = {
          ...next.metadata,
          [statusKey]: "failed",
          [errorKey]: formatErrorMessage(error),
        };
      });
      if (current()) {
        await endCall(ctx, call.callId, { reason: "error" });
      }
    }
  }
}
