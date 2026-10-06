import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");
type InboundDecisionParams = Parameters<
  InboundProcessingModule["resolveIMessageInboundDecision"]
>[0];
type ReplyCacheModule = typeof import("../monitor-reply-cache.js");
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];

beforeAll(async () => {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
  ({ resolveIMessageInboundDecision } = await import("./inbound-processing.js"));
});

describe("iMessage bot-owned thread mention policy", () => {
  const rootGuid = "imessage-bot-thread-root";

  beforeAll(async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: rootGuid,
      chatId: 123,
      timestamp: Date.now(),
      isFromMe: true,
    });
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "imessage-human-thread-root",
      chatId: 123,
      timestamp: Date.now(),
      isFromMe: false,
    });
  });

  function threadConfig(
    requireMentionInBotThreads?: boolean,
    exactRequireMentionInBotThreads?: boolean,
    requireMention = true,
  ): OpenClawConfig {
    return {
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      channels: {
        imessage: {
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention,
              requireMentionInBotThreads,
            },
            "123": { requireMentionInBotThreads: exactRequireMentionInBotThreads },
          },
        },
      },
    };
  }

  async function resolveThreadReply(
    overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
      message?: Partial<InboundDecisionParams["message"]>;
    } = {},
  ) {
    const message = {
      id: 42,
      sender: "+15555550123",
      is_group: true,
      chat_id: 123,
      text: "follow-up",
      thread_originator_guid: rootGuid,
      ...overrides.message,
    };
    const text = message.text ?? "";
    return resolveIMessageInboundDecision({
      cfg: threadConfig(false),
      accountId: "default",
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      ...overrides,
      message,
      messageText: text,
      bodyText: text,
    });
  }

  it.each([
    ["omitted preserves normal gating", undefined, undefined, "follow-up", "drop"],
    ["true accepts an explicit mention", true, undefined, "@openclaw follow-up", "dispatch"],
    ["exact false overrides wildcard true", true, false, "follow-up", "dispatch"],
  ] as const)("%s", async (_name, wildcard, exact, text, expected) => {
    const decision = await resolveThreadReply({
      cfg: threadConfig(wildcard, exact),
      message: { text },
    });
    if (expected === "drop") {
      expect(decision).toEqual({ kind: "drop", reason: "no mention" });
    } else {
      expect(decision.kind).toBe("dispatch");
    }
  });

  it.each([true, undefined])(
    "keeps owned-thread policy %s in an always-on group with disabled mention patterns",
    async (option) => {
      const cfg = threadConfig(option, undefined, false);
      cfg.messages = { groupChat: { mentionPatterns: [] } };
      const decision = await resolveThreadReply({ cfg });
      if (option) {
        expect(decision).toEqual({ kind: "drop", reason: "no mention" });
      } else {
        expect(decision.kind).toBe("dispatch");
      }
    },
  );

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
