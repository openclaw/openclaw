import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import { lineAccount } from "./channel-account.test-support.js";
import { setLineRuntime } from "./runtime.js";
import { createTestMessageEvent } from "./webhook-spool.test-support.js";

vi.mock("./send.js", () => ({
  getUserProfile: async () => null,
  getLineGroupName: async () => undefined,
  getUserDisplayName: async (id: string) => id,
  pushMessageLine: vi.fn(),
  replyMessageLine: vi.fn(),
}));

// Signed HTTP admission/error mapping lives in monitor.lifecycle.test.ts.
it.each([
  ["group", "none"],
  ["user", "none"],
  ["group", "disabled"],
  ["user", "disabled"],
  ["group", "policy"],
  ["group", "allowlist"],
] as const)("routes %s with binding-first ownership (rejection=%s)", (kind, rejection) =>
  withTempHome(async () => {
    setLineRuntime(createPluginRuntimeMock());
    const rejected = rejection !== "none";
    const disabled = rejection === "disabled";
    const account = lineAccount({
      dmPolicy: disabled ? "disabled" : "allowlist",
      allowFrom: ["sender"],
      groupPolicy: rejection === "policy" ? "disabled" : "allowlist",
      groupAllowFrom: rejection === "allowlist" ? ["other-sender"] : ["sender"],
      groups: { "*": { requireMention: true, enabled: !disabled } },
    });
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { groupChat: { mentionPatterns: ["wrong-owner"] } },
          bound: { groupChat: { mentionPatterns: ["helper"] } },
        },
      },
      channels: { line: account.config },
      bindings: [],
    };
    const conversationId = kind === "group" ? "group" : "sender";
    const binding: SessionBindingRecord = {
      bindingId: "line-bound-route",
      targetSessionKey: "agent:bound:line:proof",
      targetKind: "session",
      conversation: { channel: "line", accountId: account.accountId, conversationId },
      status: "active",
      boundAt: 1,
    };
    let current: SessionBindingRecord | null = binding;
    const adapter = {
      channel: "line",
      accountId: account.accountId,
      listBySession: () => (current ? [current] : []),
      resolveByConversation: () => current,
      inspectByConversationAsync: async () => {
        if (rejected) {
          throw new Error("binding owner unavailable");
        }
        const selected = current;
        current = null;
        return selected;
      },
      touchAsync: async () => {},
    };
    const event = createTestMessageEvent({
      source:
        kind === "group"
          ? { type: "group", groupId: conversationId, userId: "sender" }
          : { type: "user", userId: "sender" },
      timestamp: 1_800_000_000_000,
      webhookEventId: "bound-route",
      message: { type: "text", id: "bound-message", text: "hello helper", quoteToken: "quote" },
    });
    const processMessage = vi.fn<Parameters<typeof handleLineWebhookEvents>[1]["processMessage"]>(
      async () => {},
    );
    const receive = () =>
      handleLineWebhookEvents([event], {
        cfg,
        account,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        mediaMaxBytes: 1024,
        processMessage,
      });
    registerSessionBindingAdapter(adapter);
    try {
      await receive();
      if (rejected) {
        expect(processMessage).not.toHaveBeenCalled();
      } else {
        expect(processMessage.mock.calls[0]?.[0]).toMatchObject({
          route: { agentId: "bound", sessionKey: binding.targetSessionKey },
          ctxPayload: { AgentId: "bound", SessionKey: binding.targetSessionKey },
        });
        processMessage.mockClear();
        await expect(receive()).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
        expect(processMessage).not.toHaveBeenCalled();
      }
    } finally {
      unregisterSessionBindingAdapter({ channel: "line", accountId: account.accountId, adapter });
    }
  }),
);
