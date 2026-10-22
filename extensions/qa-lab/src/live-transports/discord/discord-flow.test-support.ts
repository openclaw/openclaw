import { vi } from "vitest";
import type { createDiscordQaTransportAdapter } from "./adapter.runtime.js";

type Adapter = Awaited<ReturnType<typeof createDiscordQaTransportAdapter>>;
type FlowInput = Parameters<NonNullable<Adapter["prepareFlow"]>>[0];

export const runtimeEnv = {
  guildId: "123456789012345678",
  channelId: "223456789012345678",
  driverBotToken: "driver-token",
  sutBotToken: "sut-token",
  sutApplicationId: "323456789012345678",
};

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
