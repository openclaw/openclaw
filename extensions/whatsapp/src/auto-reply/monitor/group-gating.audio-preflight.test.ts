// Whatsapp tests cover group gating.audio preflight plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import { createTestWebAudioInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";
import { clearGroupListenWindowsForTest } from "./group-listen-window.js";

function makeGroupAudioMsg(): AdmittedWebInboundMessage {
  return createTestWebAudioInboundMessage({
    platform: {
      chatJid: "1203630@g.us",
      sender: { e164: "+15550000002", name: "Alice" },
    },
    admission: {
      conversation: {
        kind: "group",
        id: "1203630@g.us",
      },
      sender: {
        id: "+15550000002",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    wasMentioned: false,
  });
}

function makeParams(
  msg: AdmittedWebInboundMessage,
  groupHistories: Map<string, GroupHistoryEntry[]>,
) {
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
    clearGroupListenWindowsForTest();
    groupHistories = new Map();
    vi.useFakeTimers({ now: new Date("2026-07-18T19:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(msg.groupMention).toEqual({ wasMentioned: true, requireMention: true });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("carries always-on activation into dispatch", async () => {
    vi.mocked(resolveGroupActivationFor).mockResolvedValueOnce("always");
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating(makeParams(msg, groupHistories));

    expect(result).toEqual({ shouldProcess: true });
    expect(msg.groupMention).toEqual({ wasMentioned: false, requireMention: false });
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

  it("accepts follow-up messages during a configured listen-after-mention window", async () => {
    const first = makeGroupAudioMsg();
    const firstParams = makeParams(first, groupHistories);
    (
      firstParams.cfg as never as { channels: { whatsapp: { groups?: unknown } } }
    ).channels.whatsapp.groups = {
      "1203630@g.us": {
        requireMention: true,
        listenAfterMentionMs: 10 * 60 * 1000,
        listenAfterMentionMaxMs: 30 * 60 * 1000,
      },
    };

    await expect(
      applyGroupGating({
        ...firstParams,
        mentionText: "openclaw please summarize the thread",
      }),
    ).resolves.toEqual({ shouldProcess: true });

    vi.setSystemTime(new Date("2026-07-18T19:05:00.000Z"));
    const followUp = makeGroupAudioMsg();
    const followUpParams = makeParams(followUp, groupHistories);
    (
      followUpParams.cfg as never as { channels: { whatsapp: { groups?: unknown } } }
    ).channels.whatsapp.groups = (
      firstParams.cfg as never as { channels: { whatsapp: { groups?: unknown } } }
    ).channels.whatsapp.groups;

    await expect(applyGroupGating(followUpParams)).resolves.toEqual({ shouldProcess: true });
    expect(followUp.groupMention).toEqual({ wasMentioned: false, requireMention: false });
  });

  it("stops extending the listen-after-mention window at the configured cap", async () => {
    const first = makeGroupAudioMsg();
    const firstParams = makeParams(first, groupHistories);
    (
      firstParams.cfg as never as { channels: { whatsapp: { groups?: unknown } } }
    ).channels.whatsapp.groups = {
      "*": {
        listenAfterMentionMs: 10 * 60 * 1000,
        listenAfterMentionMaxMs: 15 * 60 * 1000,
      },
    };

    await applyGroupGating({
      ...firstParams,
      mentionText: "openclaw please summarize the thread",
    });

    vi.setSystemTime(new Date("2026-07-18T19:09:00.000Z"));
    const extendingFollowUpParams = makeParams(makeGroupAudioMsg(), groupHistories);
    extendingFollowUpParams.cfg = firstParams.cfg;
    await expect(applyGroupGating(extendingFollowUpParams)).resolves.toEqual({
      shouldProcess: true,
    });

    vi.setSystemTime(new Date("2026-07-18T19:14:00.000Z"));
    const cappedFollowUpParams = makeParams(makeGroupAudioMsg(), groupHistories);
    cappedFollowUpParams.cfg = firstParams.cfg;
    await expect(applyGroupGating(cappedFollowUpParams)).resolves.toEqual({
      shouldProcess: true,
    });

    vi.setSystemTime(new Date("2026-07-18T19:16:00.000Z"));
    const expiredFollowUpParams = makeParams(makeGroupAudioMsg(), groupHistories);
    expiredFollowUpParams.cfg = firstParams.cfg;
    await expect(applyGroupGating(expiredFollowUpParams)).resolves.toEqual({
      shouldProcess: false,
    });
  });

  it("does not re-open a listen-after-mention window from /activation mention", async () => {
    const first = makeGroupAudioMsg();
    const firstParams = makeParams(first, groupHistories);
    (
      firstParams.cfg as never as { channels: { whatsapp: { groups?: unknown } } }
    ).channels.whatsapp.groups = {
      "*": {
        listenAfterMentionMs: 10 * 60 * 1000,
      },
    };
    (
      firstParams.cfg as never as { channels: { whatsapp: { allowFrom?: string[] } } }
    ).channels.whatsapp.allowFrom = ["+15550000002"];

    await applyGroupGating({
      ...firstParams,
      mentionText: "openclaw please summarize the thread",
    });

    vi.setSystemTime(new Date("2026-07-18T19:05:00.000Z"));
    const command = makeGroupAudioMsg();
    command.payload.body = "/activation mention";
    const commandParams = makeParams(command, groupHistories);
    commandParams.cfg = firstParams.cfg;
    await expect(applyGroupGating(commandParams)).resolves.toEqual({ shouldProcess: true });

    vi.setSystemTime(new Date("2026-07-18T19:06:00.000Z"));
    const followUpParams = makeParams(makeGroupAudioMsg(), groupHistories);
    followUpParams.cfg = firstParams.cfg;
    await expect(applyGroupGating(followUpParams)).resolves.toEqual({
      shouldProcess: false,
    });
  });
});
