import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand, isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import * as dedup from "./dedup.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { FeishuMessageInfo, ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() =>
  vi.fn(async (_params: Parameters<typeof import("./bot.js").handleFeishuMessage>[0]) => {}),
);
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
let stopDebounceMonitor: (() => Promise<void>) | undefined;

vi.mock("./client.js", () => ({ createEventDispatcher: createEventDispatcherMock }));
vi.mock("./bot.js", async () => ({
  ...(await vi.importActual<typeof import("./bot.js")>("./bot.js")),
  handleFeishuMessage: handleFeishuMessageMock,
}));
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));
vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

afterEach(async () => {
  try {
    const results = await Promise.allSettled([stopDebounceMonitor?.()]);
    results.push(...(await Promise.allSettled([closeOpenClawStateDatabaseAsync()])));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Feishu reaction test cleanup failed");
    }
    stopDebounceMonitor = undefined;
    vi.restoreAllMocks();
  } finally {
    vi.useRealTimers();
  }
});
afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./bot.js");
  vi.doUnmock("./monitor.transport.js");
  vi.doUnmock("./thread-bindings.js");
  vi.resetModules();
});

function makeReactionEvent(
  overrides: Partial<FeishuReactionCreatedEvent> = {},
): FeishuReactionCreatedEvent {
  return {
    message_id: "om_msg1",
    reaction_type: { emoji_type: "THUMBSUP" },
    operator_type: "user",
    user_id: { open_id: "ou_user1" },
    ...overrides,
  };
}
function fetchedMessage(overrides: Partial<FeishuMessageInfo> = {}): FeishuMessageInfo {
  return {
    messageId: "om_msg1",
    chatId: "oc_group_from_lookup",
    chatType: "group",
    senderOpenId: "ou_bot",
    content: "hello",
    contentType: "text",
    ...overrides,
  };
}
function resolveReaction(
  params: Partial<Parameters<typeof resolveReactionSyntheticEvent>[0]> = {},
) {
  return resolveReactionSyntheticEvent({
    cfg: {},
    accountId: "default",
    event: makeReactionEvent(),
    botOpenId: "ou_bot",
    fetchMessage: async () => fetchedMessage(),
    uuid: () => "fixed-uuid",
    ...params,
  });
}
function monitorParams(): Parameters<typeof monitorSingleAccount>[0] {
  return {
    cfg: {
      messages: { inbound: { debounceMs: 0, byChannel: { feishu: 20 } } },
      channels: { feishu: { enabled: true } },
    } as ClawdbotConfig,
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      appId: "cli_test",
      appSecret: "secret_test", // pragma: allowlist secret
      domain: "feishu",
      config: { enabled: true, connectionMode: "websocket" },
    } as ResolvedFeishuAccount,
    runtime: createNonExitingRuntimeEnv(),
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
  };
}
function installRuntime() {
  setFeishuRuntime({
    channel: {
      commands: { isControlCommandMessage },
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
      text: { hasControlCommand },
    },
  } as unknown as PluginRuntime);
}
async function setupDebounceMonitor() {
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  let onMessage: ((data: unknown) => Promise<void>) | undefined;
  createEventDispatcherMock.mockReturnValue({
    register: (handlers: Record<string, (data: unknown) => Promise<void>>) => {
      onMessage = handlers["im.message.receive_v1"];
    },
  });
  monitorWebSocketMock.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  const monitor = monitorSingleAccount({
    ...monitorParams(),
    // A partial injected runtime must fall back to the installed channel runtime.
    channelRuntime: { runtimeContexts: {} } as unknown as PluginRuntime["channel"],
  });
  stopDebounceMonitor = async () => {
    finish.resolve();
    await monitor;
  };
  await Promise.race([started.promise, monitor]);
  if (!onMessage) {
    throw new Error("missing im.message.receive_v1 handler");
  }
  return onMessage;
}

type FeishuMention = NonNullable<FeishuMessageEvent["message"]["mentions"]>[number];
function createTextEvent(params: {
  messageId: string;
  text: string;
  mentions?: FeishuMention[];
  threadId?: string;
}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    message: {
      message_id: params.messageId,
      chat_id: "oc_group_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
      ...(params.threadId ? { thread_id: params.threadId } : {}),
    },
  };
}
function mention(openId: string, name: string, key = "@_user_1"): FeishuMention {
  return { key, id: { open_id: openId }, name };
}
async function enqueueText(
  onMessage: (data: unknown) => Promise<void>,
  ...messages: Array<Parameters<typeof createTextEvent>[0]>
) {
  for (const message of messages) {
    await onMessage(createTextEvent(message));
    await Promise.resolve();
    await Promise.resolve();
  }
}
function dispatchedMessage(index = 0) {
  const call = handleFeishuMessageMock.mock.calls[index]?.[0];
  if (!call) {
    throw new Error("missing Feishu message dispatch");
  }
  return call;
}
function parsedDispatch() {
  expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
  const { event, preparedContent } = dispatchedMessage();
  return { dispatched: event, parsed: parseFeishuMessageEvent(event, "ou_bot", preparedContent) };
}
function setDedupPassThroughMocks() {
  vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockResolvedValue({
    kind: "claimed",
    handle: { keys: ["test"], commit: async () => true, release: () => undefined },
  });
  vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
}

describe("resolveReactionSyntheticEvent", () => {
  it.each([
    { name: "app self-reactions", params: { event: makeReactionEvent({ operator_type: "app" }) } },
    {
      name: "Typing reactions",
      params: { event: makeReactionEvent({ reaction_type: { emoji_type: "Typing" } }) },
    },
    { name: "unavailable bot identity", params: { botOpenId: undefined } },
    {
      name: "disabled notifications",
      params: { cfg: { channels: { feishu: { reactionNotifications: "off" } } } as ClawdbotConfig },
    },
  ])("filters $name", async ({ params }) => {
    const fetchMessage = vi.fn(async () => fetchedMessage());
    expect(await resolveReaction({ fetchMessage, ...params })).toBeNull();
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("filters reactions on non-bot messages", async () => {
    expect(
      await resolveReaction({
        fetchMessage: async () => fetchedMessage({ senderOpenId: "ou_other", senderType: "user" }),
      }),
    ).toBeNull();
  });

  it("preserves reaction actors and lookup chat context without an open_id", async () => {
    const result = await resolveReaction({
      event: makeReactionEvent({ user_id: { user_id: "u_actor_only" }, chat_type: "bogus" }),
    });
    expect(result?.sender.sender_id).toEqual({ user_id: "u_actor_only" });
    expect(result?.message.chat_id).toBe("oc_group_from_lookup");
    expect(result?.message.chat_type).toBe("group");
    expect(parseFeishuMessageEvent(result!, "ou_bot").senderOpenId).toBe("u_actor_only");
  });

  it("preserves the real reply anchor and topic ownership for deleted reactions", async () => {
    const result = await resolveReaction({
      action: "deleted",
      event: makeReactionEvent({ chat_id: "oc_group_from_event", chat_type: "topic_group" }),
      fetchMessage: async () =>
        fetchedMessage({ chatType: "private", rootId: "om_topic_root", threadId: "omt_topic" }),
    });
    expect(result?.message).toMatchObject({
      reply_target_message_id: "om_msg1",
      typing_target_message_id: "om_msg1",
      chat_id: "oc_group_from_event",
      chat_type: "topic_group",
      root_id: "om_topic_root",
      thread_id: "omt_topic",
    });
    expect(parseFeishuMessageEvent(result!, "ou_bot")).toMatchObject({
      replyTargetMessageId: "om_msg1",
      rootId: "om_topic_root",
      threadId: "omt_topic",
    });
  });

  it("drops unverified reactions when sender verification times out", async () => {
    vi.useFakeTimers();
    const pending = resolveReaction({
      verificationTimeoutMs: 1,
      fetchMessage: () => new Promise<never>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it("falls back to sender p2p chat when lookup returns empty chat_id", async () => {
    const result = await resolveReaction({
      fetchMessage: async () => fetchedMessage({ chatId: "", chatType: "p2p" }),
    });
    expect(result?.message.chat_id).toBe("p2p:ou_user1");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("drops reactions without chat context when lookup does not provide chat_type", async () => {
    expect(
      await resolveReaction({ fetchMessage: async () => fetchedMessage({ chatType: undefined }) }),
    ).toBeNull();
  });

  it("logs and drops reactions when lookup throws", async () => {
    const log = vi.fn();
    const result = await resolveReaction({
      accountId: "acct1",
      fetchMessage: async () => {
        throw new Error("boom");
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "feishu[acct1]: ignoring reaction on non-bot/unverified message om_msg1 (sender: unknown)",
    );
  });
});

describe("Feishu inbound debounce regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handleFeishuMessageMock.mockClear();
    installRuntime();
  });

  it("keeps root-less topic threads in separate debounce buckets", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();
    await enqueueText(
      onMessage,
      { messageId: "om_topic_a", text: "topic alpha", threadId: "omt_topic_a" },
      { messageId: "om_topic_b", text: "topic beta", threadId: "omt_topic_b" },
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
    expect(
      handleFeishuMessageMock.mock.calls.map(([{ event }]) => ({
        threadId: event.message.thread_id,
        text: JSON.parse(event.message.content).text,
      })),
    ).toEqual([
      { threadId: "omt_topic_a", text: "topic alpha" },
      { threadId: "omt_topic_b", text: "topic beta" },
    ]);
  });

  it("releases pending text before a bare abort trigger instead of debouncing it", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();
    await enqueueText(onMessage, { messageId: "om_1", text: "first" });
    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
    await enqueueText(onMessage, { messageId: "om_stop", text: "stop" });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(dispatchedMessage().event.message.content)).toEqual({ text: "first" });
    expect(dispatchedMessage(1).event.message.message_id).toBe("om_stop");
    expect(JSON.parse(dispatchedMessage(1).event.message.content)).toEqual({ text: "stop" });
  });

  it("preserves only the bot mention across separate messages ending without mentions", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();
    await enqueueText(
      onMessage,
      {
        messageId: "om_user_mention",
        text: "@alice first",
        mentions: [mention("ou_alice", "alice")],
      },
      { messageId: "om_bot_mention", text: "@bot second", mentions: [mention("ou_bot", "bot")] },
      { messageId: "om_plain_last", text: "plain follow-up" },
    );
    await vi.advanceTimersByTimeAsync(25);
    const { dispatched, parsed } = parsedDispatch();
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets).toBeUndefined();
    expect(dispatched.message.mentions?.map((entry) => entry.id.open_id)).toEqual(["ou_bot"]);
  });

  it("normalizes each debounced message once without mixing per-message mention keys", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();
    await enqueueText(
      onMessage,
      {
        messageId: "om_literal_first",
        text: "@_bot @_user_1 first",
        mentions: [mention("ou_bot", "Bot", "@_bot"), mention("ou_alice", "Alice @_user_10")],
      },
      {
        messageId: "om_literal_last",
        text: "@_bot @_user_1 @_user_10thanks",
        mentions: [
          mention("ou_bot", "Bot", "@_bot"),
          mention("ou_bob", "Bob"),
          mention("ou_carol", "Carol", "@_user_10"),
        ],
      },
    );
    await vi.advanceTimersByTimeAsync(25);
    const { dispatched, parsed } = parsedDispatch();
    expect(dispatched.message.message_id).toBe("om_literal_last");
    expect(parsed.content).toBe(
      '<at user_id="ou_alice">Alice @_user_10</at> first\n<at user_id="ou_bob">Bob</at> <at user_id="ou_carol">Carol</at>thanks',
    );
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets?.map((target) => target.openId)).toEqual(["ou_bob", "ou_carol"]);
  });

  it("excludes stale retries and keeps the latest fresh message as the batch anchor", async () => {
    const staleCommit = vi.fn(async () => true);
    vi.spyOn(dedup, "claimUnprocessedFeishuMessage").mockImplementation(async ({ messageId }) => ({
      kind: "claimed",
      handle: {
        keys: [messageId ?? "test"],
        commit: messageId === "om_old" ? staleCommit : async () => true,
        release: () => undefined,
      },
    }));
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockImplementation(async (id) => id === "om_old");
    const onMessage = await setupDebounceMonitor();
    await enqueueText(
      onMessage,
      { messageId: "om_old", text: "stale" },
      { messageId: "om_new_1", text: "first" },
      { messageId: "om_old", text: "stale" },
      { messageId: "om_new_2", text: "second" },
      { messageId: "om_old", text: "stale" },
    );
    await vi.advanceTimersByTimeAsync(25);
    const { dispatched, parsed } = parsedDispatch();
    expect(dispatched.message.message_id).toBe("om_new_2");
    expect(parsed.content).toBe("first\nsecond");
    expect(staleCommit).toHaveBeenCalledTimes(1);
  });
});
