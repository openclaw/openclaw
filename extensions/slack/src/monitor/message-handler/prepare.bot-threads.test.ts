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

  it("denies bot-owned threads when the room is disabled", async () => {
    const test = fixture({
      requireMentionInBotThreads: false,
      channels: { C123: { enabled: false } },
    });
    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "channel-not-allowed" }),
      expect.any(String),
    );
  });

  it.each([
    {
      scope: "account",
      slack: {
        requireMentionInBotThreads: true,
        accounts: { work: { requireMentionInBotThreads: false } },
      },
      accountId: "work",
    },
    {
      scope: "wildcard",
      slack: {
        requireMentionInBotThreads: true,
        channels: { "*": { requireMentionInBotThreads: false }, C123: {} },
      },
      accountId: "default",
    },
  ])("accepts an unmentioned reply with a $scope override", async ({ slack, accountId }) => {
    const test = fixture(slack, accountId);
    const prepared = await test.prepare();
    expect(prepared?.ctxPayload.RawBody).toBe("Continue here");
    expect(prepared?.requireMention).toBe(false);
    expect(prepared?.ctxPayload.MessageThreadId).toBe(test.threadTs);
  });

  it.each([
    { policy: "mention policy", config: { requireMentionInBotThreads: true } },
    { policy: "channel access", config: { channels: { C123: { enabled: false } } } },
    { policy: "sender access", config: { channels: { C123: { users: ["U_ALLOWED"] } } } },
  ])("stops the real handler when $policy changes during root lookup", async ({ config }) => {
    const test = fixture({ requireMentionInBotThreads: false, historyLimit: 0 }, "default", {
      ackReaction: "eyes",
      ackReactionScope: "all",
      inbound: { debounceMs: 0 },
    });
    test.message.parent_user_id = undefined;
    test.replies.mockImplementation(async () => {
      const next: OpenClawConfig = {
        ...test.ctx.cfg,
        channels: { slack: { ...test.ctx.cfg.channels?.slack, ...config } },
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

  it("does not exempt a foreign-owned thread from mention gating", async () => {
    const test = fixture({ requireMention: true, requireMentionInBotThreads: false });
    test.message.parent_user_id = "U_ROOT";
    expect(await test.prepare()).toBeNull();
  });

  it.each(["user", "bot_id"] as const)(
    "recognizes fetched bot ownership by %s",
    async (authorField) => {
      const test = fixture({ requireMentionInBotThreads: false });
      test.message.parent_user_id = undefined;
      test.replies.mockResolvedValue({
        messages: [{ ts: test.threadTs, text: "Bot root", [authorField]: "B1" }],
      });
      expect((await test.prepare())?.ctxPayload.RawBody).toBe("Continue here");
      expect(test.replies).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["wrong timestamp", "unavailable"] as const)(
    "keeps mention gating for a root lookup with %s",
    async (kind) => {
      const test = fixture({ requireMentionInBotThreads: false });
      test.message.parent_user_id = undefined;
      if (kind === "unavailable") {
        test.replies.mockRejectedValue(new Error("missing_scope"));
      } else {
        test.replies.mockResolvedValue({
          messages: [{ ts: test.message.ts, user: "B1", text: "Root" }],
        });
      }
      expect(await test.prepare()).toBeNull();
      expect(test.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "missing-mention" }),
        expect.any(String),
      );
    },
  );
});
