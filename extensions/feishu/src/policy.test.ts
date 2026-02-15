import { describe, expect, it } from "vitest";
import type { FeishuConfig } from "./types.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuReplyPolicy } from "./policy.js";

type EventOverrides = {
  sender?: Partial<FeishuMessageEvent["sender"]>;
  message?: Partial<FeishuMessageEvent["message"]>;
};

const baseGlobalConfig: FeishuConfig = {
  domain: "feishu",
  connectionMode: "websocket",
  webhookPath: "/feishu/events",
  dmPolicy: "pairing",
  groupPolicy: "allowlist",
  requireMention: true,
  replyOnAtAll: false,
};

function createEvent(overrides?: EventOverrides): FeishuMessageEvent {
  const senderOverrides = overrides?.sender;
  const messageOverrides = overrides?.message;

  return {
    sender: {
      sender_id: {
        open_id: "ou_sender",
        ...(senderOverrides?.sender_id ?? {}),
      },
      sender_type: senderOverrides?.sender_type,
      tenant_key: senderOverrides?.tenant_key,
    },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: [],
      ...(messageOverrides ?? {}),
    },
  };
}

describe("resolveFeishuReplyPolicy", () => {
  it("defaults to no @all triggering", () => {
    const policy = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: baseGlobalConfig,
    });

    expect(policy.requireMention).toBe(true);
    expect(policy.replyOnAtAll).toBe(false);
  });

  it("enables @all triggering when configured", () => {
    const policy = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: { ...baseGlobalConfig, replyOnAtAll: true },
    });

    expect(policy.replyOnAtAll).toBe(true);
  });

  it("never enables @all triggering in direct messages", () => {
    const policy = resolveFeishuReplyPolicy({
      isDirectMessage: true,
      globalConfig: { ...baseGlobalConfig, replyOnAtAll: true },
    });

    expect(policy.requireMention).toBe(false);
    expect(policy.replyOnAtAll).toBe(false);
  });
});

describe("parseFeishuMessageEvent", () => {
  it("detects @all from mention metadata", () => {
    const event = createEvent({
      message: {
        mentions: [
          {
            key: "@_all_1",
            id: { user_id: "all" },
            name: "Everyone",
          },
        ],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(true);
  });

  it("detects @all from text fallback when mention metadata is absent", () => {
    const event = createEvent({
      message: {
        content: JSON.stringify({ text: '<at user_id="all">Everyone</at> hello' }),
        mentions: [],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(true);
  });

  it("detects @all from card-style id=all text fallback", () => {
    const event = createEvent({
      message: {
        content: JSON.stringify({ text: "<at id=all></at> hello" }),
        mentions: [],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(true);
  });

  it("detects @all from mention key fallback", () => {
    const event = createEvent({
      message: {
        mentions: [
          {
            key: "<at id=all></at>",
            id: {},
            name: "All",
          },
        ],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(true);
  });

  it("detects @_all literal from real Feishu payload (no mentions array)", () => {
    const event = createEvent({
      message: {
        content: JSON.stringify({ text: "@_all hello" }),
        mentions: [],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(true);
  });

  it("does not false-positive on normal text containing 'all'", () => {
    const event = createEvent({
      message: {
        content: JSON.stringify({ text: "hello to all of you" }),
        mentions: [],
      },
    });

    const parsed = parseFeishuMessageEvent(event, "ou_bot");
    expect(parsed.mentionedAll).toBe(false);
  });
});
