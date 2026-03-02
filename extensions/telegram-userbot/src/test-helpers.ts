/**
 * Shared test mocks and fixtures for telegram-userbot integration tests.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock UserbotClient
// ---------------------------------------------------------------------------

export function createMockClient() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({
      id: 267619672n,
      username: "testbot",
      firstName: "Test",
    }),
    getSessionString: vi.fn().mockReturnValue("mock-session-string"),
    getClient: vi.fn().mockReturnValue({}),
    sendMessage: vi.fn().mockResolvedValue({ id: 1, date: 1700000000 }),
    sendFile: vi.fn().mockResolvedValue({ id: 2, date: 1700000001 }),
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
// Mock ConnectionManager
// ---------------------------------------------------------------------------

export function createMockConnectionManager(client = createMockClient()) {
  return {
    getClient: vi.fn().mockReturnValue(client),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockReturnValue({ connected: true, reconnectAttempts: 0 }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

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
