import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import {
  clearSlackThreadMuteCache,
  isSlackThreadMutedWithPersistence,
  recordSlackThreadMute,
} from "../../muted-thread-cache.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import { clearSlackAllowFromCacheForTest } from "../auth.js";
import { resetSlackThreadStarterCacheForTest } from "../thread.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";
import { clearSlackSubteamMentionCacheForTest } from "./subteam-mentions.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>();
  return {
    ...actual,
    enqueueSystemEvent: vi.fn(),
  };
});

describe("slack prepareSlackMessage mute gate", () => {
  const channelId = "CMUTETEST01";
  const rootTs = "9990000000.000001";
  const account: ResolvedSlackAccount = createSlackTestAccount();

  beforeEach(() => {
    resetSlackThreadStarterCacheForTest();
    clearSlackThreadParticipationCache();
    clearSlackThreadMuteCache();
    clearSlackAllowFromCacheForTest();
    clearSlackSubteamMentionCacheForTest();
  });

  afterEach(() => {
    clearSlackThreadMuteCache();
    clearSlackThreadParticipationCache();
  });

  function createCtxWithReactSpy() {
    const reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
    const slackCtx = createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { reactions: { add: reactionsAdd } } as unknown as App["client"],
      defaultRequireMention: false,
    });
    slackCtx.resolveChannelName = async () => ({ name: "channel", type: "channel" });
    slackCtx.resolveUserName = async () => ({ name: "Alice" });
    return { slackCtx, reactionsAdd };
  }

  function threadReply(text: string, ts: string): SlackMessageEvent {
    return {
      type: "message",
      channel: channelId,
      channel_type: "channel",
      user: "U_ALICE",
      text,
      ts,
      thread_ts: rootTs,
    } as SlackMessageEvent;
  }

  it("records the mute, reacts with an emoji, and drops the message", async () => {
    const { slackCtx, reactionsAdd } = createCtxWithReactSpy();
    recordSlackThreadParticipation(account.accountId, channelId, rootTs);

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: threadReply("monica, stop responding please", "1777244714.000100"),
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
    expect(reactionsAdd).toHaveBeenCalledWith({
      channel: channelId,
      timestamp: "1777244714.000100",
      name: "zipper_mouth_face",
    });
    await expect(
      isSlackThreadMutedWithPersistence({
        accountId: account.accountId,
        channelId,
        threadTs: rootTs,
      }),
    ).resolves.toBe(true);
  });

  it("drops follow-up messages in a muted thread when the bot is not re-tagged", async () => {
    const { slackCtx } = createCtxWithReactSpy();
    recordSlackThreadParticipation(account.accountId, channelId, rootTs);
    recordSlackThreadMute({ accountId: account.accountId, channelId, threadTs: rootTs });

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: threadReply("anyone seen the dashboard?", "1777244720.000100"),
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
  });

  it("clears the mute and proceeds when the bot is explicitly mentioned again", async () => {
    const { slackCtx } = createCtxWithReactSpy();
    recordSlackThreadMute({ accountId: account.accountId, channelId, threadTs: rootTs });

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: threadReply("<@B1> what's the latest deploy status?", "1777244730.000100"),
      opts: { source: "app_mention", wasMentioned: true },
    });

    expect(prepared).not.toBeNull();
    await expect(
      isSlackThreadMutedWithPersistence({
        accountId: account.accountId,
        channelId,
        threadTs: rootTs,
      }),
    ).resolves.toBe(false);
  });

  it("does not mute on DMs (mute is per-thread, DMs have no thread context to silence)", async () => {
    const { slackCtx, reactionsAdd } = createCtxWithReactSpy();

    const prepared = await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: {
        type: "message",
        channel: "D123",
        channel_type: "im",
        user: "U_ALICE",
        text: "please mute",
        ts: "1777244740.000100",
      } as SlackMessageEvent,
      opts: { source: "message" },
    });

    expect(prepared).not.toBeNull();
    expect(reactionsAdd).not.toHaveBeenCalled();
  });

  it("does not mute on top-level channel messages without a thread", async () => {
    const { slackCtx, reactionsAdd } = createCtxWithReactSpy();

    await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: {
        type: "message",
        channel: channelId,
        channel_type: "channel",
        user: "U_ALICE",
        text: "<@B1> mute",
        ts: "1777244750.000100",
      } as SlackMessageEvent,
      opts: { source: "app_mention", wasMentioned: true },
    });

    expect(reactionsAdd).not.toHaveBeenCalled();
  });

  it("does not record a mute when the bot was not addressed in the message", async () => {
    const { slackCtx, reactionsAdd } = createCtxWithReactSpy();
    // No recordSlackThreadParticipation — bot is not in this thread, and the
    // message has no @mention. The mute text in the body should be ignored.

    await prepareSlackMessage({
      ctx: slackCtx,
      account,
      message: threadReply("please stop responding to all my emails", "1777244760.000100"),
      opts: { source: "message" },
    });

    expect(reactionsAdd).not.toHaveBeenCalled();
    await expect(
      isSlackThreadMutedWithPersistence({
        accountId: account.accountId,
        channelId,
        threadTs: rootTs,
      }),
    ).resolves.toBe(false);
  });
});
