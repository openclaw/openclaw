import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner } from "../monitor/task-runner.js";
import {
  authFor,
  createMockClient,
  prepareMockMatrixClientStorage,
} from "./shared.test-support.js";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const resolveMatrixAuthContextMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

const TEST_CFG = {};

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

// mock-isolation: Keep disk and SDK initialization outside these generation lifecycle fixtures.
vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
  prepareMatrixClientStorage: prepareMockMatrixClientStorage,
}));

let acquireSharedMatrixClient: typeof import("./shared.js").acquireSharedMatrixClient;
let stopSharedClientForAccount: typeof import("./shared.js").stopSharedClientForAccount;

function acquireStoppedClient(auth: MatrixAuth, role?: "monitor" | "transient") {
  return acquireSharedMatrixClient({ auth, role, startClient: false });
}

function createMonitorRetirement(callOrder: string[]) {
  return {
    closeTaskAdmission: vi.fn(() => callOrder.push("close-admission")),
    detachListeners: vi.fn(() => callOrder.push("detach-listeners")),
    waitForTasks: vi.fn(async () => {
      callOrder.push("wait-tasks");
    }),
    cleanup: vi.fn(async () => {
      callOrder.push("monitor-cleanup");
    }),
  };
}

async function expectMatrixStartupAbort(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AbortError",
    message: "Matrix startup aborted",
  });
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

describe("shared Matrix client generations", () => {
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

  it("keeps colliding delimiter-shaped auth tuples isolated", async () => {
    const firstAuth = {
      ...authFor("main"),
      homeserver: "https://matrix.example.org/base|@alice",
      userId: "@bob:example.org",
      accessToken: "shared-token",
      encryption: true,
    } satisfies MatrixAuth;
    const secondAuth = {
      ...authFor("main"),
      homeserver: "https://matrix.example.org/base",
      // Historical Matrix user IDs may contain both characters in the localpart.
      userId: "@alice|@bob:example.org",
      accessToken: "shared-token",
      encryption: true,
    } satisfies MatrixAuth;
    const firstClient = createMockClient("first");
    const secondClient = createMockClient("second");

    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    const firstLease = await acquireSharedMatrixClient({ auth: firstAuth });
    const repeatedFirstLease = await acquireSharedMatrixClient({ auth: firstAuth });
    const secondLease = await acquireSharedMatrixClient({ auth: secondAuth });

    expect(firstLease.client).toBe(firstClient);
    expect(repeatedFirstLease.client).toBe(firstClient);
    expect(secondLease.client).toBe(secondClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.start).toHaveBeenCalledTimes(1);
    expect(secondClient.start).toHaveBeenCalledTimes(1);

    await firstLease.release();
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await repeatedFirstLease.release();
    expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    expect(secondClient.stopAndPersist).not.toHaveBeenCalled();

    await secondLease.release();
    expect(secondClient.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("converges concurrent creation and rejects incompatible policy before another SDK client", async () => {
    const auth = authFor("main");
    const client = createMockClient("main");
    const creation = createDeferred<typeof client>();
    const creationEntered = createDeferred<void>();
    createMatrixClientMock.mockImplementationOnce(() => {
      creationEntered.resolve();
      return creation.promise;
    });
    const first = acquireStoppedClient(auth, "monitor");
    const concurrent = acquireStoppedClient(auth);
    await creationEntered.promise;
    const incompatible = acquireStoppedClient({ ...auth, allowPrivateNetwork: true });
    const refused = expect(incompatible).rejects.toMatchObject({
      code: "MATRIX_ACCOUNT_RESTARTING",
      retryable: true,
    });
    creation.resolve(client);
    const [monitor, action] = await Promise.all([first, concurrent]);
    await refused;
    expect(action.client).toBe(monitor.client);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    await action.release();
    await monitor.release();
  });

  it("joins explicit retirement for a changed transport without creating a second client early", async () => {
    const auth = authFor("main");
    const oldClient = createMockClient("old");
    const nextClient = createMockClient("next");
    const stopEntered = createDeferred<void>();
    const stopFinished = createDeferred<void>();
    oldClient.stopWithoutPersist.mockImplementation(async () => {
      stopEntered.resolve();
      await stopFinished.promise;
    });
    createMatrixClientMock.mockResolvedValueOnce(oldClient).mockResolvedValueOnce(nextClient);
    const monitor = await acquireStoppedClient(auth, "monitor");
    const retirement = monitor.release({ mode: "discard" });
    await stopEntered.promise;
    const caller = new AbortController();
    const cancelled = acquireSharedMatrixClient({
      auth: { ...auth, allowPrivateNetwork: true },
      startClient: false,
      abortSignal: caller.signal,
    });
    caller.abort();
    await expectMatrixStartupAbort(cancelled);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    const successor = acquireStoppedClient({ ...auth, allowPrivateNetwork: true });
    stopFinished.resolve();
    await retirement;
    const replacement = await successor;
    expect(replacement.client).toBe(nextClient);
    await replacement.release();
  });

  it("shares one client generation across duplicate module identities", async () => {
    const moduleA = await importFreshModule<typeof import("./shared.js")>(
      import.meta.url,
      "./shared.js?scope=duplicate-a",
    );
    const moduleB = await importFreshModule<typeof import("./shared.js")>(
      import.meta.url,
      "./shared.js?scope=duplicate-b",
    );
    const auth = authFor("main");
    const client = createMockClient("shared");
    createMatrixClientMock.mockResolvedValue(client);

    const first = await moduleA.acquireSharedMatrixClient({ auth, startClient: false });
    const second = await moduleB.acquireSharedMatrixClient({ auth, startClient: false });

    expect(first.client).toBe(client);
    expect(second.client).toBe(client);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    await Promise.all([first.release(), second.release()]);
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
  });

  it("runs registered monitor cleanup during forced account retirement", async () => {
    const auth = authFor("main");
    const client = createMockClient("main");
    const waitForTasks = createDeferred<void>();
    createMatrixClientMock.mockResolvedValue(client);
    const monitor = await acquireStoppedClient(auth, "monitor");
    const retirement = createMonitorRetirement([]);
    retirement.waitForTasks.mockReturnValue(waitForTasks.promise);
    monitor.registerMonitorRetirement(retirement);

    const forcedRetirement = stopSharedClientForAccount(auth);
    await vi.waitFor(() => {
      expect(retirement.waitForTasks).toHaveBeenCalledTimes(1);
    });
    const lateRelease = monitor.release({ mode: "persist" });
    expect(monitor.release({ mode: "discard" })).toBe(lateRelease);
    await expectPending(lateRelease);

    waitForTasks.resolve();
    await Promise.all([forcedRetirement, lateRelease]);

    expect(retirement.closeTaskAdmission).toHaveBeenCalledTimes(1);
    expect(retirement.detachListeners).toHaveBeenCalledTimes(1);
    expect(retirement.waitForTasks).toHaveBeenCalledTimes(1);
    expect(retirement.cleanup).toHaveBeenCalledTimes(1);
    expect(client.quiesceSync).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("signals cooperative transient work and persists after it drains", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const transient = await acquireStoppedClient(auth, "transient");
    transient.abortSignal.addEventListener(
      "abort",
      () => {
        callOrder.push("transient-cancel");
        void transient.release();
      },
      { once: true },
    );

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    await monitor.release({ mode: "persist" });

    expect(transient.abortSignal.aborted).toBe(true);
    expect(callOrder).toEqual([
      "transient-cancel",
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "persist",
    ]);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("keeps shared sync open until the final monitor lease is released", async () => {
    const callOrder: string[] = [];
    const client = createMockClient("main", callOrder);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("main");
    const first = await acquireStoppedClient(auth, "monitor");
    const final = await acquireStoppedClient(auth, "monitor");
    const firstRetirement = createMonitorRetirement(callOrder);
    first.registerMonitorRetirement(firstRetirement);
    final.registerMonitorRetirement(createMonitorRetirement(callOrder));

    const firstRelease = first.release({ mode: "persist" });
    expect(first.release({ mode: "discard" })).toBe(firstRelease);
    await firstRelease;

    expect(callOrder).toEqual([
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
    ]);
    expect(client.quiesceSync).not.toHaveBeenCalled();
    expect(client.stopAndPersist).not.toHaveBeenCalled();
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();

    await final.release({ mode: "persist" });

    expect(callOrder).toEqual([
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "quiesce",
      "drain-quiesce",
      "close-admission",
      "detach-listeners",
      "wait-tasks",
      "monitor-cleanup",
      "persist",
    ]);
    expect(client.quiesceSync).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  });

  it("discards a timed-out generation and lets a later acquisition create a fresh client", async () => {
    const cause = new Error("Matrix classic sync did not reach STOPPED within 5000ms");
    const callOrder: string[] = [];
    const timedOutClient = createMockClient("timed-out", callOrder);
    const replacementClient = createMockClient("replacement");
    timedOutClient.quiesceSync.mockImplementation(async () => {
      callOrder.push("quiesce");
      throw cause;
    });
    createMatrixClientMock
      .mockResolvedValueOnce(timedOutClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const transient = await acquireStoppedClient(auth, "transient");

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    const release = monitor.release({ mode: "persist" });
    const releaseError = release.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(callOrder).toContain("monitor-cleanup");
    });
    await expect(acquireSharedMatrixClient({ auth })).rejects.toBe(cause);

    await expect(transient.release()).rejects.toBe(cause);
    expect(await releaseError).toBe(cause);
    expect(timedOutClient.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(timedOutClient.stopAndPersist).not.toHaveBeenCalled();

    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await replacement.release({ mode: "discard" });
  });

  it("preserves an earlier stop requirement when the final lease requests discard", async () => {
    const cause = new Error("best-effort persistence failed");
    const persist = createDeferred<void>();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.stopAndPersist.mockReturnValue(persist.promise);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const first = await acquireSharedMatrixClient({ auth, startClient: false });
    const final = await acquireSharedMatrixClient({ auth, startClient: false });

    await first.release({ mode: "stop" });
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    const release = final.release({ mode: "discard" });
    await vi.waitFor(() => {
      expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    });
    const replacementPromise = acquireSharedMatrixClient({ auth, startClient: false });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    persist.reject(cause);
    await release;
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);

    const replacement = await replacementPromise;
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("keeps a discarded generation unavailable until async cleanup settles", async () => {
    const discard = createDeferred<void>();
    const client = createMockClient("main");
    const replacementClient = createMockClient("replacement");
    client.stopWithoutPersist.mockReturnValue(discard.promise);
    createMatrixClientMock.mockResolvedValueOnce(client).mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    const release = lease.release({ mode: "discard" });
    await vi.waitFor(() => {
      expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    });
    const replacementPromise = acquireSharedMatrixClient({ auth, startClient: false });
    await Promise.resolve();
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    expect(client.stopAndPersist).not.toHaveBeenCalled();
    discard.resolve();
    await release;
    const replacement = await replacementPromise;
    expect(replacement.client).toBe(replacementClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await replacement.release({ mode: "discard" });
  });

  it("retains a generation when strict persistence fallback shutdown fails", async () => {
    const failure = new Error("strict persistence fallback shutdown failed");
    const client = createMockClient("main");
    client.stopAndPersist.mockRejectedValue(new Error("crypto persist failed"));
    client.stopWithoutPersist.mockRejectedValue(failure);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("strict persistence fallback-failure");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    await expect(lease.release({ mode: "persist" })).rejects.toBe(failure);
    await expect(acquireSharedMatrixClient({ auth, startClient: false })).rejects.toBe(failure);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
  });

  it("awaits discard fallback before surfacing strict persistence failure", async () => {
    const persistFailure = new Error("crypto persist failed");
    const persist = createDeferred<void>();
    const discard = createDeferred<void>();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.stopAndPersist.mockReturnValue(persist.promise);
    firstClient.stopWithoutPersist.mockReturnValue(discard.promise);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("strict-persist-failure");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    const releaseError = expect(lease.release({ mode: "persist" })).rejects.toBe(persistFailure);
    persist.reject(persistFailure);
    await vi.waitFor(() => {
      expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);
    });
    const blockedAcquire = acquireSharedMatrixClient({ auth, startClient: false });
    await expect(blockedAcquire).rejects.toBe(persistFailure);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
    const forcedRetirement = stopSharedClientForAccount(auth);
    await expectPending(forcedRetirement);

    discard.resolve();
    await releaseError;
    await expect(forcedRetirement).rejects.toBe(persistFailure);
    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("discards and replaces a generation when the decryption drain fails", async () => {
    const cause = new Error("final decryption drain timed out");
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    const draining = createDeferred<"draining">();
    const drained = createDeferred<void>();
    firstClient.drainPendingDecryptions.mockRejectedValueOnce(cause).mockImplementationOnce(() => {
      draining.resolve("draining");
      return drained.promise;
    });
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    const release = lease.release({ mode: "persist" });
    const settled = release.then(
      () => "settled",
      () => "settled",
    );
    expect(await Promise.race([draining.promise, settled])).toBe("draining");
    expect(firstClient.stopWithoutPersist).not.toHaveBeenCalled();
    drained.resolve();
    await expect(release).rejects.toBe(cause);
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await expect(stopSharedClientForAccount(auth)).resolves.toBeUndefined();

    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("joins an in-flight startup during forced retirement", async () => {
    const start = createDeferred<void>();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    let startupSignal: AbortSignal | undefined;
    firstClient.start.mockImplementation(({ abortSignal } = {}) => {
      startupSignal = abortSignal;
      return start.promise;
    });
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const owner = await acquireSharedMatrixClient({ auth, startClient: false });
    const waiter = await acquireSharedMatrixClient({ auth, startClient: false });
    const callerAbort = new AbortController();

    const ownerStart = owner.start(callerAbort.signal);
    await vi.waitFor(() => {
      expect(firstClient.start).toHaveBeenCalledTimes(1);
    });
    const waiterStart = waiter.start();
    const ownerAbort = expectMatrixStartupAbort(ownerStart);
    const waiterAbort = expectMatrixStartupAbort(waiterStart);

    const retirement = stopSharedClientForAccount(auth);
    await Promise.all([ownerAbort, waiterAbort]);
    expect(callerAbort.signal.aborted).toBe(false);
    expect(startupSignal?.aborted).toBe(true);
    expect(owner.abortSignal.aborted).toBe(true);
    expect(waiter.abortSignal.aborted).toBe(true);
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();

    await expectPending(retirement);

    start.resolve();
    await retirement;
    expect(firstClient.stopAndPersist).toHaveBeenCalledTimes(1);
    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  describe("monitor task ownership", () => {
    it.each([
      { retirementOwner: "monitor release", operation: "release" },
      { retirementOwner: "account stop", operation: "release" },
      { retirementOwner: "monitor release", operation: "late acquisition" },
    ])(
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
          expect(retainedLease.client).toBe(
            phase === "authentication" ? client : replacementClient,
          );
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

    it("keeps shutdown cancellation when retirement starts after the task settles", async () => {
      const client = createMockClient("main");
      createMatrixClientMock.mockResolvedValue(client);
      const auth = authFor("main");
      const monitor = await acquireSharedMatrixClient({
        auth,
        role: "monitor",
        startClient: false,
      });
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

    it("rejects caller cancellation during client creation before admitting a lease", async () => {
      const auth = authFor("main");
      const client = createMockClient("main");
      const clientReady = createDeferred<typeof client>();
      resolveMatrixAuthMock.mockResolvedValue(auth);
      createMatrixClientMock.mockReturnValue(clientReady.promise);
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
          expect(createMatrixClientMock).toHaveBeenCalledOnce();
        });
        caller.abort();
        clientReady.resolve(client);
        await task;
        expect(acquisitionError).toMatchObject({ name: "AbortError" });
        expect(lease).toBeUndefined();
        expect(client.start).not.toHaveBeenCalled();
        expect(client.stopWithoutPersist).toHaveBeenCalledOnce();
      } finally {
        clientReady.resolve(client);
        await task;
        await lease?.release();
      }
    });
  });
});
