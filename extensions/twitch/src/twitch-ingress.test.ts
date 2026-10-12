// Twitch durable ingress tests cover raw admission, recovery, and tombstones.
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTwitchIngressTestMessage,
  useTwitchIngressTestQueue,
  type TwitchIngressTestPayload,
} from "./twitch-ingress.test-support.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

const withTwitchIngressTestQueue = useTwitchIngressTestQueue();

function latestMonitor() {
  const result = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
  if (result?.type !== "return") {
    throw new Error("Expected the Twitch ingress monitor");
  }
  return result.value;
}

async function expectSettledIngressVerdict(
  queue: ChannelIngressQueue<TwitchIngressTestPayload>,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await withTimeout(latestMonitor().waitForIdle(), 5_000, {
    message: "Twitch ingress did not settle before the verdict assertion",
  });
  const verdict = await queue.enqueue(eventId, { version: 1, rawEvent: "{}" });
  expect(verdict.kind).toBe(expected);
}

function runtime() {
  return { error: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Twitch durable ingress", () => {
  it("durably appends before dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const realEnqueue = queue.enqueue.bind(queue);
      const appendEntered = Promise.withResolvers<void>();
      let releaseAppend = () => {};
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const enqueue: typeof queue.enqueue = vi.fn(
        async (...args: Parameters<typeof queue.enqueue>) => {
          appendEntered.resolve();
          await appendGate;
          return await realEnqueue(...args);
        },
      );
      const gatedQueue: ChannelIngressQueue<TwitchIngressTestPayload> = { ...queue, enqueue };
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue: gatedQueue,
        deliver,
        pollIntervalMs: 5,
      });
      ingress.start();
      try {
        const admission = ingress.accept(createTwitchIngressTestMessage({ id: "durable-first" }));
        await appendEntered.promise;
        expect(enqueue).toHaveBeenCalledOnce();
        expect(deliver).not.toHaveBeenCalled();
        releaseAppend();
        await admission;
        await expectSettledIngressVerdict(queue, "durable-first", "completed");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        releaseAppend();
        await ingress.stop();
      }
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches exactly once", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const interrupted = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: vi.fn(),
      });
      await interrupted.accept(createTwitchIngressTestMessage({ id: "restart" }));
      await interrupted.stop();

      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      recovered.start();
      try {
        await expectSettledIngressVerdict(queue, "restart", "completed");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone and rejects a post-completion duplicate", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      const message = createTwitchIngressTestMessage({ id: "duplicate" });
      ingress.start();
      try {
        await ingress.accept(message);
        await expectSettledIngressVerdict(queue, "duplicate", "completed");
        await ingress.accept(message);
        await latestMonitor().waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores the raw callback envelope and normalizes its channel only at dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const message = createTwitchIngressTestMessage({
        id: "raw",
        channel: "#MixedCase",
        message: "before",
      });
      const delivered = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: delivered,
        pollIntervalMs: 5,
      });
      await ingress.accept(message);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({
          id: "raw",
          laneKey: "channel:mixedcase",
          payload: { version: 1, rawEvent: JSON.stringify(message) },
        }),
      ]);
      message.message = "after";

      ingress.start();
      try {
        await expectSettledIngressVerdict(queue, "raw", "completed");
        expect(delivered).toHaveBeenCalledWith(
          expect.objectContaining({ channel: "mixedcase", message: "before" }),
          expect.any(Object),
        );
      } finally {
        await ingress.stop();
      }
    });
  });

  it("dead-letters malformed persisted JSON without dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      await queue.enqueue(
        "malformed",
        { version: 1, rawEvent: "{" },
        { laneKey: "channel:testchannel" },
      );
      const deliver = vi.fn();
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      ingress.start();
      try {
        await expectSettledIngressVerdict(queue, "malformed", "failed");
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for an in-flight durable admission before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const realEnqueue = queue.enqueue.bind(queue);
      const appendEntered = Promise.withResolvers<void>();
      const appendGate = Promise.withResolvers<void>();
      const trace: string[] = [];
      const enqueue: typeof queue.enqueue = async (...args: Parameters<typeof queue.enqueue>) => {
        appendEntered.resolve();
        await appendGate.promise;
        const result = await realEnqueue(...args);
        trace.push("append committed");
        return result;
      };
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, enqueue },
        deliver: vi.fn(),
      });
      let admission: Promise<void> | undefined;
      let stopping: Promise<void> | undefined;
      try {
        admission = ingress.accept(createTwitchIngressTestMessage({ id: "admitting" }));
        await appendEntered.promise;
        let stopped = false;
        stopping = ingress.stop().then(() => {
          stopped = true;
          trace.push("stopped");
        });
        await latestMonitor().waitForPumpIdle();
        expect(stopped).toBe(false);
        appendGate.resolve();
        await admission;
        await stopping;
        expect(stopped).toBe(true);
        expect(trace).toEqual(["append committed", "stopped"]);
      } finally {
        appendGate.resolve();
        await Promise.allSettled([admission, stopping]);
        await ingress.stop();
      }
    });
  });

  it("waits for an adopted active delivery before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      vi.useFakeTimers();
      const adopted = Promise.withResolvers<void>();
      const deliveryGate = Promise.withResolvers<void>();
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
        adopted.resolve();
        await deliveryGate.promise;
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      try {
        ingress.start();
        await ingress.accept(createTwitchIngressTestMessage({ id: "active-stop" }));
        await adopted.promise;
        expect(deliver).toHaveBeenCalledOnce();

        let stopped = false;
        const stopping = ingress.stop().then(() => {
          stopped = true;
        });
        await latestMonitor().waitForPumpIdle();
        await vi.advanceTimersByTimeAsync(30);
        expect(stopped).toBe(false);
        deliveryGate.resolve();
        await stopping;
        expect(stopped).toBe(true);
      } finally {
        deliveryGate.resolve();
        try {
          await ingress.stop();
        } finally {
          vi.useRealTimers();
        }
      }
    });
  });

  it("waits for a deferred reply-lane claim before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      vi.useFakeTimers();
      const deferred = Promise.withResolvers<void>();
      let adoptDeferred: (() => void | Promise<void>) | undefined;
      const deliver = vi.fn(async (message, lifecycle) => {
        if (message.id === "deferred-stop") {
          lifecycle.onDeferred();
          adoptDeferred = lifecycle.onAdopted;
          deferred.resolve();
          return;
        }
        await lifecycle.onAdopted();
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      try {
        ingress.start();
        await ingress.accept(createTwitchIngressTestMessage({ id: "deferred-stop" }));
        await deferred.promise;
        expect(deliver).toHaveBeenCalledOnce();
        await ingress.accept(createTwitchIngressTestMessage({ id: "queued-during-stop" }));

        let stopped = false;
        const stopping = ingress.stop().then(() => {
          stopped = true;
        });
        ingress.start();
        await latestMonitor().waitForPumpIdle();
        await vi.advanceTimersByTimeAsync(30);
        expect(stopped).toBe(false);
        if (!adoptDeferred) {
          throw new Error("Expected the deferred Twitch adoption callback");
        }
        await adoptDeferred();
        adoptDeferred = undefined;
        await stopping;
        expect(stopped).toBe(true);
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        try {
          try {
            await adoptDeferred?.();
          } finally {
            await ingress.stop();
          }
        } finally {
          vi.useRealTimers();
        }
      }
    });
  });

  it("aborts an active pre-adoption delivery before waiting for idle", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const listeningForAbort = Promise.withResolvers<void>();
      const deliver = vi.fn(
        async (_message, lifecycle) =>
          await new Promise<void>((resolve) => {
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            listeningForAbort.resolve();
          }),
      );
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      try {
        ingress.start();
        await ingress.accept(createTwitchIngressTestMessage({ id: "abort-on-stop" }));
        await listeningForAbort.promise;
        expect(deliver).toHaveBeenCalledOnce();

        await ingress.stop();

        expect(await queue.listClaims()).toHaveLength(0);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "abort-on-stop", lastError: expect.any(String) }),
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("releases a pre-adoption delivery for retry during shutdown", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const deliveryStarted = Promise.withResolvers<void>();
      const deliveryGate = Promise.withResolvers<void>();
      const deliver = vi.fn(async () => {
        deliveryStarted.resolve();
        await deliveryGate.promise;
      });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      try {
        ingress.start();
        await ingress.accept(createTwitchIngressTestMessage({ id: "shutdown-retry" }));
        await deliveryStarted.promise;
        expect(deliver).toHaveBeenCalledOnce();

        const stopping = ingress.stop();
        deliveryGate.resolve();
        await stopping;

        expect(await queue.listClaims()).toHaveLength(0);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "shutdown-retry", lastError: expect.any(String) }),
        ]);
      } finally {
        deliveryGate.resolve();
        await ingress.stop();
      }
    });
  });

  it("keeps an aged row at the retry ceiling recoverable when its reply-lane turn is cancelled", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const message = createTwitchIngressTestMessage({ id: "aged-cancelled" });
      // Received long before the dead-letter age floor, with one try left.
      await queue.enqueue(
        "aged-cancelled",
        { version: 1, rawEvent: JSON.stringify(message) },
        { laneKey: "channel:testchannel", receivedAt: 1 },
      );
      for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("aged-cancelled");
        if (!claim) {
          throw new Error("Expected to claim the aged Twitch row");
        }
        await queue.release(claim, { lastError: "prior failure", releasedAt: 1 });
      }
      const finishRedelivery = Promise.withResolvers<void>();
      const deliver = vi
        .fn()
        .mockImplementationOnce(async (_message, lifecycle) => {
          lifecycle.onDeferred();
          // The reply lane settles a cleared queued turn through onCancelled and
          // falls back to abandonment only when the lifecycle cannot cancel.
          await (lifecycle.onCancelled ? lifecycle.onCancelled() : lifecycle.onAbandoned());
        })
        .mockImplementationOnce(async (_message, lifecycle) => {
          await finishRedelivery.promise;
          await lifecycle.onAdopted();
        });
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      try {
        ingress.start();
        // Cancellation spends no budget, so the drain redelivers the row with
        // its prior retry facts instead of dead-lettering it.
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(await queue.listFailed?.()).toEqual([]);
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: "aged-cancelled",
            attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
            lastError: "prior failure",
          }),
        ]);
        finishRedelivery.resolve();
        await expectSettledIngressVerdict(queue, "aged-cancelled", "completed");
      } finally {
        finishRedelivery.resolve();
        await ingress.stop();
      }
    });
  });
});

describe("Twitch ingress fixture isolation", () => {
  const withQueue = useTwitchIngressTestQueue();

  it("joins producers before resetting failed callbacks and refuses reuse after failed cleanup", async () => {
    const stopEntered = Promise.withResolvers<void>();
    const stopGate = Promise.withResolvers<void>();
    const deliveryEntered = Promise.withResolvers<void>();
    const callbackError = new Error("fixture callback failed");
    let observedQueue: ChannelIngressQueue<TwitchIngressTestPayload> | undefined;
    const first = withQueue(async (queue, createIngress) => {
      observedQueue = queue;
      await queue.enqueue("completed", { version: 1, rawEvent: "{}" });
      await queue.complete("completed");
      const ingress = createIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver: async (_message, lifecycle) => {
          await new Promise<void>((resolve) => {
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            deliveryEntered.resolve();
          });
        },
      });
      const stop = ingress.stop.bind(ingress);
      vi.spyOn(ingress, "stop").mockImplementation(async () => {
        stopEntered.resolve();
        await stopGate.promise;
        await stop();
      });
      ingress.start();
      await ingress.accept(createTwitchIngressTestMessage({ id: "pending" }));
      await deliveryEntered.promise;
      throw callbackError;
    });
    const rejected = expect(first).rejects.toBe(callbackError);
    try {
      await Promise.race([
        stopEntered.promise,
        first.then(
          () => {
            throw new Error("Fixture settled before stopping ingress");
          },
          () => {
            throw new Error("Fixture settled before stopping ingress");
          },
        ),
      ]);
      if (!observedQueue) {
        throw new Error("Expected the callback's real ingress queue");
      }
      for (const [id, kind] of [
        ["completed", "completed"],
        ["pending", "claimed"],
      ] as const) {
        expect((await observedQueue.enqueue(id, { version: 1, rawEvent: "{}" })).kind).toBe(kind);
      }
    } finally {
      stopGate.resolve();
      await rejected;
    }

    await withQueue(async (queue) => {
      for (const id of ["completed", "pending"]) {
        expect(await queue.enqueue(id, { version: 1, rawEvent: "{}" })).toMatchObject({
          kind: "accepted",
          duplicate: false,
        });
      }
    });

    await expect(
      withQueue(async (queue, createIngress) => {
        observedQueue = queue;
        const ingress = createIngress({
          accountId: "default",
          runtime: runtime(),
          queue,
          deliver: vi.fn(),
        });
        await ingress.accept(createTwitchIngressTestMessage({ id: "cleanup-failure" }));
        const stop = ingress.stop.bind(ingress);
        vi.spyOn(ingress, "stop").mockImplementation(async () => {
          await stop();
          throw new Error("fixture stop failed");
        });
      }),
    ).rejects.toThrow("Twitch ingress cleanup failed");
    if (!observedQueue) {
      throw new Error("Expected the failed-cleanup queue");
    }
    expect(
      (await observedQueue.enqueue("cleanup-failure", { version: 1, rawEvent: "{}" })).kind,
    ).toBe("pending");
    const next = vi.fn(async () => {});
    await expect(withQueue(next)).rejects.toThrow("cleanup failure");
    expect(next).not.toHaveBeenCalled();
  });
});
