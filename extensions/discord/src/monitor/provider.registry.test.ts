import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginCommands, registerPluginCommand } from "../../../../src/plugins/commands.js";
import {
  baseConfig,
  baseRuntime,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "./provider.test-support.js";

const { createDiscordNativeCommandMock, clientHandleDeployRequestMock, monitorLifecycleMock } =
  getProviderMonitorTestMocks();

describe("monitorDiscordProvider real plugin registry", () => {
  beforeEach(() => {
    clearPluginCommands();
    resetDiscordProviderMonitorMocks({
      nativeCommands: [{ name: "status", description: "Status", acceptsArgs: false }],
    });
  });

  it("registers plugin commands from the real registry as native Discord commands", async () => {
    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    const { monitorDiscordProvider } = await import("./provider.js");

    await monitorDiscordProvider({
      config: baseConfig(),
      runtime: baseRuntime(),
    });

    const commandNames = (createDiscordNativeCommandMock.mock.calls as Array<unknown[]>)
      .map((call) => (call[0] as { command?: { name?: string } } | undefined)?.command?.name)
      .filter((value): value is string => typeof value === "string");

    expect(commandNames).toContain("status");
    expect(commandNames).toContain("pair");
    expect(clientHandleDeployRequestMock).toHaveBeenCalledTimes(1);
    expect(monitorLifecycleMock).toHaveBeenCalledTimes(1);
  });
});
