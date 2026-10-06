import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket, isProviderAuthProfileConfiguredMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

// mock-isolation: Drive native provider events with test-owned sockets, never a network connection.
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));
// mock-isolation: Keep process-wide credential profile state outside transcript fixtures.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));
// mock-isolation: Resolve only fixture credentials without reading real credential stores.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  createTestBridge,
  type FakeWebSocketInstance,
  type TestBridgeOptions,
  openRealtimeBridge,
  parseSent,
} from "./realtime-voice-provider.test-support.js";

const bridges: ReturnType<typeof createTestBridge>[] = [];
async function connect(options: Partial<TestBridgeOptions> = {}) {
  const bridge = createTestBridge(options);
  bridges.push(bridge);
  const socket = await openRealtimeBridge(bridge, FakeWebSocket.instances.length);
  return { bridge, socket };
}

function responseDone(socket: FakeWebSocketInstance, id?: string, status = "completed") {
  socket.emitServer({ type: "response.done", response: { id, status } });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  isProviderAuthProfileConfiguredMock.mockReset();
  isProviderAuthProfileConfiguredMock.mockReturnValue(false);
  resolveApiKeyForProviderMock.mockReset();
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    await bridge.close();
  }
});

describe("xAI realtime assistant transcripts", () => {
  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const { socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created" });
    socket.emitServer({ type: "response.text.delta", delta: "draft assistant" });
    socket.emitServer({ type: "response.text.done", text: "corrected assistant" });
    socket.emitServer({ type: "response.done" });
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it.each([
    ["response.text.delta", "response.text.done"],
    ["response.output_text.delta", "response.output_text.done"],
    ["response.output_audio_transcript.delta", "response.output_audio_transcript.done"],
  ])(
    "carries native response identity through %s even during cancellation",
    async (deltaType, doneType) => {
      const onTranscript = vi.fn();
      const { bridge, socket } = await connect({ onTranscript });
      socket.emitServer({ type: "response.created", response: { id: "cancelled" } });
      bridge.handleBargeIn?.({ force: true });
      socket.emitServer({ type: deltaType, response_id: "cancelled", delta: "Partial" });
      socket.emitServer({ type: doneType, response_id: "cancelled", text: "Final" });
      responseDone(socket, "cancelled", "cancelled");
      socket.emitServer({ type: "response.created", response: { id: "fresh" } });
      socket.emitServer({ type: deltaType, response_id: "fresh", delta: "Fresh partial" });
      socket.emitServer({ type: doneType, response_id: "fresh", transcript: "Fresh final" });
      responseDone(socket, "fresh");
      expect(onTranscript.mock.calls).toEqual([
        ["assistant", "Partial", false, undefined, "cancelled"],
        ["assistant", "Final", true, undefined, "cancelled"],
        ["assistant", "Fresh partial", false, undefined, "fresh"],
        ["assistant", "Fresh final", true, undefined, "fresh"],
      ]);
    },
  );

  it("continues after malformed terminal items and content beside valid text", async () => {
    const onTranscript = vi.fn();
    const { bridge, socket } = await connect({ onTranscript });
    socket.emitServer({ type: "response.created", response: { id: "terminal-only" } });
    bridge.sendUserMessage?.("Continue.");
    socket.emitServer({
      type: "response.done",
      response: {
        id: "terminal-only",
        status: "completed",
        output: [
          null,
          {
            type: "message",
            role: "assistant",
            content: [
              null,
              { type: "output_text", text: "Valid text " },
              { type: "output_audio", transcript: "and audio" },
            ],
          },
        ],
      },
    });
    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue." }],
        },
      },
      { type: "response.create" },
    ]);
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "Valid text and audio", true, undefined, "terminal-only"],
    ]);
  });
});
