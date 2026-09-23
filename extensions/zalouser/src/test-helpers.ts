// Zalouser helper module supports test helpers behavior.
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

export function createZalouserRuntimeEnv(): RuntimeEnv {
  return {
    log: () => {},
    error: () => {},
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  };
}

export function createDefaultResolvedZalouserAccount(
  overrides: Partial<ResolvedZalouserAccount> = {},
): ResolvedZalouserAccount {
  return {
    accountId: "default",
    profile: "default",
    name: "test",
    enabled: true,
    authenticated: true,
    config: {},
    ...overrides,
  };
}

export function createZalouserGroupMessage(
  overrides: Partial<ZaloInboundMessage> = {},
): ZaloInboundMessage {
  return {
    threadId: "g-1",
    isGroup: true,
    senderId: "123",
    senderName: "Alice",
    groupName: "Team",
    content: "hello",
    timestampMs: Date.now(),
    msgId: "m-1",
    hasAnyMention: false,
    wasExplicitlyMentioned: false,
    canResolveExplicitMention: true,
    implicitMention: false,
    raw: { source: "test" },
    ...overrides,
  };
}

export function createZalouserDmMessage(
  overrides: Partial<ZaloInboundMessage> = {},
): ZaloInboundMessage {
  return {
    threadId: "u-1",
    isGroup: false,
    senderId: "321",
    senderName: "Bob",
    groupName: undefined,
    content: "hello",
    timestampMs: Date.now(),
    msgId: "dm-1",
    raw: { source: "test" },
    ...overrides,
  };
}
