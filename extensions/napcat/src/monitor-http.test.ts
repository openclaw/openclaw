import type { ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import {
  NAPCAT_HTTP_LIVENESS_INTERVAL_MS,
  startNapCatHttpMonitor,
} from "./monitor-http.js";
import type { ResolvedNapCatAccount } from "./types.js";

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
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        path: "/onebot",
        bodyMaxBytes: 1024 * 1024,
      },
      ws: {
        enabled: false,
        url: "ws://127.0.0.1:3001",
        reconnectMs: 3000,
      },
    },
    ...overrides,
  };
}

describe("startNapCatHttpMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks connected after listen and clears it on stop", async () => {
    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = await startNapCatHttpMonitor({
      account: buildAccount(),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    expect(patches.some((entry) => entry.connected === true)).toBe(true);

    await handle.stop();

    expect(patches.some((entry) => entry.connected === false)).toBe(true);
  });

  it("emits liveness updates while idle", async () => {
    vi.useFakeTimers();

    const patches: Array<Partial<ChannelAccountSnapshot>> = [];
    const handle = await startNapCatHttpMonitor({
      account: buildAccount(),
      config: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      statusSink: (patch) => patches.push(patch),
    });

    const lastEventAtCount = () =>
      patches.filter((entry) => typeof entry.lastEventAt === "number").length;

    const before = lastEventAtCount();
    await vi.advanceTimersByTimeAsync(NAPCAT_HTTP_LIVENESS_INTERVAL_MS);
    const after = lastEventAtCount();

    expect(after).toBeGreaterThan(before);

    await handle.stop();
  });
});
