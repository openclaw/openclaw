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

type AckReactionConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["ackReaction"]
>;

function createMessage(
  overrides: NonNullable<Parameters<typeof createTestWebInboundMessage>[0]> = {},
): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543",
      fromMe: false,
    },
    admission: {
      accountId: "default",
      conversation: { kind: "direct", id: "15551234567" },
      sender: { id: "15551234567" },
    },
    ...overrides,
  });
}

function createConfig(reactionLevel: "off" | "ack" | "minimal" | "extensive"): OpenClawConfig {
  return {
    messages: { ackReaction: "👀", ackReactionScope: "all" },
    channels: { whatsapp: { reactionLevel } },
  } as OpenClawConfig;
}

function createAckEmojiConfig(ackReaction?: AckReactionConfig): OpenClawConfig {
  return {
    agents: { entries: { agent: { identity: { emoji: "🔥" } } } },
    channels: { whatsapp: { ackReaction } },
  } as OpenClawConfig;
}

function resolveAckEmoji(cfg: OpenClawConfig) {
  return resolveWhatsAppAckEmoji({
    cfg,
    agentId: "agent",
    ackConfig: cfg.channels?.whatsapp?.ackReaction,
  });
}

const groupJid = "120363000000000000@g.us";
const senderLid = "277038292303944@lid";
const groupSessionKey = `whatsapp:default:${groupJid}`;

function createGroupMessage(): AdmittedWebInboundMessage {
  return createMessage({
    platform: { chatJid: groupJid, sender: { jid: null, lid: senderLid } },
    admission: {
      conversation: { kind: "group", id: groupJid },
      sender: { id: senderLid },
    },
  });
}

const groupReactionCall = (cfg: OpenClawConfig, emoji: string) =>
  [
    groupJid,
    "msg-1",
    emoji,
    { verbose: false, fromMe: false, participant: senderLid, accountId: "default", cfg },
  ] as const;

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

  it("skips an unmentioned inactive group message", async () => {
    const cfg = createConfig("ack");
    cfg.messages!.ackReactionScope = "group-mentions";
    hoisted.resolveGroupActivationFor.mockResolvedValue("mention");

    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({
        platform: { chatJid: groupJid },
        admission: {
          conversation: { kind: "group", id: groupJid },
        },
        groupMention: { wasMentioned: false, requireMention: true },
      }),
      sessionKey: groupSessionKey,
    });

    expect(ackReaction).toBeNull();
  });

  it("uses the sender LID as the group reaction participant when no sender JID is available", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({
      cfg,
      msg: createGroupMessage(),
      sessionKey: groupSessionKey,
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(...groupReactionCall(cfg, "👀"));

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(...groupReactionCall(cfg, ""));
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
    const cfg = createConfig("ack");
    cfg.messages!.statusReactions = { enabled: true };
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createGroupMessage(),
      agentId: "agent",
      sessionKey: groupSessionKey,
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(...groupReactionCall(cfg, "👀"));
    });
    await controller?.clear();
    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(...groupReactionCall(cfg, ""));
  });
});
