import type { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
let enforceTelegramDmAccess: typeof import("./dm-access.js").enforceTelegramDmAccess;

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
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ enforceTelegramDmAccess } = await import("./dm-access.js"));
  });

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

  it("keeps disabled policy authoritative for bot-originated DMs", async () => {
    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "disabled",
      msg: createDmMessage({
        from: {
          id: 999,
          is_bot: true,
          first_name: "OpenClaw",
          username: "openclaw_bot",
        },
      }),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: {
        botInfo: { id: 999 },
        api: { sendMessage: vi.fn(async () => undefined) },
      } as never,
      logger: { info: vi.fn() },
    });

    expect(allowed).toBe(false);
  });

  it("allows the bot's own messages under pairing policy", async () => {
    const sendMessage = vi.fn(async () => undefined);

    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg: createDmMessage({
        from: {
          id: 999,
          is_bot: true,
          first_name: "OpenClaw",
          username: "openclaw_bot",
        },
      }),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: {
        botInfo: { id: 999 },
        api: { sendMessage },
      } as never,
      logger: { info: vi.fn() },
    });

    expect(allowed).toBe(true);
    expect(createChannelPairingChallengeIssuerMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
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
      ({
        sendPairingReply,
        onCreated,
      }: Parameters<ReturnType<typeof createChannelPairingChallengeIssuer>>[0]) =>
        (async () => {
          onCreated?.({ code: "123456" });
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
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [firstCall] = sendMessage.mock.calls as Array<unknown[]>;
    expect(firstCall?.[0]).toBe(42);
    const sentText = String(firstCall?.[1] ?? "");
    expect(sentText).toContain("Pairing code:");
    expect(firstCall?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
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
