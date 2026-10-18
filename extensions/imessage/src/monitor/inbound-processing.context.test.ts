import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");
type InboundDecisionParams = Parameters<
  InboundProcessingModule["resolveIMessageInboundDecision"]
>[0];

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

function resolveDecision(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
) {
  const { message: messageOverrides, ...restOverrides } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...messageOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return resolveIMessageInboundDecision({
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    isKnownFromMeMessageId: () => false,
    logVerbose: undefined,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  });
}

async function buildContext(
  message: InboundDecisionParams["message"],
  decision?: Awaited<ReturnType<typeof resolveDecision>>,
) {
  const admitted = decision ?? (await resolveDecision({ message }));
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

function contextMessage(overrides: Partial<InboundDecisionParams["message"]>) {
  return {
    id: 12344,
    guid: "p:0/GUID-contact-name",
    sender: "+15555550123",
    sender_name: "Alice",
    chat_name: "",
    text: "Hello",
    is_from_me: false,
    is_group: false,
    ...overrides,
  };
}

describe("buildIMessageInboundContext presentation", () => {
  it("uses provider-resolved contact names for direct session and sender presentation", async () => {
    const { ctxPayload, fromLabel } = await buildContext(contextMessage({}));

    expect(fromLabel).toBe("Alice id:+15555550123");
    expect(ctxPayload.ConversationLabel).toBe("Alice");
    expect(ctxPayload.SenderName).toBe("Alice");
    expect(ctxPayload.CommandSource).toBeUndefined();
    expect(ctxPayload.CommandTurn).toMatchObject({ kind: "normal", source: "message" });
  });

  it("keeps group route IDs out of named session presentation", async () => {
    const { ctxPayload, fromLabel } = await buildContext(
      contextMessage({
        id: 12345,
        guid: "p:0/GUID-group-name",
        chat_id: 13,
        chat_name: "Family",
        is_group: true,
      }),
    );

    expect(fromLabel).toBe("Family id:13");
    expect(ctxPayload.ConversationLabel).toBe("Family");
    expect(ctxPayload.GroupSubject).toBe("Family");
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
    const decision = await resolveDecision({
      message: { id: 102, text: "/new" },
      allowFrom: [],
      dmPolicy: "pairing",
      storeAllowFrom: ["+15555550123"],
    });

    const { ctxPayload } = await buildContext(
      {
        id: 102,
        guid: "p:0/GUID-command",
        sender: "+15555550123",
        text: "/new",
        is_from_me: false,
        is_group: false,
      },
      decision,
    );

    expect(ctxPayload.CommandAuthorized).toBe(true);
    expect(ctxPayload.ConversationRoutePeerId).toBe("+15555550123");
    expect(ctxPayload.CommandSource).toBe("text");
    expect(ctxPayload.CommandTurn).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "new",
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
