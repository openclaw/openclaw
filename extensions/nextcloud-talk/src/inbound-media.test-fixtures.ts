import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import type { NextcloudTalkInboundAttachment, NextcloudTalkInboundMessage } from "./types.js";

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

export function createAllowlistedAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  return createAccount({
    config: {
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      mediaAllowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      ...config,
    },
  });
}

export function createAttachment(
  fileId: string,
  overrides?: Partial<NextcloudTalkInboundAttachment>,
): NextcloudTalkInboundAttachment {
  return {
    fileId,
    name: "receipt.pdf",
    mimeType: "application/pdf",
    declaredSizeBytes: 1_024,
    shareUrl: "https://cloud.example.com/s/redacted-share-token",
    hideDownload: false,
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
