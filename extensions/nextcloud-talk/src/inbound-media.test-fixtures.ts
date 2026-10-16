import { vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

export function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  hasControlCommand?: (body: string) => boolean;
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
  shouldHandleTextCommands?: () => boolean;
}) {
  const runtime = {
    channel: {
      inbound: {
        dispatchReply: vi.fn(async () => undefined),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: {
        shouldHandleTextCommands: params?.shouldHandleTextCommands ?? vi.fn(() => false),
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
    },
  };
  setNextcloudTalkRuntime(runtime as unknown as PluginRuntime);
  return runtime;
}

export function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

export function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

export function createAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

export function createMessage(
  overrides?: Partial<NextcloudTalkInboundMessage>,
): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-1",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}
