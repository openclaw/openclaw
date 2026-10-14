import type { RealtimeTranscriptionSessionCreateRequest } from "openclaw/plugin-sdk/realtime-transcription-session";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

type EventSocket = { emit(event: string, ...args: unknown[]): void };

export function emitJson(socket: EventSocket, event: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(event)));
}

export function emitCommitted(
  socket: EventSocket,
  itemId: string | undefined,
  previousItemId: string | null,
): void {
  emitJson(socket, {
    type: "input_audio_buffer.committed",
    item_id: itemId,
    previous_item_id: previousItemId,
  });
}

export function emitDelta(socket: EventSocket, itemId: string, delta: string): void {
  emitJson(socket, {
    type: "conversation.item.input_audio_transcription.delta",
    item_id: itemId,
    delta,
  });
}

export function emitCompleted(socket: EventSocket, itemId: string, transcript: string): void {
  emitJson(socket, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

export function emitFailed(socket: EventSocket, itemId: string, message: string): void {
  emitJson(socket, {
    type: "conversation.item.input_audio_transcription.failed",
    item_id: itemId,
    error: { message },
  });
}

export function createTranscriptionSession(
  options: Omit<RealtimeTranscriptionSessionCreateRequest, "providerConfig">,
) {
  return buildOpenAIRealtimeTranscriptionProvider().createSession({
    providerConfig: { apiKey: "sk-test" },
    ...options,
  });
}
