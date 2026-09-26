import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover message handler.queue plugin behavior.
import { getEventListeners } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordIngressLifecycle } from "./ingress.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import {
  createIngressLifecycle,
  createDiscordHandlerParams,
  createDiscordQueuePreflightContext,
  createDiscordQueuePreflightContextForMessage,
} from "./message-handler.test-helpers.js";

type SetStatusFn = (patch: Record<string, unknown>) => void;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
function mockCalls(source: MockCallSource): Array<Array<unknown>> {
  return source.mock.calls;
}

function statusPatches(setStatus: MockCallSource) {
  return setStatus.mock.calls.map(([patch]) => patch as Record<string, unknown>);
}

function expectStatusPatch(setStatus: MockCallSource, expected: Record<string, unknown>) {
  expect(
    statusPatches(setStatus).some((patch) =>
      Object.entries(expected).every(([key, value]) => patch[key] === value),
    ),
  ).toBe(true);
}

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [{ id: `att-${messageId}` }],
    },
  };
}

function createTextMessageData(messageId: string, channelId = "ch-1") {
  const data = createMessageData(messageId, channelId);
  data.message.attachments = [];
  return data;
}

function createHandlerWithDefaultPreflight(overrides?: { setStatus?: SetStatusFn }) {
  preflightDiscordMessageMock.mockImplementation(
    async (params: { data: ReturnType<typeof createMessageData> }) =>
      createDiscordQueuePreflightContextForMessage(params.data),
  );
  return createDiscordMessageHandler(createDiscordHandlerParams(overrides));
}

function installDefaultDiscordPreflight() {
  preflightDiscordMessageMock.mockImplementation(
    async (params: { data: ReturnType<typeof createMessageData> }) =>
      createDiscordQueuePreflightContextForMessage(params.data),
  );
}

async function createLifecycleStopScenario(params: {
  createHandler: (status: SetStatusFn) => {
    handler: (data: never, opts: never) => Promise<unknown>;
    stop: () => void | Promise<void>;
  };
}) {
  preflightDiscordMessageMock.mockImplementation(
    async (preflightParams: { data: { channel_id: string } }) =>
      createDiscordQueuePreflightContext(preflightParams.data.channel_id),
  );
  const runInFlight = createDeferred<void>();
  processDiscordMessageMock.mockImplementation(async () => {
    await runInFlight.promise;
  });

  const setStatus = vi.fn<SetStatusFn>();
  const { handler, stop } = params.createHandler(setStatus);

  await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
  await flushQueueWork();
  expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

  const callsBeforeStop = setStatus.mock.calls.length;
  const stopTask = stop();

  return {
    setStatus,
    callsBeforeStop,
    finish: async () => {
      runInFlight.resolve();
      await runInFlight.promise;
      await stopTask;
      await Promise.resolve();
    },
  };
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resets busy counters when the handler is created", () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const setStatus = vi.fn();
    createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });

  it.each(["message", "handler"] as const)(
    "preserves prepared context and forwards %s cancellation through the run queue",
    async (cancelSource) => {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();
      const message = createDiscordMessage({
        id: "m-1",
        channelId: "ch-1",
        content: "hello",
        author: { id: "user-1", bot: false },
        referencedMessage: createDiscordMessage({
          id: "parent-1",
          channelId: "ch-1",
          content: "earlier",
          author: { id: "user-2", bot: false },
        }),
      });
      const data = { ...createMessageData(message.id), message };
      const messageAbort = new AbortController();
      const handlerAbort = new AbortController();
      const context = {
        ...createDiscordQueuePreflightContextForMessage(data),
        data,
        message,
        buildContext: vi.fn(),
        abortSignal: messageAbort.signal,
      };
      const started = createDeferred<DiscordMessagePreflightContext>();
      const finish = createDeferred<void>();
      preflightDiscordMessageMock.mockResolvedValue(context);
      processDiscordMessageMock.mockImplementation(
        async (received: DiscordMessagePreflightContext) => {
          started.resolve(received);
          await finish.promise;
        },
      );
      const handler = createDiscordMessageHandler(
        createDiscordHandlerParams({ abortSignal: handlerAbort.signal }),
      );
      try {
        await handler(data as never, {} as never);
        const received = await started.promise;
        expect(received.message.content).toBe("hello");
        expect(received.data.message.content).toBe("hello");
        expect(received.message.referencedMessage?.content).toBe("earlier");
        expect(received.runtime).toBe(context.runtime);
        expect(received.buildContext).toBe(context.buildContext);
        const signal = received.abortSignal;
        expect(signal?.aborted).toBe(false);
        const reason = new Error(`${cancelSource} cancelled`);
        (cancelSource === "message" ? messageAbort : handlerAbort).abort(reason);
        expect(signal?.reason).toBe(reason);
      } finally {
        finish.resolve();
        await handler.deactivate();
      }
    },
  );

  it("starts a second same-session event while the first run is active", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred<void>();
    const secondRun = createDeferred<void>();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => {
        await secondRun.promise;
      });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: ReturnType<typeof createMessageData> }) =>
        createDiscordQueuePreflightContextForMessage(params.data),
    );
    const setStatus = vi.fn();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expectStatusPatch(setStatus, { activeRuns: 1, busy: true });

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expectStatusPatch(setStatus, { activeRuns: 2, busy: true });

    secondRun.resolve();
    await secondRun.promise;

    await flushQueueWork();
    expectStatusPatch(setStatus, { activeRuns: 1, busy: true });

    firstRun.resolve();
    await firstRun.promise;

    await flushQueueWork();
    const lastStatusPatch = statusPatches(setStatus).at(-1);
    expect(lastStatusPatch?.activeRuns).toBe(0);
    expect(lastStatusPatch?.busy).toBe(false);
  });

  it("fans merged-turn adoption out to every debounced ingress claim", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: {
        data: { channel_id: string };
        turnAdoptionLifecycle?: unknown;
      }) => ({
        ...createDiscordQueuePreflightContext(preflightParams.data.channel_id),
        turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
      }),
    );
    processDiscordMessageMock.mockImplementation(
      async (ctx: { turnAdoptionLifecycle?: DiscordIngressLifecycle }) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
      },
    );
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-fanout-1") as never, {} as never, {
        turnAdoptionLifecycle: first,
      }),
    ).resolves.toEqual({ kind: "deferred" });
    await expect(
      handler(createTextMessageData("m-fanout-2") as never, {} as never, {
        turnAdoptionLifecycle: second,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    await vi.waitFor(() => expect(processDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("completes every debounced ingress claim when preflight gates the merged turn", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(null);
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await handler(createTextMessageData("m-gated-1") as never, {} as never, {
      turnAdoptionLifecycle: first,
    });
    await handler(createTextMessageData("m-gated-2") as never, {} as never, {
      turnAdoptionLifecycle: second,
    });

    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("returns retryable, never completed, for a dispatch after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler.deactivate();
    const lifecycle = createIngressLifecycle();

    // Completing here would tombstone a message that never dispatched; the
    // claim must release so a restarted drain replays it.
    const result = await handler(createTextMessageData("m-after-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });

    expect(result).toMatchObject({ kind: "deferred" });
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("reports a genuine pre-admission exception only through onFailed", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const failure = new Error("preflight failed");
    preflightDiscordMessageMock.mockRejectedValue(failure);
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-failed") as never, {} as never, {
        turnAdoptionLifecycle: lifecycle,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    expect(lifecycle.onFailed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("cancels a buffered ingress claim during deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const lifecycle = createIngressLifecycle();

    await handler(createTextMessageData("m-cancel") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("settles every buffered claim when cancellation fan-in includes a legacy lifecycle", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const cancellable = createIngressLifecycle();
    const legacy = createIngressLifecycle();
    delete (legacy as Partial<typeof legacy>).onCancelled;

    await handler(createTextMessageData("m-cancel-modern") as never, {} as never, {
      turnAdoptionLifecycle: cancellable,
    });
    await handler(createTextMessageData("m-cancel-legacy") as never, {} as never, {
      turnAdoptionLifecycle: legacy,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(cancellable.onCancelled).toHaveBeenCalledTimes(1);
    expect(legacy.onAbandoned).toHaveBeenCalledTimes(1);
    expect(legacy.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active debounce flush and cancels it after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const preflightGate = createDeferred<void>();
    preflightDiscordMessageMock.mockImplementation(async () => {
      await preflightGate.promise;
      return null;
    });
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();
    const handling = handler(createTextMessageData("m-active-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(deactivated).toBe(false);

    preflightGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(lifecycle.onCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("does not abort concurrent runs with a Discord-owned channel timeout", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();

      const firstRun = createDeferred<void>();
      const secondRun = createDeferred<void>();
      const capturedAbortSignals: Array<AbortSignal | undefined> = [];
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await firstRun.promise;
        },
      );
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await secondRun.promise;
        },
      );
      installDefaultDiscordPreflight();
      const params = createDiscordHandlerParams();
      const handler = createDiscordMessageHandler(params);

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();
      await expect(
        handler(createMessageData("m-2") as never, {} as never),
      ).resolves.toBeUndefined();
      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushQueueWork();

      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(capturedAbortSignals).toEqual([undefined, undefined]);
      const runtimeError = params.runtime.error as unknown as MockCallSource;
      expect(
        mockCalls(runtimeError).some(([message]) => String(message).includes("timed out")),
      ).toBe(false);

      firstRun.resolve();
      secondRun.resolve();
      await Promise.all([firstRun.promise, secondRun.promise]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes run activity while active runs are in progress", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const runInFlight = createDeferred<void>();
    processDiscordMessageMock.mockImplementation(async () => {
      await runInFlight.promise;
    });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createDiscordQueuePreflightContext(params.data.channel_id),
    );

    let heartbeatTick: () => void = () => {};
    let capturedHeartbeat = false;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          heartbeatTick = () => {
            callback();
          };
          capturedHeartbeat = true;
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      const setStatus = vi.fn();
      const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));
      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();

      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

      expect(capturedHeartbeat).toBe(true);
      const busyCallsBefore = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;

      heartbeatTick();

      const busyCallsAfter = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;
      expect(busyCallsAfter).toBeGreaterThan(busyCallsBefore);

      runInFlight.resolve();
      await runInFlight.promise;

      await flushQueueWork();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("stops status publishing after lifecycle abort", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const abortController = new AbortController();
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status, abortSignal: abortController.signal }),
        );
        return { handler, stop: () => abortController.abort() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("stops status publishing after handler deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status }),
        );
        return { handler, stop: () => handler.deactivate() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("removes lifecycle abort listeners after handler deactivation", async () => {
    const abortController = new AbortController();
    const initialListenerCount = getEventListeners(abortController.signal, "abort").length;
    const handler = createDiscordMessageHandler(
      createDiscordHandlerParams({ abortSignal: abortController.signal }),
    );

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(
      initialListenerCount + 2,
    );

    await handler.deactivate();

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstPreflight = createDeferred<void>();
    const processedMessageIds: string[] = [];

    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return {
          ...createDiscordQueuePreflightContext(params.data.channel_id),
          messageId,
        };
      },
    );

    processDiscordMessageMock.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("reports a concurrent run failure without leaving busy state stuck", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred<void>();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createDiscordQueuePreflightContext(params.data.channel_id),
    );

    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });
});
