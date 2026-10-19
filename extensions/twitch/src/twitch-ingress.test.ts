import { expectDefined } from "@openclaw/normalization-core";
import {
  createChannelIngressMonitor,
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

const withIngressQueue = useTwitchIngressTestQueue();
type Queue = ChannelIngressQueue<TwitchIngressTestPayload>;
type CreateIngress = Parameters<Parameters<typeof withIngressQueue>[0]>[1];
type IngressOptions = Parameters<CreateIngress>[0];

function withTwitchIngressTestQueue(
  run: (
    queue: Queue,
    create: (options: Omit<IngressOptions, "accountId" | "runtime">) => ReturnType<CreateIngress>,
  ) => Promise<void>,
) {
  return withIngressQueue((queue, create) =>
    run(queue, (options) => create({ accountId: "default", runtime: runtime(), ...options })),
  );
}

function latestMonitor() {
  const result = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
  if (result?.type !== "return") {
    throw new Error("Expected the Twitch ingress monitor");
  }
  return result.value;
}

async function expectSettledIngressVerdict(
  queue: Queue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await withTimeout(latestMonitor().waitForIdle(), 5_000, {
    message: "Twitch ingress did not settle before the verdict assertion",
  });
  expect((await queue.enqueue(eventId, { version: 1, rawEvent: "{}" })).kind).toBe(expected);
}

function gateAppend(queue: Queue, committed = () => {}) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const enqueue = vi.fn<typeof queue.enqueue>(async (...args) => {
    entered.resolve();
    await gate.promise;
    const result = await queue.enqueue(...args);
    committed();
    return result;
  });
  return { entered: entered.promise, release: gate.resolve, enqueue, queue: { ...queue, enqueue } };
}

async function expectStopWaits(
  ingress: ReturnType<CreateIngress>,
  release: () => void | Promise<void>,
  restart = false,
) {
  const stopped = vi.fn();
  const stopping = ingress.stop().then(stopped);
  if (restart) {
    ingress.start();
  }
  await latestMonitor().waitForPumpIdle();
  await vi.advanceTimersByTimeAsync(30);
  expect(stopped).not.toHaveBeenCalled();
  await release();
  await stopping;
  expect(stopped).toHaveBeenCalledOnce();
}

const runtime = () => ({ error: vi.fn() });

afterEach(() => vi.restoreAllMocks());

describe("Twitch durable ingress", () => {
  it("durably appends before dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const append = gateAppend(queue);
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createIngress({ queue: append.queue, deliver, pollIntervalMs: 5 });
      ingress.start();
      try {
        const admission = ingress.accept(createTwitchIngressTestMessage({ id: "durable-first" }));
        await append.entered;
        expect(append.enqueue).toHaveBeenCalledOnce();
        expect(deliver).not.toHaveBeenCalled();
        append.release();
        await admission;
        await expectSettledIngressVerdict(queue, "durable-first", "completed");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        append.release();
        await ingress.stop();
      }
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches exactly once", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const interrupted = createIngress({ queue, deliver: vi.fn() });
      await interrupted.accept(createTwitchIngressTestMessage({ id: "restart" }));
      await interrupted.stop();
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const recovered = createIngress({ queue, deliver, pollIntervalMs: 5 });
      recovered.start();
      await expectSettledIngressVerdict(queue, "restart", "completed");
      expect(deliver).toHaveBeenCalledOnce();
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
      const ingress = createIngress({ queue, deliver, pollIntervalMs: 5 });
      ingress.start();
      await expectSettledIngressVerdict(queue, "malformed", "failed");
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  it("waits for an in-flight durable admission before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue, createIngress) => {
      const trace: string[] = [];
      const append = gateAppend(queue, () => trace.push("append committed"));
      const ingress = createIngress({ queue: append.queue, deliver: vi.fn() });
      let admission: Promise<void> | undefined;
      let stopping: Promise<void> | undefined;
      try {
        admission = ingress.accept(createTwitchIngressTestMessage({ id: "admitting" }));
        await append.entered;
        stopping = ingress.stop().then(() => {
          trace.push("stopped");
        });
        await latestMonitor().waitForPumpIdle();
        expect(trace).toEqual([]);
        append.release();
        await admission;
        await stopping;
        expect(trace).toEqual(["append committed", "stopped"]);
      } finally {
        append.release();
        await Promise.allSettled([admission, stopping]);
        await ingress.stop();
      }
    });
  });

  it.each(["adopted", "deferred"] as const)(
    "waits for %s delivery before stop returns",
    async (mode) => {
      await withTwitchIngressTestQueue(async (queue, createIngress) => {
        vi.useFakeTimers();
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let adoptDeferred: (() => void | Promise<void>) | undefined;
        const deliver = vi.fn<IngressOptions["deliver"]>(async (message, lifecycle) => {
          if (mode === "deferred" && message.id === mode) {
            lifecycle.onDeferred();
            adoptDeferred = lifecycle.onAdopted;
            entered.resolve();
          } else {
            await lifecycle.onAdopted();
            if (mode === "adopted") {
              entered.resolve();
              await gate.promise;
            }
          }
        });
        const ingress = createIngress({ queue, deliver, pollIntervalMs: 5 });
        try {
          ingress.start();
          await ingress.accept(createTwitchIngressTestMessage({ id: mode }));
          await entered.promise;
          expect(deliver).toHaveBeenCalledOnce();
          if (mode === "deferred") {
            await ingress.accept(createTwitchIngressTestMessage({ id: "queued-during-stop" }));
          }
          await expectStopWaits(
            ingress,
            async () => {
              if (mode === "deferred") {
                await expectDefined(adoptDeferred, "deferred adoption callback")();
                adoptDeferred = undefined;
              } else {
                gate.resolve();
              }
            },
            mode === "deferred",
          );
          expect(deliver).toHaveBeenCalledOnce();
        } finally {
          gate.resolve();
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
    },
  );

  it.each(["abort", "release"] as const)(
    "returns pre-adoption work to the queue on shutdown (%s)",
    async (mode) => {
      await withTwitchIngressTestQueue(async (queue, createIngress) => {
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const deliver = vi.fn<IngressOptions["deliver"]>(async (_message, lifecycle) => {
          if (mode === "abort") {
            await new Promise<void>((resolve) => {
              lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
              entered.resolve();
            });
          } else {
            entered.resolve();
            await gate.promise;
          }
        });
        const ingress = createIngress({ queue, deliver, pollIntervalMs: 5 });
        try {
          ingress.start();
          await ingress.accept(createTwitchIngressTestMessage({ id: "shutdown-retry" }));
          await entered.promise;
          expect(deliver).toHaveBeenCalledOnce();
          const stopping = ingress.stop();
          gate.resolve();
          await stopping;
          expect(await queue.listClaims()).toHaveLength(0);
          expect(await queue.listPending()).toEqual([
            expect.objectContaining({ id: "shutdown-retry", lastError: expect.any(String) }),
          ]);
        } finally {
          gate.resolve();
          await ingress.stop();
        }
      });
    },
  );
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
      const settledEarly = () => {
        throw new Error("Fixture settled before stopping ingress");
      };
      await Promise.race([stopEntered.promise, first.then(settledEarly, settledEarly)]);
      const activeQueue = expectDefined(observedQueue, "callback queue");
      for (const [id, kind] of Object.entries({ completed: "completed", pending: "claimed" })) {
        expect((await activeQueue.enqueue(id, { version: 1, rawEvent: "{}" })).kind).toBe(kind);
      }
    } finally {
      stopGate.resolve();
      await rejected;
    }
    await withQueue(async (queue) => {
      for (const id of ["completed", "pending"]) {
        const result = await queue.enqueue(id, { version: 1, rawEvent: "{}" });
        expect(result).toMatchObject({ kind: "accepted", duplicate: false });
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
    const failedQueue = expectDefined(observedQueue, "failed-cleanup queue");
    const { kind } = await failedQueue.enqueue("cleanup-failure", { version: 1, rawEvent: "{}" });
    expect(kind).toBe("pending");
    const next = vi.fn(async () => {});
    await expect(withQueue(next)).rejects.toThrow("cleanup failure");
    expect(next).not.toHaveBeenCalled();
  });
});
