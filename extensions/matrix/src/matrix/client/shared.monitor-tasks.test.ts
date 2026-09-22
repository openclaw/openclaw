// Matrix tests cover shared plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner } from "../monitor/task-runner.js";
import { authFor, createMockClient } from "./shared.test-support.js";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthContextMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

const TEST_CFG = {};

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
}));

let acquireSharedMatrixClient: typeof import("./shared.js").acquireSharedMatrixClient;
let stopSharedClientForAccount: typeof import("./shared.js").stopSharedClientForAccount;

describe("shared Matrix monitor task ownership", () => {
  beforeAll(async () => {
    ({ acquireSharedMatrixClient, stopSharedClientForAccount } = await import("./shared.js"));
  });

  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    resolveMatrixAuthContextMock.mockReset();
    createMatrixClientMock.mockReset();
    resolveMatrixAuthContextMock.mockImplementation(
      ({ accountId }: { accountId?: string | null } = {}) => ({
        cfg: TEST_CFG,
        env: undefined,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
  });

  afterEach(async () => {
    await Promise.allSettled([
      stopSharedClientForAccount(authFor("main")),
      stopSharedClientForAccount(authFor("ops")),
    ]);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(
    ["monitor release", "account stop"].flatMap((retirementOwner) =>
      ["release", "late acquisition"].map((operation) => ({ retirementOwner, operation })),
    ),
  )(
    "drains monitor tasks during $retirementOwner with a transient $operation",
    async ({ retirementOwner, operation }) => {
      const client = createMockClient("main");
      createMatrixClientMock.mockResolvedValue(client);
      const auth = authFor("main");
      const monitor = await acquireSharedMatrixClient({
        auth,
        role: "monitor",
        startClient: false,
      });
      const transient =
        operation === "release"
          ? await acquireSharedMatrixClient({ auth, role: "transient", startClient: false })
          : undefined;
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const tasks = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });
      const sendFinished = createDeferred<void>();
      const releaseTestDrain = createDeferred<void>();
      const taskAdmissionClosed = createDeferred<void>();
      const taskFinished = vi.fn();
      let lateLease: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
      let acquisitionError: unknown;
      const task = tasks.runDetachedTask("join introduction", async () => {
        await sendFinished.promise;
        if (transient) {
          await transient.release({ mode: "persist" });
        } else {
          try {
            lateLease = await acquireSharedMatrixClient({ auth, startClient: false });
          } catch (error) {
            acquisitionError = error;
          }
        }
        taskFinished();
      });
      monitor.registerMonitorRetirement({
        closeTaskAdmission: () => {
          tasks.close();
          taskAdmissionClosed.resolve();
        },
        detachListeners: vi.fn(),
        // The escape is only released in finally so a failing assertion still joins every task.
        waitForTasks: () => Promise.race([tasks.waitForIdle(), releaseTestDrain.promise]),
        cleanup: vi.fn(),
      });

      const retirement =
        retirementOwner === "account stop"
          ? stopSharedClientForAccount(auth)
          : monitor.release({ mode: "persist" });
      await taskAdmissionClosed.promise;
      sendFinished.resolve();
      try {
        await vi.waitFor(() => {
          expect(taskFinished).toHaveBeenCalledOnce();
        });
        await retirement;
        if (operation === "late acquisition") {
          expect(acquisitionError).toMatchObject({ name: "AbortError" });
          expect(lateLease).toBeUndefined();
        }
        expect(client.stopAndPersist).toHaveBeenCalledOnce();
        expect(client.stopWithoutPersist).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        releaseTestDrain.resolve();
        await Promise.all([task, retirement]);
        await lateLease?.release();
      }
    },
  );

  it("allows retained async acquisitions after the owning monitor task settles", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
    const tasks = createMatrixMonitorTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
    });
    const resume = createDeferred<void>();
    let retained: Promise<unknown> | undefined;
    let retainedLease: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
    await tasks.runDetachedTask("retained continuation", async () => {
      retained = resume.promise.then(async () => {
        retainedLease = await acquireSharedMatrixClient({ auth, startClient: false });
        return retainedLease;
      });
    });
    resume.resolve();
    try {
      await expect(retained).resolves.toMatchObject({ client });
      expect(retainedLease?.client).toBe(client);
      const unrelated = await acquireSharedMatrixClient({ auth, startClient: false });
      expect(unrelated.client).toBe(client);
      await unrelated.release();
    } finally {
      await retained;
      await retainedLease?.release();
      await monitor.release();
    }
  });

  it.each(["authentication", "client creation"])(
    "allows a retained acquisition already suspended during %s to finish after owner settlement",
    async (phase) => {
      const auth = authFor("main");
      const replacementAuth =
        phase === "client creation"
          ? { ...auth, accessToken: `${auth.accessToken}-rotated` }
          : auth;
      const client = createMockClient("main");
      const replacementClient = createMockClient("main-replacement");
      createMatrixClientMock.mockResolvedValueOnce(client);
      const monitor = await acquireSharedMatrixClient({
        auth,
        role: "monitor",
        startClient: false,
      });
      const tasks = createMatrixMonitorTaskRunner({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logVerboseMessage: vi.fn(),
      });
      const allowOwnerSettlement = createDeferred<void>();
      const authReady = createDeferred<MatrixAuth>();
      const clientReady = createDeferred<typeof replacementClient>();
      resolveMatrixAuthMock.mockReturnValue(
        phase === "authentication" ? authReady.promise : Promise.resolve(replacementAuth),
      );
      if (phase === "client creation") {
        createMatrixClientMock.mockReturnValueOnce(clientReady.promise);
      }
      let retained: Promise<Awaited<ReturnType<typeof acquireSharedMatrixClient>>> | undefined;
      const task = tasks.runDetachedTask("retained acquisition", async () => {
        retained = acquireSharedMatrixClient({
          cfg: TEST_CFG,
          accountId: "main",
          startClient: false,
        });
        await allowOwnerSettlement.promise;
      });

      try {
        await vi.waitFor(() => {
          expect(
            phase === "authentication" ? resolveMatrixAuthMock : createMatrixClientMock,
          ).toHaveBeenCalledTimes(phase === "authentication" ? 1 : 2);
        });
        allowOwnerSettlement.resolve();
        await task;
        if (!retained) {
          throw new Error("Expected retained acquisition to start before owner settlement");
        }

        authReady.resolve(auth);
        clientReady.resolve(replacementClient);
        const retainedLease = await retained;
        expect(retainedLease.client).toBe(phase === "authentication" ? client : replacementClient);
        await retainedLease.release();
      } finally {
        allowOwnerSettlement.resolve();
        authReady.resolve(auth);
        clientReady.resolve(replacementClient);
        await task;
        await retained?.catch(() => undefined);
        await monitor.release();
      }
    },
  );

  it("keeps shutdown cancellation after the task settles for a retained continuation", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
    const tasks = createMatrixMonitorTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
    });
    const taskEntered = createDeferred<void>();
    const allowTaskToSettle = createDeferred<void>();
    const resumeRetainedContinuation = createDeferred<void>();
    const taskAdmissionClosed = createDeferred<void>();
    let retained: Promise<unknown> | undefined;
    const task = tasks.runDetachedTask("retained continuation", async () => {
      retained = resumeRetainedContinuation.promise.then(() =>
        acquireSharedMatrixClient({ auth, startClient: false }),
      );
      taskEntered.resolve();
      await allowTaskToSettle.promise;
    });
    monitor.registerMonitorRetirement({
      closeTaskAdmission: () => {
        tasks.close();
        taskAdmissionClosed.resolve();
      },
      detachListeners: vi.fn(),
      waitForTasks: tasks.waitForIdle,
      cleanup: vi.fn(),
    });

    await taskEntered.promise;
    const retirement = stopSharedClientForAccount(auth);
    await taskAdmissionClosed.promise;
    allowTaskToSettle.resolve();
    await Promise.all([task, retirement]);

    const retainedExpectation = expect(retained).rejects.toMatchObject({ name: "AbortError" });
    resumeRetainedContinuation.resolve();
    await retainedExpectation;
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
  });

  it("keeps shutdown cancellation when retirement starts after the task settles", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
    const tasks = createMatrixMonitorTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
    });
    const resumeRetainedContinuation = createDeferred<void>();
    let retained: Promise<unknown> | undefined;
    await tasks.runDetachedTask("retained continuation", async () => {
      retained = resumeRetainedContinuation.promise.then(() =>
        acquireSharedMatrixClient({ auth, startClient: false }),
      );
    });
    monitor.registerMonitorRetirement({
      closeTaskAdmission: tasks.close,
      detachListeners: vi.fn(),
      waitForTasks: tasks.waitForIdle,
      cleanup: vi.fn(),
    });

    await stopSharedClientForAccount(auth);

    const retainedExpectation = expect(retained).rejects.toMatchObject({ name: "AbortError" });
    resumeRetainedContinuation.resolve();
    await retainedExpectation;
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
  });

  it.each(["authentication", "client creation"])(
    "aborts a retained acquisition suspended during %s when retirement starts after settlement",
    async (phase) => {
      const auth = authFor("main");
      const replacementAuth =
        phase === "client creation"
          ? { ...auth, accessToken: `${auth.accessToken}-rotated` }
          : auth;
      const client = createMockClient("main");
      const replacementClient = createMockClient("main-replacement");
      createMatrixClientMock.mockResolvedValueOnce(client);
      const monitor = await acquireSharedMatrixClient({
        auth,
        role: "monitor",
        startClient: false,
      });
      const tasks = createMatrixMonitorTaskRunner({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logVerboseMessage: vi.fn(),
      });
      const allowOwnerSettlement = createDeferred<void>();
      const taskAdmissionClosed = createDeferred<void>();
      const authReady = createDeferred<MatrixAuth>();
      const clientReady = createDeferred<typeof replacementClient>();
      resolveMatrixAuthMock.mockReturnValue(
        phase === "authentication" ? authReady.promise : Promise.resolve(replacementAuth),
      );
      if (phase === "client creation") {
        createMatrixClientMock.mockReturnValueOnce(clientReady.promise);
      }
      let retained: Promise<Awaited<ReturnType<typeof acquireSharedMatrixClient>>> | undefined;
      const task = tasks.runDetachedTask("retained acquisition", async () => {
        retained = acquireSharedMatrixClient({
          cfg: TEST_CFG,
          accountId: "main",
          startClient: false,
        });
        await allowOwnerSettlement.promise;
      });
      monitor.registerMonitorRetirement({
        closeTaskAdmission: () => {
          tasks.close();
          taskAdmissionClosed.resolve();
        },
        detachListeners: vi.fn(),
        waitForTasks: tasks.waitForIdle,
        cleanup: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(
          phase === "authentication" ? resolveMatrixAuthMock : createMatrixClientMock,
        ).toHaveBeenCalledTimes(phase === "authentication" ? 1 : 2);
      });
      allowOwnerSettlement.resolve();
      await task;
      if (!retained) {
        throw new Error("Expected retained acquisition to start before owner settlement");
      }
      const retirement = stopSharedClientForAccount(auth);
      await taskAdmissionClosed.promise;
      await retirement;

      const retainedExpectation = expect(retained).rejects.toMatchObject({ name: "AbortError" });
      authReady.resolve(auth);
      clientReady.resolve(replacementClient);
      await retainedExpectation;
      expect(client.stopAndPersist).toHaveBeenCalledOnce();
      expect(replacementClient.start).not.toHaveBeenCalled();
      if (phase === "authentication") {
        expect(createMatrixClientMock).toHaveBeenCalledOnce();
        expect(replacementClient.stopWithoutPersist).not.toHaveBeenCalled();
      } else {
        expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
        expect(replacementClient.stopWithoutPersist).toHaveBeenCalledOnce();
      }
    },
  );

  it("preserves explicit cancellation for retained async acquisitions", async () => {
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
    const tasks = createMatrixMonitorTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
    });
    const resume = createDeferred<void>();
    const caller = new AbortController();
    let retained: Promise<unknown> | undefined;
    await tasks.runDetachedTask("retained continuation", async () => {
      retained = resume.promise.then(() =>
        acquireSharedMatrixClient({ auth, startClient: false, abortSignal: caller.signal }),
      );
    });
    caller.abort();
    resume.resolve();
    try {
      await expect(retained).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await retained?.catch(() => undefined);
      await monitor.release();
    }
  });

  it.each(
    ["authentication", "client creation"].flatMap((phase) =>
      ["monitor", "caller"].map((abortOwner) => ({ phase, abortOwner })),
    ),
  )(
    "rejects $abortOwner cancellation during $phase before admitting a lease",
    async ({ phase, abortOwner }) => {
      const auth = authFor("main");
      const client = createMockClient("main");
      const authReady = createDeferred<MatrixAuth>();
      const clientReady = createDeferred<typeof client>();
      resolveMatrixAuthMock.mockReturnValue(
        phase === "authentication" ? authReady.promise : Promise.resolve(auth),
      );
      createMatrixClientMock.mockReturnValue(
        phase === "client creation" ? clientReady.promise : Promise.resolve(client),
      );
      const tasks = createMatrixMonitorTaskRunner({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logVerboseMessage: vi.fn(),
      });
      const caller = new AbortController();
      let lease: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
      let acquisitionError: unknown;
      const task = tasks.runDetachedTask("pending acquisition", async () => {
        try {
          lease = await acquireSharedMatrixClient({
            cfg: TEST_CFG,
            accountId: "main",
            startClient: false,
            abortSignal: caller.signal,
          });
        } catch (error) {
          acquisitionError = error;
        }
      });
      try {
        await vi.waitFor(() => {
          expect(
            phase === "authentication" ? resolveMatrixAuthMock : createMatrixClientMock,
          ).toHaveBeenCalledOnce();
        });
        if (abortOwner === "monitor") {
          tasks.close();
        } else {
          caller.abort();
        }
        authReady.resolve(auth);
        clientReady.resolve(client);
        await task;
        expect(acquisitionError).toMatchObject({ name: "AbortError" });
        expect(lease).toBeUndefined();
        expect(client.start).not.toHaveBeenCalled();
        if (phase === "authentication") {
          expect(createMatrixClientMock).not.toHaveBeenCalled();
        } else {
          expect(client.stopWithoutPersist).toHaveBeenCalledOnce();
        }
      } finally {
        authReady.resolve(auth);
        clientReady.resolve(client);
        await task;
        await lease?.release();
      }
    },
  );
});
