import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
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

function createConfig(reactionLevel: "off" | "ack" | "minimal" | "extensive"): OpenClawConfig {
  return {
    messages: { ackReaction: "👀", ackReactionScope: "all" },
    channels: { whatsapp: { reactionLevel } },
  };
}

const groupJid = "120363000000000000@g.us";
const senderLid = "277038292303944@lid";
const groupSessionKey = `whatsapp:default:${groupJid}`;

function createGroupMessage() {
  return createTestWebInboundMessage({
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
    msg: createTestWebInboundMessage({ platform: { chatJid: "15551234567@s.whatsapp.net" } }),
    agentId: "agent",
    sessionKey: "whatsapp:default:15551234567",
    verbose: false,
    warn: vi.fn(),
    ...overrides,
  });

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [undefined, { emoji: "🔥" }, ""],
    [" ", { emoji: "🔥" }, "🔥"],
    [" ", undefined, "👀"],
    [" ✅ ", { emoji: "🔥" }, "✅"],
  ] as const)(
    "resolves configured emoji %j and identity %j to %j",
    async (configured, identity, expected) => {
      const cfg: OpenClawConfig = {
        messages: { ackReaction: configured, ackReactionScope: "all" },
        agents: { entries: { agent: { identity } } },
      };
      const reaction = await runAckReaction({ cfg });
      if (!expected) {
        expect(reaction).toBeNull();
        expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
        return;
      }
      await expect(reaction?.ackReactionPromise).resolves.toBe(true);
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        expected,
        { verbose: false, fromMe: false, accountId: "default", cfg },
      );
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    expect(await runAckReaction({ cfg: createConfig("off") })).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("skips an unmentioned inactive group message", async () => {
    const cfg = createConfig("ack");
    cfg.messages!.ackReactionScope = "group-mentions";
    hoisted.resolveGroupActivationFor.mockResolvedValue("mention");
    const ackReaction = await runAckReaction({
      cfg,
      msg: { ...createGroupMessage(), groupMention: { wasMentioned: false, requireMention: true } },
      sessionKey: groupSessionKey,
    });
    expect(ackReaction).toBeNull();
  });

  it("records ack send failures on the handle", async () => {
    const cfg = createConfig("ack");
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));
    const ackReaction = await runAckReaction({ cfg, warn });
    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "session down" }),
      expect.any(String),
    );
  });
  it.each(["ack", "status"] as const)(
    "uses the sender LID for %s reactions and removal",
    async (kind) => {
      const cfg = createConfig("ack");
      cfg.messages!.statusReactions = { enabled: true };
      const params = { cfg, msg: createGroupMessage(), sessionKey: groupSessionKey };
      if (kind === "ack") {
        const reaction = await runAckReaction(params);
        await expect(reaction?.ackReactionPromise).resolves.toBe(true);
        expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(...groupReactionCall(cfg, "👀"));
        await reaction?.remove();
      } else {
        const controller = await createWhatsAppStatusReactionController({
          ...params,
          agentId: "agent",
          verbose: false,
        });
        void controller?.setQueued();
        await vi.waitFor(() => {
          expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
            ...groupReactionCall(cfg, "👀"),
          );
        });
        await controller?.clear();
      }
      expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(...groupReactionCall(cfg, ""));
    },
  );
});
