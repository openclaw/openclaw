import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import * as channelOutbound from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsIngress } from "./msteams-ingress.js";
import { createMSTeamsReplayContext } from "./replay-context.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

type IngressQueue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
type IngressPayload = Parameters<IngressQueue["enqueue"]>[1];
type IngressDispatch = Parameters<typeof createMSTeamsIngress>[0]["dispatch"];
type Ingress = ReturnType<typeof createMSTeamsIngress>;
let queue: IngressQueue;
let stateDir: string;
const ingresses: Ingress[] = [];

type Activity = MSTeamsTurnContext["activity"];
function activity({
  conversationId = "conversation-1",
  conversationType = "personal",
  ...overrides
}: Partial<Pick<Activity, "id" | "type" | "name" | "replyToId" | "text">> & {
  conversationId?: string;
  conversationType?: string;
} = {}): Activity {
  return {
    id: "activity-1",
    type: "message",
    text: "hello",
    from: { id: "user-1", aadObjectId: "aad-user-1", name: "User" },
    recipient: { id: "bot-1", name: "Bot" },
    conversation: { id: conversationId, conversationType },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    ...overrides,
  };
}

function createOutboundCapture() {
  const outbound: Array<{ activity: Record<string, unknown>; conversationId: string }> = [];
  const app = {
    api: {
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      fromServiceUrl({ serviceUrl }: { serviceUrl: string }) {
        return { ...this, serviceUrl };
      },
      conversations: {
        activities: (conversationId: string) => ({
          create: async (sentActivity: Record<string, unknown>) => {
            outbound.push({ activity: sentActivity, conversationId });
            return { id: `outbound-${outbound.length}` };
          },
        }),
      },
    },
  } as unknown as MSTeamsApp;
  return { app, outbound };
}

function makeIngress(dispatch: IngressDispatch, accountId = "app-id") {
  const ingress = createMSTeamsIngress({
    accountId,
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  ingresses.push(ingress);
  return ingress;
}

beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-ingress-"));
  stateDir = await fs.realpath(created);
  queue = createChannelIngressQueueForTests<IngressPayload>({
    channelId: "msteams",
    accountId: "app-id",
    stateDir,
  });
});

afterEach(async () => {
  try {
    for (const ingress of ingresses.splice(0)) {
      await ingress.stop();
    }
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

async function waitForVerdict(
  eventId: string,
  expected: "completed" | "failed",
  deliveryError: () => Error | undefined = () => undefined,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const error = deliveryError();
      if (error) {
        throw error;
      }
      const verdict = await queue.enqueue(eventId, {} as IngressPayload);
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 5_000 },
  );
}

describe("Microsoft Teams durable ingress", () => {
  it("does not dispatch a failed append's stale live context on retry", async () => {
    let failNext = true;
    const failAdmissionOnce = <Args extends unknown[], Result>(
      call: (...args: Args) => Promise<Result>,
    ) => {
      return async (...args: Args) => {
        if (failNext) {
          failNext = false;
          throw new Error("sqlite busy");
        }
        return await call(...args);
      };
    };
    queue.enqueue = failAdmissionOnce(queue.enqueue.bind(queue));
    if (queue.enqueueAndClaim) {
      queue.enqueueAndClaim = failAdmissionOnce(queue.enqueueAndClaim.bind(queue));
    }
    const contexts: unknown[] = [];
    const ingress = makeIngress(async (_activity, lifecycle, liveContext) => {
      contexts.push(liveContext);
      await lifecycle.onAdopted();
    }, "default");
    const staleContext = { id: "stale" } as never;
    const retryContext = { id: "retry" } as never;
    const retryActivity = activity({ id: "activity-ctx-retry" });
    ingress.start();
    await expect(ingress.accept(retryActivity, staleContext)).rejects.toThrow("sqlite busy");
    await ingress.accept(retryActivity, retryContext);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]).toBe(retryContext);
  });

  it.each([
    ["restart", "groupChat", "19:group-restart@thread.v2"],
    ["retry", "channel", "19:channel-retry@thread.tacv2;messageid=thread-root"],
  ] as const)(
    "preserves the inbound quote across %s for %s replies",
    async (recovery, conversationType, conversationId) => {
      const activityId = `activity-${recovery}-${conversationType}`;
      const incoming = activity({
        id: activityId,
        conversationId,
        conversationType,
        replyToId: conversationType === "channel" ? "thread-root" : undefined,
      });
      const { app, outbound } = createOutboundCapture();
      let attempts = 0;
      let deliveryError: Error | undefined;
      const dispatch: IngressDispatch = async (delivered, lifecycle, liveContext) => {
        attempts += 1;
        if (recovery === "retry" && attempts === 1) {
          expect(liveContext).toBeDefined();
          throw new Error("temporary dispatch outage");
        }
        expect(liveContext).toBeUndefined();
        const replayContext = createMSTeamsReplayContext(delivered, app, { cloud: "Public" });
        try {
          await replayContext.sendActivity({ type: "message", text: "Recovered reply" });
        } catch (error) {
          deliveryError = error instanceof Error ? error : new Error(String(error));
          throw deliveryError;
        }
        await lifecycle.onAdopted();
      };
      if (recovery === "restart") {
        const interrupted = makeIngress(vi.fn());
        await interrupted.accept(incoming, { activity: incoming } as MSTeamsTurnContext);
        await interrupted.stop();
      }
      const recovered = makeIngress(dispatch);
      recovered.start();
      if (recovery === "retry") {
        await recovered.accept(incoming, { activity: incoming } as MSTeamsTurnContext);
      }

      await waitForVerdict(activityId, "completed", () => deliveryError);
      expect(attempts).toBe(recovery === "retry" ? 2 : 1);
      expect(outbound).toEqual([
        {
          conversationId,
          activity: expect.objectContaining({
            text: `<quoted messageId="${activityId}"/> Recovered reply`,
            entities: [{ type: "quotedReply", quotedReply: { messageId: activityId } }],
          }),
        },
      ]);
    },
  );

  it("deduplicates a concrete Bot Framework redelivery by activity.id", async () => {
    const enqueue = vi.spyOn(queue, "enqueue");
    const dispatch = vi.fn(async (_activity, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const first = activity({ id: "bot-framework-redelivery", text: "original" });
    const redelivery = activity({ id: "bot-framework-redelivery", text: "redelivered copy" });
    const ingress = makeIngress(dispatch);
    ingress.start();
    await ingress.accept(first);
    await waitForVerdict("bot-framework-redelivery", "completed");
    await ingress.accept(redelivery);
    await expect(enqueue.mock.results.at(-1)?.value).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ text: "original" });
  });

  it("journals only message turns and adaptive-card agent turns", async () => {
    const ingress = makeIngress(vi.fn());
    for (const [id, type, name] of [
      ["message", "message"],
      ["adaptive", "invoke", "adaptiveCard/action"],
      ["edit", "messageUpdate"],
      ["reaction", "messageReaction"],
      ["feedback", "invoke", "message/submitAction"],
      ["file-consent", "invoke", "fileConsent/invoke"],
    ]) {
      await ingress.accept(activity({ id, type, name }));
    }

    expect((await queue.listPending({ limit: "all" })).map((entry) => entry.id).toSorted()).toEqual(
      ["adaptive", "message"],
    );
  });

  it("dead-letters malformed persisted JSON without dispatch", async () => {
    await queue.enqueue(
      "activity-malformed",
      { version: 1, receivedAt: Date.now(), rawActivity: "{" },
      { laneKey: "conversation-1" },
    );
    const dispatch = vi.fn();
    makeIngress(dispatch).start();
    await waitForVerdict("activity-malformed", "failed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dead-letters permanent authentication failures without retry", async () => {
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error("invalid Bot Framework credentials"), { statusCode: 401 });
    });
    const ingress = makeIngress(dispatch);
    ingress.start();
    await ingress.accept(activity({ id: "activity-auth-failed" }));
    await waitForVerdict("activity-auth-failed", "failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const verdict = await queue.enqueue("activity-auth-failed", {} as IngressPayload);
    expect(verdict).toMatchObject({ kind: "failed", record: { reason: "authentication-failed" } });
  });

  it("caps active deliveries across repeated drain pumps", async () => {
    const deliveryGate = createDeferred<void>();
    let active = 0;
    let maxActive = 0;
    const dispatch = vi.fn(async (_activity, lifecycle) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await lifecycle.onAdopted();
      try {
        await deliveryGate.promise;
      } finally {
        active -= 1;
      }
    });
    const factory = vi.spyOn(channelOutbound, "createChannelIngressMonitor");
    const ingress = makeIngress(dispatch);
    const result = factory.mock.results[0];
    factory.mockRestore();
    if (result?.type !== "return") {
      throw new Error("Microsoft Teams ingress did not create its ingress monitor");
    }
    const monitor = result.value;
    ingress.start();
    try {
      for (let index = 0; index < 8; index += 1) {
        await ingress.accept(
          activity({ id: `activity-concurrency-${index}`, conversationId: `lane-${index}` }),
        );
      }
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(8));
      await monitor.waitForPumpIdle();
      await ingress.accept(activity({ id: "activity-concurrency-8", conversationId: "lane-8" }));
      await monitor.waitForPumpIdle();

      expect(dispatch).toHaveBeenCalledTimes(8);
      expect(maxActive).toBe(8);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "activity-concurrency-8", laneKey: "lane-8" }),
      ]);

      deliveryGate.resolve();
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(9));
      expect(maxActive).toBe(8);
    } finally {
      deliveryGate.resolve();
    }
  });

  it("waits for active delivery to finish before stopping", async () => {
    const deliveryGate = createDeferred<void>();
    let deliverySignal: AbortSignal | undefined;
    const ingress = makeIngress(async (_activity, lifecycle) => {
      deliverySignal = lifecycle.abortSignal;
      await lifecycle.onAdopted();
      await deliveryGate.promise;
    });
    ingress.start();
    await ingress.accept(activity({ id: "activity-stop" }));
    await waitForVerdict("activity-stop", "completed");

    let stopped = false;
    const stopping = ingress.stop().then(() => {
      stopped = true;
    });
    await delay(50);
    expect(stopped).toBe(false);
    expect(deliverySignal?.aborted).toBe(false);

    deliveryGate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it.each([false, true])(
    "aborts a non-cooperative delivery at stop grace (terminal=%s)",
    async (terminal) => {
      vi.useFakeTimers();
      try {
        const deliveryStarted = createDeferred<void>();
        let deliverySignal: AbortSignal | undefined;
        const dispatch = vi.fn<IngressDispatch>(async (_activity, lifecycle) => {
          deliverySignal = lifecycle.abortSignal;
          deliveryStarted.resolve();
          await new Promise<void>(() => {});
        });
        const ingress = makeIngress(dispatch);
        ingress.start();
        await ingress.accept(
          activity({ id: terminal ? "activity-terminal-stop" : "activity-stop-timeout" }),
        );
        await deliveryStarted.promise;

        const stopping = ingress.stop();
        expect(deliverySignal?.aborted).toBe(false);
        if (terminal) {
          expect(ingress.stop()).toBe(stopping);
          ingress.start();
          await ingress.accept(activity({ id: "activity-after-stop-start" }));
        }
        await vi.advanceTimersByTimeAsync(MSTEAMS_REQUEST_TIMEOUT_MS);
        await stopping;
        expect(deliverySignal?.aborted).toBe(true);
        if (terminal) {
          expect(dispatch).toHaveBeenCalledTimes(1);
          expect((await queue.listPending()).map((entry) => entry.id)).toContain(
            "activity-after-stop-start",
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
