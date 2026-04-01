import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createWhatsAppPollFixture, expectWhatsAppPollSent } from "openclaw/plugin-sdk/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/plugins/directory.ts";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { whatsappPlugin } from "./channel.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "wa-poll-1", toJid: "1555@s.whatsapp.net" })),
  sendReactionWhatsApp: vi.fn(async () => undefined),
  handleWhatsAppAction: vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] })),
  loginWeb: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  listWhatsAppAccountIds: vi.fn((cfg: OpenClawConfig) => {
    const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
    return accountIds.length > 0 ? accountIds : [DEFAULT_ACCOUNT_ID];
  }),
  resolveDefaultWhatsAppAccountId: vi.fn(() => DEFAULT_ACCOUNT_ID),
  resolveWhatsAppAuthDir: vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      whatsapp: {
        sendPollWhatsApp: hoisted.sendPollWhatsApp,
        handleWhatsAppAction: hoisted.handleWhatsAppAction,
      },
    },
  }),
}));

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendPollWhatsApp: hoisted.sendPollWhatsApp,
    sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
  };
});

vi.mock("./action-runtime.js", () => ({
  handleWhatsAppAction: hoisted.handleWhatsAppAction,
}));

vi.mock("./login.js", () => ({
  loginWeb: hoisted.loginWeb,
}));

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup")>(
    "openclaw/plugin-sdk/setup",
  );
  return {
    ...actual,
    pathExists: hoisted.pathExists,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    listWhatsAppAccountIds: hoisted.listWhatsAppAccountIds,
    resolveDefaultWhatsAppAccountId: hoisted.resolveDefaultWhatsAppAccountId,
    resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

let whatsappConfigure: ReturnType<typeof createPluginSetupWizardConfigure>;

async function runConfigureWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: Parameters<typeof whatsappConfigure>[0]["cfg"];
  runtime?: RuntimeEnv;
  options?: Parameters<typeof whatsappConfigure>[0]["options"];
  accountOverrides?: Parameters<typeof whatsappConfigure>[0]["accountOverrides"];
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
}) {
  return await runSetupWizardConfigure({
    configure: whatsappConfigure,
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? createRuntime(),
    prompter: params.harness.prompter,
    options: params.options ?? {},
    accountOverrides: params.accountOverrides ?? {},
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
    forceAllowFrom: params.forceAllowFrom ?? false,
  });
}

function createSeparatePhoneHarness(params: { selectValues: string[]; textValues?: string[] }) {
  return createQueuedWizardPrompter({
    confirmValues: [false],
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
}

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  hoisted.pathExists.mockResolvedValue(true);
  const harness = createSeparatePhoneHarness({
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
  const result = await runConfigureWithHarness({
    harness,
  });
  return { harness, result };
}

describe("whatsappPlugin outbound sendMedia", () => {
  it("chunks outbound text without requiring WhatsApp runtime initialization", () => {
    const chunker = whatsappPlugin.outbound?.chunker;
    if (!chunker) {
      throw new Error("whatsapp outbound chunker is unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const outbound = whatsappPlugin.outbound;
    if (!outbound?.sendMedia) {
      throw new Error("whatsapp outbound sendMedia is unavailable");
    }

    const result = await outbound.sendMedia({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendWhatsApp },
      gifPlayback: false,
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
        gifPlayback: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });
});

describe("whatsappPlugin outbound sendPoll", () => {
  beforeEach(async () => {
    vi.resetModules();
    hoisted.sendPollWhatsApp.mockClear();
  });

  it("threads cfg into runtime sendPollWhatsApp call", async () => {
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await whatsappPlugin.outbound!.sendPoll!({
      cfg,
      to,
      poll,
      accountId,
    });

    expectWhatsAppPollSent(hoisted.sendPollWhatsApp, { cfg, poll, to, accountId });
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          allowFrom: [
            "whatsapp:+15551230001",
            "15551230002@s.whatsapp.net",
            "120363999999999999@g.us",
          ],
          groups: {
            "120363111111111111@g.us": {},
            "120363222222222222@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(whatsappPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "+15551230001" },
        { kind: "user", id: "+15551230002" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "120363111111111111@g.us" },
        { kind: "group", id: "120363222222222222@g.us" },
      ]),
    );
  });
});

describe("whatsapp setup wizard", () => {
  beforeAll(() => {
    whatsappConfigure = createPluginSetupWizardConfigure(whatsappPlugin);
  });

  beforeEach(() => {
    hoisted.loginWeb.mockReset();
    hoisted.pathExists.mockReset();
    hoisted.pathExists.mockResolvedValue(false);
    hoisted.listWhatsAppAccountIds.mockReset();
    hoisted.listWhatsAppAccountIds.mockReturnValue([]);
    hoisted.resolveDefaultWhatsAppAccountId.mockReset();
    hoisted.resolveDefaultWhatsAppAccountId.mockReturnValue(DEFAULT_ACCOUNT_ID);
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      textValues: ["+1 (555) 555-0123"],
    });

    const result = await runConfigureWithHarness({
      harness,
      forceAllowFrom: true,
    });

    expect(result.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(harness.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Your personal WhatsApp number (the phone you will message from)",
      }),
    );
  });

  it("supports disabled DM policy for separate-phone setup", async () => {
    const { harness, result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "disabled"],
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("disabled");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toBeUndefined();
    expect(harness.text).not.toHaveBeenCalled();
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    const { result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "allowlist", "list"],
      textValues: ["+1 (555) 555-0123, +15555550123, *"],
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      selectValues: ["personal"],
      textValues: ["+1 (555) 111-2222"],
    });

    const result = await runConfigureWithHarness({
      harness,
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15551112222"]);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
      },
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["*", "+15555550123"]);
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.text).not.toHaveBeenCalled();
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createQueuedWizardPrompter({
      confirmValues: [true],
      selectValues: ["separate", "disabled"],
    });
    const runtime = createRuntime();

    await runConfigureWithHarness({
      harness,
      runtime,
    });

    expect(hoisted.loginWeb).toHaveBeenCalledWith(false, undefined, runtime, DEFAULT_ACCOUNT_ID);
  });

  it("skips relink note when already linked and relink is declined", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runConfigureWithHarness({
      harness,
    });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(harness.note).not.toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });

  it("shows follow-up login command note when not linked and linking is skipped", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runConfigureWithHarness({
      harness,
    });

    expect(harness.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });
});

describe("whatsapp group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "1203630@g.us" })).toBe(false);
    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "1203630@g.us" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "other@g.us" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("whatsapp agent prompt", () => {
  it("defaults to minimal reaction guidance when reactions are available", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.agentPrompt?.reactionGuidance?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toEqual({
      level: "minimal",
      channelLabel: "WhatsApp",
    });
  });

  it("omits reaction guidance when WhatsApp is not configured", () => {
    expect(
      whatsappPlugin.agentPrompt?.reactionGuidance?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBeUndefined();
  });

  it("returns minimal reaction guidance when configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "minimal",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.agentPrompt?.reactionGuidance?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toEqual({
      level: "minimal",
      channelLabel: "WhatsApp",
    });
  });

  it("omits reaction guidance when WhatsApp reactions are disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: false },
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.agentPrompt?.reactionGuidance?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBeUndefined();
  });

  it("omits reaction guidance when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.agentPrompt?.reactionGuidance?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBeUndefined();
  });
});

describe("whatsapp action discovery", () => {
  it("advertises react when agent reactions are enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      })?.actions,
    ).toEqual(["react", "poll"]);
  });

  it("returns null when WhatsApp is not configured", () => {
    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg: {} as OpenClawConfig,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBeNull();
  });

  it("omits react when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      })?.actions,
    ).toEqual(["poll"]);
  });

  it("uses the active account reactionLevel for discovery", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "work",
      })?.actions,
    ).toEqual(["react", "poll"]);
  });

  it("keeps react in global discovery when any account enables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg,
      })?.actions,
    ).toEqual(["react", "poll"]);
  });

  it("omits react in global discovery when only disabled accounts enable agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              enabled: false,
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(
      whatsappPlugin.actions?.describeMessageTool?.({
        cfg,
      })?.actions,
    ).toEqual(["poll"]);
  });
});

describe("whatsappPlugin actions.handleAction react messageId resolution", () => {
  const baseCfg = {
    channels: { whatsapp: { actions: { reactions: true }, allowFrom: ["*"] } },
  } as OpenClawConfig;

  beforeEach(() => {
    hoisted.handleWhatsAppAction.mockClear();
    hoisted.sendReactionWhatsApp.mockClear();
  });

  it("uses explicit messageId when provided", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { messageId: "explicit-id", emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "explicit-id" }),
      baseCfg,
    );
  });

  it("falls back to toolContext.currentMessageId when messageId omitted", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "❤️", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "ctx-msg-42" }),
      baseCfg,
    );
  });

  it("converts numeric toolContext messageId to string", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "🎉", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: 12345,
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "12345" }),
      baseCfg,
    );
  });

  it("throws ToolInputError when messageId missing and no toolContext", async () => {
    const err = await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when targeting a different chat", async () => {
    const err = await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "👍", to: "+9999" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    // Different target chat → context fallback suppressed → ToolInputError
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("uses context fallback when target matches current chat (prefixed)", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "ctx-msg-42" }),
      baseCfg,
    );
  });

  it("skips context fallback when source is another provider", async () => {
    const err = await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelId: "telegram:-1003841603622",
        currentChannelProvider: "telegram",
        currentMessageId: "tg-msg-99",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when currentChannelId is missing with explicit target", async () => {
    const err = await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    // WhatsApp source but no currentChannelId to compare → fallback suppressed
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });
});
