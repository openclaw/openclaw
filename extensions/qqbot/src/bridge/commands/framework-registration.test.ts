import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { CommandsPort } from "../../engine/adapter/commands.port.js";
import { initCommands } from "../../engine/commands/slash-commands-impl.js";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { registerQQBotFrameworkCommands } from "./framework-registration.js";

type RuntimeConfigApi = ReturnType<NonNullable<CommandsPort["approveRuntimeGetter"]>>["config"];
type ReplaceConfigFile = RuntimeConfigApi["replaceConfigFile"];
type ReplaceConfigFileResult = Awaited<ReturnType<ReplaceConfigFile>>;

function createConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        allowFrom: ["TRUSTED_OPENID"],
        streaming: false,
        accounts: {
          default: {
            allowFrom: ["TRUSTED_OPENID"],
            streaming: false,
          },
        },
      },
    },
  };
}

function installCommandRuntime(currentConfig: OpenClawConfig, writes: OpenClawConfig[]): void {
  const replaceConfigFile: ReplaceConfigFile = async (params) => {
    writes.push(params.nextConfig);
    return undefined as unknown as ReplaceConfigFileResult;
  };

  initCommands({
    resolveVersion: () => "test",
    pluginVersion: "0.0.0-test",
    approveRuntimeGetter: () => ({
      config: {
        current: () => currentConfig,
        replaceConfigFile,
      },
    }),
  });
}

function registerCommands(): OpenClawPluginCommandDefinition[] {
  ensurePlatformAdapter();
  const commands: OpenClawPluginCommandDefinition[] = [];
  const api = {
    logger: {},
    registerCommand: (command: OpenClawPluginCommandDefinition) => {
      commands.push(command);
    },
  } as unknown as OpenClawPluginApi;

  registerQQBotFrameworkCommands(api);
  return commands;
}

function findCommand(
  commands: OpenClawPluginCommandDefinition[],
  name: string,
): OpenClawPluginCommandDefinition {
  const command = commands.find((entry) => entry.name === name);
  expect(command).toBeDefined();
  return command as OpenClawPluginCommandDefinition;
}

function createCommandContext(
  config: OpenClawConfig,
  from: string | undefined,
): PluginCommandContext {
  return {
    senderId: "TRUSTED_OPENID",
    channel: "qqbot",
    isAuthorizedSender: true,
    args: "on",
    commandBody: "/bot-streaming on",
    config,
    from,
    requestConversationBinding: async () => undefined,
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  } as unknown as PluginCommandContext;
}

function getWrittenQQBotConfig(write: OpenClawConfig | undefined):
  | {
      streaming?: unknown;
      accounts?: { default?: { streaming?: unknown } };
    }
  | undefined {
  return write?.channels?.qqbot as
    | {
        streaming?: unknown;
        accounts?: { default?: { streaming?: unknown } };
      }
    | undefined;
}

describe("registerQQBotFrameworkCommands", () => {
  it("preserves the private-chat guard for bot-streaming on generic framework calls", async () => {
    const config = createConfig();
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(config, writes);
    const command = findCommand(registerCommands(), "bot-streaming");

    const missingFromResult = await command.handler(createCommandContext(config, undefined));
    const nonQQBotResult = await command.handler(createCommandContext(config, "generic:dm:user"));
    const groupResult = await command.handler(
      createCommandContext(config, "qqbot:group:GROUP_OPENID"),
    );

    expect(missingFromResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(nonQQBotResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(groupResult).toEqual({ text: "💡 请在私聊中使用此指令" });
    expect(writes).toHaveLength(0);
  });

  it("allows bot-streaming on explicit QQBot private-chat framework calls", async () => {
    const config = createConfig();
    const writes: OpenClawConfig[] = [];
    installCommandRuntime(config, writes);
    const command = findCommand(registerCommands(), "bot-streaming");

    const result = await command.handler(createCommandContext(config, "qqbot:c2c:TRUSTED_OPENID"));

    const qqbot = getWrittenQQBotConfig(writes[0]);
    expect(result).toMatchObject({ text: expect.stringContaining("已开启") });
    expect(writes).toHaveLength(1);
    expect(qqbot?.streaming).toBe(true);
    expect(qqbot?.accounts?.default?.streaming).toBe(true);
  });
});
