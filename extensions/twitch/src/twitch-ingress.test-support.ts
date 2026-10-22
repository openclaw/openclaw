import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { createTwitchIngress } from "./twitch-ingress.js";
import type { TwitchChatMessage } from "./types.js";

type Queue = NonNullable<Parameters<typeof createTwitchIngress>[0]["queue"]>;
export type TwitchIngressTestPayload = Parameters<Queue["enqueue"]>[1];
type CreateIngress = (
  options: Omit<Parameters<typeof createTwitchIngress>[0], "accountId" | "runtime">,
) => ReturnType<typeof createTwitchIngress>;

export function createTwitchIngressTestMessage(id: string): TwitchChatMessage {
  return { id, username: "viewer", message: "hello bot", channel: "#TestChannel" };
}

export async function withTwitchIngressTestQueue<T>(
  run: (queue: Queue, createIngress: CreateIngress) => Promise<T>,
): Promise<T> {
  // A fresh directory per callback removes shared tombstones and poisoned-fixture state.
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "twitch-ingress-" });
  const ingresses: ReturnType<CreateIngress>[] = [];
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const queue = createChannelIngressQueueForTests<TwitchIngressTestPayload>({
      channelId: "twitch",
      accountId: "default",
      stateDir: state.stateDir,
    });
    outcome = {
      ok: true,
      value: await run(queue, (options) => {
        const ingress = createTwitchIngress({
          accountId: "default",
          runtime: { error: () => {} },
          queue,
          pollIntervalMs: 5,
          ...options,
        });
        ingresses.push(ingress);
        return ingress;
      }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const stopped = await Promise.allSettled(ingresses.map((ingress) => ingress.stop()));
  const failures = stopped
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) {
    // Never remove a directory while a failed producer may still own it.
    throw new AggregateError(
      outcome.ok ? failures : [outcome.error, ...failures],
      "Twitch ingress cleanup failed",
    );
  }
  await state.cleanup();
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
