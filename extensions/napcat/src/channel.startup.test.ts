import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import type { ResolvedNapCatAccount } from "./types.js";

const hoisted = vi.hoisted(() => ({
  startNapCatHttpMonitor: vi.fn(),
  startNapCatWsMonitor: vi.fn(),
}));

vi.mock("./monitor-http.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor-http.js")>("./monitor-http.js");
  return {
    ...actual,
    startNapCatHttpMonitor: hoisted.startNapCatHttpMonitor,
  };
});

vi.mock("./monitor-ws.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor-ws.js")>("./monitor-ws.js");
  return {
    ...actual,
    startNapCatWsMonitor: hoisted.startNapCatWsMonitor,
  };
});

import { napcatPlugin } from "./channel.js";

function buildAccount(
  overrides: Partial<ResolvedNapCatAccount> = {},
): ResolvedNapCatAccount {
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
        enabled: true,
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

function createStartAccountCtx(params: {
  account: ResolvedNapCatAccount;
  abortSignal: AbortSignal;
  statusPatchSink?: (next: ChannelAccountSnapshot) => void;
}): ChannelGatewayContext<ResolvedNapCatAccount> {
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.account.accountId,
    configured: params.account.configured,
    enabled: params.account.enabled,
    running: false,
  };
  return {
    accountId: params.account.accountId,
    account: params.account,
    cfg: {} as OpenClawConfig,
    runtime: createRuntimeEnv(),
    abortSignal: params.abortSignal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: (next) => {
      Object.assign(snapshot, next);
      params.statusPatchSink?.(snapshot);
    },
  };
}

describe("napcatPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails startup when token is missing", async () => {
    await expect(
      napcatPlugin.gateway!.startAccount!(
        createStartAccountCtx({
          account: buildAccount({ token: undefined, tokenSource: "none", configured: false }),
          abortSignal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("NapCat token is missing");

    expect(hoisted.startNapCatHttpMonitor).not.toHaveBeenCalled();
    expect(hoisted.startNapCatWsMonitor).not.toHaveBeenCalled();
  });

  it("fails startup when apiBaseUrl is missing", async () => {
    await expect(
      napcatPlugin.gateway!.startAccount!(
        createStartAccountCtx({
          account: buildAccount({
            apiBaseUrl: undefined,
            apiBaseUrlSource: "none",
            configured: false,
          }),
          abortSignal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("NapCat apiBaseUrl is missing");

    expect(hoisted.startNapCatHttpMonitor).not.toHaveBeenCalled();
    expect(hoisted.startNapCatWsMonitor).not.toHaveBeenCalled();
  });

  it("keeps startAccount pending until abort and then stops monitors", async () => {
    const httpStop = vi.fn(async () => {});
    const wsStop = vi.fn();
    hoisted.startNapCatHttpMonitor.mockResolvedValue({ stop: httpStop });
    hoisted.startNapCatWsMonitor.mockReturnValue({ stop: wsStop });

    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();
    const task = napcatPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        account: buildAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    let settled = false;
    void task.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    expect(hoisted.startNapCatHttpMonitor).toHaveBeenCalledOnce();
    expect(hoisted.startNapCatWsMonitor).toHaveBeenCalledOnce();
    expect(httpStop).not.toHaveBeenCalled();
    expect(wsStop).not.toHaveBeenCalled();

    abort.abort();
    await task;

    expect(wsStop).toHaveBeenCalledOnce();
    expect(httpStop).toHaveBeenCalledOnce();
    expect(patches.some((entry) => entry.running === true)).toBe(true);
    expect(patches.some((entry) => entry.running === false)).toBe(true);
  });

  it("keeps connected=true when ws drops but http transport remains connected", async () => {
    const httpStop = vi.fn(async () => {});
    const wsStop = vi.fn();
    hoisted.startNapCatHttpMonitor.mockImplementation(
      async (params: { statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void }) => {
        params.statusSink?.({
          connected: true,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        return { stop: httpStop };
      },
    );
    hoisted.startNapCatWsMonitor.mockImplementation(
      (params: { statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void }) => {
        params.statusSink?.({
          reconnectAttempts: 0,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        params.statusSink?.({
          lastDisconnect: {
            at: Date.now(),
            status: 1006,
            error: "ws down",
          },
        });
        return { stop: wsStop };
      },
    );

    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();
    const task = napcatPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        account: buildAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const runningSnapshots = patches.filter((entry) => entry.running === true);
    expect(runningSnapshots.some((entry) => entry.connected === true)).toBe(true);
    expect(runningSnapshots.some((entry) => entry.connected === false)).toBe(false);

    abort.abort();
    await task;
  });

  it("resets running status when monitor startup fails", async () => {
    hoisted.startNapCatHttpMonitor.mockRejectedValue(new Error("listen failed"));
    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();

    await expect(
      napcatPlugin.gateway!.startAccount!(
        createStartAccountCtx({
          account: buildAccount(),
          abortSignal: abort.signal,
          statusPatchSink: (next) => patches.push({ ...next }),
        }),
      ),
    ).rejects.toThrow("listen failed");

    expect(hoisted.startNapCatWsMonitor).not.toHaveBeenCalled();
    const last = patches[patches.length - 1];
    expect(last?.running).toBe(false);
    expect(last?.connected).toBe(false);
    expect(String(last?.lastError ?? "")).toContain("listen failed");
  });

  it("keeps connected=true when http drops but ws transport remains connected", async () => {
    const httpStop = vi.fn(async () => {});
    const wsStop = vi.fn();
    hoisted.startNapCatHttpMonitor.mockImplementation(
      async (params: { statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void }) => {
        params.statusSink?.({
          connected: true,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        setTimeout(() => {
          params.statusSink?.({
            connected: false,
            lastError: "http down",
          });
        }, 0);
        return { stop: httpStop };
      },
    );
    hoisted.startNapCatWsMonitor.mockImplementation(
      (params: { statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void }) => {
        params.statusSink?.({
          reconnectAttempts: 0,
          lastConnectedAt: Date.now(),
          lastError: null,
        });
        return { stop: wsStop };
      },
    );

    const patches: ChannelAccountSnapshot[] = [];
    const abort = new AbortController();
    const task = napcatPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        account: buildAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    const runningSnapshots = patches.filter((entry) => entry.running === true);
    expect(runningSnapshots.some((entry) => String(entry.lastError ?? "").includes("http down"))).toBe(true);
    const latestRunning = runningSnapshots[runningSnapshots.length - 1];
    expect(latestRunning?.connected).toBe(true);

    abort.abort();
    await task;
  });
});
