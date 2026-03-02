/**
 * Shared test mocks and fixtures for telegram-userbot integration tests.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { vi } from "vitest";
import type { TelegramUserbotConfig } from "./config-schema.js";
import type { FloodController } from "./flood-control.js";
import type { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Mock UserbotClient
// ---------------------------------------------------------------------------

export function createMockClient() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    connectInteractive: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({
      id: 267619672n,
      username: "testbot",
      firstName: "Test",
    }),
    getSessionString: vi.fn().mockReturnValue("mock-session-string"),
    getClient: vi.fn().mockReturnValue({
      addEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
    }),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1, date: 1700000000 }),
    sendFile: vi.fn().mockResolvedValue({ messageId: 2, date: 1700000001 }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessages: vi.fn().mockResolvedValue(undefined),
    forwardMessages: vi.fn().mockResolvedValue(undefined),
    reactToMessage: vi.fn().mockResolvedValue(undefined),
    pinMessage: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    setTyping: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock SessionStore
// ---------------------------------------------------------------------------

export function createMockSessionStore(
  overrides: Partial<Record<keyof SessionStore, unknown>> = {},
) {
  return {
    load: vi.fn().mockResolvedValue("saved-session"),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    getSessionPath: vi.fn().mockReturnValue("/tmp/session"),
    credentialsDir: "/tmp",
    ...overrides,
  } as unknown as SessionStore;
}

// ---------------------------------------------------------------------------
// Mock FloodController
// ---------------------------------------------------------------------------

export function createMockFloodController(
  overrides: Partial<Record<keyof FloodController, unknown>> = {},
) {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    reportFloodWait: vi.fn(),
    getMetrics: vi.fn().mockReturnValue({
      totalAcquires: 0,
      totalWaits: 0,
      totalFloodWaits: 0,
      avgWaitMs: 0,
    }),
    reset: vi.fn(),
    ...overrides,
  } as unknown as FloodController;
}

// ---------------------------------------------------------------------------
// Mock ConnectionManager
// ---------------------------------------------------------------------------

export function createMockConnectionManager(client = createMockClient()) {
  return {
    getClient: vi.fn().mockReturnValue(client),
    start: vi.fn().mockResolvedValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(true),
    health: vi.fn().mockReturnValue({
      connected: true,
      latencyMs: 0,
      uptimeMs: 5000,
      reconnects: 0,
      username: "testbot",
      userId: 267619672,
    }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock GramJS message
// ---------------------------------------------------------------------------

/**
 * Create a fake GramJS message object with sensible defaults.
 * Pass overrides to customize individual fields.
 */
export function createMockGramMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    text: "hello world",
    out: false,
    senderId: BigInt(12345),
    chatId: BigInt(67890),
    date: 1700000000,
    replyTo: undefined as { replyToMsgId?: number } | undefined,
    fwdFrom: undefined,
    media: undefined,
    getChat: vi.fn().mockResolvedValue(undefined),
    getSender: vi.fn().mockResolvedValue(undefined),
    className: "Message",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

/**
 * Create a valid TelegramUserbotConfig with sensible defaults.
 */
export function createTestConfig(
  overrides: Partial<TelegramUserbotConfig> = {},
): TelegramUserbotConfig {
  return {
    apiId: 12345,
    apiHash: "abc123hash0123456789abcdef",
    ...overrides,
  };
}

export function makeValidConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        apiId: 12345,
        apiHash: "abc123hash0123456789abcdef",
        ...overrides,
      },
    },
  } as unknown as OpenClawConfig;
}

export function makeDisabledConfig(): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        apiId: 12345,
        apiHash: "abc123hash0123456789abcdef",
        enabled: false,
      },
    },
  } as unknown as OpenClawConfig;
}

export function makeEmptyConfig(): OpenClawConfig {
  return { channels: {} } as unknown as OpenClawConfig;
}
