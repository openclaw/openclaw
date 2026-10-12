// grammY's apiThrottler() does not expose its Bottleneck instances, so a
// retired bot token's limiters — and their heartbeat timers — could never be
// disconnected. This module mirrors the upstream apiThrottler() defaults
// (@grammyjs/transformer-throttler 1.2.1) while retaining ownership handles
// for disposal. Keep the option shapes in sync with upstream defaults.
import { Bottleneck } from "@grammyjs/transformer-throttler/dist/deps.node.js";
import type { Transformer } from "grammy";

export type OwnedGrammyApiThrottler = {
  transformer: Transformer;
  dispose: () => Promise<void>;
};

export function createOwnedGrammyApiThrottler(): OwnedGrammyApiThrottler {
  const globalThrottler = new Bottleneck({
    reservoir: 30,
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 1000,
  });
  const groupThrottler = new Bottleneck.Group({
    maxConcurrent: 1,
    minTime: 1000,
    reservoir: 20,
    reservoirRefreshAmount: 20,
    reservoirRefreshInterval: 60_000,
  });
  const outThrottler = new Bottleneck.Group({ maxConcurrent: 1, minTime: 1000 });
  groupThrottler.on("created", (throttler) => throttler.chain(globalThrottler));
  outThrottler.on("created", (throttler) => throttler.chain(globalThrottler));

  let retired = false;
  const transformer: Transformer = (prev, method, payload, signal) => {
    // Retired transformers must not create new group limiters for chats never
    // seen before; callers holding this transformer fail loudly instead.
    if (retired) {
      return Promise.reject(new Error("Telegram throttler for this token has been released"));
    }
    if (!payload || !("chat_id" in payload)) {
      return prev(method, payload, signal);
    }
    // Mirrors upstream: non-numeric chat ids compare false and take the DM lane.
    const chatId = Number(payload.chat_id);
    const throttler = chatId < 0 ? groupThrottler.key(`${chatId}`) : outThrottler.key(`${chatId}`);
    return throttler.schedule(() => prev(method, payload, signal));
  };

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposePromise ??= (async () => {
      retired = true;
      // Settle before disconnecting: stop() rejects queued schedule promises
      // and blocks new ones while running jobs finish; disconnect alone would
      // leave queued sends waiting on a reservoir that can never refill.
      const stopKeys = (group: Bottleneck.Group) =>
        group.limiters().map(({ limiter }) => limiter.stop({ dropWaitingJobs: true }));
      await Promise.all([
        globalThrottler.stop({ dropWaitingJobs: true }),
        ...stopKeys(groupThrottler),
        ...stopKeys(outThrottler),
      ]);
      // Group.deleteKey removes the key limiter and disconnects it, clearing
      // its heartbeat; the global limiter needs its own disconnect.
      const disconnectKeys = (group: Bottleneck.Group) =>
        group.limiters().map(({ key }) => group.deleteKey(key));
      await Promise.all([
        globalThrottler.disconnect(),
        ...disconnectKeys(groupThrottler),
        ...disconnectKeys(outThrottler),
      ]);
      // Bottleneck v2 groups start a perpetual auto-cleanup interval and
      // expose no API to stop it (Group.disconnect only handles shared
      // connections). Clear the internal handle so a retired token leaves no
      // timers behind. Pinned bottleneck 2.19.5 — revisit on upgrade.
      for (const group of [groupThrottler, outThrottler]) {
        const interval = (group as unknown as { interval?: ReturnType<typeof setInterval> })
          .interval;
        if (interval !== undefined) {
          clearInterval(interval);
        }
      }
    })());

  return { transformer, dispose };
}
