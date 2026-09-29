import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";

type MockRealtimeBridge = {
  bridge: RealtimeVoiceBridge;
  connect: Mock<RealtimeVoiceBridge["connect"]>;
  sendAudio: Mock<RealtimeVoiceBridge["sendAudio"]>;
  sendUserMessage: Mock<NonNullable<RealtimeVoiceBridge["sendUserMessage"]>>;
  triggerGreeting: Mock<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>;
  close: Mock<RealtimeVoiceBridge["close"]>;
};

export function createMockRealtimeBridge(
  connectImpl: RealtimeVoiceBridge["connect"] = async () => {},
): MockRealtimeBridge {
  const connect = vi.fn<RealtimeVoiceBridge["connect"]>(connectImpl);
  const sendAudio = vi.fn<RealtimeVoiceBridge["sendAudio"]>();
  const sendUserMessage = vi.fn<NonNullable<RealtimeVoiceBridge["sendUserMessage"]>>();
  const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
  const close = vi.fn<RealtimeVoiceBridge["close"]>();
  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: false,
    supportsToolResultSuppression: false,
    connect,
    sendAudio,
    setMediaTimestamp: vi.fn(),
    sendUserMessage,
    triggerGreeting,
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close,
    isConnected: vi.fn(() => false),
  };
  return { bridge, close, connect, sendAudio, sendUserMessage, triggerGreeting };
}
