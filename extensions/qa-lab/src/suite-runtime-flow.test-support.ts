import { vi } from "vitest";
import type { runQaSuiteScenarioDefinition } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export const qaSuiteRuntimeFlowTestConstants = {
  imageUnderstandingPngBase64: "small",
  imageUnderstandingLargePngBase64: "large",
  imageUnderstandingValidPngBase64: "valid",
};

export function createQaSuiteRuntimeFlowTestEnv(
  transportOverrides: Partial<QaSuiteRuntimeEnv["transport"]> = {},
) {
  return {
    lab: { baseUrl: "http://127.0.0.1:4444" },
    webSessionIds: new Set<string>(),
    gateway: {} as QaSuiteRuntimeEnv["gateway"],
    transport: {
      id: "qa-channel",
      label: "QA Channel",
      accountId: "qa-channel",
      waitReady: vi.fn(),
      createGatewayConfig: vi.fn(),
      buildAgentDelivery: vi.fn(),
      requiredPluginIds: [],
      supportedActions: [],
      handleAction: vi.fn(),
      createReportNotes: vi.fn(),
      reset: vi.fn(),
      sendInbound: vi.fn(),
      sendNativeCommand: vi.fn(),
      waitForNoOutbound: vi.fn(),
      waitForOutbound: vi.fn(),
      waitForOutboundSequence: vi.fn(),
      state: {
        reset: vi.fn(),
        getSnapshot: vi.fn(),
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        readMessage: vi.fn(),
        searchMessages: vi.fn(),
        waitFor: vi.fn(),
      },
      waitForCondition: vi.fn(),
      ...transportOverrides,
    },
    outputDir: "/artifacts",
    repoRoot: "/repo",
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    mock: null,
    cfg: {},
  } satisfies Parameters<typeof runQaSuiteScenarioDefinition>[0]["env"];
}
