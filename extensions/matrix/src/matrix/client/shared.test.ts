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

  it("retries admission when retirement starts after state resolution", async () => {
    const retiringClient = createMockClient("retiring");
    const replacementClient = createMockClient("replacement");
    createMatrixClientMock
      .mockResolvedValueOnce(retiringClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const monitor = await acquireStoppedClient(auth, "monitor");
    monitor.registerMonitorRetirement(createMonitorRetirement([]));

    const racingAcquire = acquireSharedMatrixClient({ auth, startClient: false });
    let retirement: Promise<void> | undefined;
    queueMicrotask(() => {
      retirement = monitor.release({ mode: "discard" });
    });

    const racingLease = await racingAcquire;
    await racingLease.release({ mode: "discard" });
    await retirement;

    expect(racingLease.client).toBe(replacementClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
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
      "drain-final",
      "persist",
    ]);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();
  });

  it("bounds non-cooperative transient drain and replaces after every late release", async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];
    const discard = createDeferred<void>();
    const client = createMockClient("main", callOrder);
    client.stopWithoutPersist.mockImplementation(async () => {
      callOrder.push("discard");
      await discard.promise;
    });
    const replacementClient = createMockClient("replacement");
    createMatrixClientMock.mockResolvedValueOnce(client).mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const firstTransient = await acquireStoppedClient(auth, "transient");
    const finalTransient = await acquireStoppedClient(auth, "transient");

    monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
    const retirement = monitor.release({ mode: "persist" });
    const retirementError = retirement.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.stopWithoutPersist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    });
    await expect(stopSharedClientForAccount(auth)).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });

    discard.resolve();
    await expect(retirementError).resolves.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });
    expect(finalTransient.abortSignal.aborted).toBe(true);
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(client.stopAndPersist).not.toHaveBeenCalled();
    await expect(acquireSharedMatrixClient({ auth })).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });

    const firstLateRelease = firstTransient.release({ mode: "persist" });
    const duplicateLateRelease = firstTransient.release({ mode: "persist" });
    expect(duplicateLateRelease).toBe(firstLateRelease);
    await firstLateRelease;
    await expect(acquireSharedMatrixClient({ auth })).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });
    await expect(stopSharedClientForAccount(auth)).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });

    const finalLateRelease = finalTransient.release({ mode: "persist" });
    const finalRepeatedForce = stopSharedClientForAccount(auth);
    await finalLateRelease;
    await expect(finalRepeatedForce).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });

    const [firstReplacement, secondReplacement] = await Promise.all([
      acquireSharedMatrixClient({ auth, startClient: false }),
      acquireSharedMatrixClient({ auth, startClient: false }),
    ]);
    expect(firstReplacement.client).toBe(replacementClient);
    expect(secondReplacement.client).toBe(replacementClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await firstReplacement.release({ mode: "discard" });
    await secondReplacement.release({ mode: "discard" });
  });

  it("keeps monitor cleanup poison after every late transient releases", async () => {
    vi.useFakeTimers();
    const cause = new Error("monitor cleanup failed");
    const client = createMockClient("main");
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("late-monitor-cleanup");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const transient = await acquireStoppedClient(auth, "transient");
    const monitorRetirement = createMonitorRetirement([]);
    monitorRetirement.cleanup.mockRejectedValue(cause);
    monitor.registerMonitorRetirement(monitorRetirement);

    const retirementError = monitor.release({ mode: "persist" }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirementError).resolves.toBe(cause);
    await transient.release();

    await expect(acquireSharedMatrixClient({ auth })).rejects.toBe(cause);
    await expect(stopSharedClientForAccount(auth)).rejects.toBe(cause);
    await expect(acquireSharedMatrixClient({ auth })).rejects.toBe(cause);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
  });

  it("keeps poison when the poisoned decryption drain fails before a late release", async () => {
    vi.useFakeTimers();
    const cause = new Error("poisoned decryption drain failed");
    const client = createMockClient("main");
    client.drainPendingDecryptions.mockImplementation(async (reason: string) => {
      if (reason === "matrix poisoned client shutdown") {
        throw cause;
      }
    });
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("poisoned-decryption-drain");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const transient = await acquireStoppedClient(auth, "transient");
    monitor.registerMonitorRetirement(createMonitorRetirement([]));

    const retirementError = monitor.release({ mode: "persist" }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirementError).resolves.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });
    await transient.release();

    await expect(acquireSharedMatrixClient({ auth })).rejects.toMatchObject({
      message: "Matrix transient leases did not drain within 5000ms",
    });
    expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
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
      "drain-final",
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
    await expect(forcedRetirement).resolves.toBeUndefined();
    const replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    expect(replacement.client).toBe(replacementClient);
    await replacement.release({ mode: "discard" });
  });

  it("discards and replaces a generation when the final decryption drain fails", async () => {
    const cause = new Error("final decryption drain timed out");
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.drainPendingDecryptions
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cause);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });

    await expect(lease.release({ mode: "persist" })).rejects.toBe(cause);
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

  it("bounds forced retirement while startup remains stuck and fences late cleanup", async () => {
    vi.useFakeTimers();
    const start = createDeferred<void>();
    const discard = createDeferred<void>();
    const firstClient = createMockClient("first");
    const replacementClient = createMockClient("replacement");
    firstClient.start.mockReturnValue(start.promise);
    firstClient.stopWithoutPersist.mockReturnValue(discard.promise);
    createMatrixClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(replacementClient);
    const auth = authFor("main");
    const lease = await acquireSharedMatrixClient({ auth, startClient: false });
    const startup = lease.start();
    await vi.waitFor(() => {
      expect(firstClient.start).toHaveBeenCalledTimes(1);
    });

    const retirementError = stopSharedClientForAccount(auth).then(
      () => null,
      (error: unknown) => error,
    );
    await expectMatrixStartupAbort(startup);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(firstClient.stopWithoutPersist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(retirementError).resolves.toMatchObject({
      message: "Matrix client startup did not settle within 5000ms during retirement",
    });
    await expect(acquireSharedMatrixClient({ auth, startClient: false })).rejects.toMatchObject({
      message: "Matrix client startup did not settle within 5000ms during retirement",
    });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    start.resolve();
    await vi.waitFor(() => {
      expect(firstClient.stopWithoutPersist).toHaveBeenCalledTimes(1);
    });
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();
    await expect(acquireSharedMatrixClient({ auth, startClient: false })).rejects.toMatchObject({
      message: "Matrix client startup did not settle within 5000ms during retirement",
    });
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);

    discard.resolve();
    await discard.promise;
    let replacement: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
    await vi.waitFor(async () => {
      replacement = await acquireSharedMatrixClient({ auth, startClient: false });
    });
    if (!replacement) {
      throw new Error("expected replacement Matrix client");
    }
    expect(replacement.client).toBe(replacementClient);
    expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
    await replacement.release({ mode: "discard" });
  });

  it("retires monitor ownership when late startup discard fails", async () => {
    vi.useFakeTimers();
    const start = createDeferred<void>();
    const monitorTasks = createDeferred<void>();
    const discardFailure = new Error("late discard failed");
    const client = createMockClient("first");
    client.start.mockReturnValue(start.promise);
    client.stopWithoutPersist.mockRejectedValue(discardFailure);
    createMatrixClientMock.mockResolvedValue(client);
    const auth = authFor("late-discard-failure");
    const monitor = await acquireStoppedClient(auth, "monitor");
    const monitorRetirement = createMonitorRetirement([]);
    monitorRetirement.waitForTasks.mockReturnValue(monitorTasks.promise);
    monitor.registerMonitorRetirement(monitorRetirement);
    const startup = monitor.start();

    await vi.waitFor(() => {
      expect(client.start).toHaveBeenCalledTimes(1);
    });
    const retirementError = stopSharedClientForAccount(auth).then(
      () => null,
      (error: unknown) => error,
    );
    await expectMatrixStartupAbort(startup);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirementError).resolves.toMatchObject({
      message: "Matrix client startup did not settle within 5000ms during retirement",
    });
    expect(monitorRetirement.closeTaskAdmission).toHaveBeenCalledTimes(1);
    expect(monitorRetirement.detachListeners).toHaveBeenCalledTimes(1);
    expect(monitorRetirement.waitForTasks).toHaveBeenCalledTimes(1);

    start.resolve();
    await vi.waitFor(() => {
      expect(client.stopWithoutPersist).toHaveBeenCalledTimes(1);
    });
    monitorTasks.resolve();
    await vi.waitFor(() => {
      expect(monitorRetirement.cleanup).toHaveBeenCalledTimes(1);
    });

    await expect(acquireSharedMatrixClient({ auth, startClient: false })).rejects.toBe(
      discardFailure,
    );
    expect(createMatrixClientMock).toHaveBeenCalledTimes(1);
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
