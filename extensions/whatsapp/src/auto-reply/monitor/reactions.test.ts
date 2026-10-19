// Whatsapp tests cover ack reaction plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
  resolveGroupActivationFor: vi.fn(async (): Promise<"always" | "mention"> => "always"),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: hoisted.resolveGroupActivationFor,
}));

type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;

type AckReactionConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["ackReaction"]
>;

function createMessage(overrides: TestMsgOverrides = {}): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543",
      fromMe: false,
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "15551234567",
      },
      sender: {
        id: "15551234567",
      },
    },
    ...overrides,
  });
}

function createConfig(reactionLevel: "off" | "ack" | "minimal" | "extensive"): OpenClawConfig {
  return {
    messages: { ackReaction: "👀", ackReactionScope: "all" },
    channels: {
      whatsapp: {
        reactionLevel,
      },
    },
  } as OpenClawConfig;
}

function createAckEmojiConfig(ackReaction?: AckReactionConfig): OpenClawConfig {
  const cfg = {
    agents: {
      entries: { agent: { identity: { emoji: "🔥" } } },
    },
    channels: {
      whatsapp: {},
    },
  } as OpenClawConfig;
  if (ackReaction !== undefined) {
    cfg.channels!.whatsapp!.ackReaction = ackReaction;
  }
  return cfg;
}

function resolveAckEmoji(cfg: OpenClawConfig) {
  return resolveWhatsAppAckEmoji({
    cfg,
    agentId: "agent",
    ackConfig: cfg.channels?.whatsapp?.ackReaction,
  });
}

function createStatusConfig(): OpenClawConfig {
  return {
    messages: {
      ackReaction: "👀",
      ackReactionScope: "all",
      statusReactions: { enabled: true },
    },
    channels: {
      whatsapp: {
        reactionLevel: "ack",
      },
    },
  } as OpenClawConfig;
}

type AckReactionParams = Parameters<typeof maybeSendAckReaction>[0];

const runAckReaction = (overrides: Partial<AckReactionParams> = {}) =>
  maybeSendAckReaction({
    cfg: createConfig("ack"),
    msg: createMessage(),
    agentId: "agent",
    sessionKey: "whatsapp:default:15551234567",
    verbose: false,
    warn: vi.fn(),
    ...overrides,
  });

describe("resolveWhatsAppAckEmoji", () => {
  it.each([
    {
      name: "keeps missing ackReaction config disabled",
      cfg: createAckEmojiConfig(),
      expected: "",
    },
    {
      name: "falls back to the routed agent identity for an empty emoji",
      cfg: createAckEmojiConfig({ emoji: " ", direct: true, group: "mentions" }),
      expected: "🔥",
    },
    {
      name: "uses the default ack emoji when configured without an emoji or agent identity",
      cfg: {
        channels: { whatsapp: { ackReaction: { direct: true, group: "mentions" } } },
      } as OpenClawConfig,
      expected: "👀",
    },
  ])("$name", ({ cfg, expected }) => {
    expect(resolveAckEmoji(cfg)).toBe(expected);
  });
});

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses ack reactions when reactionLevel is off", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off"),
    });

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "skips an unmentioned inactive group message",
      scope: "group-mentions",
      activation: "mention",
      wasMentioned: false,
      expected: false,
    },
  ] as const)("$name", async ({ scope, activation, wasMentioned, expected }) => {
    const cfg = createConfig("ack");
    cfg.messages!.ackReactionScope = scope;
    hoisted.resolveGroupActivationFor.mockResolvedValue(activation);

    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: { chatJid: "120363000000000000@g.us" },
        admission: {
          conversation: { kind: "group", id: "120363000000000000@g.us" },
        },
        groupMention: { wasMentioned, requireMention: true },
      }),
      sessionKey: "whatsapp:default:120363000000000000@g.us",
    });

    expect(Boolean(ackReaction)).toBe(expected);
    if (ackReaction) {
      await expect(ackReaction.ackReactionPromise).resolves.toBe(true);
    }
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "120363000000000000@g.us",
          sender: {
            jid: null,
            lid: "277038292303944@lid",
          },
        },
        admission: {
          conversation: {
            kind: "group",
            id: "120363000000000000@g.us",
          },
          sender: {
            id: "277038292303944@lid",
          },
        },
      }),
      sessionKey: "whatsapp:default:120363000000000000@g.us",
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "120363000000000000@g.us",
      "msg-1",
      "👀",
      {
        verbose: false,
        fromMe: false,
        participant: "277038292303944@lid",
        accountId: "default",
        cfg,
      },
    );

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "120363000000000000@g.us",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: false,
        participant: "277038292303944@lid",
        accountId: "default",
        cfg,
      },
    );
  });

  it("records ack send failures on the handle", async () => {
    const cfg = createConfig("ack");
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));

    const ackReaction = await runAckReaction({ cfg, warn });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      {
        error: "session down",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
      },
      "failed to send ack reaction",
    );
  });
});

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createStatusConfig();
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({
        platform: {
          chatJid: "120363000000000000@g.us",
          sender: { jid: null, lid: "277038292303944@lid" },
        },
        admission: {
          conversation: { kind: "group", id: "120363000000000000@g.us" },
          sender: { id: "277038292303944@lid" },
        },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:120363000000000000@g.us",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "120363000000000000@g.us",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          participant: "277038292303944@lid",
          accountId: "default",
          cfg,
        },
      );
    });
    await controller?.clear();
    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "120363000000000000@g.us",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: false,
        participant: "277038292303944@lid",
        accountId: "default",
        cfg,
      },
    );
  });
});
