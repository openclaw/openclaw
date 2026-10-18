// Zalo tests share isolated durable-ingress state and Bot API envelopes.
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import type { zaloWebhookIngressRuntime } from "./webhook-spool.js";

type CreateZaloWebhookIngress = (typeof zaloWebhookIngressRuntime)["createZaloWebhookIngress"];

type ZaloWebhookTestQueue = NonNullable<Parameters<CreateZaloWebhookIngress>[0]["queue"]>;
export type ZaloWebhookTestPayload = Parameters<ZaloWebhookTestQueue["enqueue"]>[1];

export function createZaloWebhookTestEvent(params?: {
  messageId?: string;
  userId?: string;
  chatId?: string;
  text?: string;
  date?: number;
}) {
  return {
    event_name: "message.text.received" as const,
    message: {
      message_id: params?.messageId ?? "message-1",
      from: { id: params?.userId ?? "user-1", name: "Test User" },
      chat: { id: params?.chatId ?? "chat-1", chat_type: "PRIVATE" as const },
      date: params?.date ?? Date.now(),
      text: params?.text ?? "hello",
    },
  };
}

export async function withZaloWebhookTestQueue<T>(
  fn: (queue: ZaloWebhookTestQueue) => Promise<T>,
): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-zalo-ingress-" },
    ({ stateDir }) =>
      fn(
        createChannelIngressQueueForTests<ZaloWebhookTestPayload>({
          channelId: "zalo",
          accountId: "default",
          stateDir,
        }),
      ),
  );
}

export async function waitForZaloWebhookVerdict(
  queue: ZaloWebhookTestQueue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, { version: 1, rawEvent: "{}" });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 5_000 },
  );
}
