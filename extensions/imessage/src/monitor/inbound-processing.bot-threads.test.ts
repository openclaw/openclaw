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
    options: {
      requireMention?: boolean;
      requireMentionInBotThreads?: boolean;
      exactRequireMentionInBotThreads?: boolean;
    } = {},
  ): OpenClawConfig {
    return {
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      channels: {
        imessage: {
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention: options.requireMention ?? true,
              requireMentionInBotThreads: options.requireMentionInBotThreads,
            },
            "123": { requireMentionInBotThreads: options.exactRequireMentionInBotThreads },
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
      cfg: threadConfig({ requireMentionInBotThreads: false }),
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

  const policies: Array<{
    name: string;
    requireMention?: boolean;
    requireMentionInBotThreads?: boolean;
    exactRequireMentionInBotThreads?: boolean;
    text?: string;
    expected: "dispatch" | "drop";
  }> = [
    { name: "omitted preserves normal gating", expected: "drop" },
    { name: "false allows follow-ups", requireMentionInBotThreads: false, expected: "dispatch" },
    {
      name: "true requires mentions even in an always-on group",
      requireMention: false,
      requireMentionInBotThreads: true,
      expected: "drop",
    },
    {
      name: "true still accepts an explicit mention",
      requireMentionInBotThreads: true,
      text: "@openclaw follow-up",
      expected: "dispatch",
    },
    {
      name: "exact true overrides wildcard false",
      requireMentionInBotThreads: false,
      exactRequireMentionInBotThreads: true,
      expected: "drop",
    },
    {
      name: "exact false overrides wildcard true",
      requireMentionInBotThreads: true,
      exactRequireMentionInBotThreads: false,
      expected: "dispatch",
    },
  ];

  it.each(policies)("$name", async ({ expected, text, ...policy }) => {
    const decision = await resolveThreadReply({
      cfg: threadConfig(policy),
      message: { text: text ?? "follow-up" },
    });
    if (expected === "drop") {
      expect(decision).toEqual({ kind: "drop", reason: "no mention" });
    } else {
      expect(decision.kind).toBe("dispatch");
    }
  });

  it.each([
    { option: true, root: rootGuid, expected: "drop" },
    { option: false, root: rootGuid, expected: "dispatch" },
    { option: undefined, root: rootGuid, expected: "dispatch" },
    { option: true, root: "imessage-human-thread-root", expected: "dispatch" },
  ])(
    "keeps explicit owned-thread policy $option with disabled mention patterns ($root)",
    async ({ option, root, expected }) => {
      const cfg = threadConfig({ requireMentionInBotThreads: option });
      cfg.messages = { groupChat: { mentionPatterns: [] } };
      const decision = await resolveThreadReply({
        cfg,
        message: { thread_originator_guid: root },
      });
      if (expected === "drop") {
        expect(decision).toEqual({ kind: "drop", reason: "no mention" });
      } else {
        expect(decision.kind).toBe("dispatch");
      }
    },
  );

  it.each([
    { name: "unknown root", message: { thread_originator_guid: "unobserved-root" } },
    { name: "human root", message: { thread_originator_guid: "imessage-human-thread-root" } },
    { name: "another account", accountId: "other" },
    { name: "another group", message: { chat_id: 456 } },
    { name: "top-level message", message: { thread_originator_guid: undefined } },
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
