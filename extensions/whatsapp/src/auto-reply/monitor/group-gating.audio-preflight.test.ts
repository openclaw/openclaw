// Whatsapp tests cover group gating.audio preflight plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import { createTestWebAudioInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

function makeGroupAudioMsg(): WebInboundMessage {
  return createTestWebAudioInboundMessage({
    platform: {
      chatJid: "1203630@g.us",
      sender: { e164: "+15550000002", name: "Alice" },
    },
    from: "1203630@g.us",
    conversationId: "1203630@g.us",
    chatType: "group",
    wasMentioned: false,
  });
}

function makeParams(msg: WebInboundMessage, groupHistories: Map<string, GroupHistoryEntry[]>) {
  return {
    cfg: {
      channels: {
        whatsapp: {
          groupPolicy: "open",
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    } as never,
    msg,
    conversationId: "1203630@g.us",
    groupHistoryKey: "whatsapp:group:1203630",
    agentId: "main",
    sessionKey: "agent:main:whatsapp:group:1203630",
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories,
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  };
}

describe("applyGroupGating audio preflight mention text", () => {
  let groupHistories: Map<string, GroupHistoryEntry[]>;

  beforeEach(() => {
    groupHistories = new Map();
  });

  it("defers a missing mention without storing placeholder history", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      deferMissingMention: true,
    });

    expect(result).toEqual({ shouldProcess: false, needsMentionText: true });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("accepts voice transcript text that satisfies mention gating", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "openclaw please summarize the thread",
    });

    expect(result).toEqual({ shouldProcess: true });
    expect(msg.wasMentioned).toBe(true);
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("stores transcript text instead of the audio placeholder when mention is still missing", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "please summarize the thread",
    });

    expect(result).toEqual({ shouldProcess: false });
    expect(groupHistories.get("whatsapp:group:1203630")).toEqual([
      {
        sender: "Alice (+15550000002)",
        body: "please summarize the thread",
        timestamp: 1700000000,
        id: "msg-1",
        senderJid: undefined,
      },
    ]);
  });
});
