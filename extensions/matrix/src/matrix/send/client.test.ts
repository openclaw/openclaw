import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
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
import { MatrixMessageWireDispatchGuards } from "../sdk/message-wire-dispatch.js";
import { captureMatrixSendCurrentness } from "../sdk/send-currentness.js";
import { MatrixSendScheduler } from "../sdk/send-scheduler.js";

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
    primeMatrixClientResolverMocks({ resolved: {} });
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

  it("keeps borrowed control clients unstarted and releases without persistence", async () => {
    const result = await withResolvedMatrixControlClient(
      { cfg: TEST_CFG, accountId: "default" },
      async () => "ok",
    );

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 0,
      releaseMode: "stop",
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

  it.each(["a", "b"] as const)(
    "keeps scheduler currentness on the originating monitor when %s retires",
    async (retired) => {
      const injected = createMockMatrixClient();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const monitorA = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });
      const monitorB = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });
      const guards = new MatrixMessageWireDispatchGuards();
      const scheduler = new MatrixSendScheduler((event) =>
        guards.wasCurrentnessRejected(event.getTxnId()),
      );
      const holdingA = createDeferred<void>();
      const queuedB = createDeferred<void>();
      const releaseProcessor = createDeferred<void>();
      const outcomes: { a?: Promise<unknown>; b?: Promise<unknown> } = {};
      const eventFor = (txnId: string) => {
        const event = new MatrixEvent({
          type: "m.room.message",
          room_id: "!room:example",
          content: { msgtype: "m.text", body: txnId },
          txn_id: txnId,
        });
        event.setTxnId(txnId);
        return event;
      };
      const sendUrl = (txnId: string) =>
        `https://matrix.example/_matrix/client/v3/rooms/%21room%3Aexample/send/m.room.message/${txnId}`;

      scheduler.setProcessFunction(async (event) => {
        const txnId = event.getTxnId();
        if (!txnId) {
          throw new Error("queued Matrix event has no transaction id");
        }
        if (txnId === "txn-a") {
          holdingA.resolve();
          await queuedB.promise;
          await releaseProcessor.promise;
        }
        guards.captureCurrentness(sendUrl(txnId), { method: "PUT" }, undefined)?.();
        return { event_id: `$${txnId}` };
      });

      const sendFrom = (
        monitor: ReturnType<typeof createMatrixMonitorTaskRunner>,
        txnId: "txn-a" | "txn-b",
      ) =>
        monitor.runDetachedTask(txnId, async () => {
          await withResolvedMatrixSendClient({ client: injected }, async () => {
            const assertCurrent = captureMatrixSendCurrentness(injected);
            await guards.run({
              transactionId: txnId,
              assertCurrent,
              run: async () => {
                const pending = scheduler.queueEvent(eventFor(txnId));
                if (!pending) {
                  throw new Error(`${txnId} was not queued`);
                }
                outcomes[txnId === "txn-a" ? "a" : "b"] = pending;
                if (txnId === "txn-b") {
                  queuedB.resolve();
                }
                await pending;
              },
            });
          });
        });

      const taskA = sendFrom(monitorA, "txn-a");
      const taskB = sendFrom(monitorB, "txn-b");
      try {
        await holdingA.promise;
        await queuedB.promise;
        (retired === "a" ? monitorA : monitorB).close();
        releaseProcessor.resolve();
        await Promise.all([taskA, taskB]);
        const [resultA, resultB] = await Promise.allSettled([outcomes.a, outcomes.b]);
        expect(resultA.status).toBe(retired === "a" ? "rejected" : "fulfilled");
        expect(resultB.status).toBe(retired === "b" ? "rejected" : "fulfilled");
      } finally {
        releaseProcessor.resolve();
        queuedB.resolve();
        monitorA.close();
        monitorB.close();
        await Promise.allSettled([taskA, taskB]);
      }
    },
  );
});
