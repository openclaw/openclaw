import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";

type OrderingSocket = {
  openListenerCount: number;
  emitOpen: () => void;
  emitClose: (code: number) => void;
};

export function registerMattermostOrderingTests<Socket extends OrderingSocket>(harness: {
  FakeWebSocket: new () => Socket;
  testConfig: OpenClawConfig;
  testRuntime: () => RuntimeEnv;
  createRuntimeCore: (
    config: OpenClawConfig,
    route: undefined,
    options: {
      createInboundDebouncer: typeof createInboundDebouncer;
      resolveInboundDebounceMs: typeof resolveInboundDebounceMs;
    },
  ) => unknown;
  monitorMattermostProvider: (params: {
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    webSocketFactory: () => Socket;
  }) => Promise<void>;
  emitMattermostChannelPost: (
    socket: Socket,
    post: { id: string; message: string; senderId?: string },
  ) => Promise<void>;
  mockState: {
    runtimeCore: unknown;
    dispatchInboundMessage: Mock;
  };
}) {
  const {
    FakeWebSocket,
    testConfig,
    testRuntime,
    createRuntimeCore,
    monitorMattermostProvider,
    emitMattermostChannelPost,
    mockState,
  } = harness;

  it("changes Mattermost delay at collector admission without replacing the socket", async () => {
    const cfg = { ...testConfig, messages: { inbound: { debounceMs: 0 } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);
    mockState.runtimeCore = createRuntimeCore(cfg, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const socket = new FakeWebSocket();
    const abort = new AbortController();
    const socketFactory = vi.fn(() => socket);
    const monitor = monitorMattermostProvider({
      config: cfg,
      runtime: testRuntime(),
      abortSignal: abort.signal,
      webSocketFactory: socketFactory,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([params]) => params.ctx.BodyForAgent);
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { byChannel: { mattermost: debounceMs } } } };
      setRuntimeConfigSnapshot(current, current);
    };
    try {
      await emitMattermostChannelPost(socket, { id: "debounce-1", message: "immediate" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate"]));
      publish(500);
      const started = performance.now();
      await emitMattermostChannelPost(socket, { id: "debounce-2", message: "buffered" });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(bodies()).toEqual(["immediate"]);
      publish(0);
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered"]));
      const delayedElapsedMs = performance.now() - started;
      await emitMattermostChannelPost(socket, { id: "debounce-3", message: "after disable" });
      await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "buffered", "after disable"]));
      console.log(
        "MONITOR_DEBOUNCE_PROOF " +
          JSON.stringify({
            channel: "mattermost",
            pid: process.pid,
            clock: "real",
            delaysMs: [0, 500, 0],
            delayedElapsedMs,
            bodies: bodies(),
            socketsCreated: socketFactory.mock.calls.length,
          }),
      );
    } finally {
      abort.abort();
      socket.emitClose(1000);
      await monitor;
      clearRuntimeConfigSnapshot();
    }
  });

  it("preserves conversation-wide admission order across interleaved senders in one channel", async () => {
    // Releasing the per-channel ingress lane on defer (deferredLaneOccupancy:
    // "release" in monitor-ingress.ts) lets independent per-sender debounce
    // buffers admit and flush concurrently. Without the cross-sender flush
    // guard, a later sender's post (B1) could flush ahead of an earlier
    // sender's still-buffering post (A1), inverting conversation order.
    const cfg = { ...testConfig, messages: { inbound: { debounceMs: 300 } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    mockState.dispatchInboundMessage.mockResolvedValue(undefined);
    mockState.runtimeCore = createRuntimeCore(cfg, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const socket = new FakeWebSocket();
    const abort = new AbortController();
    const socketFactory = vi.fn(() => socket);
    const monitor = monitorMattermostProvider({
      config: cfg,
      runtime: testRuntime(),
      abortSignal: abort.signal,
      webSocketFactory: socketFactory,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([params]) => params.ctx.BodyForAgent);
    try {
      await emitMattermostChannelPost(socket, {
        id: "order-a1",
        message: "A1",
        senderId: "user-a",
      });
      await emitMattermostChannelPost(socket, {
        id: "order-b1",
        message: "B1",
        senderId: "user-b",
      });
      await emitMattermostChannelPost(socket, {
        id: "order-a2",
        message: "A2",
        senderId: "user-a",
      });
      await vi.waitFor(() => expect(bodies()).toEqual(["A1", "B1", "A2"]));
    } finally {
      abort.abort();
      socket.emitClose(1000);
      await monitor;
      clearRuntimeConfigSnapshot();
    }
  });

  it("keeps a different-sender arrival waiting on an already-flushing batch's admission, not just its onFlush start", async () => {
    // onFlush firing only means the debounce timer elapsed; the earlier
    // batch's own preparation (here, a slow dispatchInboundMessage) can still
    // be in flight. A later different-key arrival must wait for that flush's
    // admission, not skip ahead the moment onFlush starts.
    const cfg = { ...testConfig, messages: { inbound: { debounceMs: 20 } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    let releaseA1!: () => void;
    const a1Gate = new Promise<void>((resolve) => {
      releaseA1 = resolve;
    });
    mockState.dispatchInboundMessage.mockImplementation(
      async (params: { ctx: { BodyForAgent?: string } }) => {
        if (params.ctx.BodyForAgent === "A1") {
          await a1Gate;
        }
      },
    );
    mockState.runtimeCore = createRuntimeCore(cfg, undefined, {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    });
    const socket = new FakeWebSocket();
    const abort = new AbortController();
    const socketFactory = vi.fn(() => socket);
    const monitor = monitorMattermostProvider({
      config: cfg,
      runtime: testRuntime(),
      abortSignal: abort.signal,
      webSocketFactory: socketFactory,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    const bodies = () =>
      mockState.dispatchInboundMessage.mock.calls.map(([params]) => params.ctx.BodyForAgent);
    try {
      await emitMattermostChannelPost(socket, {
        id: "gap-a1",
        message: "A1",
        senderId: "user-a",
      });
      await vi.waitFor(() => expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1));
      // A1's flush has started (onFlush fired) and is now blocked inside its
      // own dispatch on a1Gate, so its admission has not settled yet.
      let b1Settled = false;
      const b1Emit = emitMattermostChannelPost(socket, {
        id: "gap-b1",
        message: "B1",
        senderId: "user-b",
      }).then(() => {
        b1Settled = true;
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(b1Settled).toBe(false);
      expect(bodies()).toEqual(["A1"]);
      releaseA1();
      await b1Emit;
      expect(b1Settled).toBe(true);
      // B1 still has its own debounce timer pending (real, unref'd); let it
      // fire and settle before teardown so it cannot leak a dispatch call
      // into a later test sharing this mock.
      await vi.waitFor(() => expect(bodies()).toContain("B1"));
    } finally {
      abort.abort();
      socket.emitClose(1000);
      await monitor;
      clearRuntimeConfigSnapshot();
    }
  });
}
