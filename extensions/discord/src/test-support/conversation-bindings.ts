// Shared fixtures and assertions for retained user-owned Discord bindings.
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

export function createUserOwnedAcpTarget(targetSessionKey: string) {
  return {
    targetKind: "acp" as const,
    targetSessionKey,
    boundBy: "owner-1",
    agentId: "main",
  };
}

export function createConfiguredCodexBinding(sessionKey: string, conversationId: string) {
  const record: SessionBindingRecord = {
    bindingId: "configured-plugin-binding",
    targetSessionKey: sessionKey,
    targetKind: "session",
    conversation: { channel: "discord", accountId: "default", conversationId },
    status: "active",
    boundAt: 1,
    metadata: {
      pluginBindingOwner: "plugin",
      pluginId: "openclaw-codex-app-server",
      pluginRoot: "/synthetic/codex-plugin",
    },
  };
  return {
    record,
    statefulTarget: { kind: "stateful" as const, driverId: "codex", sessionKey, agentId: "codex" },
  };
}

export function expectThreadCreateOptionsWithoutArchiveOverride(value: unknown): void {
  const options = requireRecord(value, "thread options");
  expect(options.name).toBeTypeOf("string");
  expect(options).not.toHaveProperty("autoArchiveMinutes");
}
