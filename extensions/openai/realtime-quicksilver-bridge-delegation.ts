import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { buildOpenAIQuicksilverDelegationPrompt } from "./realtime-quicksilver-instructions.js";
import type { OpenAIQuicksilverTranscript } from "./realtime-quicksilver-transcript.js";
import { isOpenAIGptLiveApiModel } from "./realtime-quicksilver.js";

/** Admits one direct-bridge delegation before consuming its transcript or invoking host tools. */
export function dispatchOpenAIQuicksilverBridgeDelegation(params: {
  id: string;
  input: string;
  prompt?: string;
  model: string;
  callbacks: Pick<
    RealtimeVoiceBridgeCreateRequest,
    "handleDelegationInput" | "onTranscript" | "onEvent" | "onToolCall"
  >;
  transcript: OpenAIQuicksilverTranscript;
  activeDelegations: Set<string>;
  isActive: () => boolean;
  isCurrent: () => boolean;
  sendReply: (message: string) => void;
  onError: (error: Error) => void;
}): void {
  const { id, input, callbacks } = params;
  if (!params.isActive()) {
    return;
  }
  if (!input.trim()) {
    params.sendReply("Ask the user to repeat their request; no user transcript was received.");
    return;
  }
  const handleInput = callbacks.handleDelegationInput;
  if (handleInput) {
    let responded = false;
    try {
      const admission = handleInput(input, (message) => {
        if (!responded && params.isActive()) {
          responded = true;
          params.sendReply(message);
        }
      });
      if (admission === "control") {
        params.transcript.clearPendingUserInput();
        return;
      }
    } catch {
      params.onError(new Error("GPT-Live control admission failed"));
      return;
    }
  }
  if (!params.isActive()) {
    return;
  }
  const snapshot = params.transcript.consume();
  params.transcript.publish(snapshot.publication, {
    onTranscript: callbacks.onTranscript,
    isCurrent: params.isCurrent,
  });
  if (!params.isActive()) {
    return;
  }
  params.activeDelegations.add(id);
  callbacks.onEvent?.({
    direction: "server",
    type: isOpenAIGptLiveApiModel(params.model)
      ? "session.delegation.created"
      : "delegation.created",
    itemId: id,
  });
  if (!params.isActive()) {
    return;
  }
  callbacks.onToolCall?.({
    itemId: id,
    callId: id,
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: {
      question:
        params.prompt ??
        buildOpenAIQuicksilverDelegationPrompt({ input, transcript: snapshot.context }),
    },
  });
}
