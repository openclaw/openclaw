import { vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import type { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { fakeQuicksilverSocketFactories } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

export type GatewayConfig = ConstructorParameters<typeof OpenAIQuicksilverGatewayBridge>[0];

export function createGatewayHarness({
  socketFactory = () => new FakeSocket(),
  startSession,
  onSend,
  ...config
}: Partial<GatewayConfig> & {
  socketFactory?: () => FakeSocket;
  startSession?: { expires_at?: number };
  onSend?: (event: { type?: string; audio?: string }) => void;
} = {}) {
  let socket: FakeSocket | undefined;
  const onError = vi.fn(),
    onClose = vi.fn();
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      resolveAuth: async () => ({ type: "api-key", token: "fixture-key" }),
      runAgentConsult: async () => ({ text: "done" }),
      onError,
      onClose,
      logger,
      ...fakeQuicksilverSocketFactories(() => {
        const wire = (socket = socketFactory());
        const send = wire.send.bind(wire);
        wire.send = (payload) => {
          send(payload);
          const event = JSON.parse(payload) as { type?: string; audio?: string };
          if (startSession && event.type === "session.update") {
            queueMicrotask(() =>
              emitSideband(wire, { type: "session.started", session: startSession }),
            );
          } else {
            onSend?.(event);
          }
        };
        return wire;
      }),
      ...config,
    },
    openAIRealtimeHost,
  );
  return {
    bridge,
    onError,
    onClose,
    logger,
    getSocket: () => {
      if (!socket) {
        throw new Error("expected sideband socket");
      }
      return socket;
    },
  };
}

export function createAudioPeer(onAudio: (audio: Buffer) => void = vi.fn()) {
  return {
    createOffer: async () => "v=offer\r\n",
    applyAnswer: async () => {},
    adoptPendingAudio: (pending: OpenAIQuicksilverPendingAudio) => onAudio(pending.take()),
    sendAudio: onAudio,
    close: vi.fn(),
  };
}
