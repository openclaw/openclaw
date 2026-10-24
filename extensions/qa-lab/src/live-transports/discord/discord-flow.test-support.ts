import { vi } from "vitest";
import type { createDiscordQaTransportAdapter } from "./adapter.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

type Adapter = Awaited<ReturnType<typeof createDiscordQaTransportAdapter>>;
type FlowInput = Parameters<NonNullable<Adapter["prepareFlow"]>>[0];

export const runtimeEnv = {
  guildId: "123456789012345678",
  channelId: "223456789012345678",
  driverBotToken: "driver-token",
  sutBotToken: "sut-token",
  sutApplicationId: "323456789012345678",
};

export function createScenarioEnvironment(
  overrides: Partial<DiscordQaScenarioEnvironment> = {},
): DiscordQaScenarioEnvironment {
  return {
    configureScenario: vi.fn<DiscordQaScenarioEnvironment["configureScenario"]>(),
    driverIdentity: { id: "423456789012345678", bot: true },
    outputDir: "/unused",
    runtimeEnv,
    scenario: { id: "discord-canary", timeoutMs: 30_000, title: "Discord canary" },
    sutAccountId: "sut",
    sutIdentity: { id: runtimeEnv.sutApplicationId, bot: true },
    ...overrides,
  };
}

export function sentMessage(id: string, timestamp: string) {
  return { id, channel_id: runtimeEnv.channelId, timestamp };
}

export function polledReply(messageId: string, text: string, timestamp?: string) {
  return {
    afterSnowflake: messageId,
    message: {
      messageId,
      text,
      timestamp,
      channelId: runtimeEnv.channelId,
      senderId: runtimeEnv.sutApplicationId,
    },
  };
}

export function createFlowInput(
  outputDir = "/unused",
  call: FlowInput["gateway"]["call"] = vi.fn(),
): FlowInput {
  return {
    config: {},
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: outputDir,
      workspaceDir: outputDir,
      runtimeEnv: {},
      call,
    },
    outputDir,
    scenarioId: "discord-test",
    scenarioTitle: "Discord test",
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(async () => {}),
  };
}
