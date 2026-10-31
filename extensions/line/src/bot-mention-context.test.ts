import type { webhook } from "@line/bot-sdk";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedLineAccount } from "./types.js";

// Only LINE API calls are replaced; admission and context creation run together.
vi.mock("./send.js", () => ({
  getUserProfile: async () => null,
  getLineGroupName: async () => undefined,
  getUserDisplayName: async (userId: string) => userId,
  pushMessageLine: vi.fn(),
  replyMessageLine: vi.fn(),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let recordLineSentMessages: typeof import("./outbound-message-log.js").recordLineSentMessages;

beforeEach(async () => {
  const { setLineRuntime } = await import("./runtime.js");
  setLineRuntime(createPluginRuntimeMock());
});

beforeAll(async () => {
  vi.resetModules();
  ({ handleLineWebhookEvents } = await import("./bot-handlers.js"));
  ({ recordLineSentMessages } = await import("./outbound-message-log.js"));
});

afterAll(() => {
  vi.resetModules();
});

type MentionCase = {
  name: string;
  source?: webhook.Source;
  text?: string;
  mention?: webhook.TextMessageContent["mention"];
  quote?: boolean;
  quotedBot?: boolean;
  patterns?: string[];
  requireMention?: boolean;
  eventKind?: "location" | "postback";
  expected: ReturnType<typeof mentionFacts>;
};

function mentionFacts(
  mentioned: boolean | undefined,
  explicit: boolean | undefined,
  required: boolean | undefined = mentioned === undefined ? undefined : true,
  implicit: string[] | undefined = mentioned === undefined ? undefined : [],
) {
  return {
    WasMentioned: mentioned,
    ExplicitlyMentionedBot: explicit,
    GroupRequireMention: required,
    ImplicitMentionKinds: implicit,
  };
}

const nativeBotMention: webhook.TextMessageContent["mention"] = {
  mentionees: [{ index: 0, length: 4, type: "user", userId: "bot", isSelf: true }],
};

const mentionCase = (
  name: string,
  expected: MentionCase["expected"],
  input: Omit<MentionCase, "name" | "expected"> = {},
): MentionCase => ({ name, expected, ...input });

const nativeInput = { text: "@bot hello", mention: nativeBotMention };
const cases = [
  mentionCase("native bot mention in a group", mentionFacts(true, true), nativeInput),
  mentionCase("native bot mention in a room", mentionFacts(true, true), {
    ...nativeInput,
    source: { type: "room", roomId: "room", userId: "sender" },
  }),
  mentionCase("native all-members mention", mentionFacts(true, true), {
    text: "@all hello",
    mention: { mentionees: [{ index: 0, length: 4, type: "all" }] },
  }),
  mentionCase("configured pattern without a native mention", mentionFacts(true, false), {
    text: "hello helper",
    patterns: ["\\bhelper\\b"],
  }),
  mentionCase("quote of a message the bot sent", mentionFacts(true, false, true, ["quoted_bot"]), {
    quote: true,
  }),
  mentionCase(
    "disabled quote policy in an always-on group",
    mentionFacts(false, false, false, ["quoted_bot"]),
    {
      quote: true,
      quotedBot: false,
      requireMention: false,
    },
  ),
  mentionCase("ordinary message in an always-on group", mentionFacts(false, false, false), {
    requireMention: false,
  }),
  mentionCase("mention of another member", mentionFacts(false, false, false), {
    text: "@pal hello",
    requireMention: false,
    mention: { mentionees: [{ index: 0, length: 4, type: "user", userId: "pal", isSelf: false }] },
  }),
  mentionCase("authorized command bypass", mentionFacts(true, false), { text: "/status" }),
  mentionCase("non-text message without native mention metadata", mentionFacts(false, false), {
    eventKind: "location",
  }),
  mentionCase("direct message without group mention facts", mentionFacts(undefined, undefined), {
    source: { type: "user", userId: "sender" },
  }),
  mentionCase("postback without message mention facts", mentionFacts(undefined, undefined), {
    eventKind: "postback",
  }),
];

describe("LINE admission facts on the dispatched turn", () => {
  it.each(cases)("preserves $name", async (testCase) => {
    await withTempHome(async () => {
      const account: ResolvedLineAccount = {
        accountId: "mention-context",
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        tokenSource: "config",
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["sender"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["sender"],
          groups: { "*": { requireMention: testCase.requireMention ?? true } },
        },
      };
      const cfg: OpenClawConfig = {
        channels: {
          line: account.config,
          defaults: { implicitMentions: { quotedBot: testCase.quotedBot } },
        },
        messages: { groupChat: { mentionPatterns: testCase.patterns ?? [] } },
      };
      const eventBase = {
        source: testCase.source ?? { type: "group" as const, groupId: "group", userId: "sender" },
        replyToken: "reply-token",
        timestamp: 1_700_000_000_000,
        mode: "active" as const,
        webhookEventId: "mention-event",
        deliveryContext: { isRedelivery: false },
      };
      const event: webhook.MessageEvent | webhook.PostbackEvent =
        testCase.eventKind === "postback"
          ? { ...eventBase, type: "postback", postback: { data: "selected" } }
          : {
              ...eventBase,
              type: "message",
              message:
                testCase.eventKind === "location"
                  ? {
                      id: "message",
                      type: "location",
                      title: "Place",
                      address: "Place",
                      latitude: 1,
                      longitude: 1,
                    }
                  : {
                      id: "message",
                      type: "text",
                      text: testCase.text ?? "hello",
                      quoteToken: "quote-token",
                      mention: testCase.mention,
                      quotedMessageId: testCase.quote ? "sent-message" : undefined,
                    },
            };
      if (testCase.quote) {
        recordLineSentMessages(account.accountId, ["sent-message"]);
      }
      const processMessage = vi.fn<Parameters<typeof handleLineWebhookEvents>[1]["processMessage"]>(
        async () => {},
      );
      await handleLineWebhookEvents([event], {
        cfg,
        account,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        mediaMaxBytes: 1,
        processMessage,
      });

      expect(processMessage).toHaveBeenCalledTimes(1);
      expect(processMessage.mock.calls[0]?.[0].ctxPayload).toMatchObject(testCase.expected);
    });
  });
});
