/**
 * Integration tests for the telegram-userbot channel.
 *
 * Tests component interactions with mocked GramJS client.
 * Covers: connection lifecycle, inbound flow, outbound flow,
 * config validation, flood control, normalize round-trips,
 * message actions, adapter integration, and fallback behavior.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramUserbotAgentPromptAdapter } from "./adapters/agent-prompt.js";
import { listTelegramUserbotAccountIds, resolveTelegramUserbotAccount } from "./adapters/config.js";
import { telegramUserbotDirectoryAdapter } from "./adapters/directory.js";
import { telegramUserbotMessageActions } from "./adapters/message-actions.js";
import { telegramUserbotStreamingAdapter } from "./adapters/streaming.js";
import { telegramUserbotThreadingAdapter } from "./adapters/threading.js";
import { telegramUserbotConfigSchema } from "./config-schema.js";
import { ConnectionManager } from "./connection.js";
import { UserbotAuthError } from "./errors.js";
import { FloodController } from "./flood-control.js";
import { registerInboundHandlers, type InboundHandlerConfig } from "./inbound.js";
import {
  CHANNEL_PREFIX,
  formatChannelChatId,
  normalizeChatId,
  parseChannelChatId,
} from "./normalize.js";
import { chunkMessage, sendMedia, sendText, TELEGRAM_TEXT_LIMIT } from "./outbound.js";
import {
  createMockClient,
  createMockConnectionManager,
  createMockFloodController,
  createMockGramMessage,
  createTestConfig,
  makeDisabledConfig,
  makeEmptyConfig,
  makeValidConfig,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Mock channel.ts getConnectionManager for message actions
// ---------------------------------------------------------------------------

const mockClient = createMockClient();
const mockManager = createMockConnectionManager(mockClient);

vi.mock("./channel.js", () => ({
  getConnectionManager: vi.fn((accountId: string) => {
    if (accountId === "missing" || accountId === "disconnected") return undefined;
    return mockManager;
  }),
}));

vi.mock("./adapters/config.js", async () => {
  const actual = await vi.importActual("./adapters/config.js");
  return {
    ...actual,
    resolveTelegramUserbotAccount: vi.fn(
      ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
        const section = cfg.channels?.["telegram-userbot"] as Record<string, unknown> | undefined;
        return {
          accountId: accountId ?? "default",
          name: (section?.name as string) ?? undefined,
          enabled: section?.enabled !== false,
          configured: Boolean(section?.apiId && section?.apiHash),
          apiId: (section?.apiId as number) ?? 0,
          apiHash: (section?.apiHash as string) ?? "",
          config: section ?? {},
        };
      },
    ),
    listTelegramUserbotAccountIds: vi.fn(() => ["default"]),
  };
});

// ===========================================================================
// 1. CONNECTION LIFECYCLE (uses real ConnectionManager with mocked client)
// ===========================================================================

// Separate mock for connection lifecycle tests. The ConnectionManager
// constructs UserbotClient internally, so we mock the client module.
const connMockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(true),
  getMe: vi.fn().mockResolvedValue({
    id: 267619672,
    firstName: "Test",
    username: "testuser",
  }),
  getSessionString: vi.fn().mockReturnValue("session-xyz"),
  getClient: vi.fn(),
  sendMessage: vi.fn(),
  sendFile: vi.fn(),
  editMessage: vi.fn(),
  deleteMessages: vi.fn(),
  forwardMessages: vi.fn(),
  reactToMessage: vi.fn(),
  pinMessage: vi.fn(),
  getHistory: vi.fn(),
  setTyping: vi.fn(),
  connectInteractive: vi.fn(),
};

vi.mock("./client.js", () => ({
  UserbotClient: vi.fn().mockImplementation(() => connMockClient),
}));

function createMockSessionStore(session: string | null = "saved-session") {
  return {
    load: vi.fn().mockResolvedValue(session),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(session !== null),
    getSessionPath: vi.fn().mockReturnValue("/tmp/session"),
    credentialsDir: "/tmp",
  };
}

describe("connection lifecycle integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset connection mock client to defaults
    connMockClient.connect.mockResolvedValue(undefined);
    connMockClient.disconnect.mockResolvedValue(undefined);
    connMockClient.isConnected.mockReturnValue(true);
    connMockClient.getMe.mockResolvedValue({
      id: 267619672,
      firstName: "Test",
      username: "testuser",
    });
    connMockClient.getSessionString.mockReturnValue("session-xyz");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start with valid session connects and emits 'connected' event", async () => {
    const store = createMockSessionStore("valid-session");
    const mgr = new ConnectionManager(
      { apiId: 12345, apiHash: "abc123", accountId: "test" },
      store as never,
    );

    const events: string[] = [];
    mgr.on("connected", () => events.push("connected"));

    const result = await mgr.start();

    expect(result).toBe(true);
    expect(connMockClient.connect).toHaveBeenCalledOnce();
    expect(connMockClient.getMe).toHaveBeenCalledOnce();
    expect(events).toContain("connected");
  });

  it("start with no session does not connect and emits 'disconnected'", async () => {
    const store = createMockSessionStore(null);
    const mgr = new ConnectionManager(
      { apiId: 12345, apiHash: "abc123", accountId: "test" },
      store as never,
    );

    const events: Array<{ event: string; data: unknown }> = [];
    mgr.on("disconnected", (data: unknown) => events.push({ event: "disconnected", data }));

    const result = await mgr.start();

    expect(result).toBe(false);
    expect(connMockClient.connect).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { reason: string }).reason).toBe("no-session");
  });

  it("auth error on connect emits 'authError' without reconnect", async () => {
    const store = createMockSessionStore("stale-session");
    connMockClient.connect.mockRejectedValueOnce(new UserbotAuthError("SESSION_REVOKED"));

    const mgr = new ConnectionManager(
      { apiId: 12345, apiHash: "abc123", accountId: "test" },
      store as never,
    );

    const authEvents: unknown[] = [];
    const reconnectEvents: unknown[] = [];
    mgr.on("authError", (d: unknown) => authEvents.push(d));
    mgr.on("reconnecting", (d: unknown) => reconnectEvents.push(d));

    const result = await mgr.start();

    expect(result).toBe(false);
    expect(authEvents).toHaveLength(1);
    expect(reconnectEvents).toHaveLength(0);
  });

  it("reconnect after transient disconnect retries with backoff", async () => {
    const store = createMockSessionStore("valid-session");
    connMockClient.connect
      .mockRejectedValueOnce(new Error("network timeout")) // initial failure
      .mockResolvedValue(undefined); // reconnect succeeds

    const mgr = new ConnectionManager(
      { apiId: 12345, apiHash: "abc123", accountId: "test" },
      store as never,
    );

    const reconnectEvents: Array<{ attempt: number; delayMs: number }> = [];
    const connectedEvents: unknown[] = [];
    mgr.on("reconnecting", (d: { attempt: number; delayMs: number }) => reconnectEvents.push(d));
    mgr.on("connected", (d: unknown) => connectedEvents.push(d));

    await mgr.start(); // fails, schedules reconnect
    expect(reconnectEvents).toHaveLength(1);
    expect(reconnectEvents[0]!.delayMs).toBe(0); // first attempt is immediate

    // Fire the immediate reconnect timer
    await vi.advanceTimersByTimeAsync(1);
    expect(connectedEvents).toHaveLength(1);
  });
});

// ===========================================================================
// 2. INBOUND FLOW
// ===========================================================================

// Mock the NewMessage event class for inbound tests
vi.mock("telegram/events/index.js", () => {
  class NewMessage {
    constructor(public filter: unknown) {}
  }
  return { NewMessage };
});

type EventHandler = (event: unknown) => Promise<void>;

function createInboundMockClient() {
  const handlers: { fn: EventHandler; filter: unknown }[] = [];

  const gramClient = {
    addEventHandler: vi.fn((fn: EventHandler, filter: unknown) => {
      handlers.push({ fn, filter });
    }),
    removeEventHandler: vi.fn(),
  };

  const client = {
    getClient: vi.fn().mockReturnValue(gramClient),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    getMe: vi.fn(),
    getSessionString: vi.fn(),
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    deleteMessages: vi.fn(),
    forwardMessages: vi.fn(),
    reactToMessage: vi.fn(),
    pinMessage: vi.fn(),
    getHistory: vi.fn(),
    setTyping: vi.fn(),
  };

  return { client: client as never, handlers };
}

async function dispatchInboundEvent(
  handlers: { fn: EventHandler; filter: unknown }[],
  message: ReturnType<typeof createMockGramMessage>,
) {
  for (const h of handlers) {
    await h.fn({ message });
  }
}

describe("inbound flow integration", () => {
  it("text message creates InboundTelegramMessage with correct fields", async () => {
    const { client, handlers } = createInboundMockClient();
    const onMessage = vi.fn();
    const config: InboundHandlerConfig = { selfUserId: 99999, onMessage };

    registerInboundHandlers(client, config);

    const msg = createMockGramMessage({
      id: 100,
      text: "test message",
      senderId: BigInt(12345),
      chatId: BigInt(67890),
    });

    await dispatchInboundEvent(handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
    const inbound = onMessage.mock.calls[0]![0];
    expect(inbound.channel).toBe("telegram-userbot");
    expect(inbound.messageId).toBe(100);
    expect(inbound.text).toBe("test message");
    expect(inbound.senderId).toBe(12345);
    expect(inbound.chatId).toBe("67890");
    expect(inbound.channelChatId).toBe("telegram-userbot:67890");
  });

  it("own outgoing message (message.out=true) is silently ignored", async () => {
    const { client, handlers } = createInboundMockClient();
    const onMessage = vi.fn();
    registerInboundHandlers(client, { selfUserId: 99999, onMessage });

    await dispatchInboundEvent(handlers, createMockGramMessage({ out: true }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("message from non-allowFrom user is silently ignored", async () => {
    const { client, handlers } = createInboundMockClient();
    const onMessage = vi.fn();
    registerInboundHandlers(client, {
      selfUserId: 99999,
      onMessage,
      allowFrom: [999, 888],
    });

    await dispatchInboundEvent(handlers, createMockGramMessage({ senderId: BigInt(777) }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("message from allowFrom user is processed", async () => {
    const { client, handlers } = createInboundMockClient();
    const onMessage = vi.fn();
    registerInboundHandlers(client, {
      selfUserId: 99999,
      onMessage,
      allowFrom: [12345, 888],
    });

    await dispatchInboundEvent(handlers, createMockGramMessage({ senderId: BigInt(12345) }));

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("media message has mediaType resolved correctly", async () => {
    const { client, handlers } = createInboundMockClient();
    const onMessage = vi.fn();
    registerInboundHandlers(client, { selfUserId: 99999, onMessage });

    await dispatchInboundEvent(
      handlers,
      createMockGramMessage({
        media: { className: "MessageMediaPhoto" },
      }),
    );

    expect(onMessage.mock.calls[0]![0].mediaType).toBe("photo");
  });
});

// ===========================================================================
// 3. OUTBOUND FLOW
// ===========================================================================

describe("outbound flow integration", () => {
  it("sendText calls flood control acquire then client.sendMessage", async () => {
    const client = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 100, date: 1000 }),
    } as never;
    const fc = createMockFloodController();

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text: "hello",
    });

    expect(fc.acquire).toHaveBeenCalledWith("12345");
    expect(result.messageIds).toEqual([100]);
    expect(result.error).toBeUndefined();
  });

  it("long message is chunked into multiple pieces", async () => {
    const client = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ messageId: 1, date: 100 })
        .mockResolvedValueOnce({ messageId: 2, date: 101 }),
    } as never;
    const fc = createMockFloodController();

    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const text = `${line1}\n${line2}`;

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text,
      chunkLimit: 50,
    });

    expect(result.messageIds).toEqual([1, 2]);
    // Two chunks means two acquire calls
    expect(fc.acquire).toHaveBeenCalledTimes(2);
  });

  it("sendMedia calls client.sendFile with forceDocument", async () => {
    const client = {
      sendFile: vi.fn().mockResolvedValue({ messageId: 200, date: 2000 }),
    } as never;
    const fc = createMockFloodController();

    const result = await sendMedia({
      client,
      floodController: fc,
      chatId: 12345,
      file: "/tmp/doc.pdf",
      forceDocument: true,
    });

    expect(fc.acquire).toHaveBeenCalledWith("12345");
    expect(result.messageId).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it("error during send returns error result, does not throw", async () => {
    const client = {
      sendMessage: vi.fn().mockRejectedValue(new Error("network timeout")),
    } as never;
    const fc = createMockFloodController();

    const result = await sendText({
      client,
      floodController: fc,
      chatId: 12345,
      text: "hello",
    });

    expect(result.messageIds).toEqual([]);
    expect(result.error).toBe("network timeout");
  });
});

// ===========================================================================
// 4. CONFIG VALIDATION
// ===========================================================================

describe("config validation", () => {
  it("accepts valid minimal config (apiId + apiHash)", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiId: 12345,
      apiHash: "abc123hash",
    });
    expect(result.success).toBe(true);
  });

  it("rejects config without apiId", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiHash: "abc123hash",
    });
    expect(result.success).toBe(false);
  });

  it("rejects config without apiHash", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiId: 12345,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty config", () => {
    const result = telegramUserbotConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts config with optional rate limit", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiId: 12345,
      apiHash: "abc",
      rateLimit: { messagesPerSecond: 10, perChatPerSecond: 2 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with capabilities", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiId: 12345,
      apiHash: "abc",
      capabilities: {
        deleteOtherMessages: false,
        readHistory: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with allowFrom", () => {
    const result = telegramUserbotConfigSchema.safeParse({
      apiId: 12345,
      apiHash: "abc",
      allowFrom: [111222, "@someuser"],
    });
    expect(result.success).toBe(true);
  });

  it("parses full config with all options correctly", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      allowFrom: [267619672, "@alice"],
      rateLimit: {
        messagesPerSecond: 10,
        perChatPerSecond: 2,
        jitterMs: [100, 300],
      },
      reconnect: {
        maxAttempts: 5,
        alertAfterFailures: 2,
      },
      capabilities: {
        deleteOtherMessages: false,
        readHistory: false,
        forceDocument: false,
      },
    });

    expect(parsed.apiId).toBe(14858133);
    expect(parsed.apiHash).toBe("abc123def456");
    expect(parsed.allowFrom).toEqual([267619672, "@alice"]);
    expect(parsed.rateLimit?.messagesPerSecond).toBe(10);
    expect(parsed.rateLimit?.perChatPerSecond).toBe(2);
    expect(parsed.rateLimit?.jitterMs).toEqual([100, 300]);
    expect(parsed.reconnect?.maxAttempts).toBe(5);
    expect(parsed.reconnect?.alertAfterFailures).toBe(2);
    expect(parsed.capabilities?.deleteOtherMessages).toBe(false);
    expect(parsed.capabilities?.readHistory).toBe(false);
    expect(parsed.capabilities?.forceDocument).toBe(false);
  });
});

// ===========================================================================
// 5. FLOOD CONTROL (integration-level -- component behavior)
// ===========================================================================

describe("flood control integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("concurrent sends are throttled by global rate", async () => {
    // globalRate=2 means only 2 tokens available at start
    const fc = new FloodController({ globalRate: 2, perChatRate: 100, jitterMs: [0, 0] });
    const results: number[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 3; i++) {
      const idx = i;
      promises.push(
        fc.acquire(`chat-${idx}`).then(() => {
          results.push(idx);
        }),
      );
    }

    // First 2 resolve immediately (bucket has 2 tokens)
    await vi.advanceTimersByTimeAsync(0);
    expect(results.length).toBe(2);

    // Third needs time for token refill (1/2 = 500ms)
    await vi.advanceTimersByTimeAsync(600);
    expect(results.length).toBe(3);

    await Promise.all(promises);
  });

  it("per-chat rate limiting works independently", async () => {
    const fc = new FloodController({ globalRate: 100, perChatRate: 1, jitterMs: [0, 0] });
    const results: string[] = [];

    // Two different chats should both resolve immediately
    const pA = fc.acquire("chatA").then(() => results.push("A"));
    const pB = fc.acquire("chatB").then(() => results.push("B"));

    await vi.advanceTimersByTimeAsync(0);
    expect(results).toContain("A");
    expect(results).toContain("B");
    expect(results.length).toBe(2);

    await Promise.all([pA, pB]);
  });

  it("reportFloodWait pauses all operations", async () => {
    const fc = new FloodController({ globalRate: 100, perChatRate: 100, jitterMs: [0, 0] });

    fc.reportFloodWait(3);

    const resolved: boolean[] = [];
    const p = fc.acquire("chat-1").then(() => resolved.push(true));

    // Should not resolve before flood wait expires
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolved.length).toBe(0);

    // After flood wait expires it should resolve
    await vi.advanceTimersByTimeAsync(1100);
    expect(resolved.length).toBe(1);

    await p;
  });
});

// ===========================================================================
// 6. NORMALIZE (integration-level -- round-trip consistency)
// ===========================================================================

describe("normalize integration", () => {
  it("chat ID normalization round-trip: number -> string -> number", () => {
    const original = 267619672;
    const normalized = normalizeChatId(original);
    expect(normalized).toBe("267619672");
    expect(Number(normalized)).toBe(original);
  });

  it("chat ID normalization round-trip: bigint -> string -> number", () => {
    const original = BigInt(-1001234567890);
    const normalized = normalizeChatId(original);
    expect(normalized).toBe("-1001234567890");
    expect(Number(normalized)).toBe(Number(original));
  });

  it("channel prefix format/parse consistency", () => {
    const chatId = 267619672;
    const formatted = formatChannelChatId(chatId);
    expect(formatted).toBe(`${CHANNEL_PREFIX}:267619672`);

    const parsed = parseChannelChatId(formatted);
    expect(parsed).toBe(chatId);
  });

  it("negative channel ID round-trips through format/parse", () => {
    const chatId = -1001234567890;
    const formatted = formatChannelChatId(chatId);
    const parsed = parseChannelChatId(formatted);
    expect(parsed).toBe(chatId);
  });

  it("parseChannelChatId handles plain numeric string", () => {
    expect(parseChannelChatId("42")).toBe(42);
  });
});

// ===========================================================================
// 7. ACCOUNT RESOLUTION
// ===========================================================================

describe("account resolution", () => {
  it("resolves configured account", () => {
    const account = resolveTelegramUserbotAccount({ cfg: makeValidConfig() });
    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.apiId).toBe(12345);
  });

  it("resolves disabled account", () => {
    const account = resolveTelegramUserbotAccount({ cfg: makeDisabledConfig() });
    expect(account.enabled).toBe(false);
  });

  it("resolves unconfigured account", () => {
    const account = resolveTelegramUserbotAccount({ cfg: makeEmptyConfig() });
    expect(account.configured).toBe(false);
  });
});

// ===========================================================================
// 8. MESSAGE ACTIONS INTEGRATION
// ===========================================================================

describe("message actions integration", () => {
  const handleAction = telegramUserbotMessageActions.handleAction!;
  const listActions = telegramUserbotMessageActions.listActions!;

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager.getClient.mockReturnValue(mockClient);
    mockClient.isConnected.mockReturnValue(true);
  });

  it("lists supported actions when configured", () => {
    const actions = listActions({ cfg: makeValidConfig() });
    expect(actions).toContain("delete");
    expect(actions).toContain("edit");
    expect(actions).toContain("react");
    expect(actions).toContain("pin");
  });

  it("returns empty actions when disabled", () => {
    const actions = listActions({ cfg: makeDisabledConfig() });
    expect(actions).toEqual([]);
  });

  it("delete action calls client.deleteMessages", async () => {
    await handleAction({
      channel: "telegram-userbot",
      action: "delete",
      cfg: makeValidConfig(),
      params: { to: "12345", messageId: 42 },
      accountId: "default",
    });
    expect(mockClient.deleteMessages).toHaveBeenCalledWith("12345", [42], true);
  });

  it("edit action calls client.editMessage", async () => {
    await handleAction({
      channel: "telegram-userbot",
      action: "edit",
      cfg: makeValidConfig(),
      params: { to: "12345", messageId: 10, text: "updated" },
      accountId: "default",
    });
    expect(mockClient.editMessage).toHaveBeenCalledWith("12345", 10, "updated");
  });

  it("react action calls client.reactToMessage", async () => {
    await handleAction({
      channel: "telegram-userbot",
      action: "react",
      cfg: makeValidConfig(),
      params: { to: "12345", messageId: 20, emoji: "\u2764\uFE0F" },
      accountId: "default",
    });
    expect(mockClient.reactToMessage).toHaveBeenCalledWith("12345", 20, "\u2764\uFE0F");
  });

  it("pin action calls client.pinMessage", async () => {
    await handleAction({
      channel: "telegram-userbot",
      action: "pin",
      cfg: makeValidConfig(),
      params: { to: "12345", messageId: 55 },
      accountId: "default",
    });
    expect(mockClient.pinMessage).toHaveBeenCalledWith("12345", 55);
  });

  it("throws for unsupported action", async () => {
    await expect(
      handleAction({
        channel: "telegram-userbot",
        action: "search" as never,
        cfg: makeValidConfig(),
        params: { to: "12345" },
        accountId: "default",
      }),
    ).rejects.toThrow(/not supported/);
  });

  it("throws when no connection manager (disconnected)", async () => {
    await expect(
      handleAction({
        channel: "telegram-userbot",
        action: "delete",
        cfg: makeValidConfig(),
        params: { to: "12345", messageId: 1 },
        accountId: "missing",
      }),
    ).rejects.toThrow(/no active connection/);
  });
});

// ===========================================================================
// 9. AGENT PROMPT INTEGRATION
// ===========================================================================

describe("agent prompt integration", () => {
  it("returns hints for configured account", () => {
    const hints = telegramUserbotAgentPromptAdapter.messageToolHints!({
      cfg: makeValidConfig(),
    });
    expect(hints.length).toBeGreaterThan(0);
    const text = hints.join("\n");
    expect(text).toContain("Telegram");
  });

  it("dynamically excludes disabled capabilities", () => {
    const hints = telegramUserbotAgentPromptAdapter.messageToolHints!({
      cfg: makeValidConfig({ capabilities: { deleteOtherMessages: false } }),
    });
    const text = hints.join("\n");
    expect(text).not.toContain("delete other");
  });
});

// ===========================================================================
// 10. STREAMING ADAPTER INTEGRATION
// ===========================================================================

describe("streaming adapter integration", () => {
  it("provides coalesce defaults", () => {
    expect(telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults).toBeDefined();
    expect(
      telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults!.minChars,
    ).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 11. DIRECTORY ADAPTER INTEGRATION
// ===========================================================================

describe("directory adapter integration", () => {
  it("lists peers from allowFrom", async () => {
    const result = await telegramUserbotDirectoryAdapter.listPeers!({
      cfg: makeValidConfig({ allowFrom: ["@alice", 12345] }),
      accountId: "default",
      runtime: {} as never,
    });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toContain("@alice");
    expect(result.map((e) => e.id)).toContain("12345");
  });

  it("returns self info", async () => {
    const result = await telegramUserbotDirectoryAdapter.self!({
      cfg: makeValidConfig(),
      accountId: "default",
      runtime: {} as never,
    });
    expect(result).toBeTruthy();
    expect(result!.kind).toBe("user");
  });
});

// ===========================================================================
// 12. THREADING ADAPTER INTEGRATION
// ===========================================================================

describe("threading adapter integration", () => {
  it("builds tool context with forum topic", () => {
    const result = telegramUserbotThreadingAdapter.buildToolContext!({
      cfg: {} as never,
      context: {
        To: "12345",
        CurrentMessageId: 42,
        MessageThreadId: 999,
      },
    });
    expect(result?.currentChannelId).toBe("12345");
    expect(result?.currentThreadTs).toBe("999");
    expect(result?.replyToMode).toBe("all");
  });

  it("resolves replyToMode as all", () => {
    const mode = telegramUserbotThreadingAdapter.resolveReplyToMode!({
      cfg: {} as never,
    });
    expect(mode).toBe("all");
  });
});

// ===========================================================================
// 13. FALLBACK BEHAVIOR
// ===========================================================================

describe("fallback when disconnected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("actions fail gracefully with clear error", async () => {
    mockManager.getClient.mockReturnValue(null);
    await expect(
      telegramUserbotMessageActions.handleAction!({
        channel: "telegram-userbot",
        action: "pin",
        cfg: makeValidConfig(),
        params: { to: "12345", messageId: 1 },
        accountId: "default",
      }),
    ).rejects.toThrow(/not connected/);
  });
});

// ===========================================================================
// 14. TEST HELPER FACTORIES (verify mocks have correct shape)
// ===========================================================================

describe("test helper factories", () => {
  it("createTestConfig returns valid config", () => {
    const config = createTestConfig();
    const result = telegramUserbotConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("createTestConfig with overrides merges correctly", () => {
    const config = createTestConfig({
      allowFrom: [123, "@bob"],
      rateLimit: { messagesPerSecond: 5, perChatPerSecond: 1, jitterMs: [10, 20] },
    });
    const result = telegramUserbotConfigSchema.parse(config);
    expect(result.allowFrom).toEqual([123, "@bob"]);
    expect(result.rateLimit?.messagesPerSecond).toBe(5);
  });

  it("createMockGramMessage returns a properly shaped message", () => {
    const msg = createMockGramMessage({ id: 999, text: "custom" });
    expect(msg.id).toBe(999);
    expect(msg.text).toBe("custom");
    expect(msg.out).toBe(false);
    expect(typeof msg.getChat).toBe("function");
    expect(typeof msg.getSender).toBe("function");
  });

  it("createMockFloodController has all required methods", () => {
    const fc = createMockFloodController();
    expect(typeof fc.acquire).toBe("function");
    expect(typeof fc.reportFloodWait).toBe("function");
    expect(typeof fc.getMetrics).toBe("function");
    expect(typeof fc.reset).toBe("function");
  });
});
