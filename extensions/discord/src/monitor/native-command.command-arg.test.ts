// Discord tests cover native command.command arg plugin behavior.
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordCommandArgFallbackButton } from "./native-command-arg-ui.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";

type CommandArgContext = Parameters<typeof createDiscordCommandArgFallbackButton>[0]["ctx"];
type CommandArgButton = ReturnType<typeof createDiscordCommandArgFallbackButton>;
type CommandArgInteraction = Parameters<CommandArgButton["run"]>[0];
type CommandArgData = Parameters<CommandArgButton["run"]>[1];

function createCommandDefinition(): ChatCommandDefinition {
  return {
    key: "think",
    nativeName: "think",
    description: "Set thinking level",
    textAliases: ["/think"],
    acceptsArgs: true,
    args: [
      {
        name: "level",
        description: "Thinking level",
        type: "string",
        required: true,
      },
    ],
    argsParsing: "none",
    scope: "native",
  };
}

function createInteraction(): CommandArgInteraction {
  return {
    user: {
      id: "owner",
      username: "tester",
      globalName: "Tester",
    },
    update: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as CommandArgInteraction;
}

async function safeInteractionCall<T>(_label: string, fn: () => Promise<T>): Promise<T | null> {
  return await fn();
}

describe("discord command argument fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves public slash command visibility for selected argument follow-ups", async () => {
    const commandDefinition = createCommandDefinition();
    const dispatchReplyFromConfig =
      vi.fn<NonNullable<CommandArgContext["dispatchReplyFromConfig"]>>();
    vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockReturnValue(commandDefinition);
    const dispatchSpy = vi
      .fn<DispatchDiscordCommandInteraction>()
      .mockResolvedValue({ accepted: true });
    const button = createDiscordCommandArgFallbackButton({
      ctx: {
        ...nativeCommandContext({
          channels: { discord: { slashCommand: { ephemeral: false } } },
        }),
        dispatchReplyFromConfig,
      },
      safeInteractionCall,
      dispatchCommandInteraction: dispatchSpy,
    });

    await button.run(createInteraction(), {
      command: "think",
      arg: "level",
      value: "high",
      user: "owner",
    } satisfies CommandArgData);

    expect(dispatchSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: "/think high",
        responseEphemeral: false,
        accountId: "default",
        sessionPrefix: "discord:slash",
        dispatchReplyFromConfig,
      }),
    );
  });
});

installDiscordIngressTestRuntime();
