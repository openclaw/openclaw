import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover durable retry recovery through full handler replacement.
import type { APIMessage } from "discord-api-types/v10";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  type ChannelIngressQueue,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  createDiscordHandlerParams,
  createDiscordQueuePreflightContextForMessage,
} from "./message-handler.test-helpers.js";
import { createDiscordMessageRunQueue } from "./message-run-queue.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordQueue = ChannelIngressQueue<DiscordIngressPayload>;

function rawMessage(id: string, channelId = "lane-a", timestamp = 0): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date(timestamp).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

async function withQueue(
  run: (queue: DiscordQueue, stateDir: string) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-discord-recovery-", applyEnv: false },
    ({ stateDir }) =>
      run(
        createChannelIngressQueueForTests<DiscordIngressPayload>({
          channelId: "discord",
          accountId: "default",
          stateDir,
        }),
        stateDir,
      ),
  );
}

async function seedPendingFailure(params: {
  queue: DiscordQueue;
  id: string;
  attempts: number;
  laneKey?: string;
}): Promise<void> {
  await params.queue.enqueue(
    params.id,
    { version: 1, receivedAt: 1, rawMessage: rawMessage(params.id) },
    { laneKey: params.laneKey ?? "channel:lane-a", receivedAt: 1 },
  );
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const claim = await params.queue.claim(params.id, { ownerId: `seed-${attempt}` });
    if (!claim) {
      throw new Error(`Expected ${params.id} to be claimable for seed attempt ${attempt}`);
    }
    await params.queue.release(claim, {
      lastError: `prior genuine failure ${attempt}`,
      releasedAt: 10 + attempt,
    });
  }
}

async function retryFacts(queue: DiscordQueue, id: string) {
  const record = (await queue.listPending({ limit: "all" })).find((entry) => entry.id === id);
  if (!record) {
    throw new Error(`Expected pending Discord ingress row ${id}`);
  }
  return {
    attempts: record.attempts,
    lastAttemptAt: record.lastAttemptAt,
    lastError: record.lastError,
  };
}

async function expectRecovered(queue: DiscordQueue, id: string) {
  const recovered = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
    await lifecycle.onAdopted();
  });
  const completed = observeChannelIngressQueueWrite(queue, "complete", id);
  const replacement = createDiscordIngressMonitor({
    accountId: "default",
    client: {} as never,
    runtime: createDiscordHandlerParams().runtime,
    queue,
    dispatch: recovered,
  });
  replacement.start();
  try {
    await expect(completed).resolves.toBe(true);
    expect(recovered).toHaveBeenCalledTimes(1);
    await expect(queue.enqueue(id, {} as DiscordIngressPayload)).resolves.toMatchObject({
      kind: "completed",
    });
  } finally {
    await replacement.stop();
  }
}

function createHandler(params: {
  queue: DiscordQueue;
  preflight: (input: { data: { message?: { id?: string } } }) => Promise<null>;
  debounceMs?: number;
  beforeDispatch?: () => Promise<void>;
}) {
  const handlerParams = createDiscordHandlerParams();
  handlerParams.cfg.messages = { inbound: { debounceMs: params.debounceMs ?? 0 } };
  return createDiscordMessageHandler({
    ...handlerParams,
    client: {} as never,
    testing: {
      preflightDiscordMessage: params.preflight as never,
      createIngressMonitor: (monitorParams) =>
        createDiscordIngressMonitor({
          ...monitorParams,
          queue: params.queue,
          dispatch: params.beforeDispatch
            ? async (event, lifecycle) => {
                await params.beforeDispatch?.();
                return await monitorParams.dispatch(event, lifecycle);
              }
            : monitorParams.dispatch,
        }),
    },
  });
}

describe("Discord durable ingress replacement recovery", () => {
  it("preserves retry facts across every Discord cancellation route and replacement", async () => {
    await withQueue(async (queue) => {
      await seedPendingFailure({
        queue,
        id: "poison",
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      });
      await queue.enqueue(
        "follower",
        { version: 1, receivedAt: 2, rawMessage: rawMessage("follower") },
        { laneKey: "channel:lane-a", receivedAt: 2 },
      );
      const expectedFacts = await retryFacts(queue, "poison");

      const dispatchEntered = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const beforeDispatch = async () => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
      };
      const beforeDispatchPreflight = vi.fn(async () => null);
      const beforeDispatchHandler = createHandler({
        queue,
        preflight: beforeDispatchPreflight,
        beforeDispatch,
      });
      await dispatchEntered.promise;
      const beforeDispatchStop = beforeDispatchHandler.deactivate();
      await Promise.resolve();
      releaseDispatch.resolve();
      await beforeDispatchStop;
      expect(beforeDispatchPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const bufferedPreflight = vi.fn(async () => null);
      const bufferedHandler = createHandler({
        queue,
        preflight: bufferedPreflight,
        debounceMs: 60_000,
      });
      // Both rows sit on `channel:lane-a`. Releasing the lane on defer lets the
      // second row be claimed and buffered by the same debounce window instead
      // of being guillotined behind the first, so the buffered handler holds two
      // claims, not one. Neither may reach preflight, and neither may lose its
      // retry facts on replacement — that is what this case guards.
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(2));
      await bufferedHandler.deactivate();
      expect(bufferedPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const preflightEntered = createDeferred<void>();
      const releasePreflight = createDeferred<void>();
      const activePreflight = vi.fn(async () => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return null;
      });
      const activeHandler = createHandler({ queue, preflight: activePreflight });
      await preflightEntered.promise;
      const activeStop = activeHandler.deactivate();
      await Promise.resolve();
      releasePreflight.resolve();
      await activeStop;
      expect(activePreflight).toHaveBeenCalledTimes(1);
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const finalDispatches: string[] = [];
      const followerCompleted = observeChannelIngressQueueWrite(queue, "complete", "follower");
      const replacement = createHandler({
        queue,
        preflight: vi.fn(async ({ data }) => {
          const id = data.message?.id ?? "unknown";
          finalDispatches.push(id);
          if (id === "poison") {
            throw new Error("final genuine failure");
          }
          return null;
        }),
      });
      try {
        await expect(followerCompleted).resolves.toBe(true);
        await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject({
          kind: "failed",
          record: { reason: "retry-limit-exceeded" },
        });
        await expect(queue.enqueue("follower", {} as DiscordIngressPayload)).resolves.toMatchObject(
          {
            kind: "completed",
          },
        );
        expect(finalDispatches).toEqual(["poison", "follower"]);
      } finally {
        await replacement.deactivate();
      }
    });
  });
});

describe("Discord durable ingress settlement", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred<void>();
    const accept = vi.fn(() => admissionGate.promise);
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler({
      ...params,
      client: {} as never,
      testing: {
        createIngressMonitor: vi.fn(() => ({ accept, start, stop })),
      },
    });
    const handling = handler({ id: "m-admitting", channel_id: "ch-1" } as never, {} as never);

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(deactivated).toBe(false);

    admissionGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an exhausted queued processing failure and releases its Discord lane", async () => {
    vi.useFakeTimers();
    try {
      await withQueue(async (queue) => {
        await seedPendingFailure({
          queue,
          id: "processing-poison",
          attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
        });
        await queue.enqueue(
          "processing-follower",
          {
            version: 1,
            receivedAt: 2,
            rawMessage: rawMessage("processing-follower"),
          },
          { laneKey: "channel:lane-a", receivedAt: 2 },
        );
        const processed: string[] = [];
        const handler = createDiscordMessageHandler({
          ...createDiscordHandlerParams(),
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: DiscordMessagePreflightParams) => ({
              ...createDiscordQueuePreflightContextForMessage(preflightParams.data),
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: async (ctx) => {
              processed.push(ctx.message.id);
              if (ctx.message.id === "processing-poison") {
                throw new Error("deterministic queued processing failure");
              }
            },
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expect(processed).toHaveLength(2));
          expect(processed).toEqual(["processing-poison", "processing-follower"]);
          expect((await queue.listFailed?.())?.[0]?.reason).toBe("retry-limit-exceeded");
        } finally {
          await handler.deactivate();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["returns", "throws"] as const)(
    "preserves retry facts when a started durable Discord job %s after cancellation",
    async (outcome) => {
      await withQueue(async (queue) => {
        const id = `started-cancelled-${outcome}`;
        await seedPendingFailure({ queue, id, attempts: 1 });
        const before = await retryFacts(queue, id);
        const processingStarted = createDeferred<void>();
        const finishProcessing = createDeferred<void>();
        let processingSignal: AbortSignal | undefined;
        const processDiscordMessage = vi.fn(async (ctx: { abortSignal?: AbortSignal }) => {
          processingSignal = ctx.abortSignal;
          processingStarted.resolve();
          await finishProcessing.promise;
          if (outcome === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
        const params = createDiscordHandlerParams();
        const handler = createDiscordMessageHandler({
          ...params,
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: {
              abortSignal?: AbortSignal;
              data: DiscordMessagePreflightParams["data"];
              turnAdoptionLifecycle?: DiscordIngressLifecycle;
            }) => ({
              ...createDiscordQueuePreflightContextForMessage(preflightParams.data),
              abortSignal: preflightParams.abortSignal,
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: processDiscordMessage as never,
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });

        await processingStarted.promise;
        const deactivation = handler.deactivate();
        await vi.waitFor(() => expect(processingSignal?.aborted).toBe(true));
        finishProcessing.resolve();
        await deactivation;

        expect(await queue.listPending()).toHaveLength(1);
        expect(await retryFacts(queue, id)).toEqual(before);

        await expectRecovered(queue, id);
      });
    },
  );

  it("preserves retry facts when deactivation skips a queued durable Discord job", async () => {
    await withQueue(async (queue) => {
      const id = "queued-cancelled";
      await seedPendingFailure({ queue, id, attempts: 1 });
      const before = await retryFacts(queue, id);
      const params = createDiscordHandlerParams();
      const processDiscordMessage = vi.fn(async () => {});
      const messageRunQueue = createDiscordMessageRunQueue({
        runtime: params.runtime,
        testing: { processDiscordMessage: processDiscordMessage as never },
      });
      const skipped = createDeferred<void>();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: params.runtime,
        queue,
        dispatch: async (_event, lifecycle) => {
          const ingress = fanInChannelIngressLifecycles([lifecycle]);
          messageRunQueue.enqueue({
            context: await createBaseDiscordMessageContext(),
            ingressSettlement: ingress,
          });
          await messageRunQueue.deactivate();
          skipped.resolve();
          return { kind: "deferred" };
        },
      });
      monitor.start();
      try {
        await skipped.promise;
        await monitor.stop();
        expect(processDiscordMessage).not.toHaveBeenCalled();
        expect(await queue.listPending()).toHaveLength(1);
        expect(await retryFacts(queue, id)).toEqual(before);
      } finally {
        await monitor.stop();
        await messageRunQueue.deactivate();
      }

      await expectRecovered(queue, id);
    });
  });
});
