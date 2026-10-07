import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
} from "./monitor.test-helpers.js";
import { getSlackRuntime, setSlackRuntime } from "./runtime.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";
import type { SlackMessageEvent } from "./types.js";

const { monitorSlackProvider } = await import("./monitor/provider.js");
const slackTestState = getSlackTestState();
const AUTH_FAILURE = "⚠️ Model login expired on the gateway.";

async function dispatchEvent(overrides: Partial<SlackMessageEvent>): Promise<void> {
  await runSlackMessageOnce(
    monitorSlackProvider,
    {
      event: {
        type: "message",
        user: "U1",
        text: "ordinary follow-up",
        ts: "100.000001",
        channel: "C1",
        channel_type: "channel",
        ...overrides,
      },
    },
    { awaitDispatch: true },
  );
}

async function threadReply(ts: string, threadTs: string, text = "ordinary follow-up") {
  await dispatchEvent({ ts, thread_ts: threadTs, parent_user_id: "U1", text });
}

function mockReplySequence(...payloads: Array<{ text: string; isError?: boolean }>): void {
  let runIndex = 0;
  slackTestState.replyMock.mockImplementation(async (...args: unknown[]) => {
    const options = args[1] as { onAgentRunStart?: (runId: string) => void } | undefined;
    options?.onAgentRunStart?.(`slack-failure-notice-test-${runIndex}`);
    return payloads[Math.min(runIndex++, payloads.length - 1)];
  });
}

function configure(requireMention = true): void {
  slackTestState.config = {
    messages: { groupChat: { visibleReplies: "automatic" } },
    channels: {
      slack: {
        dm: { enabled: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        requireMention,
        replyToMode: "all",
        channels: { C1: { allow: true, requireMention } },
      },
    },
  };
}

describe("Slack thread failure notices", () => {
  beforeEach(async () => {
    resetInboundDedupe();
    clearSlackThreadParticipationCache();
    await resetSlackTestState();
    configure();
  });

  it("announces the first failure for participation restored after a restart", async () => {
    const threadTs = "101.100000";
    const openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", options);
    const persistedStore = openKeyedStore<{ repliedAt: number }>({
      namespace: "slack.thread-participation",
      maxEntries: 1000,
    });
    await persistedStore.register(
      `default:C1:${threadTs}`,
      { repliedAt: Date.now() },
      { ttlMs: 60_000 },
    );
    const runtime = getSlackRuntime();
    setSlackRuntime({ ...runtime, state: { ...runtime.state, openKeyedStore } });
    expect(hasSlackThreadParticipation("default", "C1", threadTs)).toBe(false);
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ ts: "101.100001", thread_ts: threadTs, parent_user_id: "U1" });
    await dispatchEvent({ ts: "101.100002", thread_ts: threadTs, parent_user_id: "U1" });

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(2);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(1);
    expect(slackTestState.sendMock.mock.calls[0]?.[1]).toBe(AUTH_FAILURE);
  });

  it("announces the same failure again after a successful reply", async () => {
    mockReplySequence(
      { text: "Working normally" },
      { text: AUTH_FAILURE, isError: true },
      { text: "Recovered" },
      { text: AUTH_FAILURE, isError: true },
    );

    await dispatchEvent({ text: "<@bot-user> please help", ts: "103.000000" });
    await threadReply("103.000001", "103.000000");
    await threadReply("103.000002", "103.000000");
    await threadReply("103.000003", "103.000000");

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(4);
    expect(slackTestState.sendMock.mock.calls[3]?.[1]).toBe(AUTH_FAILURE);
  });

  it("always explains the current failure when the user explicitly mentions the bot", async () => {
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ text: "<@bot-user> please help", ts: "104.000000" });
    await threadReply("104.000001", "104.000000");
    await threadReply("104.000002", "104.000000", "<@bot-user> are you working now?");

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });

  it("always answers an explicit mention after an unmentioned channel failure", async () => {
    configure(false);
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ ts: "105.030000" });
    await dispatchEvent({ ts: "105.030001" });
    await dispatchEvent({ text: "<@bot-user> are you working now?", ts: "105.030002" });

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
    expect(slackTestState.sendMock.mock.calls[1]?.[1]).toBe(AUTH_FAILURE);
  });

  it("does not retry a thread failure whose first Slack send is ambiguous", async () => {
    mockReplySequence(
      { text: "Working normally" },
      { text: AUTH_FAILURE, isError: true },
      { text: AUTH_FAILURE, isError: true },
    );

    await dispatchEvent({ text: "<@bot-user> please help", ts: "105.040000" });
    const failure = new Error("Slack delivery unavailable");
    slackTestState.sendMock.mockRejectedValueOnce(failure);

    await expect(threadReply("105.040001", "105.040000")).rejects.toBe(failure);
    await threadReply("105.040002", "105.040000");

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not suppress warnings for non-terminal tool failures", async () => {
    const warning = setReplyPayloadMetadata(
      { text: "A tool failed, but the run completed.", isError: true },
      { nonTerminalToolErrorWarning: true },
    );
    mockReplySequence({ text: "Working normally" }, warning, warning);

    await dispatchEvent({ text: "<@bot-user> please help", ts: "105.100000" });
    await threadReply("105.100001", "105.100000");
    await threadReply("105.100002", "105.100000");

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(3);
  });

  it("keeps failures visible in Slack group direct messages", async () => {
    slackTestState.config = {
      messages: { groupChat: { visibleReplies: "automatic" } },
      channels: {
        slack: {
          dm: { enabled: true, groupEnabled: true },
          dmPolicy: "open",
          allowFrom: ["U1"],
          groupPolicy: "open",
          replyToMode: "off",
        },
      },
    };
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ channel: "G1", channel_type: "mpim", ts: "107.000000" });
    await dispatchEvent({ channel: "G1", channel_type: "mpim", ts: "107.000001" });

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(2);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });
});
