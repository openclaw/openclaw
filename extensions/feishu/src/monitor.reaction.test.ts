import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasControlCommand } from "../../../src/auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../src/auto-reply/inbound-debounce.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import * as dedup from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { resolveReactionSyntheticEvent, type FeishuReactionCreatedEvent } from "./monitor.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async (_params: { event?: unknown }) => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: handleFeishuMessageMock,
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

const cfg = {} as ClawdbotConfig;

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

function createFetchedReactionMessage(chatId: string) {
  return {
    messageId: "om_msg1",
    chatId,
    senderOpenId: "ou_bot",
    content: "hello",
    contentType: "text",
  };
}

async function resolveReactionWithLookup(params: {
  event?: FeishuReactionCreatedEvent;
  lookupChatId: string;
}) {
  return await resolveReactionSyntheticEvent({
    cfg,
    accountId: "default",
    event: params.event ?? makeReactionEvent(),
    botOpenId: "ou_bot",
    fetchMessage: async () => createFetchedReactionMessage(params.lookupChatId),
    uuid: () => "fixed-uuid",
  });
}

type FeishuMention = NonNullable<FeishuMessageEvent["message"]["mentions"]>[number];

function buildDebounceConfig(): ClawdbotConfig {
  return {
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 20,
        },
      },
    },
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildDebounceAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createTextEvent(params: {
  messageId: string;
  text: string;
  senderId?: string;
  mentions?: FeishuMention[];
}): FeishuMessageEvent {
  const senderId = params.senderId ?? "ou_sender";
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_group_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
    },
  };
}

async function setupDebounceMonitor(params?: {
  botOpenId?: string;
  botName?: string;
}): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    cfg: buildDebounceConfig(),
    account: buildDebounceAccount(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as RuntimeEnv,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: params?.botOpenId ?? "ou_bot",
      botName: params?.botName,
    },
  });

  const onMessage = handlers["im.message.receive_v1"];
  if (!onMessage) {
    throw new Error("missing im.message.receive_v1 handler");
  }
  return onMessage;
}

function getFirstDispatchedEvent(): FeishuMessageEvent {
  const firstCall = handleFeishuMessageMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("missing dispatch call");
  }
  const firstParams = firstCall[0] as { event?: FeishuMessageEvent } | undefined;
  if (!firstParams?.event) {
    throw new Error("missing dispatched event payload");
  }
  return firstParams.event;
}

function setDedupPassThroughMocks(): void {
  vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
  vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
  vi.spyOn(dedup, "hasRecordedMessage").mockReturnValue(false);
  vi.spyOn(dedup, "hasRecordedMessagePersistent").mockResolvedValue(false);
}

function createMention(params: { openId: string; name: string; key?: string }): FeishuMention {
  return {
    key: params.key ?? "@_user_1",
    id: { open_id: params.openId },
    name: params.name,
  };
}

async function enqueueDebouncedMessage(
  onMessage: (data: unknown) => Promise<void>,
  event: FeishuMessageEvent,
): Promise<void> {
  await onMessage(event);
  await Promise.resolve();
  await Promise.resolve();
}

describe("resolveReactionSyntheticEvent", () => {
  it("filters app self-reactions", async () => {
    const event = makeReactionEvent({ operator_type: "app" });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("filters Typing reactions", async () => {
    const event = makeReactionEvent({ reaction_type: { emoji_type: "Typing" } });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("fails closed when bot open_id is unavailable", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
    });
    expect(result).toBeNull();
  });

  it("drops reactions when reactionNotifications is off", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg: {
        channels: {
          feishu: {
            reactionNotifications: "off",
          },
        },
      } as ClawdbotConfig,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group",
        senderOpenId: "ou_bot",
        senderType: "app",
        content: "hello",
        contentType: "text",
      }),
    });
    expect(result).toBeNull();
  });

  it("filters reactions on non-bot messages", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group",
        senderOpenId: "ou_other",
        senderType: "user",
        content: "hello",
        contentType: "text",
      }),
    });
    expect(result).toBeNull();
  });

  it("allows non-bot reactions when reactionNotifications is all", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg: {
        channels: {
          feishu: {
            reactionNotifications: "all",
          },
        },
      } as ClawdbotConfig,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group",
        senderOpenId: "ou_other",
        senderType: "user",
        content: "hello",
        contentType: "text",
      }),
      uuid: () => "fixed-uuid",
    });
    expect(result?.message.message_id).toBe("om_msg1:reaction:THUMBSUP:fixed-uuid");
  });

  it("drops unverified reactions when sender verification times out", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      verificationTimeoutMs: 1,
      fetchMessage: async () =>
        await new Promise<never>(() => {
          // Never resolves
        }),
    });
    expect(result).toBeNull();
  });

  it("uses event chat context when provided", async () => {
    const result = await resolveReactionWithLookup({
      event: makeReactionEvent({
        chat_id: "oc_group_from_event",
        chat_type: "group",
      }),
      lookupChatId: "oc_group_from_lookup",
    });

    expect(result).toEqual({
      sender: {
        sender_id: { open_id: "ou_user1" },
        sender_type: "user",
      },
      message: {
        message_id: "om_msg1:reaction:THUMBSUP:fixed-uuid",
        chat_id: "oc_group_from_event",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: "[reacted with THUMBSUP to message om_msg1]",
        }),
      },
    });
  });

  it("falls back to reacted message chat_id when event chat_id is absent", async () => {
    const result = await resolveReactionWithLookup({
      lookupChatId: "oc_group_from_lookup",
    });

    expect(result?.message.chat_id).toBe("oc_group_from_lookup");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("falls back to sender p2p chat when lookup returns empty chat_id", async () => {
    const result = await resolveReactionWithLookup({
      lookupChatId: "",
    });

    expect(result?.message.chat_id).toBe("p2p:ou_user1");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("logs and drops reactions when lookup throws", async () => {
    const log = vi.fn();
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "acct1",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => {
        throw new Error("boom");
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ignoring reaction on non-bot/unverified message om_msg1"),
    );
  });
});

describe("Feishu inbound debounce regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    handleFeishuMessageMock.mockClear();
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          debounce: {
            createInboundDebouncer,
            resolveInboundDebounceMs,
          },
          text: {
            hasControlCommand,
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps bot mention when per-message mention keys collide across non-forward messages", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_1",
        text: "first",
        mentions: [createMention({ openId: "ou_user_a", name: "user-a" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_2",
        text: "@bot second",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatched = getFirstDispatchedEvent();
    const mergedMentions = dispatched.message.mentions ?? [];
    expect(mergedMentions.some((mention) => mention.id.open_id === "ou_bot")).toBe(true);
    expect(mergedMentions.some((mention) => mention.id.open_id === "ou_user_a")).toBe(false);
  });

  it("passes prefetched botName through to handleFeishuMessage", async () => {
    vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
    vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
    vi.spyOn(dedup, "hasRecordedMessage").mockReturnValue(false);
    vi.spyOn(dedup, "hasRecordedMessagePersistent").mockResolvedValue(false);
    const onMessage = await setupDebounceMonitor({ botName: "OpenClaw Bot" });

    await onMessage(
      createTextEvent({
        messageId: "om_name_passthrough",
        text: "@bot hello",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "OpenClaw Bot",
          },
        ],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const firstParams = handleFeishuMessageMock.mock.calls[0]?.[0] as
      | { botName?: string }
      | undefined;
    expect(firstParams?.botName).toBe("OpenClaw Bot");
  });

  it("does not synthesize mention-forward intent across separate messages", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_user_mention",
        text: "@alice first",
        mentions: [createMention({ openId: "ou_alice", name: "alice" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_bot_mention",
        text: "@bot second",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatched = getFirstDispatchedEvent();
    const parsed = parseFeishuMessageEvent(dispatched, "ou_bot");
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets).toBeUndefined();
    const mergedMentions = dispatched.message.mentions ?? [];
    expect(mergedMentions.every((mention) => mention.id.open_id === "ou_bot")).toBe(true);
  });

  it("preserves bot mention signal when the latest merged message has no mentions", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_bot_first",
        text: "@bot first",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_plain_second",
        text: "plain follow-up",
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatched = getFirstDispatchedEvent();
    const parsed = parseFeishuMessageEvent(dispatched, "ou_bot");
    expect(parsed.mentionedBot).toBe(true);
  });

  it("excludes previously processed retries from combined debounce text", async () => {
    vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
    vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
    vi.spyOn(dedup, "hasRecordedMessage").mockImplementation((key) => key.endsWith(":om_old"));
    vi.spyOn(dedup, "hasRecordedMessagePersistent").mockImplementation(
      async (messageId) => messageId === "om_old",
    );
    const onMessage = await setupDebounceMonitor();

    await onMessage(createTextEvent({ messageId: "om_old", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_new_1", text: "first" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_old", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_new_2", text: "second" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatched = getFirstDispatchedEvent();
    expect(dispatched.message.message_id).toBe("om_new_2");
    const combined = JSON.parse(dispatched.message.content) as { text?: string };
    expect(combined.text).toBe("first\nsecond");
  });

  it("uses latest fresh message id when debounce batch ends with stale retry", async () => {
    const recordSpy = vi.spyOn(dedup, "tryRecordMessage").mockReturnValue(true);
    vi.spyOn(dedup, "tryRecordMessagePersistent").mockResolvedValue(true);
    vi.spyOn(dedup, "hasRecordedMessage").mockImplementation((key) => key.endsWith(":om_old"));
    vi.spyOn(dedup, "hasRecordedMessagePersistent").mockImplementation(
      async (messageId) => messageId === "om_old",
    );
    const onMessage = await setupDebounceMonitor();

    await onMessage(createTextEvent({ messageId: "om_new", text: "fresh" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_old", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const dispatched = getFirstDispatchedEvent();
    expect(dispatched.message.message_id).toBe("om_new");
    const combined = JSON.parse(dispatched.message.content) as { text?: string };
    expect(combined.text).toBe("fresh");
    expect(recordSpy).toHaveBeenCalledWith("default:om_old");
    expect(recordSpy).not.toHaveBeenCalledWith("default:om_new");
  });
});
