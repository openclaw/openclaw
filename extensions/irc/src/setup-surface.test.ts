import type { RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk/irc";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { ircPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

const selectFirstOption = async <T>(params: { options: Array<{ value: T }> }): Promise<T> => {
  const first = params.options[0];
  if (!first) {
    throw new Error("no options");
  }
  return first.value;
};

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: selectFirstOption as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

const ircConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: ircPlugin,
  wizard: ircPlugin.setupWizard!,
});

describe("irc setup wizard", () => {
  it("configures host and nick via setup prompts", async () => {
    const prompter = createPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC server host") {
          return "irc.libera.chat";
        }
        if (message === "IRC server port") {
          return "6697";
        }
        if (message === "IRC nick") {
          return "openclaw-bot";
        }
        if (message === "IRC username") {
          return "openclaw";
        }
        if (message === "IRC real name") {
          return "OpenClaw Bot";
        }
        if (message.startsWith("Auto-join IRC channels")) {
          return "#openclaw, #ops";
        }
        if (message.startsWith("IRC channels allowlist")) {
          return "#openclaw, #ops";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use TLS for IRC?") {
          return true;
        }
        if (message === "Configure IRC channels access?") {
          return true;
        }
        return false;
      }),
    });

    const runtime: RuntimeEnv = createRuntimeEnv();

    const result = await ircConfigureAdapter.configure({
      cfg: {} as CoreConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.irc?.enabled).toBe(true);
    expect(result.cfg.channels?.irc?.host).toBe("irc.libera.chat");
    expect(result.cfg.channels?.irc?.nick).toBe("openclaw-bot");
    expect(result.cfg.channels?.irc?.tls).toBe(true);
    expect(result.cfg.channels?.irc?.channels).toEqual(["#openclaw", "#ops"]);
    expect(result.cfg.channels?.irc?.groupPolicy).toBe("allowlist");
    expect(Object.keys(result.cfg.channels?.irc?.groups ?? {})).toEqual(["#openclaw", "#ops"]);
  });

  it("writes DM allowFrom to top-level config for non-default account prompts", async () => {
    const prompter = createPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "IRC allowFrom (nick or nick!user@host)") {
          return "Alice, Bob!ident@example.org";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
    });

    const promptAllowFrom = ircConfigureAdapter.dmPolicy?.promptAllowFrom;
    expect(promptAllowFrom).toBeTypeOf("function");

    const cfg: CoreConfig = {
      channels: {
        irc: {
          accounts: {
            work: {
              host: "irc.libera.chat",
              nick: "openclaw-work",
            },
          },
        },
      },
    };

    const updated = (await promptAllowFrom?.({
      cfg,
      prompter,
      accountId: "work",
    })) as CoreConfig;

    expect(updated.channels?.irc?.allowFrom).toEqual(["alice", "bob!ident@example.org"]);
    expect(updated.channels?.irc?.accounts?.work?.allowFrom).toBeUndefined();
  });
});
