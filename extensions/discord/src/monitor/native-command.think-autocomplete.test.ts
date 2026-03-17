import { ChannelType, type AutocompleteInteraction } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listNativeCommandSpecs } from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig, loadConfig } from "../../../../src/config/config.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const mocks = vi.hoisted(() => ({
  resolveBoundConversationRoute: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("./route-resolution.js", () => ({
  resolveDiscordBoundConversationRoute: mocks.resolveBoundConversationRoute,
  resolveDiscordEffectiveRoute: vi.fn(),
}));

vi.mock("../../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: mocks.loadSessionStore,
    resolveStorePath: mocks.resolveStorePath,
  };
});

describe("discord native /think autocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBoundConversationRoute.mockResolvedValue({
      agentId: "main",
      sessionKey: "discord:session:1",
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw-sessions.mock.json");
    mocks.loadSessionStore.mockReturnValue({
      "discord:session:1": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
      },
    });
  });

  it("uses bound session model override for /think choices", async () => {
    const spec = listNativeCommandSpecs({ provider: "discord" }).find(
      (entry) => entry.name === "think",
    );
    expect(spec).toBeTruthy();
    if (!spec) {
      return;
    }

    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4.5",
          },
        },
      },
    } as ReturnType<typeof loadConfig>;
    const discordConfig = {} as NonNullable<OpenClawConfig["channels"]>["discord"];
    const command = createDiscordNativeCommand({
      command: spec,
      cfg,
      discordConfig,
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });

    const levelOption = command.options?.find((entry) => entry.name === "level") as
      | {
          autocomplete?: (
            interaction: AutocompleteInteraction & {
              respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
            },
          ) => Promise<void>;
        }
      | undefined;
    expect(typeof levelOption?.autocomplete).toBe("function");
    if (typeof levelOption?.autocomplete !== "function") {
      return;
    }

    const respond = vi.fn(async (_choices: Array<{ name: string; value: string }>) => {});
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond,
      rawData: {},
      channel: { id: "D1", type: ChannelType.DM },
      user: { id: "U1" },
      guild: undefined,
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    await levelOption.autocomplete(interaction);

    expect(respond).toHaveBeenCalledTimes(1);
    const choices = respond.mock.calls[0]?.[0] ?? [];
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("xhigh");
  });
});
