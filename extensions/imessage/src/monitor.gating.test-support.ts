// Imessage tests cover monitor.gating plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { parseIMessageNotification } from "./monitor/parse-notification.js";
import type { IMessagePayload } from "./monitor/types.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type InboundProcessingModule = typeof import("./monitor/inbound-processing.js");
type DecisionParams = Parameters<InboundProcessingModule["resolveIMessageInboundDecision"]>[0];
let buildIMessageInboundContext: InboundProcessingModule["buildIMessageInboundContext"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];

function baseCfg(
  imessage: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>> = {},
): OpenClawConfig {
  return {
    channels: {
      imessage: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
        ...imessage,
      },
    },
    session: { mainKey: "main" },
    messages: {
      groupChat: { mentionPatterns: ["@openclaw"] },
    },
  } as unknown as OpenClawConfig;
}

async function resolve(params: {
  cfg?: OpenClawConfig;
  message: IMessagePayload;
  storeAllowFrom?: string[];
}) {
  const cfg = params.cfg ?? baseCfg();
  return resolveDecision({
    cfg,
    message: params.message,
    groupPolicy: cfg.channels?.imessage?.groupPolicy ?? "open",
    dmPolicy: cfg.channels?.imessage?.dmPolicy ?? "pairing",
    storeAllowFrom: params.storeAllowFrom ?? [],
  });
}

async function resolveDecision(params: {
  cfg: OpenClawConfig;
  message: IMessagePayload;
  groupHistories?: DecisionParams["groupHistories"];
  allowFrom?: string[];
  groupAllowFrom?: string[];
  allowLegacyConversationAllowFromForGroup?: boolean;
  groupPolicy?: string;
  dmPolicy?: string;
  storeAllowFrom?: string[];
}) {
  return resolveIMessageInboundDecision({
    cfg: params.cfg,
    accountId: "default",
    message: params.message,
    opts: {},
    messageText: params.message.text ?? "",
    bodyText: params.message.text ?? "",
    allowFrom: params.allowFrom ?? ["*"],
    groupAllowFrom: params.groupAllowFrom ?? [],
    allowLegacyConversationAllowFromForGroup: params.allowLegacyConversationAllowFromForGroup,
    groupPolicy: params.groupPolicy ?? "open",
    dmPolicy: params.dmPolicy ?? "open",
    storeAllowFrom: params.storeAllowFrom ?? [],
    historyLimit: 0,
    groupHistories: params.groupHistories ?? new Map(),
  });
}

async function resolveDispatchDecision(params: Parameters<typeof resolveDecision>[0]) {
  const groupHistories = params.groupHistories ?? new Map();
  const decision = await resolveDecision({ ...params, groupHistories });
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected dispatch decision");
  }
  return { decision, groupHistories };
}

async function buildDispatchContextPayload(params: {
  cfg: OpenClawConfig;
  message: IMessagePayload;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: string;
}) {
  const { cfg, message } = params;
  const { decision, groupHistories } = await resolveDispatchDecision(params);

  const { ctxPayload } = await buildIMessageInboundContext({
    cfg,
    accountService: cfg.channels?.imessage?.service,
    decision,
    message,
    historyLimit: 0,
    groupHistories,
  });

  return ctxPayload;
}

function groupMessage(id: number, chatId: number, sender: string, text: string): IMessagePayload {
  return {
    id,
    chat_id: chatId,
    sender,
    is_from_me: false,
    text,
    is_group: true,
  };
}

function groupReplyMessage(id: number, quote: string): IMessagePayload {
  return {
    ...groupMessage(id, 55, "+15550001111", "@openclaw replying now"),
    reply_to_guid: "parent-9001",
    reply_to_text: quote,
    reply_to_sender: "+15559998888",
  };
}

describe("imessage monitor gating + envelope builders", () => {
  beforeEach(async () => {
    await loadFreshIMessageReplyCacheForTest();
    ({ buildIMessageInboundContext, resolveIMessageInboundDecision } =
      await import("./monitor/inbound-processing.js"));
  });

  it("parseIMessageNotification rejects malformed payloads", async () => {
    expect(
      parseIMessageNotification({
        message: { chat_id: 1, sender: { nested: "nope" } },
      }),
    ).toBeNull();
  });

  it("parseIMessageNotification preserves destination_caller_id metadata", async () => {
    expect(
      parseIMessageNotification({
        message: {
          id: 1,
          sender: "+15550001111",
          destination_caller_id: "+15550002222",
          is_from_me: true,
          text: "hello",
        },
      }),
    ).toEqual({
      id: 1,
      sender: "+15550001111",
      destination_caller_id: "+15550002222",
      is_from_me: true,
      text: "hello",
    });
  });

  it("drops group messages without mention by default", async () => {
    const decision = await resolve({
      message: groupMessage(1, 99, "+15550001111", "hello group"),
    });
    expect(decision.kind).toBe("drop");
    if (decision.kind !== "drop") {
      throw new Error("expected drop decision");
    }
    expect(decision.reason).toBe("no mention");
  });

  it("dispatches group messages with mention and builds a group envelope", async () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      id: 3,
      chat_id: 42,
      sender: "+15550002222",
      is_from_me: false,
      text: "@openclaw ping",
      is_group: true,
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    };
    const ctxPayload = await buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.ChatType).toBe("group");
    expect(ctxPayload.SessionKey).toBe("agent:main:imessage:group:42");
    expect(ctxPayload.Body ?? "").toContain("+15550002222:");
    expect(ctxPayload.Body ?? "").not.toContain("[from:");
    expect(ctxPayload.To).toBe("chat_id:42");
  });

  it("uses short message ids in context and keeps the full guid for actions", async () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      id: 3,
      guid: "full-message-guid",
      chat_id: 42,
      chat_guid: "iMessage;+;chat0000",
      chat_identifier: "thread-42",
      sender: "+15550002222",
      is_from_me: false,
      text: "@openclaw ping",
      is_group: true,
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    };
    const ctxPayload = await buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.MessageSid).toBe("1");
    expect(ctxPayload.MessageSidFull).toBe("full-message-guid");
  });

  it.each([
    { parent: { reply_to_guid: "reply-parent" }, expected: "reply-parent" },
    { parent: { thread_originator_guid: "thread-parent" }, expected: "thread-parent" },
    {
      parent: { thread_originator_guid: "thread-parent", reply_to_guid: "reply-parent" },
      expected: "thread-parent",
    },
  ])(
    "includes the authoritative reply parent, context fields, and suffix",
    async ({ parent, expected }) => {
      const message: IMessagePayload = {
        id: 5,
        chat_id: 55,
        sender: "+15550001111",
        is_from_me: false,
        text: "replying now",
        is_group: false,
        ...parent,
        reply_to_text: "original message",
        reply_to_sender: "+15559998888",
      };
      const ctxPayload = await buildDispatchContextPayload({ cfg: baseCfg(), message });

      expect(ctxPayload.ReplyToId).toBe(expected);
      expect(ctxPayload.ReplyToBody).toBe("original message");
      expect(ctxPayload.ReplyToSender).toBe("+15559998888");
      expect(ctxPayload.Body ?? "").toContain(`[Replying to +15559998888 id:${expected}]`);
      expect(ctxPayload.Body ?? "").toContain("original message");
    },
  );

  it("drops group reply context from non-allowlisted senders in allowlist mode", async () => {
    const cfg = baseCfg({
      groupPolicy: "allowlist",
      contextVisibility: "allowlist",
    });

    const message: IMessagePayload = groupReplyMessage(6, "blocked quote");
    const ctxPayload = await buildDispatchContextPayload({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
    });

    expect(ctxPayload.ReplyToId).toBeUndefined();
    expect(ctxPayload.ReplyToBody).toBeUndefined();
    expect(ctxPayload.ReplyToSender).toBeUndefined();
    expect(ctxPayload.Body ?? "").not.toContain("[Replying to");
  });

  it("keeps group reply context when the group allowlist matches the chat target", async () => {
    const cfg = baseCfg({
      groupPolicy: "allowlist",
      contextVisibility: "allowlist",
    });

    const message: IMessagePayload = groupReplyMessage(8, "quoted context");
    const ctxPayload = await buildDispatchContextPayload({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["chat_id:55"],
      groupPolicy: "allowlist",
    });

    expect(ctxPayload.ReplyToId).toBe("parent-9001");
    expect(ctxPayload.ReplyToBody).toBe("quoted context");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(ctxPayload.Body ?? "").toContain("[Replying to +15559998888 id:parent-9001]");
  });

  it("keeps group reply context when the group allowlist matches an access group", async () => {
    const cfg = baseCfg({
      groupPolicy: "allowlist",
      contextVisibility: "allowlist",
    });
    cfg.accessGroups = {
      oncall: {
        type: "message.senders",
        members: { imessage: ["+15559998888"] },
      },
    };

    const message: IMessagePayload = {
      id: 9,
      chat_id: 56,
      sender: "+15559998888",
      is_from_me: false,
      text: "@openclaw replying now",
      is_group: true,
      reply_to_guid: "parent-9002",
      reply_to_text: "own quoted context",
      reply_to_sender: "+15559998888",
    };
    const ctxPayload = await buildDispatchContextPayload({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["accessGroup:oncall"],
      groupPolicy: "allowlist",
    });

    expect(ctxPayload.ReplyToId).toBe("parent-9002");
    expect(ctxPayload.ReplyToBody).toBe("own quoted context");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(ctxPayload.Body ?? "").toContain("[Replying to +15559998888 id:parent-9002]");
  });

  it("keeps group reply context in allowlist_quote mode", async () => {
    const cfg = baseCfg({
      groupPolicy: "allowlist",
      contextVisibility: "allowlist_quote",
    });

    const message: IMessagePayload = groupReplyMessage(7, "quoted context");
    const ctxPayload = await buildDispatchContextPayload({
      cfg,
      message,
      allowFrom: ["*"],
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
    });

    expect(ctxPayload.ReplyToId).toBe("parent-9001");
    expect(ctxPayload.ReplyToBody).toBe("quoted context");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(ctxPayload.Body ?? "").toContain("[Replying to +15559998888 id:parent-9001]");
  });

  it("treats configured chat_id as a group session even when is_group is false", async () => {
    const cfg = baseCfg({ groups: { "2": { requireMention: false } } });

    const groupHistories = new Map();
    const message: IMessagePayload = {
      id: 14,
      chat_id: 2,
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
      is_group: false,
    };
    const { decision } = await resolveDispatchDecision({ cfg, message, groupHistories });
    expect(decision.isGroup).toBe(true);
    expect(decision.route.sessionKey).toBe("agent:main:imessage:group:2");
  });

  it("allows group messages when requireMention is true but no mentionPatterns exist", async () => {
    const cfg = baseCfg();
    cfg.messages ??= {};
    cfg.messages.groupChat ??= {};
    cfg.messages.groupChat.mentionPatterns = [];

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(12, 777, "+15550001111", "hello group"),
      groupPolicy: "open",
      dmPolicy: "open",
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("blocks group messages when imessage.groups is set without a wildcard", async () => {
    const cfg = baseCfg({ groups: { "99": { requireMention: false } } });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(13, 123, "+15550001111", "@openclaw hello"),
      groupPolicy: "open",
      dmPolicy: "open",
    });
    expect(decision.kind).toBe("drop");
  });

  it("honors group allowlist and ignores pairing-store senders in groups", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const groupHistories = new Map();
    const denied = await resolveDecision({
      cfg,
      message: groupMessage(3, 202, "+15550003333", "@openclaw hi"),
      allowFrom: ["*"],
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      storeAllowFrom: ["+15550003333"],
      groupHistories,
    });
    expect(denied.kind).toBe("drop");

    const allowed = await resolveDecision({
      cfg,
      message: groupMessage(33, 101, "+15550003333", "@openclaw ok"),
      allowFrom: ["*"],
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      storeAllowFrom: ["+15550003333"],
      groupHistories,
    });
    expect(allowed.kind).toBe("dispatch");
  });

  it("uses legacy conversation allowFrom entries for group admission", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const { decision } = await resolveDispatchDecision({
      cfg,
      message: groupMessage(35, 101, "+15550003333", "@openclaw ok"),
      allowFrom: ["chat_id:101"],
      groupAllowFrom: [],
      allowLegacyConversationAllowFromForGroup: true,
      groupPolicy: "allowlist",
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not use legacy conversation allowFrom entries when groupAllowFrom is explicitly empty", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(38, 101, "+15550003333", "@openclaw ok"),
      allowFrom: ["chat_id:101"],
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
    });

    expect(decision).toEqual({
      kind: "drop",
      reason: "groupPolicy allowlist (empty groupAllowFrom)",
    });
  });

  it("does not merge legacy conversation allowFrom entries when groupAllowFrom is configured", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(37, 101, "+15550003333", "@openclaw ok"),
      allowFrom: ["chat_id:101"],
      groupAllowFrom: ["+15550004444"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
    });

    expect(decision).toEqual({ kind: "drop", reason: "not in groupAllowFrom" });
  });

  it("does not authorize group control commands from conversation allowlist entries", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(34, 101, "+15550003333", "/status"),
      allowFrom: [],
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
    });

    expect(decision).toEqual({ kind: "drop", reason: "control command (unauthorized)" });
  });

  it("does not authorize group control commands from legacy conversation allowFrom entries", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist" });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(36, 101, "+15550003333", "/status"),
      allowFrom: ["chat_id:101"],
      groupAllowFrom: [],
      allowLegacyConversationAllowFromForGroup: true,
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
    });

    expect(decision).toEqual({ kind: "drop", reason: "control command (unauthorized)" });
  });

  it("blocks group messages when groupPolicy is disabled", async () => {
    const cfg = baseCfg({ groupPolicy: "disabled" });

    const decision = await resolveDecision({
      cfg,
      message: groupMessage(10, 303, "+15550003333", "@openclaw hi"),
      groupPolicy: "disabled",
      dmPolicy: "open",
    });
    expect(decision.kind).toBe("drop");
  });
});
