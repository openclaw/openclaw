import type { RealtimeVoiceBridgeEvent } from "openclaw/plugin-sdk/realtime-voice";

const DISCORD_REALTIME_INTERRUPTION_MESSAGES = new Map([
  ["client:response.cancel", "interrupt requested"],
  ["client:conversation.item.truncate.skipped", "interrupt ignored"],
  ["client:conversation.item.truncate", "audio truncated"],
  ["server:response.cancelled", "interrupt confirmed"],
]);

export function formatRealtimeInfoLog(event: RealtimeVoiceBridgeEvent): string | undefined {
  const eventKey = `${event.direction}:${event.type}`;
  const message =
    eventKey === "server:error" && event.detail === "Cancellation failed: no active response found"
      ? "interrupt raced"
      : DISCORD_REALTIME_INTERRUPTION_MESSAGES.get(eventKey);
  if (message) {
    return `discord voice: realtime model ${message} ${eventKey}${event.detail ? ` ${event.detail}` : ""}`;
  }
  if (
    !event.type.startsWith("session.") ||
    event.type.startsWith("session.output_audio") ||
    event.type.endsWith(".delta") ||
    event.type.endsWith(".append")
  ) {
    return undefined;
  }
  const detail = event.detail ? ` ${event.detail}` : "";
  return `discord voice: realtime lifecycle ${event.direction}:${event.type}${detail}`;
}
