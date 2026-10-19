import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  clearSlackThreadParticipationCache();
  vi.mocked(enqueueRoutedSystemEvent).mockClear();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
let caseId = 0;
function fixture(
  slack: SlackConfig = {},
  accountId = "default",
  messages?: OpenClawConfig["messages"],
) {
  const threadTs = `${1700000000 + caseId++}.000000`;
  const cfg: OpenClawConfig = {
    session: { store: store.makeTmpStorePath().storePath },
    messages,
    channels: {
      slack: {
        enabled: true,
        groupPolicy: "open",
        implicitMentions: { replyToBot: false, threadParticipation: false },
        ...slack,
      },
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const config = mergeSlackAccountConfig(cfg, accountId);
  const account = { ...createSlackTestAccount(config), accountId };
  const replies = vi.fn().mockResolvedValue({ messages: [] });
  const addReaction = vi.fn().mockResolvedValue({ ok: true });
  const ctx = createInboundSlackTestContext({
    cfg,
    accountId,
    defaultRequireMention: config.requireMention,
    channelsConfig: config.channels,
    groupPolicy: config.groupPolicy,
    appClient: {
      conversations: { replies },
      reactions: { add: addReaction },
    } as unknown as App["client"],
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
  return { ctx, info, message, replies, addReaction, prepare, threadTs };
}

describe("Slack bot-thread mention configuration", () => {
  it("validates scoped boolean overrides without adding a default", () => {
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

  it.each<[string, SlackConfig, string, boolean]>([
    [
      "account",
      {
        requireMentionInBotThreads: true,
        accounts: { work: { requireMentionInBotThreads: false } },
      },
      "work",
      true,
    ],
    [
      "disabled room",
      { requireMentionInBotThreads: false, channels: { C123: { enabled: false } } },
      "default",
      false,
    ],
  ])("applies the %s override to unmentioned replies", async (_, slack, accountId, allowed) => {
    const test = fixture(slack, accountId);
    const prepared = await test.prepare();
    if (allowed) {
      expect(prepared?.ctxPayload.RawBody).toBe("Continue here");
      expect(prepared?.ctxPayload.MentionSource).toBe("none");
      expect(prepared?.ctxPayload.MessageThreadId).toBe(test.threadTs);
    } else {
      expect(prepared).toBeNull();
      expect(test.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "channel-not-allowed" }),
        expect.any(String),
      );
    }
  });

  it("stops the real handler when mention policy changes during root lookup", async () => {
    const test = fixture({ requireMentionInBotThreads: false, historyLimit: 0 }, "default", {
      ackReaction: "eyes",
      ackReactionScope: "all",
      inbound: { debounceMs: 0 },
    });
    test.message.parent_user_id = undefined;
    test.replies.mockImplementation(async () => {
      const next: OpenClawConfig = {
        ...test.ctx.cfg,
        channels: { slack: { ...test.ctx.cfg.channels?.slack, requireMentionInBotThreads: true } },
      };
      setRuntimeConfigSnapshot(next, next);
      return { messages: [{ ts: test.threadTs, text: "Bot root", user: "B1" }] };
    });
    const onPrepared = vi.fn();
    await createSlackMessageHandler({ ctx: test.ctx, onPrepared })(test.message, {
      source: "message",
      awaitDispatch: true,
    });
    expect(test.replies).toHaveBeenCalledTimes(1);
    expect(test.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "final-route-denied" }),
      expect.any(String),
    );
    expect(test.addReaction).not.toHaveBeenCalled();
    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("requires an explicit mention despite reply and participation exemptions when the channel overrides true", async () => {
    const test = fixture({
      requireMention: false,
      requireMentionInBotThreads: false,
      implicitMentions: { replyToBot: true, threadParticipation: true },
      channels: { C123: { requireMentionInBotThreads: true } },
    });
    recordSlackThreadParticipation("default", "C123", test.threadTs);
    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missing-mention" }),
      expect.any(String),
    );
    test.message.text = "<@B1> Continue here";
    expect((await test.prepare())?.ctxPayload.MentionSource).toBe("explicit_bot");
  });

  it("admits replies to roots verified by bot ID when bot-thread mentions are disabled", async () => {
    const test = fixture({ requireMention: true, requireMentionInBotThreads: false });
    test.message.parent_user_id = undefined;
    test.replies.mockResolvedValue({
      messages: [{ ts: test.threadTs, bot_id: "B1", text: "Bot root" }],
    });
    const prepared = await test.prepare();
    expect(prepared?.ctxPayload.RawBody).toBe("Continue here");
    expect(test.replies).toHaveBeenCalledTimes(1);
  });
});

describe("Slack strict bot mentions", () => {
  function botFixture(slack: SlackConfig, accountId = "default") {
    return fixture(
      {
        ...slack,
        channels: {
          ...slack.channels,
          C123: { users: ["U1", "UOTHERBOT"], ...slack.channels?.C123 },
        },
      },
      accountId,
    );
  }

  it.each(["reply_to_bot", "bot_thread_participant"])(
    "rejects untagged bots with %s while preserving explicit bots and human follow-ups",
    async (kind) => {
      const test = botFixture({
        allowBots: "mentions",
        requireExplicitBotMention: true,
        implicitMentions: { replyToBot: true, threadParticipation: true },
      });
      test.message.bot_id = "OTHERBOT";
      test.message.user = "UOTHERBOT";
      if (kind === "bot_thread_participant") {
        test.message.parent_user_id = "UROOT";
        recordSlackThreadParticipation("default", "C123", test.threadTs);
      }
      const onPrepared = vi.fn();
      const handler = createSlackMessageHandler({ ctx: test.ctx, onPrepared });
      const receive = () =>
        handler({ ...test.message }, { source: "message", awaitDispatch: true });
      await receive();
      expect(onPrepared).not.toHaveBeenCalled();
      expect(test.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "bot-missing-mention" }),
        expect.any(String),
      );
      test.message.text = "<@B1> Continue here";
      await receive();
      expect(onPrepared).toHaveBeenCalledTimes(1);
      expect(onPrepared.mock.calls[0]?.[0].ctxPayload.MentionSource).toBe("explicit_bot");
      test.message.ts = test.threadTs.replace(".000000", ".000002");
      test.message.text = "Continue here";
      delete test.message.bot_id;
      test.message.user = "U1";
      await receive();
      expect(onPrepared).toHaveBeenCalledTimes(2);
      expect(onPrepared.mock.calls[1]?.[0].ctxPayload.MentionSource).toBe("implicit_thread");
    },
  );

  it.each([undefined, false])(
    "preserves legacy implicit bot handoffs when strict mode is %s",
    async (strict) => {
      const test = botFixture({
        allowBots: "mentions",
        requireExplicitBotMention: strict,
        implicitMentions: { replyToBot: true, threadParticipation: true },
      });
      test.message.bot_id = "OTHERBOT";
      test.message.user = "UOTHERBOT";
      expect((await test.prepare())?.ctxPayload.MentionSource).toBe("implicit_thread");
    },
  );

  it.each(["reply_to_bot", "bot_thread_participant"])(
    "uses newly published strict policy for %s waiting in the debounce queue",
    async (kind) => {
      const test = fixture(
        {
          allowBots: "mentions",
          requireExplicitBotMention: false,
          implicitMentions: { replyToBot: true, threadParticipation: true },
          channels: { C123: { users: ["UOTHERBOT"] } },
        },
        "default",
        { ackReaction: "eyes", ackReactionScope: "all", inbound: { debounceMs: 25 } },
      );
      test.message.bot_id = "OTHERBOT";
      test.message.user = "UOTHERBOT";
      if (kind === "bot_thread_participant") {
        test.message.parent_user_id = "UROOT";
        recordSlackThreadParticipation("default", "C123", test.threadTs);
      }
      const onPrepared = vi.fn();
      const abort = new AbortController();
      const handler = createSlackMessageHandler({
        ctx: test.ctx,
        onPrepared,
        abortSignal: abort.signal,
      });
      vi.useFakeTimers();
      try {
        await handler(test.message, { source: "message" });
        expect(onPrepared).not.toHaveBeenCalled();
        expect(test.info).not.toHaveBeenCalled();
        const next: OpenClawConfig = {
          ...test.ctx.cfg,
          channels: { slack: { ...test.ctx.cfg.channels?.slack, requireExplicitBotMention: true } },
        };
        setRuntimeConfigSnapshot(next, next);
        await vi.advanceTimersByTimeAsync(25);
        await vi.waitFor(() =>
          expect(test.info).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "bot-missing-mention", messageTs: test.message.ts }),
            expect.any(String),
          ),
        );
        expect(onPrepared).not.toHaveBeenCalled();
        expect(test.addReaction).not.toHaveBeenCalled();
        expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it.each<[SlackConfig, string, boolean]>([
    [
      { requireExplicitBotMention: false, accounts: { work: { requireExplicitBotMention: true } } },
      "work",
      false,
    ],
    [
      {
        requireExplicitBotMention: false,
        channels: { "*": { requireExplicitBotMention: true }, C123: {} },
      },
      "default",
      false,
    ],
    [
      {
        requireExplicitBotMention: true,
        channels: {
          "*": { requireExplicitBotMention: true },
          C123: { requireExplicitBotMention: false },
        },
      },
      "default",
      true,
    ],
  ])("honors account and channel overrides (%j, %s)", async (slack, accountId, admitted) => {
    const test = botFixture(
      {
        ...slack,
        allowBots: "mentions",
        implicitMentions: { replyToBot: true, threadParticipation: true },
      },
      accountId,
    );
    test.message.bot_id = "OTHERBOT";
    test.message.user = "UOTHERBOT";
    expect(Boolean(await test.prepare())).toBe(admitted);
  });
});
