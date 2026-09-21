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
}
