import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, expect, it, vi } from "vitest";
import { createLazyGoogleRealtimeVoiceProvider } from "./realtime-voice-lazy.js";
import { createMockRealtimeBridge } from "./realtime-voice-lazy.test-helpers.js";

const { createRealtimeBridgeMock } = vi.hoisted(() => ({
  createRealtimeBridgeMock: vi.fn<(req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge>(),
}));
vi.mock("./realtime-voice-provider.js", () => ({
  buildGoogleRealtimeVoiceProvider: () => ({ createBridge: createRealtimeBridgeMock }),
}));
beforeEach(() => createRealtimeBridgeMock.mockReset());

it("fences all nonterminal callbacks from a closed Google provider generation", async () => {
  const first = createMockRealtimeBridge();
  const replacement = createMockRealtimeBridge();
  createRealtimeBridgeMock
    .mockReturnValueOnce(first.bridge)
    .mockReturnValueOnce(replacement.bridge);
  const callbacks = {
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onMark: vi.fn(),
    onEvent: vi.fn(),
    onResponseDone: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    getPlaybackState: vi.fn(() => [{ itemId: "current", audioEndMs: 320 }]),
  };
  const bridge = createLazyGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: {},
    ...callbacks,
  });
  const deliver = (request: RealtimeVoiceBridgeCreateRequest | undefined) => {
    request?.onAudio(Buffer.from([0x01]));
    request?.onClearAudio("barge-in");
    request?.onMark?.("mark");
    request?.onEvent?.({ direction: "server", type: "test-event" });
    request?.onResponseDone?.({ status: "completed" });
    request?.onToolCall?.({ itemId: "item", callId: "call", name: "probe", args: {} });
    request?.onError?.(new Error("provider error"));
    return request?.getPlaybackState?.();
  };
  await bridge.connect();
  const firstRequest = createRealtimeBridgeMock.mock.calls[0]?.[0];
  void bridge.close();
  for (const reconnect of [false, true]) {
    if (reconnect) {
      await bridge.connect();
    }
    expect(deliver(firstRequest)).toEqual([]);
    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled();
    }
  }
  expect(deliver(createRealtimeBridgeMock.mock.calls[1]?.[0])).toEqual([
    { itemId: "current", audioEndMs: 320 },
  ]);
  for (const callback of Object.values(callbacks)) {
    expect(callback).toHaveBeenCalledOnce();
  }
  await bridge.close();
});

it("keeps close synchronous before any provider load", () => {
  const bridge = createLazyGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: {},
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  expect(bridge.close()).toBeUndefined();
  expect(createRealtimeBridgeMock).not.toHaveBeenCalled();
});
