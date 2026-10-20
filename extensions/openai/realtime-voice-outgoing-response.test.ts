import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
// mock-isolation: Outgoing-response ordering uses synthetic credentials, independent of host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  createNativeBridge,
  connectReadyBridge,
  parseSent,
  emitServerEvent,
  emitAssistantPlayback,
  emitCompletedToolCalls,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({
  ...mocks,
  buildOpenAIRealtimeVoiceProvider,
});

type Socket = Parameters<typeof parseSent>[0];
const responses = (socket: Socket, type = "response.create") =>
  parseSent(socket).filter((event) => event.type === type);
function playResponse(socket: Socket, responseId: string, itemId: string) {
  emitAssistantPlayback(socket, { responseId, itemId, audio: Buffer.alloc(320) });
}
function finishResponse(socket: Socket, id: string, status = "completed") {
  emitServerEvent(socket, { type: "response.done", response: { id, status, output: [] } });
}
async function interruptibleBridge(
  eventType: "session.update" | "response.create",
  options: Parameters<typeof createNativeBridge>[0] = {},
  onClearAudio?: (bridge: RealtimeVoiceBridge) => void,
) {
  let armed = false;
  const bridge = createNativeBridge({
    ...options,
    onClearAudio: () => onClearAudio?.(bridge),
    onEvent: (event) => {
      if (armed && event.direction === "client" && event.type === eventType) {
        armed = false;
        bridge.handleBargeIn?.({ force: true });
      }
    },
  });
  const socket = await connectReadyBridge(bridge);
  armed = true;
  return { bridge, socket };
}

describe("OpenAI realtime outgoing response ownership", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it.each(["manual", "standalone"])(
    "sends %s creation before its observer can cancel",
    async (mode) => {
      const onAudio = vi.fn();
      const { bridge, socket } = await interruptibleBridge("response.create", {
        autoRespondToAudio: false,
        onAudio,
        onToolCall: vi.fn(),
      });
      if (mode === "standalone") {
        emitCompletedToolCalls(socket);
      }
      bridge.sendUserMessage?.("First response.");
      expect(
        parseSent(socket)
          .filter((event) => event.type.startsWith("response."))
          .map((event) => event.type),
      ).toEqual(["response.create", "response.cancel"]);
      playResponse(socket, "cancelled", "discarded");
      expect(onAudio).not.toHaveBeenCalled();
      bridge.sendUserMessage?.("Follow-up response.");
      expect(responses(socket)).toHaveLength(1);
      finishResponse(socket, "cancelled", "cancelled");
      expect(responses(socket)).toHaveLength(2);
      playResponse(socket, "recovery", "heard");
      expect(onAudio).toHaveBeenCalledTimes(1);
      await bridge.close();
    },
  );

  it.each([false, true])(
    "cancels during VAD suppression and preserves replacement admission (clear requests replacement=%s)",
    async (replaceOnClear) => {
      const { bridge, socket } = await interruptibleBridge("session.update", {}, (activeBridge) => {
        if (replaceOnClear) {
          activeBridge.sendUserMessage?.("Replacement from the clear callback.");
        }
      });
      bridge.sendUserMessage?.("Cancelled before response creation.");
      expect(responses(socket, "response.cancel")).toEqual([]);
      expect(responses(socket)).toHaveLength(replaceOnClear ? 1 : 0);
      if (replaceOnClear) {
        bridge.sendUserMessage?.("Queued behind the replacement.");
        expect(responses(socket)).toHaveLength(1);
        finishResponse(socket, "replacement");
        expect(responses(socket)).toHaveLength(2);
      } else {
        expect(
          parseSent(socket).at(-1)?.session?.audio?.input?.turn_detection?.create_response,
        ).toBe(true);
        bridge.sendUserMessage?.("Follow-up without a native terminal for the unsent response.");
        expect(responses(socket)).toHaveLength(1);
      }
      await bridge.close();
    },
  );
  it("finishes history truncation and sink clearing before a truncate observer's replacement response", async () => {
    const trace: string[] = [];
    const bridge = createNativeBridge({
      autoRespondToAudio: false,
      getPlaybackState: () => [{ itemId: "completed-a", audioEndMs: 500 }],
      onClearAudio: () => trace.push("sink.clear"),
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "conversation.item.truncate") {
          bridge.sendUserMessage?.("Replacement B.");
        }
      },
    });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "a" } });
    finishResponse(socket, "a");
    vi.spyOn(socket, "send").mockImplementation((payload: string) => {
      socket.sent.push(payload);
      const event = JSON.parse(payload) as { type: string };
      if (event.type !== "conversation.item.create") {
        trace.push(event.type);
      }
    });
    bridge.handleBargeIn?.({ force: true });
    expect(trace).toEqual(["conversation.item.truncate", "sink.clear", "response.create"]);
    await bridge.close();
  });
  it("does not drain a replacement when preparing-response cleanup throws", async () => {
    const { bridge, socket } = await interruptibleBridge("session.update", {}, (activeBridge) => {
      activeBridge.sendUserMessage?.("Queued replacement.");
      throw new Error("sink clear failed");
    });
    expect(() => bridge.sendUserMessage?.("Cancelled preparation.")).toThrow("sink clear failed");
    expect(parseSent(socket).filter((event) => event.type.startsWith("response."))).toEqual([]);
    bridge.sendUserMessage?.("Explicit follow-up after the failed clear.");
    expect(responses(socket)).toHaveLength(1);
    await bridge.close();
  });
});
