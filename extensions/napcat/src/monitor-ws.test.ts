import type { ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import type { ResolvedNapCatAccount } from "./types.js";

const wsCtor = vi.hoisted(() =>
  vi.fn(function MockWebSocket() {
    throw new Error("connect failed");
  }),
);

vi.mock("ws", () => ({
  WebSocket: wsCtor,
}));

import { startNapCatWsMonitor } from "./monitor-ws.js";

type MockSocket = {
  on: (event: string, handler: (...args: unknown[]) => void) => MockSocket;
  close: () => void;
  emit: (event: string, ...args: unknown[]) => void;
};

function createMockSocket(): MockSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: MockSocket = {
    on: (event, handler) => {
      const next = handlers.get(event) ?? [];
      next.push(handler);
      handlers.set(event, next);
      return socket;
    },
    close: () => {},
    emit: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
  };
  return socket;
}

function buildAccount(overrides: Partial<ResolvedNapCatAccount> = {}): ResolvedNapCatAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    token: "token",
    tokenSource: "config",
    apiBaseUrl: "http://127.0.0.1:3000",
    apiBaseUrlSource: "config",
    config: {},
    transport: {
      http: {
        enabled: false,
        host: "127.0.0.1",
        port: 5715,
        path: "/onebot",
        bodyMaxBytes: 1024 * 1024,
      },
      ws: {
        enabled: true,
        url: "ws://127.0.0.1:3001",
        reconnectMs: 3000,
      },
    },
    ...overrides,
  };
}

describe("startNapCatWsMonitor", () => {
  afterEach(() => {
    wsCtor.mockImplementation(function MockWebSocket() {
      throw new Error("connect failed");
    });
    vi.clearAllMocks();
  });

  it("marks connected=false on ws failure when ws is the only inbound transport", () => {
    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = startNapCatWsMonitor({
      account: buildAccount(),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    expect(patches[0]).toMatchObject({
      connected: false,
      reconnectAttempts: 1,
    });
    handle.stop();
  });

  it("does not force connected=false on ws failure when http inbound is enabled", () => {
    const base = buildAccount();
    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = startNapCatWsMonitor({
      account: buildAccount({
        transport: {
          ...base.transport,
          http: {
            ...base.transport.http,
            enabled: true,
          },
        },
      }),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    expect(patches[0]).toMatchObject({
      reconnectAttempts: 1,
    });
    expect("connected" in (patches[0] ?? {})).toBe(false);
    handle.stop();
  });

  it("does not force connected=false on ws error when http inbound is enabled", () => {
    const base = buildAccount();
    let socket: MockSocket | null = null;
    wsCtor.mockImplementationOnce(function MockWebSocket() {
      socket = createMockSocket();
      return socket;
    });

    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = startNapCatWsMonitor({
      account: buildAccount({
        transport: {
          ...base.transport,
          http: {
            ...base.transport.http,
            enabled: true,
          },
        },
      }),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    expect(socket).toBeTruthy();
    socket?.emit("error", new Error("boom"));

    const errorPatch = patches.find((patch) => patch.lastError?.includes("boom"));
    expect(errorPatch).toBeTruthy();
    expect("connected" in (errorPatch ?? {})).toBe(false);
    handle.stop();
  });

  it("does not mark connected=false on ws error before close in ws-only mode", () => {
    let socket: MockSocket | null = null;
    wsCtor.mockImplementationOnce(function MockWebSocket() {
      socket = createMockSocket();
      return socket;
    });

    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = startNapCatWsMonitor({
      account: buildAccount(),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    expect(socket).toBeTruthy();
    socket?.emit("open");
    socket?.emit("error", new Error("boom"));

    const errorPatch = patches.find((patch) => patch.lastError?.includes("boom"));
    expect(errorPatch).toBeTruthy();
    expect("connected" in (errorPatch ?? {})).toBe(false);
    handle.stop();
  });
});
