import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";
import {
  createInboundDecisionParams,
  type InboundDecisionParams,
} from "./inbound-decision.test-support.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");

type ReplyCacheModule = typeof import("../monitor-reply-cache.js");
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let buildIMessageInboundContext: InboundProcessingModule["buildIMessageInboundContext"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];
const cfg = {} as OpenClawConfig;

beforeAll(async () => {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
  ({ buildIMessageInboundContext, resolveIMessageInboundDecision } =
    await import("./inbound-processing.js"));
});

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams({ cfg, ...overrides }));
}

async function buildContext(
  messageOverrides: Partial<InboundDecisionParams["message"]>,
  overrides: Parameters<typeof resolveDecision>[0] = {},
) {
  const message = makeMessage(messageOverrides);
  const admitted = await resolveDecision({ ...overrides, message });
  expect(admitted.kind).toBe("dispatch");
  if (admitted.kind !== "dispatch") {
    throw new Error("expected context fixture admission");
  }
  return buildIMessageInboundContext({
    cfg,
    accountService: undefined,
    decision: admitted,
    message,
    historyLimit: 0,
    groupHistories: new Map(),
  });
}

function makeMessage(overrides: Partial<InboundDecisionParams["message"]> = {}) {
  return {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...overrides,
  };
}

describe("buildIMessageInboundContext presentation", () => {
  it.each([
    [
      { sender_name: "Alice", chat_name: "" },
      "Alice id:+15555550123",
      {
        ConversationLabel: "Alice",
        SenderName: "Alice",
        CommandTurn: { kind: "normal", source: "message" },
      },
    ],
    [
      { sender_name: "Alice", chat_name: "Family", chat_id: 13, is_group: true },
      "Family id:13",
      { ConversationLabel: "Family", GroupSubject: "Family" },
    ],
  ] as const)("presents named conversation %s", async (message, fromLabel, ctxPayload) => {
    const actual = await buildContext(message);
    expect(actual).toMatchObject({ fromLabel, ctxPayload });
    expect(actual.ctxPayload.CommandSource).toBeUndefined();
  });
});

describe("resolveIMessageInboundDecision command auth", () => {
  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const decision = await resolveDecision({
      message: { id: 100, text: "/status" },
      allowFrom: [],
    });

    expect(decision).toEqual({ kind: "drop", reason: "dmPolicy blocked" });
  });

  it("marks authorized iMessage control commands as text command turns", async () => {
    const { ctxPayload } = await buildContext(
      { id: 102, guid: "p:0/GUID-command", text: "/new" },
      { allowFrom: [], dmPolicy: "pairing", storeAllowFrom: ["+15555550123"] },
    );

    expect(ctxPayload).toMatchObject({
      CommandAuthorized: true,
      ConversationRoutePeerId: "+15555550123",
      CommandSource: "text",
      CommandTurn: { kind: "text-slash", source: "text", authorized: true, commandName: "new" },
    });
  });
});

describe("iMessage bot-owned thread mention policy", () => {
  const rootGuid = "imessage-bot-thread-root";

  beforeAll(async () => {
    for (const [messageId, isFromMe] of [
      [rootGuid, true],
      ["imessage-human-thread-root", false],
    ] as const) {
      await rememberIMessageReplyCache({
        accountId: "default",
        messageId,
        chatId: 123,
        timestamp: Date.now(),
        isFromMe,
      });
    }
  });

  async function resolveThreadReply(overrides: Parameters<typeof resolveDecision>[0] = {}) {
    return resolveDecision({
      isKnownFromMeMessageId: undefined,
      cfg: {
        messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
        channels: {
          imessage: {
            groupPolicy: "open",
            groups: {
              "*": { requireMention: true, requireMentionInBotThreads: false },
              "123": {},
            },
          },
        },
      },
      ...overrides,
      message: {
        is_group: true,
        chat_id: 123,
        text: "follow-up",
        thread_originator_guid: rootGuid,
        ...overrides.message,
      },
    });
  }

  it.each([
    { name: "human root", message: { thread_originator_guid: "imessage-human-thread-root" } },
    { name: "another account", accountId: "other" },
    { name: "another group", message: { chat_id: 456 } },
    {
      name: "reply to the bot without a native thread root",
      message: { thread_originator_guid: undefined, reply_to_guid: rootGuid },
    },
  ])("retains the mention requirement for $name", async ({ name: _name, ...overrides }) => {
    expect(await resolveThreadReply(overrides)).toEqual({ kind: "drop", reason: "no mention" });
  });

  it("recognizes the native part-prefixed root and keeps sender authorization", async () => {
    const message = { thread_originator_guid: `p:0/${rootGuid}` };
    expect((await resolveThreadReply({ message })).kind).toBe("dispatch");
    expect(
      await resolveThreadReply({
        message,
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15555550999"],
      }),
    ).toEqual({ kind: "drop", reason: "not in groupAllowFrom" });
  });

  it("restores normal mention gating when the remembered root expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      expect(await resolveThreadReply()).toEqual({ kind: "drop", reason: "no mention" });
    } finally {
      vi.useRealTimers();
    }
  });
});
