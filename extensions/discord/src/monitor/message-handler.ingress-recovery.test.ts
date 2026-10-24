import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import {
  preflightDiscordMessageMock as preflightMock,
  processDiscordMessageMock as processMessage,
} from "./message-handler.module-test-helpers.js";

installDiscordIngressTestRuntime();
import type { APIMessage } from "discord-api-types/v10";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  type ChannelIngressQueue,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import * as channelOutbound from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncGate as barrier } from "../../../test-support/async-gate.test-support.js";
import * as ingressRuntime from "./ingress.js";
import type { DiscordIngressLifecycle } from "./ingress.js";
const createDiscordIngressMonitor = ingressRuntime.createDiscordIngressMonitor;
import { createDiscordMessageHandler } from "./message-handler.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightParams as PreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordHandlerParams,
  createDiscordQueuePreflightContextForMessage as messageContext,
} from "./message-handler.test-helpers.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordQueue = ChannelIngressQueue<DiscordIngressPayload>;
const priorAttempts = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1;

const payload = (id: string, receivedAt = 1): DiscordIngressPayload => ({
  version: 1,
  receivedAt,
  rawMessage: createDiscordMessage({
    id,
    channelId: "lane-a",
    content: "hello",
    author: { id: "user-1", username: "alice", bot: false },
    timestamp: new Date(0).toISOString(),
    components: [],
  }).rawData,
});

function prepareQueuedContext() {
  preflightMock.mockImplementation((async (params: PreflightParams) => ({
    ...messageContext(params.data),
    abortSignal: params.abortSignal,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
  })) as never);
}

async function withQueue(run: (queue: DiscordQueue) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-discord-recovery-", applyEnv: false },
    ({ stateDir }) =>
      run(
        createChannelIngressQueueForTests<DiscordIngressPayload>({
          channelId: "discord",
          accountId: "default",
          stateDir,
        }),
      ),
  );
}

async function seedPendingFailure(queue: DiscordQueue, id: string, attempts = 1) {
  await queue.enqueue(id, payload(id), { laneKey: "channel:lane-a", receivedAt: 1 });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const claim = await queue.claim(id, { ownerId: `seed-${attempt}` });
    if (!claim) {
      throw new Error(`Expected ${id} to be claimable for seed attempt ${attempt}`);
    }
    await queue.release(claim, {
      lastError: `prior genuine failure ${attempt}`,
      releasedAt: 10 + attempt,
    });
  }
  return retryFacts(queue, id);
}

async function retryFacts(queue: DiscordQueue, id: string) {
  const record = (await queue.listPending({ limit: "all" })).find((entry) => entry.id === id);
  if (!record) {
    throw new Error(`Expected pending Discord ingress row ${id}`);
  }
  const { attempts, lastAttemptAt, lastError } = record;
  return { attempts, lastAttemptAt, lastError };
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
    await expectRecord(queue, id, { kind: "completed" });
  } finally {
    await replacement.stop();
  }
}

async function expectRecord(queue: DiscordQueue, id: string, record: Record<string, unknown>) {
  await expect(queue.enqueue(id, {} as DiscordIngressPayload)).resolves.toMatchObject(record);
}

async function seedPoisonLane(queue: DiscordQueue) {
  const facts = await seedPendingFailure(queue, "poison", priorAttempts);
  await queue.enqueue("follower", payload("follower", 2), {
    laneKey: "channel:lane-a",
    receivedAt: 2,
  });
  return facts;
}

function createHandler(params: {
  queue: DiscordQueue;
  preflight?: (input: { data: { message?: { id?: string } } }) => Promise<null>;
  debounceMs?: number;
  beforeDispatch?: () => Promise<void>;
  afterDispatch?: () => void;
}) {
  const handlerParams = createDiscordHandlerParams();
  handlerParams.cfg.messages = { inbound: { debounceMs: params.debounceMs ?? 0 } };
  if (params.preflight) {
    preflightMock.mockImplementation(params.preflight as never);
  }
  vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation((monitorParams) =>
    createDiscordIngressMonitor({
      ...monitorParams,
      queue: params.queue,
      dispatch:
        params.beforeDispatch || params.afterDispatch
          ? async (event, lifecycle) => {
              await params.beforeDispatch?.();
              const result = await monitorParams.dispatch(event, lifecycle);
              params.afterDispatch?.();
              return result;
            }
          : monitorParams.dispatch,
    }),
  );
  return createDiscordMessageHandler({
    ...handlerParams,
    client: {} as never,
  });
}

it("preserves retry facts across every Discord cancellation route and replacement", async () => {
  await withQueue(async (queue) => {
    const expectedFacts = await seedPoisonLane(queue);
    for (const phase of ["dispatch", "buffer", "preflight"] as const) {
      const gate = barrier();
      const buffered = createDeferred<void>();
      const preflight = vi.fn(async () => {
        if (phase === "preflight") {
          await gate.wait();
        }
        return null;
      });
      const handler = createHandler({
        queue,
        preflight,
        beforeDispatch: phase === "dispatch" ? gate.wait : undefined,
        debounceMs: phase === "buffer" ? 60_000 : 0,
        afterDispatch: phase === "buffer" ? () => buffered.resolve() : undefined,
      });
      await (phase === "buffer" ? buffered.promise : gate.entered);
      const stopping = handler.deactivate();
      await Promise.resolve();
      gate.release();
      await stopping;
      expect(preflight).toHaveBeenCalledTimes(phase === "preflight" ? 1 : 0);
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);
    }

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
      await expectRecord(queue, "poison", {
        kind: "failed",
        record: { reason: "retry-limit-exceeded" },
      });
      await expectRecord(queue, "follower", { kind: "completed" });
      expect(finalDispatches).toEqual(["poison", "follower"]);
    } finally {
      await replacement.deactivate();
    }
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
    vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation(
      vi.fn(() => ({ accept, start, stop })),
    );
    const handler = createDiscordMessageHandler({
      ...params,
      client: {} as never,
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
        await seedPoisonLane(queue);
        const processed: string[] = [];
        prepareQueuedContext();
        processMessage.mockImplementation(async (ctx) => {
          processed.push(ctx.message.id);
          if (ctx.message.id === "poison") {
            throw new Error("deterministic queued processing failure");
          }
        });
        const handler = createHandler({ queue });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expect(processed).toHaveLength(2));
          expect(processed).toEqual(["poison", "follower"]);
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
        const before = await seedPendingFailure(queue, id);
        const processing = barrier();
        let processingSignal: AbortSignal | undefined;
        const processDiscordMessage = vi.fn(async (ctx: { abortSignal?: AbortSignal }) => {
          processingSignal = ctx.abortSignal;
          await processing.wait();
          if (outcome === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
        prepareQueuedContext();
        processMessage.mockImplementation(processDiscordMessage as never);
        const handler = createHandler({ queue });

        await processing.entered;
        const deactivation = handler.deactivate();
        await vi.waitFor(() => expect(processingSignal?.aborted).toBe(true));
        processing.release();
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
      const before = await seedPendingFailure(queue, id);
      const processDiscordMessage = vi.fn(async () => {});
      processMessage.mockImplementation(processDiscordMessage as never);
      const queued = createDeferred<void>();
      const createRunQueue = channelOutbound.createChannelRunQueue;
      // Hold scheduling at the SDK boundary: the real handler must cancel an admitted
      // job that has not started, rather than clearing its durable retry history.
      vi.spyOn(channelOutbound, "createChannelRunQueue").mockImplementation((params) => ({
        ...createRunQueue(params),
        enqueue: () => queued.resolve(),
      }));
      prepareQueuedContext();
      const handler = createHandler({ queue });
      try {
        await queued.promise;
        await handler.deactivate();
        expect(processDiscordMessage).not.toHaveBeenCalled();
        expect(await queue.listPending()).toHaveLength(1);
        expect(await retryFacts(queue, id)).toEqual(before);
      } finally {
        await handler.deactivate();
      }

      await expectRecovered(queue, id);
    });
  });
});

afterEach(() => vi.restoreAllMocks());
