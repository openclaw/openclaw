// LINE event fixtures shared by handler, durable spool, and upgrade-migration suites.
import type { webhook } from "@line/bot-sdk";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelIngressQueueForTests as createChannelIngressQueue } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";

export type SpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

/** Row shape written by the pre-drain (#109655) spool worker; only seeded by upgrade tests. */
type LegacySpoolPayload = {
  version: number;
  destination: string;
  event: webhook.Event;
};

export const runtime = (): RuntimeEnv => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() });

export function createTestMessageEvent(params: {
  message: webhook.MessageEvent["message"];
  source: webhook.MessageEvent["source"];
  webhookEventId: string;
  timestamp?: number;
  replyToken?: string;
  isRedelivery?: boolean;
  mode?: webhook.EventMode;
}): webhook.MessageEvent {
  return {
    type: "message",
    message: params.message,
    ...(params.mode === "standby" ? {} : { replyToken: params.replyToken ?? "reply-token" }),
    timestamp: params.timestamp ?? Date.now(),
    source: params.source,
    mode: params.mode ?? "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: params.isRedelivery ?? false },
  };
}

export function createEvent(params: {
  webhookEventId: string;
  messageId?: string;
  userId?: string;
  text?: string;
  /** Marks the event as one part of a LINE multi-image send. */
  imageSet?: { id: string; index: number; total: number };
  mode?: webhook.EventMode;
}): webhook.Event {
  const message: webhook.MessageEvent["message"] = params.imageSet
    ? {
        id: params.messageId ?? `message-${params.webhookEventId}`,
        type: "image",
        contentProvider: { type: "line" },
        imageSet: params.imageSet,
        quoteToken: "test-quote-token-placeholder",
      }
    : {
        id: params.messageId ?? `message-${params.webhookEventId}`,
        type: "text",
        text: params.text ?? "hello",
        quoteToken: "test-quote-token-placeholder",
      };
  return createTestMessageEvent({
    message,
    replyToken: "test-reply-token",
    source: { type: "user", userId: params.userId ?? "user-1" },
    mode: params.mode,
    webhookEventId: params.webhookEventId,
  });
}

export function callback(event: webhook.Event): webhook.CallbackRequest {
  return { destination: "destination-1", events: [event] };
}

export function payloadFor(event: webhook.Event): SpoolPayload {
  return { version: 1, rawEvent: JSON.stringify(event), destination: "destination-1" };
}

export async function withQueue<T>(
  fn: (
    queue: ChannelIngressQueue<SpoolPayload>,
    legacySeed: ChannelIngressQueue<LegacySpoolPayload>,
  ) => Promise<T>,
): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-line-spool-", applyEnv: false },
    async ({ stateDir }) => {
      const queueOptions = { channelId: "line", accountId: "default", stateDir };
      const queue = createChannelIngressQueue<SpoolPayload>(queueOptions);
      // Upgrade tests seed the pre-drain row shape through the same store.
      const legacySeed = createChannelIngressQueue<LegacySpoolPayload>(queueOptions);
      return await fn(queue, legacySeed);
    },
  );
}

export async function waitForVerdict(
  queue: ChannelIngressQueue<SpoolPayload>,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, {
        version: 1,
        rawEvent: "{}",
        destination: "",
      });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 4_000 },
  );
}
