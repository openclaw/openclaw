import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";
import { claimUnprocessedFeishuMessage, finalizeFeishuMessageProcessing } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  buildFeishuFlushIngressLifecycle,
  createFeishuDurableIngress,
  type FeishuIngressLifecycle,
} from "./feishu-ingress.js";
import { monitorWebhook } from "./monitor.transport.js";
import {
  createFeishuWebhookTestAccount,
  getGatewayPort,
  postSignedPayload,
  waitForWebhookRoute,
} from "./monitor.webhook.test-helpers.js";

type FeishuIngressQueue = NonNullable<Parameters<typeof createFeishuDurableIngress>[0]["queue"]>;
type FeishuIngressPayload = Parameters<FeishuIngressQueue["enqueue"]>[1];

function messageEnvelope(eventId: string, threadId?: string) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        chat_id: "oc-chat",
        chat_type: "topic_group",
        message_id: `om-${eventId}`,
        thread_id: threadId,
      },
    },
  };
}

function createLifecycle(
  overrides: Partial<FeishuIngressLifecycle> = {},
  replayClaim?: ReturnType<typeof createReplayClaim>,
  options?: Parameters<typeof buildFeishuFlushIngressLifecycle>[1],
) {
  const calls = {
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
    onDropped: vi.fn(async () => {}),
  };
  const transport: FeishuIngressLifecycle = {
    abortSignal: new AbortController().signal,
    ...calls,
    ...overrides,
  };
  return {
    calls,
    transport,
    ...buildFeishuFlushIngressLifecycle([{ lifecycle: transport, replayClaim }], options),
  };
}

function createReplayClaim(key: string, commit: () => Promise<boolean> = async () => true) {
  return { keys: [key] as const, commit: vi.fn(commit), release: vi.fn() };
}

const failAdoption = async () => {
  throw new Error("queue completion failed");
};

function createTestIngress(params: {
  queue: FeishuIngressQueue;
  dispatch?: (data: ReturnType<typeof messageEnvelope>) => unknown;
}) {
  return createFeishuDurableIngress({
    accountId: "default",
    queue: params.queue,
    dispatcher: {
      invoke: async (data) => await params.dispatch?.(data as ReturnType<typeof messageEnvelope>),
    },
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
}

async function withQueue<T>(
  fn: (queue: FeishuIngressQueue, startIngress: typeof createTestIngress) => Promise<T>,
) {
  return withOpenClawTestState({ label: "feishu-ingress" }, async ({ stateDir }) => {
    const queue = createChannelIngressQueueForTests<FeishuIngressPayload>({
      channelId: "feishu",
      accountId: "default",
      stateDir,
    });
    const ingresses: ReturnType<typeof createTestIngress>[] = [];
    const startIngress: typeof createTestIngress = (params) => {
      const ingress = createTestIngress(params);
      ingresses.push(ingress);
      return ingress;
    };
    const [outcome] = await Promise.allSettled([fn(queue, startIngress)]);
    const stopped = await Promise.allSettled(ingresses.map((ingress) => ingress.stop()));
    const errors = stopped.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(
        outcome.status === "rejected" ? [outcome.reason, ...errors] : errors,
        "Feishu ingress test cleanup failed",
      );
    }
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  });
}

async function withWebhook(
  ingress: Pick<ReturnType<typeof createFeishuDurableIngress>, "invoke" | "invokeWebhook">,
  run: (url: string) => Promise<void>,
) {
  const port = await getGatewayPort();
  const webhookPath = "/feishu-ingress-test";
  const account = createFeishuWebhookTestAccount("default", webhookPath);
  const abortController = new AbortController();
  const monitor = monitorWebhook({
    account,
    accountId: account.accountId,
    eventDispatcher: { invoke: ingress.invoke } as Lark.EventDispatcher,
    invokeWebhookEvent: ingress.invokeWebhook,
    abortSignal: abortController.signal,
    runtime: createNonExitingRuntimeEnv(),
  });
  const url = `http://127.0.0.1:${port}${webhookPath}`;
  try {
    await waitForWebhookRoute(url);
    await run(url);
  } finally {
    abortController.abort();
    await monitor;
  }
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  feishuDedupeState.reset();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Feishu durable ingress", () => {
  it("waits for durable append before acknowledging the webhook", async () => {
    await withQueue(async (queue, startIngress) => {
      const appendGate = createDeferred<void>();
      const enqueue = vi.fn(async (...args: Parameters<FeishuIngressQueue["enqueue"]>) => {
        await appendGate.promise;
        return await queue.enqueue(...args);
      });
      const gatedQueue = { ...queue, enqueue } as FeishuIngressQueue;
      const ingress = startIngress({ queue: gatedQueue });

      await withWebhook(ingress, async (url) => {
        let responseSettled = false;
        const responsePromise = postSignedPayload(url, messageEnvelope("evt-append-gate")).then(
          (response) => {
            responseSettled = true;
            return response;
          },
        );
        try {
          await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
          expect(responseSettled).toBe(false);
        } finally {
          appendGate.resolve();
          await responsePromise;
        }
        const response = await responsePromise;
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      });
    });
  });

  it("returns non-2xx when durable append fails", async () => {
    await withQueue(async (queue, startIngress) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const failingQueue = { ...queue, enqueue } as FeishuIngressQueue;
      const dispatch = vi.fn(async () => undefined);
      const ingress = startIngress({ queue: failingQueue, dispatch });

      await withWebhook(ingress, async (url) => {
        const response = await postSignedPayload(url, messageEnvelope("evt-append-fail"));
        expect(response.status).toBe(500);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
      });

      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it.each(["adopted", "queue-cap-new"] as const)(
    "retains %s so one event_id dispatches only once",
    async (outcome) => {
      await withQueue(async (queue, startIngress) => {
        const dispatch = vi.fn(async (data: ReturnType<typeof messageEnvelope>) => {
          const lifecycle = ingress.resolveLifecycle({ ...data.header, ...data.event })!;
          if (outcome === "adopted") {
            await lifecycle.onAdopted();
          } else {
            await lifecycle.onDropped?.(outcome);
          }
          return { kind: "deferred" };
        });
        const ingress = startIngress({ queue, dispatch });
        ingress.start();
        const envelope = messageEnvelope("evt-completed");

        await ingress.invoke(envelope, { needCheck: false });
        await ingress.waitForIdle();
        await ingress.invoke(envelope, { needCheck: false });
        await ingress.waitForIdle();

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(await queue.listClaims()).toEqual([]);
        if (outcome !== "adopted") {
          expect(await queue.listFailed?.()).toMatchObject([
            { id: "evt-completed", reason: outcome },
          ]);
        }
      });
    },
  );

  it("admits later same-chat input while retaining a deferred input's claim", async () => {
    await withQueue(async (queue, startIngress) => {
      const deferred = createDeferred<FeishuIngressLifecycle>();
      const dispatched: string[] = [];
      const ingress = startIngress({
        queue,
        dispatch: async (data) => {
          const lifecycle = ingress.resolveLifecycle({ event_id: data.header.event_id });
          if (!lifecycle) {
            throw new Error("Missing ingress lifecycle");
          }
          dispatched.push(data.header.event_id);
          if (data.header.event_id === "evt-first") {
            lifecycle.onDeferred();
            deferred.resolve(lifecycle);
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return undefined;
        },
      });
      ingress.start();
      await ingress.invoke(messageEnvelope("evt-first"), { needCheck: false });
      await ingress.waitForIdle();
      const first = await deferred.promise;
      try {
        await ingress.invoke(messageEnvelope("evt-first"), { needCheck: false });
        await ingress.invoke(messageEnvelope("evt-second"), { needCheck: false });
        await ingress.waitForIdle();
        expect(dispatched).toEqual(["evt-first", "evt-second"]);
        expect(await queue.listPending()).toEqual([]);
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["evt-first"]);
      } finally {
        await first.onAdopted();
        await ingress.waitForIdle();
      }
      expect(await queue.listClaims()).toEqual([]);
    });
  });

  it("keeps buffered input in its chat lane until a lifecycle handoff", async () => {
    await withQueue(async (queue, startIngress) => {
      const buffered = createDeferred<FeishuIngressLifecycle>();
      const dispatched: string[] = [];
      const ingress = startIngress({
        queue,
        dispatch: async (data) => {
          const lifecycle = ingress.resolveLifecycle({ event_id: data.header.event_id });
          if (!lifecycle) {
            throw new Error("Missing ingress lifecycle");
          }
          dispatched.push(data.header.event_id);
          if (data.header.event_id === "evt-buffered") {
            buffered.resolve(lifecycle);
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return undefined;
        },
      });
      ingress.start();
      await ingress.invoke(messageEnvelope("evt-buffered", "omt-a"), { needCheck: false });
      const first = await buffered.promise;
      try {
        await ingress.invoke(messageEnvelope("evt-later", "omt-a"), { needCheck: false });
        const sentinel = messageEnvelope("evt-other", "omt-b");
        sentinel.event.message.chat_id = "oc-other-chat";
        await ingress.invoke(sentinel, { needCheck: false });
        await vi.waitFor(() => expect(dispatched).toContain("evt-other"));
        expect((await queue.listPending()).map((row) => row.id)).toEqual(["evt-later"]);
        expect(dispatched).toEqual(["evt-buffered", "evt-other"]);
      } finally {
        await first.onAdopted();
        await ingress.waitForIdle();
      }
      expect(dispatched).toEqual(["evt-buffered", "evt-other", "evt-later"]);
    });
  });

  it.each([
    "chat:oc-chat",
    "chat:oc-chat:topic:omt-a",
    "chat:oc-chat:topic:omt-a:sender:ou-user",
    "chat:oc-chat:topic:omt-other",
  ])("recovers a retained lane independently of current session scope: %s", async (laneKey) => {
    await withQueue(async (queue, startIngress) => {
      await queue.enqueue(
        "evt-upgrade",
        {
          version: 1,
          receivedAt: Date.now(),
          rawEnvelope: JSON.stringify(messageEnvelope("evt-upgrade", "omt-a")),
        },
        { laneKey },
      );
      const dispatched: string[] = [];
      const after = startIngress({
        queue,
        dispatch: async (data) => {
          dispatched.push(data.header.event_id);
          await after.resolveLifecycle({ event_id: data.header.event_id })?.onAdopted();
        },
      });
      after.start();
      await after.waitForIdle();
      if (laneKey.endsWith("omt-other")) {
        expect(dispatched).toEqual([]);
        expect(await queue.listFailed?.()).toMatchObject([
          { id: "evt-upgrade", reason: "invalid-event" },
        ]);
      } else {
        expect(dispatched).toEqual(["evt-upgrade"]);
      }
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it.each([undefined, 42, "not-json"])(
    "settles an invalid retained envelope instead of blocking the drain: %s",
    async (rawEnvelope) => {
      await withQueue(async (queue, startIngress) => {
        const payload = { version: 1 as const, receivedAt: Date.now(), rawEnvelope: "" };
        Reflect.set(payload, "rawEnvelope", rawEnvelope);
        await queue.enqueue("evt-corrupt", payload, { laneKey: "chat:oc-chat" });
        const dispatch = vi.fn();
        const ingress = startIngress({ queue, dispatch });
        ingress.start();
        await ingress.waitForIdle();
        expect(dispatch).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toMatchObject([
          { id: "evt-corrupt", reason: "invalid-event" },
        ]);
      });
    },
  );

  it("stops without stranding a buffered delivery or its durable claim", async () => {
    await withQueue(async (queue, startIngress) => {
      const buffered = createDeferred<void>();
      const ingress = startIngress({
        queue,
        dispatch: async () => {
          const claim = await claimUnprocessedFeishuMessage({
            messageId: "buffered-stop",
            namespace: "default",
          });
          if (claim.kind !== "claimed") {
            throw new Error("Missing logical claim");
          }
          const lifecycle = ingress.resolveLifecycle({ event_id: "evt-buffered-stop" });
          if (!lifecycle) {
            throw new Error("Missing ingress lifecycle");
          }
          lifecycle.onBeforeAbandon = () => claim.handle.release({ error: new Error("stopped") });
          buffered.resolve();
          return { kind: "deferred" };
        },
      });
      ingress.start();
      await ingress.invoke(messageEnvelope("evt-buffered-stop"), { needCheck: false });
      await buffered.promise;
      await ingress.stop();
      expect(await queue.listClaims()).toEqual([]);
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["evt-buffered-stop"]);
      const replay = await claimUnprocessedFeishuMessage({
        messageId: "buffered-stop",
        namespace: "default",
      });
      expect(replay.kind).toBe("claimed");
      if (replay.kind === "claimed") {
        replay.handle.release({ error: new Error("test complete") });
      }
    });
  });

  it.each([
    {
      name: "authentication failure",
      error: Object.assign(new Error("unauthorized"), { status: 401 }),
      calls: 1,
      expected: { kind: "failed", record: { reason: "authentication-failed" } },
    },
    {
      name: "missing conversation identity",
      error: undefined,
      calls: 0,
      expected: { kind: "failed", record: { reason: "invalid-event" } },
    },
    {
      name: "downstream syntax failure",
      error: new SyntaxError("temporary API response parse failure"),
      calls: 1,
      expected: { kind: "pending", duplicate: true },
    },
  ])("retains the correct retry state for $name", async ({ error, calls, expected }) => {
    await withQueue(async (queue, startIngress) => {
      const dispatch = vi.fn(async () => {
        if (error) {
          throw error;
        }
      });
      const ingress = startIngress({ queue, dispatch });
      ingress.start();
      const envelope = messageEnvelope("evt-failure");
      if (!error) {
        delete (envelope.event.message as { chat_id?: string }).chat_id;
      }

      await expect(ingress.invoke(envelope, { needCheck: false })).resolves.toBeUndefined();
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(calls);
      await expect(queue.enqueue("evt-failure", {} as FeishuIngressPayload)).resolves.toMatchObject(
        expected,
      );
    });
  });

  it("suppresses a captioned post redelivery after upgrade when the pre-upgrade record exists", async () => {
    await withQueue(async () => {
      const preUpgradeKey = "om_post";
      await expect(
        finalizeFeishuMessageProcessing({
          messageId: preUpgradeKey,
          namespace: "default",
        }),
      ).resolves.toBe(true);
      await closeOpenClawStateDatabaseAsync();
      feishuDedupeState.reset();

      const redelivery: FeishuMessageEvent = {
        sender: { sender_id: { open_id: "ou-user" } },
        message: {
          message_id: preUpgradeKey,
          chat_id: "oc-chat",
          chat_type: "p2p",
          message_type: "post",
          content: JSON.stringify({
            title: "",
            content: [[{ tag: "text", text: "这是账本" }]],
            files: [{ file_key: "file_v3_report", file_name: "report.csv", is_folder: false }],
          }),
        },
      };
      const currentKey = resolveFeishuMessageDedupeKey(redelivery);
      expect(currentKey).toBe(preUpgradeKey);
      await expect(
        claimUnprocessedFeishuMessage({ messageId: currentKey, namespace: "default" }),
      ).resolves.toEqual({ kind: "duplicate" });
    });
  });

  it("preserves legacy abandonment without advertising terminal drops", async () => {
    const replayClaim = createReplayClaim("legacy-drop");
    const { lifecycle, calls } = createLifecycle({ onDropped: undefined }, replayClaim);
    expect(lifecycle?.onDropped).toBeUndefined();
    await lifecycle?.onAbandoned();
    expect(calls.onAbandoned).toHaveBeenCalledOnce();
    expect(replayClaim.release).toHaveBeenCalledOnce();
    expect(replayClaim.commit).not.toHaveBeenCalled();
  });

  it.each(["onAdopted", "onDropped"] as const)(
    "does not reopen %s transport claims when a logical guard commit fails",
    async (outcome) => {
      const onReplayCommitError = vi.fn();
      const replayClaim = createReplayClaim("failing-adoption", async () => {
        throw new Error("dedupe persistence failed");
      });
      const { lifecycle, calls } = createLifecycle({}, replayClaim, { onReplayCommitError });

      await expect(lifecycle?.[outcome]?.("queue-cap-old")).resolves.toBeUndefined();

      expect(calls[outcome]).toHaveBeenCalledTimes(1);
      expect(calls.onAbandoned).not.toHaveBeenCalled();
      expect(onReplayCommitError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "dedupe persistence failed" }),
      );
    },
  );

  it.each(["onAdopted", "onDropped", "settle"] as const)(
    "releases logical claims when transport %s persistence fails",
    async (outcome) => {
      const replayClaim = createReplayClaim("transport-adoption-failure");
      const { lifecycle, settle, calls } = createLifecycle(
        { [outcome === "settle" ? "onAdopted" : outcome]: failAdoption },
        replayClaim,
      );
      const completion = outcome === "settle" ? settle() : lifecycle?.[outcome]?.("queue-cap-old");
      await expect(completion).rejects.toThrow("queue completion failed");

      expect(replayClaim.commit).not.toHaveBeenCalled();
      expect(replayClaim.release).toHaveBeenCalledTimes(1);
      expect(calls.onAbandoned).toHaveBeenCalledTimes(outcome === "onDropped" ? 0 : 1);
      if (outcome === "settle") {
        expect(calls.onAdoptionFinalizing).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not adopt while constituent abandonment is in progress", async () => {
    const abandonmentGate = createDeferred<void>();
    const replayClaim = createReplayClaim("concurrent-terminal-state");
    const { lifecycle, transport, calls } = createLifecycle(
      { onAbandoned: vi.fn(async () => await abandonmentGate.promise) },
      replayClaim,
    );

    const abandonment = lifecycle?.onAbandoned();
    await vi.waitFor(() => {
      expect(transport.onAbandoned).toHaveBeenCalledTimes(1);
    });
    const adoption = lifecycle?.onAdopted();
    expect(calls.onAdopted).not.toHaveBeenCalled();

    abandonmentGate.resolve();
    await Promise.all([abandonment, adoption]);

    expect(calls.onAdopted).not.toHaveBeenCalled();
    expect(replayClaim.commit).not.toHaveBeenCalled();
    expect(replayClaim.release).toHaveBeenCalledTimes(1);
  });

  it("finalizes gated claims before persisting terminal completion", async () => {
    const { settle, calls } = createLifecycle();

    await settle();

    expect(calls.onAdoptionFinalizing).toHaveBeenCalledTimes(1);
    expect(calls.onAdopted).toHaveBeenCalledTimes(1);
    expect(calls.onAdoptionFinalizing.mock.invocationCallOrder[0]).toBeLessThan(
      calls.onAdopted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not settle an observer fallback after an active reply lane defers", async () => {
    const { lifecycle, settle, calls } = createLifecycle();

    lifecycle?.onDeferred();
    await settle();

    expect(calls.onDeferred).toHaveBeenCalledTimes(1);
    expect(calls.onAdopted).not.toHaveBeenCalled();

    await lifecycle?.onAdopted();
    expect(calls.onAdopted).toHaveBeenCalledTimes(1);
  });
});
