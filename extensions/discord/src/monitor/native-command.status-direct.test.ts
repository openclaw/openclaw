import { ChannelType } from "discord-api-types/v10";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  buildStatusReply: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveSessionAgentId: vi.fn(),
  resolveAgentConfig: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) =>
      runtimeModuleMocks.dispatchReplyWithDispatcher(...args),
  };
});

vi.mock("../../../../src/auto-reply/reply/commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => runtimeModuleMocks.buildStatusReply(...args),
}));

vi.mock("../../../../src/gateway/session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => runtimeModuleMocks.loadSessionEntry(...args),
}));

vi.mock("../../../../src/agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => runtimeModuleMocks.resolveSessionAgentId(...args),
  resolveAgentConfig: (...args: unknown[]) => runtimeModuleMocks.resolveAgentConfig(...args),
}));

vi.mock("../../../../src/agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: (...args: unknown[]) =>
    runtimeModuleMocks.resolveDefaultModelForAgent(...args),
}));

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let discordNativeCommandTesting: typeof import("./native-command.js").__testing;

function createInteraction(): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: "owner",
    username: "tester",
    globalName: "Tester",
    channelType: ChannelType.DM,
    channelId: "dm-1",
    interactionId: "interaction-1",
  });
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
  } as OpenClawConfig;
}

function createStatusCommandSpec(): NativeCommandSpec {
  return {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  };
}

describe("Discord native /status", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, __testing: discordNativeCommandTesting } =
      await import("./native-command.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 0,
        block: 0,
        tool: 0,
      },
      queuedFinal: false,
    } as never);
    runtimeModuleMocks.buildStatusReply.mockResolvedValue({ text: "status reply" });
    runtimeModuleMocks.loadSessionEntry.mockReturnValue({
      cfg: createConfig(),
      storePath: "/tmp/session-store.json",
      store: {},
      entry: {
        verboseLevel: "off",
        reasoningLevel: "off",
        contextTokens: 0,
      },
      canonicalKey: "agent:main:main",
    });
    runtimeModuleMocks.resolveSessionAgentId.mockReturnValue("main");
    runtimeModuleMocks.resolveAgentConfig.mockReturnValue({});
    runtimeModuleMocks.resolveDefaultModelForAgent.mockReturnValue({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(
      runtimeModuleMocks.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithDispatcher,
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async (params) => ({
      route: {
        agentId: "main",
        channel: "discord",
        accountId: params.accountId ?? "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      effectiveRoute: {
        agentId: "main",
        channel: "discord",
        accountId: params.accountId ?? "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      boundSessionKey: undefined,
      configuredRoute: null,
      configuredBinding: null,
      bindingReadiness: null,
    }));
  });

  it("returns a direct status reply without falling through the generic dispatcher", async () => {
    const command = createDiscordNativeCommand({
      command: createStatusCommandSpec(),
      cfg: createConfig(),
      discordConfig: createConfig().channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.buildStatusReply).toHaveBeenCalledTimes(1);
    expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "status reply",
      }),
    );
  });
});
