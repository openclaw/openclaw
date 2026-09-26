// Twitch tests share isolated durable-ingress state and raw chat envelopes.
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import { createTwitchIngress } from "./twitch-ingress.js";
import type { TwitchChatMessage } from "./types.js";

type TwitchIngressTestQueue = NonNullable<Parameters<typeof createTwitchIngress>[0]["queue"]>;
export type TwitchIngressTestPayload = Parameters<TwitchIngressTestQueue["enqueue"]>[1];

export function createTwitchIngressTestMessage(
  params: Partial<TwitchChatMessage> = {},
): TwitchChatMessage {
  return {
    id: params.id ?? "message-1",
    username: params.username ?? "viewer",
    userId: params.userId ?? "viewer-1",
    displayName: params.displayName ?? "Viewer",
    message: params.message ?? "hello bot",
    channel: params.channel ?? "#TestChannel",
    timestamp: params.timestamp ?? 1_721_300_000_000,
    isMod: params.isMod ?? false,
    isOwner: params.isOwner ?? false,
    isVip: params.isVip ?? false,
    isSub: params.isSub ?? false,
    chatType: "group",
  };
}

export async function withTwitchIngressTestQueue<T>(
  fn: (queue: TwitchIngressTestQueue) => Promise<T>,
): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-twitch-ingress-" },
    ({ stateDir }) =>
      fn(
        createChannelIngressQueueForTests<TwitchIngressTestPayload>({
          channelId: "twitch",
          accountId: "default",
          stateDir,
        }),
      ),
  );
}

export async function waitForTwitchIngressVerdict(
  queue: TwitchIngressTestQueue,
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
