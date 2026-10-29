import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

type Post = {
  id: string;
  message: string;
  senderId?: string;
  senderName?: string;
  rootId?: string;
  fileIds?: string[];
};
type Transport = {
  monitor: Promise<void>;
  open: () => void;
  close: () => void;
  connectionCount: () => number;
  post: (post: Post) => Promise<void>;
};
type InboundDispatchParams = Parameters<typeof dispatchInboundMessage>[0];

export function registerMattermostIngressDebounceTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (
    config: OpenClawConfig,
    route: undefined,
    overrides: {
      inboundDebounceMs?: number;
      resolveInboundDebounceMs?: typeof resolveInboundDebounceMs;
      createInboundDebouncer: typeof createInboundDebouncer;
      isControlCommandMessage?: (text?: string) => boolean;
      shouldHandleTextCommands?: () => boolean;
    },
  ) => unknown;
  mockState: {
    runtimeCore: unknown;
    ingressQueue: unknown;
    dispatchInboundMessage: Mock;
    sendMessageMattermost: Mock;
    resolveChannelInfo: Mock;
  };
  startTransport: (config: OpenClawConfig, abort: AbortController, ready: () => void) => Transport;
}) {
  const { testConfig, mockState } = harness;
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  const contexts = () => mockState.dispatchInboundMessage.mock.calls.map(([p]) => p.ctx);
  function fixture(signal: AbortSignal, debounceMs = 1_000, liveConfig = false) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const queue = createChannelIngressQueueForTests<{
      version: 1;
      receivedAt: number;
      rawEvent: string;
    }>({
      channelId: "mattermost",
      accountId: "default",
      stateDir: dirs.make("openclaw-mm-batch-"),
    });
    mockState.ingressQueue = queue;
    const config: OpenClawConfig = {
      ...testConfig,
      ...(liveConfig ? { messages: { inbound: { debounceMs: 0 } } } : {}),
      channels: {
        ...testConfig.channels,
        mattermost: {
          ...testConfig.channels?.mattermost,
          allowFrom: ["user-1"],
          groupAllowFrom: ["user-1", "user-2"],
        },
      },
    };
    const collectors: Array<{
      keys: Set<string>;
      collector: Pick<ReturnType<typeof createInboundDebouncer>, "cancelKey" | "drain">;
    }> = [];
    let enqueued = 0;
    const arrivals = new Map<number, ReturnType<typeof createDeferred<void>>>();
    mockState.runtimeCore = harness.createRuntimeCore(config, undefined, {
      ...(liveConfig ? { resolveInboundDebounceMs } : { inboundDebounceMs: debounceMs }),
      isControlCommandMessage: (text) => text?.trim().startsWith("/") ?? false,
      shouldHandleTextCommands: () => true,
      createInboundDebouncer: (params) => {
        const collector = createInboundDebouncer(params);
        const keys = new Set<string>();
        collectors.push({ keys, collector });
        return {
          ...collector,
          enqueue: async (entry) => {
            const key = params.buildKey(entry);
            if (key) {
              keys.add(key);
            }
            const queued = collector.enqueue(entry);
            arrivals.get(++enqueued)?.resolve();
            await queued;
          },
        };
      },
    });
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);
    const interrupted = createDeferred<never>();
    const onAbort = () =>
      interrupted.reject(new Error("Mattermost owned completion did not settle"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void interrupted.promise.catch(() => {});
    const join = <T>(work: Promise<T>) => Promise.race([work, interrupted.promise]);
    const providers: Array<Transport & { abort: AbortController; stop: () => Promise<void> }> = [];
    const start = async () => {
      const abort = new AbortController();
      const ready = createDeferred<void>();
      const transport = harness.startTransport(config, abort, ready.resolve);
      void transport.monitor.catch(() => {});
      const provider = {
        ...transport,
        abort,
        stop: async () => {
          abort.abort();
          transport.close();
          await join(transport.monitor);
        },
      };
      providers.push(provider);
      await join(ready.promise);
      transport.open();
      return provider;
    };
    const arrived = (count: number) => {
      if (enqueued >= count) {
        return Promise.resolve();
      }
      const gate = arrivals.get(count) ?? createDeferred<void>();
      arrivals.set(count, gate);
      return join(gate.promise);
    };
    const post = async (provider: Transport, value: Post) => {
      const expected = enqueued + 1;
      await provider.post(value);
      await arrived(expected);
    };
    const bodies = () => contexts().map((ctx) => ctx.BodyForAgent);
    const drain = () => join(Promise.all(collectors.map(({ collector }) => collector.drain())));
    const close = async () => {
      for (const provider of providers) {
        provider.abort.abort();
        provider.close();
      }
      try {
        // Emergency cleanup follows assertions; production stop must do its own cancellation.
        for (const { keys, collector } of collectors) {
          for (const key of keys) {
            collector.cancelKey(key);
          }
        }
        const stopped = await Promise.allSettled([
          ...providers.map((p) => p.monitor),
          ...collectors.map(({ collector }) => collector.drain()),
        ]);
        const failure = stopped.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          throw failure.reason;
        }
      } finally {
        mockState.ingressQueue = undefined;
        closeOpenClawStateDatabaseForTest();
        signal.removeEventListener("abort", onAbort);
        vi.useRealTimers();
      }
    };
    const flush = async (id: string) => {
      const done = observeChannelIngressQueueWrite(queue, "complete", id);
      await vi.advanceTimersByTimeAsync(debounceMs);
      expect(await join(done)).toBe(true);
      await drain();
    };
    const expectQueue = async (pending: string[] = []) => {
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toEqual(
        pending.map((id) => expect.objectContaining({ id, attempts: 0 })),
      );
    };
    const f = { config, queue, start, post, arrived, join, bodies, drain, flush, expectQueue };
    return Object.assign(f, { [Symbol.asyncDispose]: close });
  }

  it("changes Mattermost delay at collector admission without replacing the socket", async ({
    signal,
  }) => {
    const f = fixture(signal, 0, true);
    setRuntimeConfigSnapshot(f.config, f.config);
    const delivered = new Map(
      ["immediate", "buffered", "after disable"].map((body) => [body, createDeferred<void>()]),
    );
    mockState.dispatchInboundMessage.mockImplementation(async (params) =>
      delivered.get(params.ctx.BodyForAgent)?.resolve(),
    );
    const dispatched = (body: string) => f.join(delivered.get(body)!.promise);
    const publish = (debounceMs: number) => {
      const current = {
        ...f.config,
        messages: { inbound: { byChannel: { mattermost: debounceMs } } },
      };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      const transport = await f.start();
      await f.post(transport, { id: "debounce-1", message: "immediate" });
      await dispatched("immediate");
      expect(f.bodies()).toEqual(["immediate"]);
      publish(500);
      await f.post(transport, { id: "debounce-2", message: "buffered" });
      await vi.advanceTimersByTimeAsync(50);
      expect(f.bodies()).toEqual(["immediate"]);
      publish(0);
      await vi.advanceTimersByTimeAsync(450);
      await dispatched("buffered");
      expect(f.bodies()).toEqual(["immediate", "buffered"]);
      await f.post(transport, { id: "debounce-3", message: "after disable" });
      await dispatched("after disable");
      expect(f.bodies()).toEqual(["immediate", "buffered", "after disable"]);
      expect(transport.connectionCount()).toBe(1);
    } finally {
      try {
        await f[Symbol.asyncDispose]();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it("keeps channel admission ordered across thread changes", async ({ signal }) => {
    await using f = fixture(signal);
    const provider = await f.start();
    await f.post(provider, { id: "a1", message: "A1" });
    await f.post(provider, { id: "b1", message: "B1", rootId: "thread-root" });
    await f.post(provider, { id: "a2", message: "A2" });
    await f.flush("a2");
    expect(f.bodies()).toEqual(["A1", "B1", "A2"]);
    expect(contexts().map((ctx) => ctx.MessageThreadId)).toEqual([
      undefined,
      "thread-root",
      undefined,
    ]);
    expect(await f.queue.listClaims()).toEqual([]);
  });

  it.for([
    { name: "command", special: { message: "@openclaw /new" }, expected: "/new" },
    {
      name: "attachment",
      special: { message: "document", fileIds: ["owned-file"] },
      expected: "document\n\n[mattermost attachment unavailable]",
    },
  ])(
    "flushes text before an immediate $name post",
    async ({ name, special, expected }, { signal }) => {
      await using f = fixture(signal);
      const provider = await f.start();
      await f.post(provider, { id: "before", message: "before" });
      await f.post(provider, { id: "special", ...special });
      await f.drain();
      expect(f.bodies()).toEqual(["before", expected]);
      if (name === "command") {
        expect(contexts()[1]).toMatchObject({
          WasMentioned: true,
          BodyForAgent: "/new",
          CommandBody: "/new",
          CommandAuthorized: true,
          CommandSource: "text",
        });
      }
      await f.post(provider, { id: "after", message: "after" });
      await f.flush("after");
      expect(f.bodies()).toEqual(["before", expected, "after"]);
      expect(await f.queue.listClaims()).toEqual([]);
    },
  );

  it("releases channel admission before reply completion", async ({ signal }) => {
    await using f = fixture(signal);
    const firstEntered = createDeferred<void>();
    const secondEntered = createDeferred<void>();
    const admit = createDeferred<void>();
    const finish = createDeferred<void>();
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      const lifecycle = params.replyOptions.turnAdoptionLifecycle;
      if (params.ctx.BodyForAgent === "A1") {
        firstEntered.resolve();
        await admit.promise;
        await lifecycle.onAdopted();
        await finish.promise;
      } else {
        await lifecycle.onAdopted();
        secondEntered.resolve();
      }
    });
    try {
      const provider = await f.start();
      await f.post(provider, { id: "held-a1", message: "A1" });
      await f.post(provider, { id: "held-b1", message: "B1", senderId: "user-2" });
      await f.join(firstEntered.promise);
      await f.post(provider, { id: "held-a2", message: "A2" });
      expect(f.bodies()).toEqual(["A1"]);
      admit.resolve();
      await f.join(secondEntered.promise);
      expect(f.bodies()).toEqual(["A1", "B1"]);
      const done = observeChannelIngressQueueWrite(f.queue, "complete", "held-a2");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await f.join(done)).toBe(true);
      expect(f.bodies()).toEqual(["A1", "B1", "A2"]);
      expect(contexts().map((ctx) => ctx.SenderId)).toEqual(["user-1", "user-2", "user-1"]);
      finish.resolve();
      await f.drain();
    } finally {
      admit.resolve();
      finish.resolve();
    }
  });

  it("dispatches later DM input while an older followup remains deferred", async ({ signal }) => {
    await using f = fixture(signal, 0);
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "chan-1",
      type: "D",
      name: "",
      display_name: "",
    });
    const adopted = new Map(
      ["active", "normal", "steer"].map((body) => [body, createDeferred<void>()]),
    );
    const followupAdoption = createDeferred<() => void | Promise<void>>();
    const finishActive = createDeferred<void>();
    let activeFinished = false;
    mockState.dispatchInboundMessage.mockImplementation(async (params: InboundDispatchParams) => {
      const lifecycle = params.replyOptions?.turnAdoptionLifecycle;
      if (!lifecycle?.onDeferred) {
        throw new Error("Missing Mattermost turn adoption lifecycle");
      }
      if (params.ctx.BodyForAgent === "followup") {
        lifecycle.onDeferred();
        followupAdoption.resolve(lifecycle.onAdopted);
        return;
      }
      await lifecycle.onAdopted();
      const arrival = params.ctx.BodyForAgent ? adopted.get(params.ctx.BodyForAgent) : undefined;
      if (!arrival) {
        throw new Error("Unexpected Mattermost regression input");
      }
      arrival.resolve();
      if (params.ctx.BodyForAgent === "active") {
        await finishActive.promise;
        activeFinished = true;
      }
    });
    let adoptFollowup: (() => void | Promise<void>) | undefined;
    try {
      const provider = await f.start();
      await f.post(provider, { id: "dm-active", message: "active" });
      await f.join(adopted.get("active")!.promise);
      await f.post(provider, { id: "dm-normal", message: "normal" });
      await f.join(adopted.get("normal")!.promise);
      expect(activeFinished).toBe(false);

      await f.post(provider, { id: "dm-followup", message: "followup" });
      adoptFollowup = await f.join(followupAdoption.promise);
      expect(await f.queue.listClaims()).toEqual([expect.objectContaining({ id: "dm-followup" })]);
      // Queue ownership must not block a newer input from reaching steering.
      await f.post(provider, { id: "dm-steer", message: "steer" });
      await f.join(adopted.get("steer")!.promise);
      expect(activeFinished).toBe(false);
      expect(contexts().map((ctx) => ctx.ChatType)).toEqual([
        "direct",
        "direct",
        "direct",
        "direct",
      ]);
      expect(await f.queue.listClaims()).toEqual([expect.objectContaining({ id: "dm-followup" })]);
      expect(await f.queue.listPending({ limit: "all" })).toEqual([]);

      await adoptFollowup();
      finishActive.resolve();
      await f.drain();
      expect(activeFinished).toBe(true);
      expect(f.bodies()).toEqual(["active", "normal", "followup", "steer"]);
      await f.expectQueue();
    } finally {
      await adoptFollowup?.();
      finishActive.resolve();
    }
  });

  it.for([
    { name: "authentication", error: "Mattermost API 401 Unauthorized", terminal: true },
    { name: "retryable", error: "synthetic local admission failure", terminal: false },
  ])(
    "settles every merged source once after $name failure",
    async ({ error, terminal }, { signal }) => {
      await using f = fixture(signal);
      mockState.dispatchInboundMessage.mockRejectedValue(new Error(error));
      const provider = await f.start();
      await f.post(provider, { id: "failed-1", message: "first" });
      await f.post(provider, { id: "failed-2", message: "second" });
      const disposed = Promise.race([
        observeChannelIngressQueueWrite(f.queue, "release", "failed-2"),
        observeChannelIngressQueueWrite(f.queue, "fail", "failed-2"),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await f.join(disposed)).toBe(true);
      await f.drain();
      expect(f.bodies()).toEqual(["first\nsecond"]);
      if (terminal) {
        if (!f.queue.listFailed) {
          throw new Error("Missing canonical dead-letter inspection");
        }
        const failed = await f.queue.listFailed({ limit: "all" });
        expect(failed).toHaveLength(2);
        expect(failed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "failed-1", reason: "mattermost-auth", attempts: 0 }),
            expect.objectContaining({ id: "failed-2", reason: "mattermost-auth", attempts: 0 }),
          ]),
        );
        expect(await f.queue.listPending({ limit: "all" })).toEqual([]);
      } else {
        expect(await f.queue.listPending({ limit: "all" })).toEqual([
          expect.objectContaining({ id: "failed-1", attempts: 1, lastError: error }),
          expect.objectContaining({ id: "failed-2", attempts: 1, lastError: error }),
        ]);
      }
      expect(await f.queue.listClaims()).toEqual([]);
    },
  );

  it("joins cancellation of immediate work behind an unadopted turn", async ({ signal }) => {
    await using f = fixture(signal);
    const entered = createDeferred<void>();
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      const abort = params.replyOptions.turnAdoptionLifecycle.abortSignal;
      entered.resolve();
      if (!abort.aborted) {
        await new Promise<void>((resolve) => {
          abort.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    });
    const provider = await f.start();
    await f.post(provider, { id: "cancel-active", message: "active" });
    await f.post(provider, { id: "cancel-immediate", message: "@openclaw /new" });
    await f.join(entered.promise);
    expect(f.bodies()).toEqual(["active"]);
    await provider.stop();
    expect(f.bodies()).toEqual(["active"]);
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    await f.expectQueue(["cancel-active", "cancel-immediate"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.bodies()).toEqual(["active"]);
  });

  it("cancels buffered posts without late effects and replays their raw input", async ({
    signal,
  }) => {
    await using f = fixture(signal);
    const provider = await f.start();
    await f.post(provider, { id: "replay-1", message: "first" });
    await f.post(provider, { id: "replay-2", message: "second" });
    await provider.stop();
    expect(f.bodies()).toEqual([]);
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    await f.expectQueue(["replay-1", "replay-2"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.bodies()).toEqual([]);
    const done = observeChannelIngressQueueWrite(f.queue, "complete", "replay-2");
    const replayed = f.arrived(4);
    await f.start();
    await replayed;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await f.join(done)).toBe(true);
    await f.drain();
    expect(f.bodies()).toEqual(["first\nsecond"]);
    await f.expectQueue();
  });
}
