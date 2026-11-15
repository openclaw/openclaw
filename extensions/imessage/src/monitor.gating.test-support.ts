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
    readStoreAllowFrom: async () => params.storeAllowFrom ?? [],
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

function inbound(overrides: IMessagePayload = {}): IMessagePayload {
  return { ...groupMessage(3, 42, "+15550002222", "@openclaw ping"), ...overrides };
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
    expect(decision).toEqual({ kind: "drop", reason: "no mention" });
  });

  it("dispatches group messages with mention and builds a group envelope", async () => {
    const cfg = baseCfg();
    const message = inbound({
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    });
    const ctxPayload = await buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload).toMatchObject({
      ChatType: "group",
      SessionKey: "agent:main:imessage:group:42",
      To: "chat_id:42",
    });
    expect(ctxPayload.Body ?? "").toContain("+15550002222:");
    expect(ctxPayload.Body ?? "").not.toContain("[from:");
  });

  it("uses short message ids in context and keeps the full guid for actions", async () => {
    const cfg = baseCfg();
    const message = inbound({
      guid: "full-message-guid",
      chat_guid: "iMessage;+;chat0000",
      chat_identifier: "thread-42",
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    });
    const ctxPayload = await buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload).toMatchObject({ MessageSid: "1", MessageSidFull: "full-message-guid" });
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
      const message = inbound({
        id: 5,
        chat_id: 55,
        sender: "+15550001111",
        text: "replying now",
        is_group: false,
        ...parent,
        reply_to_text: "original message",
        reply_to_sender: "+15559998888",
      });
      const ctxPayload = await buildDispatchContextPayload({ cfg: baseCfg(), message });

      expect(ctxPayload).toMatchObject({
        ReplyToId: expected,
        ReplyToBody: "original message",
        ReplyToSender: "+15559998888",
      });
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

  it.each([
    ["chat target", "allowlist", "chat_id:55", false],
    ["access group", "allowlist", "accessGroup:oncall", true],
    ["allowlist_quote mode", "allowlist_quote", "+15550001111", false],
  ] as const)(
    "keeps group reply context for %s",
    async (_, contextVisibility, allowed, accessGroup) => {
      const cfg = baseCfg({ groupPolicy: "allowlist", contextVisibility });
      const message = groupReplyMessage(8, "quoted context");
      if (accessGroup) {
        cfg.accessGroups = {
          oncall: { type: "message.senders", members: { imessage: ["+15559998888"] } },
        };
        message.sender = "+15559998888";
      }
      const ctxPayload = await buildDispatchContextPayload({
        cfg,
        message,
        groupAllowFrom: [allowed],
        groupPolicy: "allowlist",
      });
      expect(ctxPayload).toMatchObject({
        ReplyToId: "parent-9001",
        ReplyToBody: "quoted context",
        ReplyToSender: "+15559998888",
      });
      expect(ctxPayload.Body ?? "").toContain("[Replying to +15559998888 id:parent-9001]");
    },
  );

  it("treats configured chat_id as a group session even when is_group is false", async () => {
    const cfg = baseCfg({ groups: { "2": { requireMention: false } } });

    const message = inbound({ chat_id: 2, text: "hello", is_group: false });
    const { decision } = await resolveDispatchDecision({ cfg, message });
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
    const params = {
      cfg: baseCfg({ groupPolicy: "allowlist" }),
      groupAllowFrom: ["chat_id:101"],
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      storeAllowFrom: ["+15550003333"],
      groupHistories: new Map(),
    };
    const denied = await resolveDecision({
      ...params,
      message: groupMessage(3, 202, "+15550003333", "@openclaw hi"),
    });
    expect(denied.kind).toBe("drop");

    const allowed = await resolveDecision({
      ...params,
      message: groupMessage(33, 101, "+15550003333", "@openclaw ok"),
    });
    expect(allowed.kind).toBe("dispatch");
  });

  it.each([
    ["legacy admission", ["chat_id:101"], [], true, "@openclaw ok", undefined],
    [
      "explicit empty group allowlist",
      ["chat_id:101"],
      [],
      false,
      "@openclaw ok",
      "groupPolicy allowlist (empty groupAllowFrom)",
    ],
    [
      "configured group allowlist",
      ["chat_id:101"],
      ["+15550004444"],
      false,
      "@openclaw ok",
      "not in groupAllowFrom",
    ],
    [
      "conversation command",
      [],
      ["chat_id:101"],
      false,
      "/status",
      "control command (unauthorized)",
    ],
    ["legacy command", ["chat_id:101"], [], true, "/status", "control command (unauthorized)"],
  ] as const)(
    "enforces %s authority",
    async (_, allowFrom, groupAllowFrom, legacy, text, reason) => {
      const decision = await resolveDecision({
        cfg: baseCfg({ groupPolicy: "allowlist" }),
        message: groupMessage(35, 101, "+15550003333", text),
        allowFrom: [...allowFrom],
        groupAllowFrom: [...groupAllowFrom],
        allowLegacyConversationAllowFromForGroup: legacy,
        groupPolicy: "allowlist",
        dmPolicy: "pairing",
      });
      if (reason) {
        expect(decision).toEqual({ kind: "drop", reason });
      } else {
        expect(decision.kind).toBe("dispatch");
      }
    },
  );

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
