/**
 * Tests for drain-time mention gating in Telegram bot handlers.
 *
 * Verifies that the drain path uses resolveMentionGatingWithBypass so that
 * slash commands (e.g. /status) bypass the mention gate in groups with
 * requireMention:true — matching the behaviour of the normal message path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Third-party stubs for packages that may lag behind the branch's lockfile ──
vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(() => null),
  getOAuthProviders: vi.fn(() => []),
}));

// ── Drain / pending-inbound mocks ─────────────────────────────────────────
const { isGatewayDraining, writePendingInbound } = vi.hoisted(() => ({
  isGatewayDraining: vi.fn<() => boolean>(() => true),
  writePendingInbound: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, isGatewayDraining };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return { ...actual, writePendingInbound };
});

vi.mock("openclaw/plugin-sdk/state-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/state-paths")>();
  return { ...actual, resolveStateDir: () => "/tmp/test-state-dir" };
});

// ── Shared harness (mocks loadConfig, reply, pairing, etc.) ───────────────
import { getLoadConfigMock, getOnHandler, onSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();

// ── Helpers ───────────────────────────────────────────────────────────────

function makeGroupMsgCtx(params: {
  text: string;
  fromId?: number;
  botId?: number;
  botUsername?: string;
  replyToBotMessageId?: number;
  entities?: { type: string; offset: number; length: number }[];
}) {
  return {
    message: {
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      from: { id: params.fromId ?? 99999, username: "testuser" },
      text: params.text,
      date: 1736380800,
      message_id: 42,
      ...(params.entities ? { entities: params.entities } : {}),
      ...(params.replyToBotMessageId !== undefined
        ? {
            reply_to_message: {
              message_id: params.replyToBotMessageId,
              from: { id: params.botId ?? 7777 },
            },
          }
        : {}),
    },
    me: {
      id: params.botId ?? 7777,
      username: params.botUsername ?? "openclaw_bot",
    },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

function makeGroupVoiceMsgCtx(params: {
  fromId?: number;
  botId?: number;
  botUsername?: string;
  caption?: string;
  disableAudioPreflight?: boolean;
}) {
  return {
    message: {
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      from: { id: params.fromId ?? 99999, username: "testuser" },
      date: 1736380800,
      message_id: 43,
      voice: { file_id: "voice-file-id-001", duration: 5, mime_type: "audio/ogg" },
      ...(params.caption !== undefined ? { caption: params.caption } : {}),
    },
    me: {
      id: params.botId ?? 7777,
      username: params.botUsername ?? "openclaw_bot",
    },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("drain-time mention gating", () => {
  beforeEach(() => {
    onSpy.mockReset();
    writePendingInbound.mockReset();
    isGatewayDraining.mockReturnValue(true);
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: {
            "*": { requireMention: true, allowFrom: ["*"] },
          },
        },
      },
    });
  });

  it("queues group slash command even when bot is not mentioned (command bypass)", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    // /status is a known control command — should bypass mention gate
    await handler(makeGroupMsgCtx({ text: "/status" }));

    expect(writePendingInbound).toHaveBeenCalledTimes(1);
  });

  it("drops regular group message when requireMention=true and bot not mentioned", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(makeGroupMsgCtx({ text: "hey everyone" }));

    expect(writePendingInbound).not.toHaveBeenCalled();
  });

  it("queues group message when bot is explicitly @mentioned", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(
      makeGroupMsgCtx({
        text: "@openclaw_bot what is 2+2",
        entities: [{ type: "mention", offset: 0, length: 14 }],
      }),
    );

    expect(writePendingInbound).toHaveBeenCalledTimes(1);
  });

  it("queues group message when it is a reply to a bot message (implicit mention)", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(
      makeGroupMsgCtx({
        text: "yes please",
        replyToBotMessageId: 99,
      }),
    );

    expect(writePendingInbound).toHaveBeenCalledTimes(1);
  });

  it("does not queue anything when gateway is not draining", async () => {
    isGatewayDraining.mockReturnValue(false);
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    // A slash command — without drain, this goes through normal processing (replySpy),
    // not writePendingInbound.
    await handler(makeGroupMsgCtx({ text: "/status" }));

    expect(writePendingInbound).not.toHaveBeenCalled();
  });
});

describe("drain-time voice mention preflight", () => {
  beforeEach(() => {
    onSpy.mockReset();
    writePendingInbound.mockReset();
    isGatewayDraining.mockReturnValue(true);
    // mentionPatterns are required so that mentionRegexes.length > 0, which
    // mirrors the needsPreflightTranscription condition from bot-message-context.body.ts:
    // audio preflight only runs when there are patterns to match in the transcript.
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: {
            "*": { requireMention: true, allowFrom: ["*"] },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["openclaw"],
        },
      },
    });
  });

  it("queues voice-only group message even when bot is not mentioned (audio preflight deferred)", async () => {
    // A voice-only message in a group with requireMention=true has no text/caption
    // to check for a mention at drain time. The mention check must be deferred to
    // replay time so the audio can be transcribed first.
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(makeGroupVoiceMsgCtx({}));

    expect(writePendingInbound).toHaveBeenCalledTimes(1);
  });

  it("drops regular text group message without mention (gate still enforced for text)", async () => {
    // Text messages still go through the normal mention gate — only audio-only is bypassed.
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    await handler(makeGroupMsgCtx({ text: "no mention here" }));

    expect(writePendingInbound).not.toHaveBeenCalled();
  });

  it("voice message with caption is NOT bypassed (caption can be checked for mentions directly)", async () => {
    // If the voice message has a caption, the caption text is available for mention
    // checking at drain time — no audio preflight is needed, so the gate applies.
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    // Caption present but does not mention the bot
    await handler(makeGroupVoiceMsgCtx({ caption: "listen to this" }));

    expect(writePendingInbound).not.toHaveBeenCalled();
  });

  it("voice message with caption that mentions the bot IS queued", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message");

    // Caption explicitly mentions the bot
    await handler(makeGroupVoiceMsgCtx({ caption: "@openclaw_bot check this out" }));

    expect(writePendingInbound).toHaveBeenCalledTimes(1);
  });
});
