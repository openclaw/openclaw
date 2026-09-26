// Nostr plugin module implements test fixtures behavior.
import { vi } from "vitest";
import type { ResolvedNostrAccount } from "./types.js";

export const NOSTR_SANITIZER_CASES = [
  {
    name: "strips an internal tool-failure banner",
    text: "Done.\n\u26a0\ufe0f \u{1f6e0}\ufe0f `search repos (agent)` failed",
    expected: "Done.",
  },
  {
    name: "strips internal tool-call XML",
    text: '<tool_call>{"name":"read","arguments":{"path":"private"}}</tool_call>Done.',
    expected: "Done.",
  },
  {
    name: "strips multiline tool-response scaffolding",
    text: ["Before", "<function_response>", "private output", "</function_response>", "After"].join(
      "\n",
    ),
    expected: "Before\n\nAfter",
  },
  {
    name: "suppresses an internal-trace-only reply",
    text: "\u26a0\ufe0f \u{1f6e0}\ufe0f `search repos (agent)` failed",
    expected: "",
  },
  {
    name: "preserves ordinary visible prose",
    text: "The relay has two active subscriptions.",
    expected: "The relay has two active subscriptions.",
  },
];

export function createMockNostrBus(eventId?: string) {
  return {
    sendDm: vi.fn(async () => eventId),
    close: vi.fn(async () => {}),
    getMetrics: vi.fn(() => ({ counters: {} })),
    publishProfile: vi.fn(),
    getProfileState: vi.fn(async () => null),
  };
}

export const TEST_HEX_PRIVATE_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const TEST_HEX_PUBLIC_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export const TEST_RELAY_URL = "wss://relay.example.com";
export const TEST_SETUP_RELAY_URLS = ["wss://relay.damus.io", "wss://relay.primal.net"];
export const TEST_RESOLVED_PRIVATE_KEY = "resolved-nostr-private-key";

export const TEST_HEX_PRIVATE_KEY_BYTES = new Uint8Array(
  TEST_HEX_PRIVATE_KEY.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
);

export function createConfiguredNostrCfg(overrides: Record<string, unknown> = {}): {
  channels: { nostr: Record<string, unknown> };
} {
  return {
    channels: {
      nostr: {
        privateKey: TEST_HEX_PRIVATE_KEY,
        ...overrides,
      },
    },
  };
}

export function buildResolvedNostrAccount(
  overrides: Partial<ResolvedNostrAccount> = {},
): ResolvedNostrAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    privateKey: TEST_HEX_PRIVATE_KEY,
    publicKey: TEST_HEX_PUBLIC_KEY,
    relays: [TEST_RELAY_URL],
    config: {},
    ...overrides,
  };
}
