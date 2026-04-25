import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

async function makeSessionStore(): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify({}));
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

function createMessage(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    id: "msg-1",
    from: "15551234567",
    conversationId: "15551234567",
    to: "15559876543",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "15551234567@s.whatsapp.net",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

function createConfig(
  reactionLevel: "off" | "ack" | "minimal" | "extensive",
  extras?: Partial<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        reactionLevel,
        ackReaction: {
          emoji: "👀",
          direct: true,
          group: "mentions",
        },
        ...extras,
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
    conversationId: "15551234567",
    verbose: false,
    accountId: "default",
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  });

const expectAckReactionSent = (accountId: string) => {
  expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
    "15551234567@s.whatsapp.net",
    "msg-1",
    "👀",
    expect.objectContaining({
      verbose: false,
      fromMe: false,
      accountId,
    }),
  );
};

describe("maybeSendAckReaction", () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    async (reactionLevel) => {
      const ackReaction = await runAckReaction({
        cfg: createConfig(reactionLevel),
      });

      expect(ackReaction?.ackReactionValue).toBe("👀");
      await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
      expectAckReactionSent("default");
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off"),
    });

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the active account reactionLevel override for ack gating", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off", {
        accounts: {
          work: {
            reactionLevel: "ack",
          },
        },
      }),
      msg: createMessage({
        accountId: "work",
      }),
      sessionKey: "whatsapp:work:15551234567",
      accountId: "work",
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    expectAckReactionSent("work");
  });

  it("returns a handle that removes the ack with an empty reaction", async () => {
    const ackReaction = await runAckReaction();

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "",
      expect.objectContaining({
        verbose: false,
        fromMe: false,
        accountId: "default",
      }),
    );
  });

  it("treats configured group admins as active for mention-scoped ack reactions", async () => {
    const { storePath, cleanup } = await makeSessionStore();
    cleanups.push(cleanup);

    const ackReaction = await runAckReaction({
      msg: createMessage({
        from: "123@g.us",
        conversationId: "123@g.us",
        chatType: "group",
        chatId: "123@g.us",
        senderE164: "+15550001111",
        wasMentioned: false,
      }),
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      conversationId: "123@g.us",
      cfg: {
        ...createConfig("ack", {
          groups: {
            "*": {
              requireMention: true,
              admin: "+15550001111",
            },
          },
        }),
        session: { store: storePath },
      } as OpenClawConfig,
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "123@g.us",
      "msg-1",
      "👀",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("records ack send failures on the handle", async () => {
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));

    const ackReaction = await runAckReaction({ warn });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "session down",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
      }),
      "failed to send ack reaction",
    );
  });
});
