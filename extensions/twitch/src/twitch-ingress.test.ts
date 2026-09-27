import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
// Twitch durable ingress tests cover raw admission, recovery, and tombstones.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTwitchIngress } from "./twitch-ingress.js";
import {
  createTwitchIngressTestMessage,
  waitForTwitchIngressVerdict,
  withTwitchIngressTestQueue,
  type TwitchIngressTestPayload,
} from "./twitch-ingress.test-support.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function latestMonitor() {
  const result = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
  if (result?.type !== "return") {
    throw new Error("Expected the Twitch ingress monitor");
  }
  return result.value;
}

function runtime() {
  return { error: vi.fn() };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Twitch durable ingress", () => {
  it("durably appends before dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      const realEnqueue = queue.enqueue.bind(queue);
      let releaseAppend = () => {};
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const enqueue: typeof queue.enqueue = vi.fn(
        async (...args: Parameters<typeof queue.enqueue>) => {
          await appendGate;
          return await realEnqueue(...args);
        },
      );
      const gatedQueue: ChannelIngressQueue<TwitchIngressTestPayload> = { ...queue, enqueue };
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createTwitchIngress({
        accountId: "default",
        runtime: runtime(),
        queue: gatedQueue,
        deliver,
        pollIntervalMs: 5,
      });
      ingress.start();
      try {
        const admission = ingress.accept(createTwitchIngressTestMessage({ id: "durable-first" }));
        await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
        expect(deliver).not.toHaveBeenCalled();
        releaseAppend();
        await admission;
        await waitForTwitchIngressVerdict(queue, "durable-first", "completed");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        releaseAppend();
        await ingress.stop();
      }
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches exactly once", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      const interrupted = createTwitchIngress({
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
      const recovered = createTwitchIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      recovered.start();
      try {
        await waitForTwitchIngressVerdict(queue, "restart", "completed");
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        await recovered.stop();
      }
    });
  });

  it("keeps a completion tombstone and rejects a post-completion duplicate", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createTwitchIngress({
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
        await waitForTwitchIngressVerdict(queue, "duplicate", "completed");
        await ingress.accept(message);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("stores the raw callback envelope and normalizes its channel only at dispatch", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      const message = createTwitchIngressTestMessage({
        id: "raw",
        channel: "#MixedCase",
        message: "before",
      });
      const delivered = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
      });
      const ingress = createTwitchIngress({
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
        await waitForTwitchIngressVerdict(queue, "raw", "completed");
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
    await withTwitchIngressTestQueue(async (queue) => {
      await queue.enqueue(
        "malformed",
        { version: 1, rawEvent: "{" },
        { laneKey: "channel:testchannel" },
      );
      const deliver = vi.fn();
      const ingress = createTwitchIngress({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        pollIntervalMs: 5,
      });
      ingress.start();
      try {
        await waitForTwitchIngressVerdict(queue, "malformed", "failed");
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await ingress.stop();
      }
    });
  });

  it("waits for an in-flight durable admission before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      const realEnqueue = queue.enqueue.bind(queue);
      let releaseAppend = () => {};
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const enqueue: typeof queue.enqueue = async (...args: Parameters<typeof queue.enqueue>) => {
        await appendGate;
        return await realEnqueue(...args);
      };
      const ingress = createTwitchIngress({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, enqueue },
        deliver: vi.fn(),
      });
      const admission = ingress.accept(createTwitchIngressTestMessage({ id: "admitting" }));
      let stopped = false;
      const stopping = ingress.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(stopped).toBe(false);
      releaseAppend();
      await admission;
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  it("waits for an adopted active delivery before stop returns", async () => {
    await withTwitchIngressTestQueue(async (queue) => {
      vi.useFakeTimers();
      const adopted = Promise.withResolvers<void>();
      const deliveryGate = Promise.withResolvers<void>();
      const deliver = vi.fn(async (_message, lifecycle) => {
        await lifecycle.onAdopted();
        adopted.resolve();
        await deliveryGate.promise;
      });
      const ingress = createTwitchIngress({
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
    await withTwitchIngressTestQueue(async (queue) => {
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
      const ingress = createTwitchIngress({
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
    await withTwitchIngressTestQueue(async (queue) => {
      const listeningForAbort = Promise.withResolvers<void>();
      const deliver = vi.fn(
        async (_message, lifecycle) =>
          await new Promise<void>((resolve) => {
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            listeningForAbort.resolve();
          }),
      );
      const ingress = createTwitchIngress({
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
    await withTwitchIngressTestQueue(async (queue) => {
      const deliveryStarted = Promise.withResolvers<void>();
      const deliveryGate = Promise.withResolvers<void>();
      const deliver = vi.fn(async () => {
        deliveryStarted.resolve();
        await deliveryGate.promise;
      });
      const ingress = createTwitchIngress({
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
});
