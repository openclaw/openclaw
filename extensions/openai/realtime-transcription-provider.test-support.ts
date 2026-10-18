import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionSessionCreateRequest } from "openclaw/plugin-sdk/realtime-transcription-session";
import { vi } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import type { createTranscriptionMockWebSocket } from "./realtime-transcription-socket.test-support.js";

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

export function createTranscriptionSocketHarness(
  FakeWebSocket: ReturnType<typeof createTranscriptionMockWebSocket>,
) {
  type Socket = InstanceType<typeof FakeWebSocket>;
  const sessions = new Set<{ close(): void }>();

  async function waitForFakeSocket(session: { close(): void }, index = 0): Promise<Socket> {
    sessions.add(session);
    await vi.dynamicImportSettled();
    const existing = FakeWebSocket.instances[index];
    if (existing) {
      return existing;
    }
    const created = createDeferred<Socket>();
    FakeWebSocket.onCreated = (socket) => {
      if (FakeWebSocket.instances[index] === socket) {
        created.resolve(socket);
      }
    };
    try {
      return await vi.waitFor(() => created.promise);
    } finally {
      FakeWebSocket.onCreated = undefined;
    }
  }

  return {
    waitForFakeSocket,
    connectFakeSession: async (
      session: { connect(): Promise<void>; close(): void },
      index = 0,
    ): Promise<Socket> => {
      const connecting = session.connect();
      const socket = await waitForFakeSocket(session, index);
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      emitJson(socket, { type: "session.updated" });
      await connecting;
      return socket;
    },
    close() {
      // Close session ownership before its fake peers so cleanup cannot start a reconnect.
      for (const session of sessions) {
        session.close();
      }
      for (const socket of FakeWebSocket.instances) {
        socket.close();
      }
      sessions.clear();
    },
  };
}
