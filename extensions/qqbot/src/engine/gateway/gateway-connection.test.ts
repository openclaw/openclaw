// Qqbot tests cover gateway connection close/disconnect status behavior.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapters } from "../adapter/index.js";
import { MAX_RECONNECT_ATTEMPTS } from "./constants.js";
import { GatewayConnection } from "./gateway-connection.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const createQQWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./ws-client.js", () => ({
  createQQWSClient: createQQWSClientMock,
}));

vi.mock("../messaging/sender.js", () => ({
  getAccessToken: vi.fn(async () => "test-token"),
  getGatewayUrl: vi.fn(async () => "wss://mock-gateway"),
  getPluginUserAgent: vi.fn(() => "test-agent"),
  startBackgroundTokenRefresh: vi.fn(),
  stopBackgroundTokenRefresh: vi.fn(),
  clearTokenCache: vi.fn(),
}));

vi.mock("../session/session-store.js", () => ({
  loadSession: vi.fn(() => undefined),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../session/known-users.js", () => ({
  recordKnownUser: vi.fn(),
  flushKnownUsers: vi.fn(),
}));

vi.mock("../ref/store.js", () => ({
  flushRefIndex: vi.fn(),
}));

vi.mock("../commands/slash-command-handler.js", () => ({
  trySlashCommand: vi.fn(async () => "enqueue"),
}));

class FakeWebSocket extends EventEmitter {
  readyState = 3; // CLOSED — keeps cleanup() from re-entering close()
  close = vi.fn();
  send = vi.fn();
}

function makeAccount(): GatewayAccount {
  return {
    accountId: "test-account",
    appId: "test-app",
    clientSecret: "test-secret",
    markdownSupport: false,
    config: {},
  };
}

async function startConnection(params: { onDisconnected?: (info: unknown) => void }) {
  const ws = new FakeWebSocket();
  createQQWSClientMock.mockResolvedValue(ws);
  const controller = new AbortController();
  const connection = new GatewayConnection({
    account: makeAccount(),
    abortSignal: controller.signal,
    cfg: {},
    runtime: {} as GatewayPluginRuntime,
    adapters: {} as EngineAdapters,
    handleMessage: async () => {},
    onDisconnected: params.onDisconnected,
  });
  const started = connection.start();
  await vi.waitFor(() => {
    expect(createQQWSClientMock).toHaveBeenCalled();
  });
  return { ws, controller, started };
}

describe("GatewayConnection disconnect status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports a fatal disconnect when the close code says the bot is banned", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 4915, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "banned", fatal: true });
    controller.abort();
    await started;
  });

  it("reports a non-fatal disconnect on a transient close before reconnecting", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    ws.emit("close", 1006, Buffer.from(""));

    expect(onDisconnected).toHaveBeenCalledWith({ reason: "close code 1006", fatal: false });
    controller.abort();
    await started;
  });

  it("reports a fatal disconnect when reconnect attempts are exhausted", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    // Each close consumes one reconnect attempt without ever reconnecting
    // (fake timers never fire the scheduled connect), so the attempt
    // counter reaches the cap and the next close gives up permanently.
    for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      ws.emit("close", 1006, Buffer.from(""));
    }

    expect(onDisconnected).toHaveBeenCalledWith({
      reason: "reconnect attempts exhausted",
      fatal: true,
    });
    controller.abort();
    await started;
  });

  it("does not report a disconnect for the close caused by an intentional abort", async () => {
    const onDisconnected = vi.fn();
    const { ws, controller, started } = await startConnection({ onDisconnected });

    controller.abort();
    ws.emit("close", 1000, Buffer.from(""));

    expect(onDisconnected).not.toHaveBeenCalled();
    await started;
  });
});
