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
  imessage: NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]> = {},
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
  } satisfies OpenClawConfig;
}

function message(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 3,
    chat_id: 101,
    sender: "+15550003333",
    is_from_me: false,
    text: "@openclaw ok",
    is_group: true,
    ...overrides,
  };
}

function quotedMessage(overrides: Partial<IMessagePayload> = {}) {
  return message({
    id: 7,
    chat_id: 55,
    sender: "+15550001111",
    text: "@openclaw replying now",
    reply_to_guid: "parent-9001",
    reply_to_text: "quoted context",
    reply_to_sender: "+15559998888",
    ...overrides,
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

async function buildDispatchContextPayload(params: Parameters<typeof resolveDecision>[0]) {
  const { cfg, message: inbound } = params;
  const { decision, groupHistories } = await resolveDispatchDecision(params);

  const { ctxPayload } = await buildIMessageInboundContext({
    cfg,
    accountService: cfg.channels?.imessage?.service,
    decision,
    message: inbound,
    historyLimit: 0,
    groupHistories,
  });

  return ctxPayload;
}

function resolveGroup(
  inbound: IMessagePayload,
  overrides: Partial<Parameters<typeof resolveDecision>[0]> = {},
) {
  return resolveDecision({
    cfg: baseCfg({ groupPolicy: "allowlist" }),
    message: inbound,
    allowFrom: ["chat_id:101"],
    groupPolicy: "allowlist",
    dmPolicy: "pairing",
    ...overrides,
  });
}

async function quotedContext(
  groupAllowFrom: string[],
  inbound = quotedMessage(),
  cfg: OpenClawConfig = baseCfg({ groupPolicy: "allowlist", contextVisibility: "allowlist" }),
) {
  return buildDispatchContextPayload({
    cfg,
    message: inbound,
    allowFrom: ["*"],
    groupAllowFrom,
    groupPolicy: "allowlist",
  });
}

function expectQuote(
  ctx: Awaited<ReturnType<typeof quotedContext>>,
  body = "quoted context",
  id = "parent-9001",
) {
  expect(ctx).toMatchObject({ ReplyToId: id, ReplyToBody: body, ReplyToSender: "+15559998888" });
  expect(ctx.Body ?? "").toContain(`[Replying to +15559998888 id:${id}]`);
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
    const decision = await resolveDecision({
      cfg: baseCfg(),
      message: message({ id: 1, chat_id: 99, sender: "+15550001111", text: "hello group" }),
    });
    expect(decision).toMatchObject({ kind: "drop", reason: "no mention" });
  });

  it("dispatches group messages with mention and builds a group envelope", async () => {
    const cfg = baseCfg();
    const inbound = message({
      chat_id: 42,
      sender: "+15550002222",
      text: "@openclaw ping",
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    });
    const ctxPayload = await buildDispatchContextPayload({ cfg, message: inbound });

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
    const inbound = message({
      guid: "full-message-guid",
      chat_id: 42,
      chat_guid: "iMessage;+;chat0000",
      chat_identifier: "thread-42",
      sender: "+15550002222",
      text: "@openclaw ping",
      chat_name: "Lobster Squad",
      participants: ["+1555", "+1556"],
    });
    const ctxPayload = await buildDispatchContextPayload({ cfg, message: inbound });

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
      const inbound = message({
        id: 5,
        chat_id: 55,
        sender: "+15550001111",
        text: "replying now",
        is_group: false,
        ...parent,
        reply_to_text: "original message",
        reply_to_sender: "+15559998888",
      });
      const ctxPayload = await buildDispatchContextPayload({ cfg: baseCfg(), message: inbound });

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
    const ctxPayload = await quotedContext(
      ["+15550001111"],
      quotedMessage({ id: 6, reply_to_text: "blocked quote" }),
    );

    expect([ctxPayload.ReplyToId, ctxPayload.ReplyToBody, ctxPayload.ReplyToSender]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(ctxPayload.Body ?? "").not.toContain("[Replying to");
  });

  it("keeps group reply context when the group allowlist matches the chat target", async () => {
    expectQuote(await quotedContext(["chat_id:55"], quotedMessage({ id: 8 })));
  });

  it("keeps group reply context when the group allowlist matches an access group", async () => {
    const cfg: OpenClawConfig = baseCfg({
      groupPolicy: "allowlist",
      contextVisibility: "allowlist",
    });
    cfg.accessGroups = {
      oncall: {
        type: "message.senders",
        members: { imessage: ["+15559998888"] },
      },
    };

    const inbound = quotedMessage({
      id: 9,
      chat_id: 56,
      sender: "+15559998888",
      reply_to_guid: "parent-9002",
      reply_to_text: "own quoted context",
    });
    expectQuote(
      await quotedContext(["accessGroup:oncall"], inbound, cfg),
      "own quoted context",
      "parent-9002",
    );
  });

  it("keeps group reply context in allowlist_quote mode", async () => {
    const cfg = baseCfg({ groupPolicy: "allowlist", contextVisibility: "allowlist_quote" });
    expectQuote(await quotedContext(["+15550001111"], quotedMessage(), cfg));
  });

  it("treats configured chat_id as a group session even when is_group is false", async () => {
    const cfg = baseCfg({ groups: { "2": { requireMention: false } } });

    const groupHistories = new Map();
    const { decision } = await resolveDispatchDecision({
      cfg,
      groupHistories,
      message: message({
        id: 14,
        chat_id: 2,
        sender: "+15550001111",
        text: "hello",
        is_group: false,
      }),
    });
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
      message: message({ id: 12, chat_id: 777, sender: "+15550001111", text: "hello group" }),
      groupPolicy: "open",
      dmPolicy: "open",
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("blocks group messages when imessage.groups is set without a wildcard", async () => {
    const cfg = baseCfg({ groups: { "99": { requireMention: false } } });

    const decision = await resolveDecision({
      cfg,
      message: message({ id: 13, chat_id: 123, sender: "+15550001111", text: "@openclaw hello" }),
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
      message: message({ chat_id: 202, text: "@openclaw hi" }),
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
      message: message({ id: 33 }),
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
    const decision = await resolveGroup(message({ id: 35 }), {
      groupAllowFrom: [],
      allowLegacyConversationAllowFromForGroup: true,
      dmPolicy: "open",
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not use legacy conversation allowFrom entries when groupAllowFrom is explicitly empty", async () => {
    const decision = await resolveGroup(message({ id: 38 }), {
      groupAllowFrom: [],
    });

    expect(decision).toEqual({
      kind: "drop",
      reason: "groupPolicy allowlist (empty groupAllowFrom)",
    });
  });

  it("does not merge legacy conversation allowFrom entries when groupAllowFrom is configured", async () => {
    const decision = await resolveGroup(message({ id: 37 }), {
      groupAllowFrom: ["+15550004444"],
    });

    expect(decision).toEqual({ kind: "drop", reason: "not in groupAllowFrom" });
  });

  it("does not authorize group control commands from conversation allowlist entries", async () => {
    const decision = await resolveGroup(message({ id: 34, text: "/status" }), {
      allowFrom: [],
      groupAllowFrom: ["chat_id:101"],
    });

    expect(decision).toEqual({ kind: "drop", reason: "control command (unauthorized)" });
  });

  it("does not authorize group control commands from legacy conversation allowFrom entries", async () => {
    const decision = await resolveGroup(message({ id: 36, text: "/status" }), {
      groupAllowFrom: [],
      allowLegacyConversationAllowFromForGroup: true,
    });

    expect(decision).toEqual({ kind: "drop", reason: "control command (unauthorized)" });
  });

  it("blocks group messages when groupPolicy is disabled", async () => {
    const cfg = baseCfg({ groupPolicy: "disabled" });

    const decision = await resolveDecision({
      cfg,
      message: message({ id: 10, chat_id: 303, text: "@openclaw hi" }),
      groupPolicy: "disabled",
      dmPolicy: "open",
    });
    expect(decision.kind).toBe("drop");
  });
});
