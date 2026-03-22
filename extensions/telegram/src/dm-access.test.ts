import { describe, expect, it, vi } from "vitest";

const createChannelPairingChallengeIssuerMock = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequestMock = vi.hoisted(() => vi.fn(async () => undefined));
const withTelegramApiErrorLoggingMock = vi.hoisted(() => vi.fn(async ({ fn }) => await fn()));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer: createChannelPairingChallengeIssuerMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: withTelegramApiErrorLoggingMock,
}));

import type { Message } from "@grammyjs/types";
import { normalizeAllowFrom } from "./bot-access.js";
import { enforceTelegramDmAccess } from "./dm-access.js";

function createDmMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 42, type: "private" },
    from: {
      id: 12345,
      is_bot: false,
      first_name: "Test",
      username: "tester",
    },
    text: "hello",
    ...overrides,
  } as Message;
}

describe("enforceTelegramDmAccess", () => {
  it("allows DMs when policy is open", async () => {
    const bot = { api: { sendMessage: vi.fn(async () => undefined) } };

    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "open",
      msg: createDmMessage(),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: bot as never,
      logger: { info: vi.fn() },
    });

    expect(allowed).toBe(true);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks DMs when policy is disabled", async () => {
    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "disabled",
      msg: createDmMessage(),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: { api: { sendMessage: vi.fn(async () => undefined) } } as never,
      logger: { info: vi.fn() },
    });

    expect(allowed).toBe(false);
  });

  it("allows DMs for allowlisted senders under pairing policy", async () => {
    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg: createDmMessage(),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom(["12345"]),
      accountId: "main",
      bot: { api: { sendMessage: vi.fn(async () => undefined) } } as never,
      logger: { info: vi.fn() },
    });

    expect(allowed).toBe(true);
    expect(createChannelPairingChallengeIssuerMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge for unauthorized DMs under pairing policy", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const logger = { info: vi.fn() };
    createChannelPairingChallengeIssuerMock.mockReturnValueOnce(
      ({ sendPairingReply, onCreated }) =>
        (async () => {
          onCreated();
          await sendPairingReply("Pairing code: 123456");
        })(),
    );

    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg: createDmMessage(),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: { api: { sendMessage } } as never,
      logger,
    });

    expect(allowed).toBe(false);
    expect(createChannelPairingChallengeIssuerMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(42, "Pairing code: 123456");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "42",
        senderUserId: "12345",
        username: "tester",
      }),
      "telegram pairing request",
    );
  });
});
