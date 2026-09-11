import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";

export function createMockRealtimeBridge(connectImpl: () => Promise<void> = async () => {}) {
  const connect = vi.fn(connectImpl);
  const sendAudio = vi.fn();
  const sendUserMessage = vi.fn();
  const triggerGreeting = vi.fn();
  const close = vi.fn();
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
