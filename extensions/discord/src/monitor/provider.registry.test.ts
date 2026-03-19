import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseConfig,
  baseRuntime,
  getProviderMonitorTestMocks,
  resetDiscordProviderMonitorMocks,
} from "../../../../test/helpers/extensions/discord-provider.test-support.js";

const {
  createDiscordNativeCommandMock,
  clientHandleDeployRequestMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
} = getProviderMonitorTestMocks();

describe("monitorDiscordProvider real plugin registry", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetDiscordProviderMonitorMocks({
      nativeCommands: [{ name: "status", description: "Status", acceptsArgs: false }],
    });
    vi.doMock("../accounts.js", () => ({
      resolveDiscordAccount: (...args: Parameters<typeof resolveDiscordAccountMock>) =>
        resolveDiscordAccountMock(...args),
    }));
    vi.doMock("../probe.js", () => ({
      fetchDiscordApplicationId: async () => "app-1",
    }));
    vi.doMock("../token.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../token.js")>();
      return {
        ...actual,
        normalizeDiscordToken: (value?: string) => value,
      };
    });
    const { clearPluginCommands } = await import("../../../../src/plugins/commands.js");
    clearPluginCommands();
  });

  it("registers plugin commands from the real registry as native Discord commands", async () => {
    const { registerPluginCommand } = await import("../../../../src/plugins/commands.js");
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
