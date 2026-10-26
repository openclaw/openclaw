import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import {
  preflightDiscordMessageMock as preflightMock,
  processDiscordMessageMock as processMessage,
} from "./message-handler.module-test-helpers.js";

installDiscordIngressTestRuntime();
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import * as channelOutbound from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type DiscordQueue = NonNullable<Parameters<typeof createDiscordIngressMonitor>[0]["queue"]>;
type DiscordIngressPayload = Parameters<DiscordQueue["enqueue"]>[1];
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

it.each(["dispatch", "buffer", "preflight", "queued", "returns", "throws"] as const)(
  "preserves retry facts and replays work cancelled at %s",
  async (phase) => {
    await withQueue(async (queue) => {
      const before = await seedPendingFailure(queue, "poison", priorAttempts);
      const gate = barrier();
      const queued = createDeferred<void>();
      let signal: AbortSignal | undefined;
      prepareQueuedContext();
      if (phase === "preflight") {
        preflightMock.mockImplementation(async () => {
          await gate.wait();
          return null;
        });
      }
      if (phase === "queued") {
        const createRunQueue = channelOutbound.createChannelRunQueue;
        vi.spyOn(channelOutbound, "createChannelRunQueue").mockImplementation((params) => ({
          ...createRunQueue(params),
          enqueue: () => queued.resolve(),
        }));
      }
      if (phase === "returns" || phase === "throws") {
        processMessage.mockImplementation(async (ctx: { abortSignal?: AbortSignal }) => {
          signal = ctx.abortSignal;
          await gate.wait();
          if (phase === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
      }
      const handler = createHandler({
        queue,
        beforeDispatch: phase === "dispatch" ? gate.wait : undefined,
        debounceMs: phase === "buffer" ? 60_000 : 0,
        afterDispatch: phase === "buffer" ? () => queued.resolve() : undefined,
      });
      await (phase === "buffer" || phase === "queued" ? queued.promise : gate.entered);
      const stopping = handler.deactivate();
      if (phase === "returns" || phase === "throws") {
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      }
      await Promise.resolve();
      gate.release();
      await stopping;
      expect(preflightMock).toHaveBeenCalledTimes(
        phase === "dispatch" || phase === "buffer" ? 0 : 1,
      );
      if (phase === "queued") {
        expect(processMessage).not.toHaveBeenCalled();
      }
      expect(await queue.listPending()).toHaveLength(1);
      expect(await retryFacts(queue, "poison")).toEqual(before);
      await expectRecovered(queue, "poison");
    });
  },
);

describe("Discord durable ingress settlement", () => {
  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred<void>();
    const accept = vi.fn(() => admissionGate.promise);
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const params = createDiscordHandlerParams();
    vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation(() => ({
      accept,
      start,
      stop,
    }));
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

  it.each(["preflight", "processing"] as const)(
    "dead-letters an exhausted %s failure and releases its Discord lane",
    async (phase) => {
      vi.useFakeTimers();
      await withQueue(async (queue) => {
        await seedPoisonLane(queue);
        const processed: string[] = [];
        prepareQueuedContext();
        const failPoison = (id: string) => {
          processed.push(id);
          if (id === "poison") {
            throw new Error("deterministic queued failure");
          }
        };
        processMessage.mockImplementation(async (ctx) => failPoison(ctx.message.id));
        const handler = createHandler({
          queue,
          preflight:
            phase === "preflight"
              ? async ({ data }) => {
                  failPoison(data.message?.id ?? "unknown");
                  return null;
                }
              : undefined,
        });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expect(processed).toHaveLength(2));
          expect(processed).toEqual(["poison", "follower"]);
          await expectRecord(queue, "poison", {
            kind: "failed",
            record: { reason: "retry-limit-exceeded" },
          });
          await expectRecord(queue, "follower", { kind: "completed" });
        } finally {
          await handler.deactivate();
        }
      });
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
