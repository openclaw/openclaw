import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSlackAccountConfig } from "../../accounts.js";
import { SlackConfigSchema } from "../../config-schema.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import { createSlackMessageHandler } from "../message-handler.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

const store = createSlackSessionStoreFixture("slack-bot-thread-mentions-");
beforeAll(() => store.setup());
beforeEach(() => {
  clearSlackThreadParticipationCache();
  vi.mocked(enqueueRoutedSystemEvent).mockClear();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});
afterAll(() => store.cleanup());

let caseId = 0;
type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
type FixtureParams = {
  slack?: SlackConfig;
  accountId?: string;
  messages?: OpenClawConfig["messages"];
};

function fixture(params: FixtureParams = {}) {
  const threadTs = `${1700000000 + caseId++}.000000`;
  const { storePath } = store.makeTmpStorePath();
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    messages: params.messages,
    channels: {
      slack: {
        enabled: true,
        groupPolicy: "open",
        implicitMentions: { replyToBot: false, threadParticipation: false },
        ...params.slack,
      },
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const accountId = params.accountId ?? "default";
  const config = mergeSlackAccountConfig(cfg, accountId);
  const account = { ...createSlackTestAccount(config), accountId };
  const replies = vi.fn().mockResolvedValue({ messages: [] });
  const addReaction = vi.fn().mockResolvedValue({ ok: true });
  const ctx = createInboundSlackTestContext({
    cfg,
    accountId,
    appClient: {
      conversations: { replies },
      reactions: { add: addReaction },
    } as unknown as App["client"],
    defaultRequireMention: config.requireMention,
    channelsConfig: config.channels,
    groupPolicy: config.groupPolicy,
  });
  ctx.resolveUserName = async () => ({ name: "Synthetic sender" });
  ctx.resolveChannelName = async () => ({ name: "synthetic-room", type: "channel" });
  const info = vi.spyOn(ctx.logger, "info").mockImplementation(() => undefined);
  const message: SlackMessageEvent = {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    ts: threadTs.replace(".000000", ".000001"),
    thread_ts: threadTs,
    parent_user_id: "B1",
    text: "Continue here",
  };
  const prepare = () => prepareSlackMessage({ ctx, account, message, opts: { source: "message" } });
  return { ctx, info, message, replies, addReaction, prepare, accountId, threadTs };
}

describe("Slack bot-thread mention configuration", () => {
  it("accepts boolean overrides at root, account, wildcard, and channel scope without a default", () => {
    const parsed = SlackConfigSchema.parse({
      requireMentionInBotThreads: false,
      channels: { "*": { requireMentionInBotThreads: true } },
      accounts: {
        work: {
          requireMentionInBotThreads: true,
          channels: { C123: { requireMentionInBotThreads: false } },
        },
      },
    });
    expect(parsed.accounts?.work?.channels?.C123?.requireMentionInBotThreads).toBe(false);
    expect(SlackConfigSchema.parse({}).requireMentionInBotThreads).toBeUndefined();
    expect(SlackConfigSchema.safeParse({ requireMentionInBotThreads: "false" }).success).toBe(
      false,
    );
  });

  const relaxedScopeCases: Array<FixtureParams & { scope: string }> = [
    { scope: "root", slack: { requireMentionInBotThreads: false } },
    {
      scope: "inherited account",
      slack: { requireMentionInBotThreads: false, accounts: { work: {} } },
      accountId: "work",
    },
    {
      scope: "account override",
      slack: {
        requireMentionInBotThreads: true,
        accounts: { work: { requireMentionInBotThreads: false } },
      },
      accountId: "work",
    },
    {
      scope: "wildcard override",
      slack: {
        requireMentionInBotThreads: true,
        channels: { "*": { requireMentionInBotThreads: false }, C123: {} },
      },
    },
    {
      scope: "channel override",
      slack: {
        requireMentionInBotThreads: true,
        channels: { C123: { requireMentionInBotThreads: false } },
      },
    },
  ];
  it.each(relaxedScopeCases)(
    "accepts an unmentioned reply in its own thread with $scope false",
    async (params) => {
      const test = fixture(params);
      const prepared = await test.prepare();

      expect(prepared?.ctxPayload.RawBody).toBe("Continue here");
      expect(prepared?.requireMention).toBe(false);
      expect(prepared?.ctxPayload.MessageThreadId).toBe(test.threadTs);
    },
  );

  it.each(["mention policy", "channel access", "sender access"] as const)(
    "stops the real handler before visible effects when %s changes during root lookup",
    async (changedPolicy) => {
      const test = fixture({
        slack: { requireMentionInBotThreads: false, historyLimit: 0 },
        messages: { ackReaction: "eyes", ackReactionScope: "all", inbound: { debounceMs: 0 } },
      });
      test.message.parent_user_id = undefined;
      test.replies.mockImplementation(async () => {
        const changed: SlackConfig = {
          ...test.ctx.cfg.channels?.slack,
          ...(changedPolicy === "mention policy"
            ? { requireMentionInBotThreads: true }
            : {
                channels: {
                  C123:
                    changedPolicy === "channel access"
                      ? { enabled: false }
                      : { users: ["U_ALLOWED"] },
                },
              }),
        };
        const next: OpenClawConfig = { ...test.ctx.cfg, channels: { slack: changed } };
        setRuntimeConfigSnapshot(next, next);
        return { messages: [{ ts: test.threadTs, text: "Bot root", user: "B1" }] };
      });
      const onPrepared = vi.fn();
      const handler = createSlackMessageHandler({ ctx: test.ctx, onPrepared });

      await handler(test.message, { source: "message", awaitDispatch: true });

      expect(test.replies).toHaveBeenCalledTimes(1);
      expect(test.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "final-route-denied" }),
        expect.any(String),
      );
      expect(test.addReaction).not.toHaveBeenCalled();
      expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
      expect(onPrepared).not.toHaveBeenCalled();
    },
  );

  it("requires a mention with a channel true override despite reply and participation exemptions", async () => {
    const test = fixture({
      slack: {
        requireMention: false,
        requireMentionInBotThreads: false,
        implicitMentions: { replyToBot: true, threadParticipation: true },
        channels: { C123: { requireMentionInBotThreads: true } },
      },
    });
    recordSlackThreadParticipation(test.accountId, "C123", test.threadTs);

    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missing-mention" }),
      expect.any(String),
    );

    test.message.text = "<@B1> Continue here";
    expect((await test.prepare())?.ctxPayload.MentionSource).toBe("explicit_bot");
  });

  it.each([
    { name: "foreign root", parentUserId: "U_ROOT", requireMention: true, expected: false },
    { name: "ungated foreign root", parentUserId: "U_ROOT", requireMention: false, expected: true },
    { name: "top-level message", parentUserId: undefined, requireMention: true, expected: false },
  ])("preserves the normal mention rule for $name", async (scenario) => {
    const test = fixture({
      slack: {
        requireMention: scenario.requireMention,
        requireMentionInBotThreads: !scenario.requireMention,
      },
    });
    test.message.parent_user_id = scenario.parentUserId;
    if (!scenario.parentUserId) {
      test.message.thread_ts = undefined;
    }

    expect(Boolean(await test.prepare())).toBe(scenario.expected);
  });

  it("keeps existing participation behavior in threads started by someone else", async () => {
    const test = fixture({
      slack: {
        requireMentionInBotThreads: true,
        implicitMentions: { threadParticipation: true },
      },
    });
    test.message.parent_user_id = "U_ROOT";
    recordSlackThreadParticipation(test.accountId, "C123", test.threadTs);

    expect((await test.prepare())?.ctxPayload.ImplicitMentionKinds).toEqual([
      "bot_thread_participant",
    ]);
  });

  it.each(["user", "bot_id"] as const)(
    "recognizes a fetched bot-owned root by %s when parent_user_id is absent",
    async (authorField) => {
      const test = fixture({ slack: { requireMentionInBotThreads: false } });
      test.message.parent_user_id = undefined;
      test.replies.mockResolvedValue({
        messages: [{ ts: test.threadTs, text: "Bot root", [authorField]: "B1" }],
      });

      expect((await test.prepare())?.ctxPayload.RawBody).toBe("Continue here");
      expect(test.replies).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["foreign", "wrong timestamp", "unavailable"] as const)(
    "keeps mention gating when fetched root ownership is %s",
    async (kind) => {
      const test = fixture({ slack: { requireMentionInBotThreads: false } });
      test.message.parent_user_id = undefined;
      if (kind === "unavailable") {
        test.replies.mockRejectedValue(new Error("missing_scope"));
      } else {
        test.replies.mockResolvedValue({
          messages: [
            {
              ts: kind === "wrong timestamp" ? test.message.ts : test.threadTs,
              user: kind === "foreign" ? "U_ROOT" : "B1",
              text: "Root",
            },
          ],
        });
      }

      expect(await test.prepare()).toBeNull();
      expect(test.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "missing-mention" }),
        expect.any(String),
      );
    },
  );

  it.each([
    { reason: "channel-not-allowed", slack: { channels: { C123: { enabled: false } } } },
    { reason: "unauthorized-sender", slack: { channels: { C123: { users: ["U_ALLOWED"] } } } },
    { reason: "bot-disabled", slack: { allowBots: false }, bot: true },
    {
      reason: "bot-missing-mention",
      slack: { allowBots: "mentions" as const, channels: { C123: { users: ["U1"] } } },
      bot: true,
    },
    {
      reason: "other-mention",
      slack: { channels: { C123: { ignoreOtherMentions: true } } },
      text: "<@U_OTHER> Continue here",
    },
  ])("preserves the $reason gate in bot-owned threads", async (scenario) => {
    const test = fixture({ slack: { ...scenario.slack, requireMentionInBotThreads: false } });
    if (scenario.bot) {
      test.message.bot_id = "B_OTHER";
      test.message.subtype = "bot_message";
    }
    if (scenario.text) {
      test.message.text = scenario.text;
    }

    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: scenario.reason }),
      expect.any(String),
    );
  });
});
