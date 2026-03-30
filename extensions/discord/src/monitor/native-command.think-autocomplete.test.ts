import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, type AutocompleteInteraction } from "@buape/carbon";
import {
  findCommandByNativeName,
  resolveCommandArgChoices,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
);
const resolveConfiguredBindingRouteMock = vi.hoisted(() =>
  vi.fn<
    () => {
      bindingResolution: {
        record: {
          conversation: {
            channel: string;
            accountId: string;
            conversationId: string;
          };
        };
      };
      boundSessionKey: string;
      route: {
        agentId: string;
        sessionKey: string;
      };
    } | null
  >(() => null),
);

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const { createConfiguredBindingConversationRuntimeModuleMock } =
    await import("../test-support/configured-binding-runtime.js");
  return await createConfiguredBindingConversationRuntimeModuleMock(
    {
      ensureConfiguredBindingRouteReadyMock,
      resolveConfiguredBindingRouteMock,
    },
    importOriginal,
  );
});

const STORE_PATH = path.join(
  os.tmpdir(),
  `openclaw-discord-think-autocomplete-${process.pid}.json`,
);
const SESSION_KEY = "agent:main:main";
let resolveDiscordNativeChoiceContext: typeof import("./native-command-ui.js").resolveDiscordNativeChoiceContext;

describe("discord native /think autocomplete", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolveDiscordNativeChoiceContext } = await import("./native-command-ui.js"));
    clearSessionStoreCacheForTest();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReturnValue(null);
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({
        [SESSION_KEY]: {
          updatedAt: Date.now(),
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
        },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    try {
      fs.unlinkSync(STORE_PATH);
    } catch {}
  });

  function createConfig() {
    return {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4.5",
          },
        },
      },
      session: {
        store: STORE_PATH,
      },
    } as ReturnType<typeof loadConfig>;
  }

  it("uses the session override context for /think choices", async () => {
    const cfg = createConfig();
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {},
      channel: { id: "D1", type: ChannelType.DM },
      user: { id: "U1" },
      guild: undefined,
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const command = findCommandByNativeName("think", "discord");
    expect(command).toBeTruthy();
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }

    const context = await resolveDiscordNativeChoiceContext({
      interaction,
      cfg,
      accountId: "default",
      threadBindings: createNoopThreadBindingManager("default"),
    });
    expect(context).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("xhigh");
  });

  it("falls back when a configured binding is unavailable", async () => {
    const cfg = createConfig();
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: {
        record: {
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "C1",
          },
        },
      },
      boundSessionKey: SESSION_KEY,
      route: {
        agentId: "main",
        sessionKey: SESSION_KEY,
      },
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "acpx exited",
    });
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {
        member: { roles: [] },
      },
      channel: { id: "C1", type: ChannelType.GuildText },
      user: { id: "U1" },
      guild: { id: "G1" },
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const context = await resolveDiscordNativeChoiceContext({
      interaction,
      cfg,
      accountId: "default",
      threadBindings: createNoopThreadBindingManager("default"),
    });

    expect(context).toBeNull();
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);

    const command = findCommandByNativeName("think", "discord");
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(command).toBeTruthy();
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }
    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).not.toContain("xhigh");
  });
});
