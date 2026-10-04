import type { RichTextBlock } from "@slack/types";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSlackTestConfig,
  getSlackTestState,
  getSlackHandlerOrThrow,
  getSlackClient,
  flush,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";
import { buildSlackSlashCommandMatcher } from "./monitor/commands.js";
import { createSlackThreadTsResolver } from "./monitor/thread-resolution.js";
import type { SlackMessageEvent } from "./types.js";

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof import("./monitor/media.runtime.js").fetchWithRuntimeDispatcher>(),
);
vi.mock("./monitor/media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor/media.runtime.js")>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));
const { monitorSlackProvider } = await import("./monitor/provider.js");
const slackTestState = getSlackTestState();
const { sendMock, replyMock, reactMock, reactionAddMock, upsertPairingRequestMock } =
  slackTestState;

type MentionCase = { name: string; elements: RichTextBlock["elements"]; expected: string };
type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
function configure(slack: SlackConfig, messages?: OpenClawConfig["messages"]) {
  const base = defaultSlackTestConfig();
  slackTestState.config = {
    ...base,
    messages: { ...base.messages, ...messages },
    channels: { slack: { ...base.channels.slack, ...slack } },
  };
}
function event(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: "message",
    user: "U1",
    text: "hello",
    ts: "123",
    channel: "C1",
    channel_type: "im",
    ...overrides,
  };
}
async function run(overrides: Partial<SlackMessageEvent> = {}, awaitDispatch = false) {
  await runSlackMessageOnce(monitorSlackProvider, { event: event(overrides) }, { awaitDispatch });
}
function captureContexts<T extends Record<string, unknown>>() {
  const contexts: T[] = [];
  replyMock.mockImplementation(async (ctx: unknown) => {
    contexts.push(ctx as T);
  });
  return contexts;
}
function configureReactions(visibleReplies: "automatic" | "message_tool" = "automatic") {
  configure({}, { groupChat: { visibleReplies }, statusReactions: { enabled: true } });
  getSlackClient().conversations.info.mockResolvedValueOnce({
    channel: { name: "general", is_channel: true },
  });
}
async function runMention() {
  await run({ text: "<@bot-user> hello", ts: "456", channel_type: "channel" }, true);
}
async function expectAck() {
  await vi.waitFor(
    () => expect(reactMock).toHaveBeenCalledWith({ channel: "C1", timestamp: "456", name: "eyes" }),
    { timeout: 5_000 },
  );
}

describe("Slack monitor dispatch", () => {
  beforeEach(async () => {
    mediaFetchMock.mockReset().mockRejectedValue(new Error("Unexpected Slack media test request"));
    resetInboundDedupe();
    await resetSlackTestState(defaultSlackTestConfig());
  });

  it("drops events with mismatched api_app_id", async () => {
    getSlackClient().auth.test.mockResolvedValue({
      user_id: "bot-user",
      team_id: "T1",
      app_id: "A1",
    });
    await runSlackMessageOnce(
      monitorSlackProvider,
      {
        body: { api_app_id: "A2", team_id: "T1" },
        event: event(),
      },
      { appToken: "xapp-1-A1-abc" },
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("recovers platform edits and offline discussion after restart without waking on quiet ingress", async () => {
    configure({ historyLimit: 5, channels: { C1: { requireMention: true } } });
    const captured = captureContexts<{
      Body?: string;
      RawBody?: string;
      InboundHistory?: Array<{ body: string }>;
    }>();
    const client = getSlackClient();
    await run({ text: "old text before editing", ts: "100", channel_type: "channel" }, true);
    expect(replyMock).not.toHaveBeenCalled();
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(client.conversations.replies).not.toHaveBeenCalled();
    client.conversations.history.mockResolvedValue({
      messages: [
        { user: "U2", text: "discussion while offline", ts: "102" },
        { user: "U1", text: "edited platform text", ts: "100" },
      ],
    });
    await run(
      { text: "<@bot-user> recover the discussion", ts: "103", channel_type: "channel" },
      true,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.InboundHistory?.map((entry) => entry.body)).toEqual([
      "edited platform text",
      "discussion while offline",
    ]);
    expect(captured[0]?.Body).toContain("edited platform text");
    expect(captured[0]?.Body).toContain("discussion while offline");
    expect(captured[0]?.Body).not.toContain("old text before editing");
    expect(captured[0]?.RawBody).toContain("recover the discussion");
  });

  it("surfaces forwarded image download failures through monitor dispatch", async () => {
    const captured = captureContexts<{ RawBody?: string }>();
    mediaFetchMock.mockImplementation(async () => new Response("Not Found", { status: 404 }));
    await run(
      {
        text: "caption",
        attachments: [{ is_share: true, image_url: "https://files.slack.com/forwarded.jpg" }],
      },
      true,
    );
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(captured[0]?.RawBody).toBe("caption\n\n[slack attachment unavailable]");
    expect(mediaFetchMock).toHaveBeenCalledOnce();
  });

  it("accepts mention patterns even when another user is mentioned", async () => {
    configure(
      { groupPolicy: "allowlist", channels: { C1: { requireMention: true } } },
      { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
    );
    replyMock.mockResolvedValue({ text: "hi" });
    await run({ text: "openclaw: hello <@U2>", channel_type: "channel" });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]?.[0]).toMatchObject({ WasMentioned: true });
  });

  it("treats replies to bot threads as implicit mentions", async () => {
    configure({ channels: { C1: { requireMention: true } } });
    replyMock.mockResolvedValue({ text: "hi" });
    await run({
      text: "following up",
      ts: "124",
      thread_ts: "123",
      parent_user_id: "bot-user",
      channel_type: "channel",
    });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]?.[0]).toMatchObject({ WasMentioned: true });
  });

  it("keeps always-on message-tool-only turns private", async () => {
    configure(
      { requireMention: false },
      {
        ackReactionScope: "all",
        groupChat: { visibleReplies: "message_tool" },
        statusReactions: { enabled: true },
      },
    );
    replyMock.mockResolvedValue({ text: "quiet" });
    await run({ channel_type: "channel" });
    await flush();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(reactMock).not.toHaveBeenCalled();
  });

  it("updates session status when replies start", async () => {
    configure({ replyToMode: "all" });
    replyMock.mockImplementation(async (...args: unknown[]) => {
      const options = (args[1] ?? {}) as { onReplyStart?: () => Promise<void> | void };
      await options.onReplyStart?.();
      return { text: "final reply" };
    });
    await run();
    const setStatus = getSlackClient().apiCall;
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    const target = { token: "bot-token", channel_id: "C1", thread_ts: "123" };
    expect(setStatus).toHaveBeenNthCalledWith(1, "agents.sessions.setStatus", {
      ...target,
      status: "processing",
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, "agents.sessions.setStatus", {
      ...target,
      status: "active",
    });
  });

  it("keeps a self-thread DM reply on the main DM session", async () => {
    replyMock.mockResolvedValue({ text: "thread reply" });
    await run({ thread_ts: "123", parent_user_id: "U2" });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]?.[0]).toMatchObject({
      SessionKey: "agent:main:main",
      ParentSessionKey: undefined,
    });
  });

  it("keeps replyToId directive threading when replyToMode is all", async () => {
    configure({ replyToMode: "all" });
    replyMock.mockResolvedValue({ text: "forced reply", replyToId: "555" });
    await run({ ts: "789" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[2].threadTs).toBe("555");
  });

  it("applies acknowledgement scope changes without reconnecting", async () => {
    const config: OpenClawConfig = {
      messages: { ackReaction: "eyes", ackReactionScope: "off" },
      channels: { slack: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    slackTestState.config = config;
    setRuntimeConfigSnapshot(config, config);
    replyMock.mockResolvedValue({ text: "reply" });
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      for (const [index, scope] of (["off", "all", "off"] as const).entries()) {
        const next: OpenClawConfig = {
          ...config,
          messages: { ...config.messages, ackReactionScope: scope },
        };
        setRuntimeConfigSnapshot(next, next);
        await runSlackHandlerWithDispatch(handler, { event: event({ ts: `200.${index}` }) });
        await vi.waitFor(() => expect(reactionAddMock).toHaveBeenCalledTimes(index === 0 ? 0 : 1));
        expect(slackTestState.appStartMock).toHaveBeenCalledTimes(1);
        expect(slackTestState.appStopMock).not.toHaveBeenCalled();
      }
      expect(reactionAddMock).toHaveBeenCalledWith({
        channel: "C1",
        timestamp: "200.1",
        name: "eyes",
      });
    } finally {
      try {
        await stopSlackMonitor(monitor);
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it("keeps ack reaction after sending the missing-reply fallback with status reactions enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    configureReactions();
    await runMention();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe(
      "PFX ⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs.",
    );
    await expectAck();
  });

  it("keeps status reactions for mentioned message-tool-only turns", async () => {
    replyMock.mockResolvedValue({ text: "quiet default reply" });
    configureReactions("message_tool");
    await runMention();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    await expectAck();
  });

  it("restores the ack reaction when dispatch fails before delivery", async () => {
    replyMock.mockRejectedValue(new Error("boom"));
    configureReactions();
    await expect(runMention()).rejects.toThrow("boom");
    expect(sendMock).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        const names = reactionAddMock.mock.calls.map(([args]) => (args as { name: string }).name);
        expect(names.slice(0, 2)).toEqual(["eyes", "x"]);
        expect(names.at(-1)).toBe("eyes");
      },
      { timeout: 5_000 },
    );
  });

  it("sends a pairing challenge only when the request is newly created", async () => {
    configure({ dmPolicy: "pairing", allowFrom: [] });
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await handler({ event: event() });
      await handler({ event: event({ ts: "124", text: "hello again" }) });
    } finally {
      await stopSlackMonitor(monitor);
    }
    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expectPairingReplyText(sendMock.mock.calls[0]?.[1] ?? "", {
      channel: "slack",
      idLine: "Your Slack user id: U1",
      code: "PAIRCODE",
    });
  });

  it("routes thread replies and starter context to the selected agent", async () => {
    configure(
      { replyToMode: "off", channels: { C1: { requireMention: false } } },
      { groupChat: { visibleReplies: "automatic" } },
    );
    slackTestState.config = {
      ...slackTestState.config,
      bindings: [{ agentId: "support", match: { channel: "slack", teamId: "T1" } }],
    };
    replyMock.mockResolvedValue({ text: "ok" });
    const client = getSlackClient();
    client.auth.test.mockResolvedValue({ user_id: "bot-user", team_id: "T1" });
    client.conversations.info.mockResolvedValue({ channel: { name: "general", is_channel: true } });
    client.conversations.replies.mockResolvedValue({
      messages: [{ text: "starter message", user: "U2", ts: "111.222" }],
    });
    await run({
      text: "thread reply",
      ts: "123.456",
      thread_ts: "111.222",
      channel_type: "channel",
    });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]?.[0]).toMatchObject({
      SessionKey: "agent:support:slack:channel:c1:thread:111.222",
      ParentSessionKey: undefined,
      ThreadStarterBody: expect.stringContaining("starter message"),
      ThreadLabel: expect.stringContaining("Slack thread #general"),
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[2].threadTs).toBe("111.222");
  });

  it.each<MentionCase>([
    {
      name: "native mention in a nested list",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "Ask " },
                { type: "user", user_id: "UTARGET" },
                { type: "text", text: " now" },
              ],
            },
          ],
        },
      ],
      expected: "Ask <@UTARGET> (Target Person) now",
    },
    {
      name: "literal mention-shaped text",
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "Ask <@UTARGET> now" }] },
      ],
      expected: "Ask &lt;@UTARGET&gt; now",
    },
  ])("preserves $name before model dispatch", async ({ elements, expected }) => {
    getSlackClient().users.info.mockResolvedValue({
      user: { profile: { display_name: "Target Person" } },
    });
    await run(
      {
        channel: "D12345678",
        user: "USENDER",
        ts: "1787800000.000100",
        text: "Ask",
        blocks: [{ type: "rich_text", elements }],
      },
      true,
    );
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]?.[0]).toMatchObject({ RawBody: expected });
  });
});

it("matches only the configured slash command, with an optional leading slash", () => {
  const matcher = buildSlackSlashCommandMatcher("openclaw");
  expect(matcher.test("openclaw")).toBe(true);
  expect(matcher.test("/openclaw")).toBe(true);
  expect(matcher.test("/openclaw-bot")).toBe(false);
});

it.each([false, true])(
  "recovers a missing thread timestamp, marking lookup failures ambiguous (failure=%s)",
  async (fails) => {
    const history = vi.fn();
    if (fails) {
      history.mockRejectedValueOnce(new Error("history failed"));
    } else {
      history.mockResolvedValueOnce({ messages: [{ ts: "456", thread_ts: "111.222" }] });
    }
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history } } as never,
    });
    const message = event({ ts: "456", parent_user_id: "U2", channel_type: "channel" });
    const expected = fails
      ? { ...message, _ambiguousThreadReply: true }
      : { ...message, thread_ts: "111.222" };
    expect(await resolver.resolve({ message, source: "message" })).toEqual(expected);
  },
);
