import type { RealtimeVoiceUsageReport } from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RealtimeEvent } from "./realtime-voice-session-policy.js";

function readTokenCount(record: unknown, key: string): number {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Reads `response.usage` from an OpenAI realtime `response.done` event. */
export function readOpenAIRealtimeUsage(
  response: RealtimeEvent["response"],
): Pick<RealtimeVoiceUsageReport, "input" | "cachedInput" | "output"> | undefined {
  const usage = response?.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  const inputDetails = usage.input_token_details;
  const cachedDetails = isRecord(inputDetails) ? inputDetails.cached_tokens_details : undefined;
  const audioIn = readTokenCount(inputDetails, "audio_tokens");
  const imageIn = readTokenCount(inputDetails, "image_tokens");
  const cachedAudio = readTokenCount(cachedDetails, "audio_tokens");
  const cachedImage = readTokenCount(cachedDetails, "image_tokens");
  const audioOut = readTokenCount(usage.output_token_details, "audio_tokens");
  const inputTokens = readTokenCount(usage, "input_tokens");
  const cachedTokens = readTokenCount(inputDetails, "cached_tokens");
  const outputTokens = readTokenCount(usage, "output_tokens");
  // Text takes the remainder, so totals still add up when a modality split is missing.
  return {
    input: { text: Math.max(0, inputTokens - audioIn - imageIn), audio: audioIn, image: imageIn },
    cachedInput: {
      text: Math.max(0, cachedTokens - cachedAudio - cachedImage),
      audio: cachedAudio,
      image: cachedImage,
    },
    output: { text: Math.max(0, outputTokens - audioOut), audio: audioOut },
  };
}
