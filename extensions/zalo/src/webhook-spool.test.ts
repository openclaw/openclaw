import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloWebhookIngressRuntime } from "./webhook-spool.js";
import {
  createZaloWebhookTestEvent,
  waitForZaloWebhookVerdict,
  withZaloWebhookTestQueue,
  type ZaloWebhookTestQueue as Queue,
} from "./webhook-spool.test-support.js";

const { createZaloWebhookIngress } = zaloWebhookIngressRuntime;

let selectedQueue: Queue;
// mock-isolation: Select the real test queue without initializing the plugin runtime.
vi.mock("./runtime.js", () => ({
  getZaloRuntime: () => ({ state: { openChannelIngressQueue: () => selectedQueue } }),
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function latestMonitor() {
  const result = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
  if (result?.type !== "return") {
    throw new Error("Expected the Zalo ingress monitor");
  }
  return result.value;
}

type IngressOptions = Parameters<typeof createZaloWebhookIngress>[0];

function createIngress(queue: Queue, deliver: IngressOptions["deliver"] = vi.fn()) {
  selectedQueue = queue;
  const runtime = { error: vi.fn(), log: vi.fn() };
  return createZaloWebhookIngress({ accountId: "default", runtime, deliver });
}

async function withIngress(
  deliver: IngressOptions["deliver"],
  run: (ingress: ReturnType<typeof createIngress>, queue: Queue) => Promise<void>,
) {
  await withZaloWebhookTestQueue(async (queue) => {
    const ingress = createIngress(queue, deliver);
    try {
      await run(ingress, queue);
    } finally {
      await ingress.stop();
    }
  });
}

async function expectShutdownWaits(
  ingress: ReturnType<typeof createIngress>,
  settle: () => void | Promise<void>,
) {
  const stopped = vi.fn();
  const stopping = ingress.stop().then(stopped);
  await latestMonitor().waitForPumpIdle();
  await vi.advanceTimersByTimeAsync(50);
  expect(stopped).not.toHaveBeenCalled();
  await settle();
  await stopping;
  expect(stopped).toHaveBeenCalledTimes(1);
}

function rawEvent(params?: Parameters<typeof createZaloWebhookTestEvent>[0]): string {
  return JSON.stringify(createZaloWebhookTestEvent(params));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Zalo durable webhook ingress", () => {
  it("serializes concurrent admissions across append backoff", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const realEnqueue = queue.enqueue.bind(queue);
      const admissionOrder: string[] = [];
      const enqueue: typeof queue.enqueue = async (...args) => {
        admissionOrder.push(args[0]);
        if (admissionOrder.length === 1) {
          throw new Error("sqlite busy");
        }
        return await realEnqueue(...args);
      };
      const ingress = createIngress({ ...queue, enqueue });

      await Promise.all([
        ingress.accept(rawEvent({ messageId: "admission-a", chatId: "same-chat" })),
        ingress.accept(rawEvent({ messageId: "admission-b", chatId: "same-chat" })),
      ]);

      expect(admissionOrder).toEqual(["admission-a", "admission-a", "admission-b"]);
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.map((entry) => entry.id)).toEqual(["admission-a", "admission-b"]);
      await ingress.stop();
    });
  });

  it("retries a failed append before acknowledging and fails closed after the bound", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const deliver = vi.fn(async () => {});
      const ingress = createIngress({ ...queue, enqueue }, deliver);

      await expect(ingress.accept(rawEvent({ messageId: "append-failure" }))).rejects.toThrow(
        "sqlite unavailable",
      );
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(deliver).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches exactly once", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      const interrupted = createIngress(queue);
      await interrupted.accept(rawEvent({ messageId: "restart" }));
      await interrupted.stop();

      const deliver = vi.fn<IngressOptions["deliver"]>(async (_update, life) => {
        await life.onAdopted();
      });
      const recovered = createIngress(queue, deliver);
      recovered.start();
      try {
        await waitForZaloWebhookVerdict(queue, "restart", "completed");
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        await recovered.stop();
      }
    });
  });

  it("preserves old replay-guard parity for the same message id with changed payload bytes", async () => {
    const deliver = vi.fn<IngressOptions["deliver"]>(async (_update, life) => {
      await life.onAdopted();
    });
    await withIngress(deliver, async (ingress, queue) => {
      const enqueue = vi.spyOn(queue, "enqueue");
      ingress.start();
      await ingress.accept(rawEvent({ messageId: "redelivery", text: "original", date: 1 }));
      await waitForZaloWebhookVerdict(queue, "redelivery", "completed");
      await ingress.accept(
        rawEvent({ messageId: "redelivery", text: "transport redelivery", date: 2 }),
      );
      await expect(enqueue.mock.results.at(-1)?.value).resolves.toMatchObject({
        kind: "completed",
        duplicate: true,
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]?.[0].message?.text).toBe("original");
    });
  });

  it("dead-letters malformed persisted JSON without dispatch", async () => {
    const deliver = vi.fn(async () => {});
    await withIngress(deliver, async (ingress, queue) => {
      await queue.enqueue(
        "malformed",
        { version: 1, rawEvent: "{" },
        { laneKey: "chat:conversation-1" },
      );
      ingress.start();
      await waitForZaloWebhookVerdict(queue, "malformed", "failed");
      expect(deliver).not.toHaveBeenCalled();
      const verdict = await queue.enqueue("malformed", { version: 1, rawEvent: "{}" });
      expect(verdict).toMatchObject({ kind: "failed", record: { reason: "invalid-event" } });
    });
  });

  it("retries transient dispatch failures", async () => {
    const deliver = vi.fn<IngressOptions["deliver"]>(async (_update, lifecycle) => {
      if (deliver.mock.calls.length === 1) {
        throw new Error("temporary dispatch outage");
      }
      await lifecycle.onAdopted();
    });
    await withIngress(deliver, async (ingress, queue) => {
      ingress.start();
      await ingress.accept(rawEvent({ messageId: "retry" }));
      await waitForZaloWebhookVerdict(queue, "retry", "completed");
      expect(deliver).toHaveBeenCalledTimes(2);
    });
  });

  it("dead-letters authentication failures without retry", async () => {
    const deliver = vi.fn(async () => {
      throw Object.assign(new Error("invalid Zalo token"), { statusCode: 401 });
    });
    await withIngress(deliver, async (ingress, queue) => {
      ingress.start();
      await ingress.accept(rawEvent({ messageId: "auth-failure" }));
      await waitForZaloWebhookVerdict(queue, "auth-failure", "failed");
      expect(deliver).toHaveBeenCalledTimes(1);
      const verdict = await queue.enqueue("auth-failure", { version: 1, rawEvent: "{}" });
      expect(verdict).toMatchObject({
        kind: "failed",
        record: { reason: "authentication-failed" },
      });
    });
  });

  it("waits for an active delivery before shutdown returns", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      vi.useFakeTimers();
      const adopted = Promise.withResolvers<void>();
      const deliveryGate = Promise.withResolvers<void>();
      const deliver = vi.fn<IngressOptions["deliver"]>(async (_update, lifecycle) => {
        await lifecycle.onAdopted();
        adopted.resolve();
        await deliveryGate.promise;
      });
      const ingress = createIngress(queue, deliver);
      try {
        ingress.start();
        await ingress.accept(rawEvent({ messageId: "active-stop" }));
        await adopted.promise;
        expect(deliver).toHaveBeenCalledTimes(1);
        await expectShutdownWaits(ingress, () => deliveryGate.resolve());
      } finally {
        deliveryGate.resolve();
        await ingress.stop().finally(() => vi.useRealTimers());
      }
    });
  });

  it("holds a deferred claim through shutdown until adoption settles", async () => {
    await withZaloWebhookTestQueue(async (queue) => {
      vi.useFakeTimers();
      const deferred = Promise.withResolvers<void>();
      let deferredLifecycle: Parameters<IngressOptions["deliver"]>[1] | undefined;
      const deliver = vi.fn<IngressOptions["deliver"]>(async (_update, lifecycle) => {
        deferredLifecycle = lifecycle;
        lifecycle.onDeferred();
        deferred.resolve();
      });
      const ingress = createIngress(queue, deliver);
      try {
        ingress.start();
        await ingress.accept(rawEvent({ messageId: "deferred-stop" }));
        await deferred.promise;
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(await queue.listClaims()).toHaveLength(1);
        await expectShutdownWaits(ingress, async () => {
          if (!deferredLifecycle) {
            throw new Error("Zalo delivery did not expose its deferred lifecycle");
          }
          await deferredLifecycle.onAdopted();
          deferredLifecycle = undefined;
        });
        const verdict = await queue.enqueue("deferred-stop", { version: 1, rawEvent: "{}" });
        expect(verdict.kind).toBe("completed");
      } finally {
        try {
          await deferredLifecycle?.onAdopted();
        } finally {
          await ingress.stop().finally(() => vi.useRealTimers());
        }
      }
    });
  });
});
