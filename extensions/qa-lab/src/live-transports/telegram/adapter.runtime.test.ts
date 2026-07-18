import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  callTelegramApi: vi.fn(),
  flushTelegramUpdates: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseRelease: vi.fn(),
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
  }),
}));

vi.mock("./telegram-live.runtime.js", () => ({
  __testing: {
    buildTelegramQaConfig: vi.fn(() => ({})),
    callTelegramApi: mocks.callTelegramApi,
    flushTelegramUpdates: mocks.flushTelegramUpdates,
    parseTelegramQaCredentialPayload: vi.fn(),
    resolveTelegramQaRuntimeEnv: vi.fn(),
    waitForTelegramChannelRunning: vi.fn(),
  },
}));

import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";

describe("Telegram QA transport adapter cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireQaCredentialLease.mockResolvedValue({
      payload: {
        groupId: "-100123",
        driverToken: "driver-token",
        sutToken: "sut-token",
      },
      release: mocks.leaseRelease,
    });
    mocks.flushTelegramUpdates.mockResolvedValue(0);
  });

  it("holds the credential lease until gateway teardown has completed", async () => {
    let getMeCalls = 0;
    let resolvePoll: ((updates: unknown[]) => void) | undefined;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return getMeCalls === 1
          ? { id: 1, username: "driver_bot" }
          : { id: 2, username: "sut_bot" };
      }
      if (method === "getUpdates") {
        return await new Promise<unknown[]>((resolve) => {
          resolvePoll = resolve;
        });
      }
      throw new Error(`unexpected Telegram API method: ${method}`);
    });

    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);
    await vi.waitFor(() => expect(resolvePoll).toBeTypeOf("function"));

    const cleanup = adapter.cleanup?.();
    resolvePoll?.([]);
    await cleanup;

    expect(mocks.heartbeatStop).not.toHaveBeenCalled();
    expect(mocks.leaseRelease).not.toHaveBeenCalled();

    await adapter.cleanupAfterGatewayStop?.();

    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
    expect(mocks.heartbeatStop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.leaseRelease.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("releases the credential lease even when heartbeat shutdown fails", async () => {
    let getMeCalls = 0;
    let resolvePoll: ((updates: unknown[]) => void) | undefined;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return { id: getMeCalls, username: `bot_${getMeCalls}` };
      }
      if (method === "getUpdates") {
        return await new Promise<unknown[]>((resolve) => {
          resolvePoll = resolve;
        });
      }
      throw new Error(`unexpected Telegram API method: ${method}`);
    });
    mocks.heartbeatStop.mockRejectedValueOnce(new Error("heartbeat stop failed"));

    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);
    await vi.waitFor(() => expect(resolvePoll).toBeTypeOf("function"));
    const cleanup = adapter.cleanup?.();
    resolvePoll?.([]);
    await cleanup;

    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow("heartbeat stop failed");
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });
});
