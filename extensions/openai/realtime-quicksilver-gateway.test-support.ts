import { vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";

type GatewayConfig = ConstructorParameters<typeof OpenAIQuicksilverGatewayBridge>[0];

export function createGatewayBridge(overrides: Partial<GatewayConfig> = {}) {
  return new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      resolveAuth: async () => ({ type: "api-key", token: "fixture-key" }),
      runAgentConsult: async () => ({ text: "done" }),
      logger: { debug: vi.fn(), warn: vi.fn() },
      ...overrides,
    },
    openAIRealtimeHost,
  );
}
