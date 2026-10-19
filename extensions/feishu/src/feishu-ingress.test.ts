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

function messageEnvelope(eventId: string) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
    },
    event: { message: { chat_id: "oc-chat" } },
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

  it("retains completion so one event_id dispatches only once", async () => {
    await withQueue(async (queue, startIngress) => {
      const dispatch = vi.fn(async (data: ReturnType<typeof messageEnvelope>) => {
        await ingress.resolveLifecycle({ ...data.header, ...data.event })?.onAdopted();
      });
      const ingress = startIngress({ queue, dispatch });
      ingress.start();
      const envelope = messageEnvelope("evt-completed");

      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();
      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
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

  it("does not reopen adopted transport claims when a logical guard commit fails", async () => {
    const onReplayCommitError = vi.fn();
    const replayClaim = createReplayClaim("failing-adoption", async () => {
      throw new Error("dedupe persistence failed");
    });
    const { lifecycle, calls } = createLifecycle({}, replayClaim, { onReplayCommitError });

    await expect(lifecycle?.onAdopted()).resolves.toBeUndefined();

    expect(calls.onAdopted).toHaveBeenCalledTimes(1);
    expect(calls.onAbandoned).not.toHaveBeenCalled();
    expect(onReplayCommitError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dedupe persistence failed" }),
    );
  });

  it("abandons logical claims when transport adoption persistence fails", async () => {
    const replayClaim = createReplayClaim("transport-adoption-failure");
    const { lifecycle, calls } = createLifecycle({ onAdopted: failAdoption }, replayClaim);

    await expect(lifecycle?.onAdopted()).rejects.toThrow("queue completion failed");

    expect(replayClaim.commit).not.toHaveBeenCalled();
    expect(replayClaim.release).toHaveBeenCalledTimes(1);
    expect(calls.onAbandoned).toHaveBeenCalledTimes(1);
  });

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

  it("abandons a gated claim when terminal completion persistence fails", async () => {
    const { settle, calls } = createLifecycle({ onAdopted: failAdoption });

    await expect(settle()).rejects.toThrow("queue completion failed");

    expect(calls.onAdoptionFinalizing).toHaveBeenCalledTimes(1);
    expect(calls.onAbandoned).toHaveBeenCalledTimes(1);
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
