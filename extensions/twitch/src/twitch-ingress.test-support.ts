// Twitch tests share isolated durable-ingress state and raw chat envelopes.
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll } from "vitest";
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

export function useTwitchIngressTestQueue() {
  let state: OpenClawTestState | undefined;
  let poisoned = false;
  beforeAll(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-twitch-ingress-",
    });
  });
  afterAll(async () => {
    await state?.cleanup();
  });

  return async <T>(
    fn: (queue: TwitchIngressTestQueue, createIngress: typeof createTwitchIngress) => Promise<T>,
  ): Promise<T> => {
    if (!state || poisoned) {
      throw new Error(
        "Twitch ingress fixture is unavailable after initialization or cleanup failure",
      );
    }
    const queue = createChannelIngressQueueForTests<TwitchIngressTestPayload>({
      channelId: "twitch",
      accountId: "default",
      stateDir: state.stateDir,
    });
    const purge = queue.purge?.bind(queue);
    if (!purge) {
      throw new Error("Twitch ingress test queue requires purge support");
    }
    const ingresses: ReturnType<typeof createTwitchIngress>[] = [];
    const createIngress: typeof createTwitchIngress = (options) => {
      const ingress = createTwitchIngress(options);
      ingresses.push(ingress);
      return ingress;
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await fn(queue, createIngress) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // Purge cannot race a producer, including when a callback assertion throws before stop.
      const stopped = await Promise.allSettled(
        ingresses.map(async (ingress) => await ingress.stop()),
      );
      const failed = stopped.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        throw new AggregateError(
          failed.map((result) => result.reason),
          "Twitch ingress cleanup failed",
        );
      }
      await purge();
    } catch (error) {
      poisoned = true;
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, error],
          "Twitch ingress callback and cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  };
}
