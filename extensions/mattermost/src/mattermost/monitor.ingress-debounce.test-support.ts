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
    resolveMattermostMedia: Mock;
  };
  startTransport: (config: OpenClawConfig, abort: AbortController, ready: () => void) => Transport;
}) {
  const { testConfig, mockState } = harness;
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  function fixture(signal: AbortSignal) {
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
      channels: {
        ...testConfig.channels,
        mattermost: { ...testConfig.channels?.mattermost, groupAllowFrom: ["user-1", "user-2"] },
      },
    };
    const collectors: Array<{
      keys: Set<string>;
      collector: Pick<ReturnType<typeof createInboundDebouncer>, "cancelKey" | "drain">;
    }> = [];
    let enqueued = 0;
    const arrivals = new Map<number, ReturnType<typeof createDeferred<void>>>();
    mockState.runtimeCore = harness.createRuntimeCore(config, undefined, {
      inboundDebounceMs: 1_000,
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
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([p]) => p.ctx.BodyForAgent);
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
    return { queue, start, post, arrived, join, bodies, drain, close };
  }

  it("changes Mattermost delay at collector admission without replacing the socket", async ({
    signal,
  }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const config = { ...testConfig, messages: { inbound: { debounceMs: 0 } } };
    setRuntimeConfigSnapshot(config, config);
    const delivered = new Map(
      ["immediate", "buffered", "after disable"].map((body) => [body, createDeferred<void>()]),
    );
    mockState.dispatchInboundMessage.mockImplementation(async (params) =>
      delivered.get(params.ctx.BodyForAgent)?.resolve(),
    );
    const interrupted = createDeferred<never>();
    const onAbort = () => interrupted.reject(new Error("Config refresh dispatch did not settle"));
    signal.addEventListener("abort", onAbort, { once: true });
    void interrupted.promise.catch(() => {});
    const dispatched = (body: string) =>
      Promise.race([delivered.get(body)?.promise, interrupted.promise]);
    mockState.runtimeCore = harness.createRuntimeCore(config, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const ready = createDeferred<void>();
    const abort = new AbortController();
    const transport = harness.startTransport(config, abort, ready.resolve);
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([p]) => p.ctx.BodyForAgent);
    const publish = (debounceMs: number) => {
      const current = {
        ...config,
        messages: { inbound: { byChannel: { mattermost: debounceMs } } },
      };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      await Promise.race([
        ready.promise,
        interrupted.promise,
        transport.monitor.then(() => {
          throw new Error("Mattermost monitor ended before opening its socket");
        }),
      ]);
      transport.open();
      await transport.post({ id: "debounce-1", message: "immediate" });
      await dispatched("immediate");
      expect(bodies()).toEqual(["immediate"]);
      publish(500);
      await transport.post({ id: "debounce-2", message: "buffered" });
      await vi.advanceTimersByTimeAsync(50);
      expect(bodies()).toEqual(["immediate"]);
      publish(0);
      await vi.advanceTimersByTimeAsync(450);
      await dispatched("buffered");
      expect(bodies()).toEqual(["immediate", "buffered"]);
      await transport.post({ id: "debounce-3", message: "after disable" });
      await dispatched("after disable");
      expect(bodies()).toEqual(["immediate", "buffered", "after disable"]);
      expect(transport.connectionCount()).toBe(1);
    } finally {
      abort.abort();
      transport.close();
      try {
        await transport.monitor;
      } finally {
        signal.removeEventListener("abort", onAbort);
        clearRuntimeConfigSnapshot();
        vi.useRealTimers();
      }
    }
  });

  it("merges durable same-sender posts before the debounce flush", async ({ signal }) => {
    const f = fixture(signal);
    try {
      const provider = await f.start();
      await f.post(provider, { id: "batch-1", message: "first" });
      await f.post(provider, { id: "batch-2", message: "second" });
      expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
      const done = observeChannelIngressQueueWrite(f.queue, "complete", "batch-2");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await f.join(done)).toBe(true);
      await f.drain();
      expect(f.bodies()).toEqual(["first\nsecond"]);
      expect(await f.queue.listPending({ limit: "all" })).toEqual([]);
      expect(await f.queue.listClaims()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.for([
    { name: "sender", middle: { senderId: "user-2", senderName: "bob", rootId: undefined } },
    {
      name: "thread",
      middle: { rootId: "thread-root", senderId: undefined, senderName: undefined },
    },
  ])("keeps channel admission ordered across $name changes", async ({ middle }, { signal }) => {
    const f = fixture(signal);
    try {
      const provider = await f.start();
      await f.post(provider, { id: "a1", message: "A1" });
      await f.post(provider, { id: "b1", message: "B1", ...middle });
      await f.post(provider, { id: "a2", message: "A2" });
      const done = observeChannelIngressQueueWrite(f.queue, "complete", "a2");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await f.join(done)).toBe(true);
      await f.drain();
      expect(f.bodies()).toEqual(["A1", "B1", "A2"]);
      const contexts = mockState.dispatchInboundMessage.mock.calls.map(([p]) => p.ctx);
      if (middle.senderId) {
        expect(contexts.map((ctx) => ctx.SenderId)).toEqual(["user-1", "user-2", "user-1"]);
      } else {
        expect(contexts[1].MessageThreadId).toBe("thread-root");
        expect(contexts[0].MessageThreadId).toBeUndefined();
        expect(contexts[2].MessageThreadId).toBeUndefined();
      }
      expect(await f.queue.listClaims()).toEqual([]);
    } finally {
      await f.close();
    }
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
      const f = fixture(signal);
      try {
        const provider = await f.start();
        await f.post(provider, { id: "before", message: "before" });
        await f.post(provider, { id: "special", ...special });
        await f.drain();
        expect(f.bodies()).toEqual(["before", expected]);
        if (name === "command") {
          expect(mockState.dispatchInboundMessage.mock.calls[1]?.[0].ctx.CommandBody).toBe("/new");
        }
        await f.post(provider, { id: "after", message: "after" });
        const done = observeChannelIngressQueueWrite(f.queue, "complete", "after");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await f.join(done)).toBe(true);
        await f.drain();
        expect(f.bodies()).toEqual(["before", expected, "after"]);
        expect(await f.queue.listClaims()).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it("releases channel admission before reply completion", async ({ signal }) => {
    const f = fixture(signal);
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
      finish.resolve();
      await f.drain();
    } finally {
      admit.resolve();
      finish.resolve();
      await f.close();
    }
  });

  it.for([
    { name: "authentication", error: "Mattermost API 401 Unauthorized", terminal: true },
    { name: "retryable", error: "synthetic local admission failure", terminal: false },
  ])(
    "settles every merged source once after $name failure",
    async ({ error, terminal }, { signal }) => {
      const f = fixture(signal);
      mockState.dispatchInboundMessage.mockRejectedValue(new Error(error));
      try {
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
      } finally {
        await f.close();
      }
    },
  );

  it("joins cancellation of immediate work behind an unadopted turn", async ({ signal }) => {
    const f = fixture(signal);
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
    try {
      const provider = await f.start();
      await f.post(provider, { id: "cancel-active", message: "active" });
      await f.post(provider, { id: "cancel-immediate", message: "@openclaw /new" });
      await f.join(entered.promise);
      expect(f.bodies()).toEqual(["active"]);
      await provider.stop();
      expect(f.bodies()).toEqual(["active"]);
      expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
      expect(await f.queue.listClaims()).toEqual([]);
      expect(await f.queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({ id: "cancel-active", attempts: 0 }),
        expect.objectContaining({ id: "cancel-immediate", attempts: 0 }),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.bodies()).toEqual(["active"]);
    } finally {
      await f.close();
    }
  });

  it("cancels buffered posts without late effects and replays their raw input", async ({
    signal,
  }) => {
    const f = fixture(signal);
    try {
      const provider = await f.start();
      await f.post(provider, { id: "replay-1", message: "first" });
      await f.post(provider, { id: "replay-2", message: "second" });
      await provider.stop();
      expect(f.bodies()).toEqual([]);
      expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
      expect(await f.queue.listClaims()).toEqual([]);
      expect(await f.queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({ id: "replay-1", attempts: 0 }),
        expect.objectContaining({ id: "replay-2", attempts: 0 }),
      ]);
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
      expect(await f.queue.listPending({ limit: "all" })).toEqual([]);
      expect(await f.queue.listClaims()).toEqual([]);
    } finally {
      await f.close();
    }
  });
}
