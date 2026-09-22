import type { RealtimeVoiceBridgeEvent } from "openclaw/plugin-sdk/realtime-voice";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DISCORD_VOICE_LOG_PREVIEW_CHARS = 500;

export function formatVoiceLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= DISCORD_VOICE_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${truncateUtf16Safe(oneLine, DISCORD_VOICE_LOG_PREVIEW_CHARS)}...`;
}

const DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS = new Set([
  "conversation.output_audio.delta",
  "input_audio_buffer.append",
  "response.audio.delta",
  "response.output_audio.delta",
]);

export function formatRealtimeInterruptionLog(event: RealtimeVoiceBridgeEvent): string | undefined {
  const detail = event.detail ? ` ${event.detail}` : "";
  if (event.direction === "client") {
    if (event.type === "response.cancel") {
      return `discord voice: realtime model interrupt requested ${event.direction}:${event.type}${detail}`;
    }
    if (event.type === "conversation.item.truncate.skipped") {
      return `discord voice: realtime model interrupt ignored ${event.direction}:${event.type}${detail}`;
    }
    if (event.type === "conversation.item.truncate") {
      return `discord voice: realtime model audio truncated ${event.direction}:${event.type}${detail}`;
    }
  }
  if (event.direction === "server") {
    if (event.type === "response.cancelled") {
      return `discord voice: realtime model interrupt confirmed ${event.direction}:${event.type}${detail}`;
    }
    if (
      event.type === "error" &&
      event.detail === "Cancellation failed: no active response found"
    ) {
      return `discord voice: realtime model interrupt raced ${event.direction}:${event.type}${detail}`;
    }
  }
  return undefined;
}

export function formatRealtimeLifecycleLog(event: RealtimeVoiceBridgeEvent): string | undefined {
  if (!event.type.startsWith("session.")) {
    return undefined;
  }
  const detail = event.detail ? ` ${event.detail}` : "";
  return `discord voice: realtime lifecycle ${event.direction}:${event.type}${detail}`;
}

export function shouldLogRealtimeVerboseEvent(event: RealtimeVoiceBridgeEvent): boolean {
  return !DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS.has(event.type);
}
