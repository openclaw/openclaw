// Whatsapp tests cover group gating for ingest-only senders and groups.<jid>.ingest hooks.
import { describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

const hookMocks = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return { ...actual, triggerInternalHook: hookMocks.triggerInternalHook };
});

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { MentionConfig } from "../mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

const GROUP_JID = "120363401234567890@g.us";
const STRANGER = "+15550002222";

function makeGroupMsg(params: {
  body: string;
  ingestOnly: boolean;
  media?: { type: string; path: string; kind: "audio" };
}) {
  return createTestWebInboundMessage({
    event: { id: "msg-ingest", timestamp: 1700000000 },
    payload: { body: params.body, ...(params.media ? { media: params.media } : {}) },
    platform: {
      chatJid: GROUP_JID,
      recipientJid: "+15550000001",
      sender: { e164: STRANGER, name: "Alice" },
    },
    admission: {
      accountId: "default",
      conversation: { kind: "group", id: GROUP_JID },
      sender: { id: STRANGER },
      ...(params.ingestOnly
        ? {
            ingress: {
              admission: "skip",
              decision: "block",
              decisiveGateId: "sender:group",
              reasonCode: "group_policy_not_allowlisted",
            },
            senderAccess: {
              allowed: false,
              decision: "block",
              reasonCode: "group_policy_not_allowlisted",
            },
          }
        : { senderAccess: { reasonCode: "group_policy_allowed" } }),
    },
  });
}

function makeParams(
  msg: ReturnType<typeof makeGroupMsg>,
  groupEntry?: Record<string, unknown>,
  extra?: { deferMissingMention?: boolean },
) {
  const groupHistories = new Map<string, GroupHistoryEntry[]>();
  const groupHistoryKey = `whatsapp:group:${GROUP_JID}`;
  return {
    groupHistories,
    groupHistoryKey,
    params: {
      cfg: {
        channels: {
          whatsapp: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["+15550001111"],
            ...(groupEntry ? { groups: { [GROUP_JID]: groupEntry } } : {}),
          },
        },
        messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
      } as never,
      msg,
      ...(extra?.deferMissingMention !== undefined
        ? { deferMissingMention: extra.deferMissingMention }
        : {}),
      groupHistoryKey,
      agentId: "main",
      sessionKey: `agent:main:whatsapp:group:${GROUP_JID}`,
      baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
      groupHistories,
      groupHistoryLimit: 20,
      groupMemberNames: new Map<string, Map<string, string>>(),
      logVerbose: vi.fn(),
      replyLogger: { debug: vi.fn(), warn: vi.fn() },
    },
  };
}

describe("applyGroupGating ingest-only senders", () => {
  it("stores an ingest-only @-mention for context without starting a turn", async () => {
    hookMocks.triggerInternalHook.mockClear();
    const msg = makeGroupMsg({ body: "@openclaw please summarize", ingestOnly: true });
    const { params, groupHistories, groupHistoryKey } = makeParams(msg);

    await expect(applyGroupGating(params)).resolves.toEqual({ shouldProcess: false });

    expect(groupHistories.get(groupHistoryKey)).toEqual([
      expect.objectContaining({
        body: "@openclaw please summarize",
        sender: `Alice (${STRANGER})`,
      }),
    ]);
    expect(params.groupMemberNames.get(groupHistoryKey)?.get(STRANGER)).toBe("Alice");
    expect(hookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("still processes the same @-mention from an allowlisted sender", async () => {
    const msg = makeGroupMsg({ body: "@openclaw please summarize", ingestOnly: false });
    const { params } = makeParams(msg);

    await expect(applyGroupGating(params)).resolves.toEqual({ shouldProcess: true });
  });

  it("emits internal message:received for skipped messages when groups.<jid>.ingest is true", async () => {
    hookMocks.triggerInternalHook.mockClear();
    const msg = makeGroupMsg({ body: "hello without mention", ingestOnly: true });
    const { params } = makeParams(msg, { ingest: true });

    await expect(applyGroupGating(params)).resolves.toEqual({ shouldProcess: false });

    expect(hookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    const [event] = hookMocks.triggerInternalHook.mock.calls[0] as [
      { type: string; action: string; sessionKey: string; context: Record<string, unknown> },
    ];
    expect(event.type).toBe("message");
    expect(event.action).toBe("received");
    expect(event.sessionKey).toBe(params.sessionKey);
    expect(event.context).toMatchObject({
      from: GROUP_JID,
      content: "hello without mention",
      channelId: "whatsapp",
      accountId: "default",
      conversationId: GROUP_JID,
      messageId: "msg-ingest",
    });
  });

  it("does not emit hooks for skipped messages when ingest is unset", async () => {
    hookMocks.triggerInternalHook.mockClear();
    const msg = makeGroupMsg({ body: "hello without mention", ingestOnly: false });
    const { params } = makeParams(msg, { requireMention: true });

    await expect(applyGroupGating(params)).resolves.toEqual({ shouldProcess: false });

    expect(hookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("never requests audio transcription for an ingest-only sender's voice message", async () => {
    // needsMentionText is the only signal that makes on-message.ts run STT
    // preflight (see auto-reply/monitor/on-message.ts deferMissingMention
    // handling). Ingest-only admissions must resolve before that branch runs.
    const msg = makeGroupMsg({
      body: "",
      ingestOnly: true,
      media: { type: "audio/ogg; codecs=opus", path: "/tmp/voice.ogg", kind: "audio" },
    });
    const { params } = makeParams(msg, undefined, { deferMissingMention: true });

    const result = await applyGroupGating(params);

    expect(result).toEqual({ shouldProcess: false });
    expect("needsMentionText" in result).toBe(false);
  });
});
