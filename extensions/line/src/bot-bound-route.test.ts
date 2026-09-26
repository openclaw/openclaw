import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { webhook } from "@line/bot-sdk";
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
import { setLineRuntime } from "./runtime.js";
import type { ResolvedLineAccount } from "./types.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

vi.mock("./send.js", () => ({
  getUserProfile: async () => null,
  getLineGroupName: async () => undefined,
  getUserDisplayName: async (id: string) => id,
  pushMessageLine: vi.fn(),
  replyMessageLine: vi.fn(),
}));

it.each([
  { kind: "group", disabled: false },
  { kind: "user", disabled: false },
  { kind: "group", disabled: true },
  { kind: "user", disabled: true },
] as const)(
  "settles a signed $kind message (disabled=$disabled) with binding-first routing",
  async ({ kind, disabled }) => {
    await withTempHome(async () => {
      setLineRuntime(createPluginRuntimeMock());
      const account: ResolvedLineAccount = {
        accountId: "bound-route",
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        tokenSource: "config",
        config: {
          dmPolicy: disabled ? "disabled" : "allowlist",
          allowFrom: ["sender"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["sender"],
          groups: { "*": { requireMention: true, enabled: !disabled } },
        },
      };
      const cfg: OpenClawConfig = {
        agents: {
          list: disabled
            ? [{ id: "main" }]
            : [
                { id: "main", groupChat: { mentionPatterns: ["wrong-owner"] } },
                { id: "bound", groupChat: { mentionPatterns: ["helper"] } },
              ],
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
      // A second lookup would observe retirement rather than silently choose a new owner.
      let current: SessionBindingRecord | null = binding;
      const adapter = {
        channel: "line",
        accountId: account.accountId,
        listBySession: () => (current ? [current] : []),
        resolveByConversation: () => current,
        inspectByConversationAsync: async () => {
          if (disabled) {
            throw new Error("binding owner unavailable");
          }
          const selected = current;
          current = null;
          return selected;
        },
        touchAsync: async () => {},
      };
      registerSessionBindingAdapter(adapter);
      const processMessage = vi.fn(async () => {});
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const failures: unknown[] = [];
      const handler = createLineNodeWebhookHandler({
        runtime,
        getTargets: () => [
          {
            channelSecret: account.channelSecret,
            bot: {
              // Durability is tested by the spool suite; drive signed parsing through real admission here.
              handleWebhook: async (body) => {
                await handleLineWebhookEvents(body.events, {
                  cfg,
                  account,
                  runtime,
                  mediaMaxBytes: 1024,
                  processMessage,
                }).catch((error: unknown) => {
                  failures.push(error);
                  throw error;
                });
                return "ignored";
              },
            },
          },
        ],
      });
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      try {
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing webhook listener");
        }
        const source: webhook.Source =
          kind === "group"
            ? { type: "group", groupId: conversationId, userId: "sender" }
            : { type: "user", userId: "sender" };
        const body = JSON.stringify({
          events: [
            {
              type: "message",
              source,
              timestamp: 1_800_000_000_000,
              mode: "active",
              webhookEventId: "bound-route",
              deliveryContext: { isRedelivery: false },
              replyToken: "reply-token",
              message: { type: "text", id: "bound-message", text: "hello helper" },
            },
          ],
        });
        const send = () =>
          fetch(`http://127.0.0.1:${address.port}/line/webhook`, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-line-signature": createHmac("sha256", account.channelSecret)
                .update(body)
                .digest("base64"),
            },
          });
        const response = await send();
        expect(response.status).toBe(200);
        await response.text();
        if (disabled) {
          expect(processMessage).not.toHaveBeenCalled();
          expect(failures).toEqual([]);
          return;
        }
        expect(processMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            route: expect.objectContaining({
              agentId: "bound",
              sessionKey: binding.targetSessionKey,
            }),
            ctxPayload: expect.objectContaining({
              AgentId: "bound",
              SessionKey: binding.targetSessionKey,
            }),
          }),
          expect.anything(),
        );
        processMessage.mockClear();
        const unbound = await send();
        expect(unbound.status).toBe(500);
        await unbound.text();
        expect(processMessage).not.toHaveBeenCalled();
        expect(failures).toEqual([expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" })]);
      } finally {
        unregisterSessionBindingAdapter({ channel: "line", accountId: account.accountId, adapter });
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  },
);
