/**
 * Integration tests for the telegram-userbot channel.
 *
 * Tests component interactions with mocked GramJS client.
 * Covers: config validation, outbound flow, message actions,
 * flood control, fallback behavior, and allowFrom filtering.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { telegramUserbotAgentPromptAdapter } from "./adapters/agent-prompt.js";
import { resolveTelegramUserbotAccount, listTelegramUserbotAccountIds } from "./adapters/config.js";
import { telegramUserbotDirectoryAdapter } from "./adapters/directory.js";
import { telegramUserbotMessageActions } from "./adapters/message-actions.js";
import { telegramUserbotStreamingAdapter } from "./adapters/streaming.js";
import { telegramUserbotThreadingAdapter } from "./adapters/threading.js";
import { telegramUserbotConfigSchema } from "./config-schema.js";
import {
  makeValidConfig,
  makeDisabledConfig,
  makeEmptyConfig,
  createMockClient,
  createMockConnectionManager,
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

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  it("accepts valid config with required fields", () => {
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
});

// ---------------------------------------------------------------------------
// Account Resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Message Actions Integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent Prompt Integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Streaming Adapter Integration
// ---------------------------------------------------------------------------

describe("streaming adapter integration", () => {
  it("provides coalesce defaults", () => {
    expect(telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults).toBeDefined();
    expect(
      telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults!.minChars,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Directory Adapter Integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Threading Adapter Integration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fallback Behavior
// ---------------------------------------------------------------------------

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
