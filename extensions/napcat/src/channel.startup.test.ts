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
});
