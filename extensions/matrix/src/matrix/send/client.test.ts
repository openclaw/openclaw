// Matrix tests cover client plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  expectOneOffSharedMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
  setAcquiredMatrixClient,
} from "../client-resolver.test-helpers.js";
import { createMatrixMonitorTaskRunner } from "../monitor/task-runner.js";
import { captureMatrixSendCurrentness } from "../sdk/send-currentness.js";

const {
  getMatrixRuntimeMock,
  acquireSharedMatrixClientMock,
  sharedLeaseReleaseMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

let withResolvedMatrixControlClient: typeof import("./client.js").withResolvedMatrixControlClient;
let withResolvedMatrixSendClient: typeof import("./client.js").withResolvedMatrixSendClient;

describe("matrix send client helpers", () => {
  beforeAll(async () => {
    ({ withResolvedMatrixControlClient, withResolvedMatrixSendClient } =
      await import("./client.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts and persists borrowed send clients", async () => {
    const result = await withResolvedMatrixSendClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
    expect(result).toBe("ok");
  });

  it("forwards the transient retirement signal to send work", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);

    await withResolvedMatrixSendClient(
      { cfg: TEST_CFG, accountId: "default" },
      async (_client, abortSignal) => {
        expect(abortSignal).toBe(lease.abortSignal);
      },
    );
  });

  it("persists borrowed send clients when wrapped sends fail", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedMatrixSendClient({ cfg: TEST_CFG, accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });

  it("keeps borrowed control clients unstarted and requests final persistence", async () => {
    const result = await withResolvedMatrixControlClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 0,
      releaseMode: "persist",
    });
    expect(result).toBe("ok");
  });

  it("does not borrow or stop explicitly injected clients", async () => {
    const start = vi.fn(async () => undefined);
    const injected = Object.assign(createMockMatrixClient(), { start });

    await withResolvedMatrixSendClient({ client: injected }, async (client) => {
      expect(client).toBe(injected);
    });
    await withResolvedMatrixControlClient({ client: injected }, async (client) => {
      expect(client).toBe(injected);
    });

    expect(start).not.toHaveBeenCalled();
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).not.toHaveBeenCalled();
  });

  it("does not use an injected client after the monitor task is retired", async () => {
    vi.useFakeTimers();
    const injected = createMockMatrixClient();
    const tasks = createMatrixMonitorTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      logVerboseMessage: vi.fn(),
    });
    const sendEntered = createDeferred<void>();
    const releaseSend = createDeferred<void>();
    let wireSend = false;
    const task = tasks.runDetachedTask("reply", async () => {
      await withResolvedMatrixSendClient({ client: injected }, async () => {
        sendEntered.resolve();
        await releaseSend.promise;
        captureMatrixSendCurrentness(injected)?.();
        wireSend = true;
      });
    });
    const idle = tasks.waitForIdle();
    try {
      await sendEntered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await idle;
      releaseSend.resolve();
      await task;
      expect(wireSend).toBe(false);
    } finally {
      tasks.close();
      vi.useRealTimers();
    }
  });
});
