import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner } from "../monitor/task-runner.js";
import { authFor, createMockClient } from "./shared.test-support.js";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());
const TEST_CFG = {};

vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
}));
vi.mock("./create-client.js", () => ({ createMatrixClient: createMatrixClientMock }));

let acquireSharedMatrixClient: typeof import("./shared.js").acquireSharedMatrixClient;
let stopSharedClientForAccount: typeof import("./shared.js").stopSharedClientForAccount;
type Lease = Awaited<ReturnType<typeof acquireSharedMatrixClient>>;

function createTasks() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger, ...createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() }) };
}

async function createMonitor() {
  const client = createMockClient("main");
  createMatrixClientMock.mockResolvedValueOnce(client);
  const auth = authFor("main");
  const monitor = await acquireSharedMatrixClient({ auth, role: "monitor", startClient: false });
  return { client, auth, monitor, tasks: createTasks() };
}

function registerRetirement(
  monitor: Lease,
  tasks: ReturnType<typeof createTasks>,
  waitForTasks = tasks.waitForIdle,
) {
  const closed = createDeferred<void>();
  monitor.registerMonitorRetirement({
    closeTaskAdmission: () => {
      tasks.close();
      closed.resolve();
    },
    detachListeners: vi.fn(),
    waitForTasks,
    cleanup: vi.fn(),
  });
  return closed.promise;
}

async function createSuspendedAcquisition(phase: string) {
  const fixture = await createMonitor();
  const { auth, tasks } = fixture;
  const replacementClient = createMockClient("main-replacement");
  const replacementAuth = { ...auth, accessToken: `${auth.accessToken}-rotated` };
  const authReady = createDeferred<MatrixAuth>();
  const clientReady = createDeferred<typeof replacementClient>();
  const entered = createDeferred<void>();
  const allowSettlement = createDeferred<void>();
  resolveMatrixAuthMock.mockImplementation(() => {
    if (phase === "authentication") {
      entered.resolve();
      return authReady.promise;
    }
    return Promise.resolve(replacementAuth);
  });
  if (phase === "client creation") {
    createMatrixClientMock.mockImplementationOnce(() => {
      entered.resolve();
      return clientReady.promise;
    });
  }
  let acquisition: Promise<Lease> | undefined;
  const task = tasks.runDetachedTask("retained acquisition", async () => {
    acquisition = acquireSharedMatrixClient({
      cfg: TEST_CFG,
      accountId: "main",
      startClient: false,
    });
    await allowSettlement.promise;
  });
  await entered.promise;
  allowSettlement.resolve();
  await task;
  if (!acquisition) {
    throw new Error("Expected retained acquisition to start before owner settlement");
  }
  return {
    ...fixture,
    replacementClient,
    acquisition,
    resume: () => {
      authReady.resolve(auth);
      clientReady.resolve(replacementClient);
    },
  };
}

describe("shared Matrix monitor task ownership", () => {
  beforeAll(async () => {
    ({ acquireSharedMatrixClient, stopSharedClientForAccount } = await import("./shared.js"));
  });
  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    createMatrixClientMock.mockReset();
  });
  afterEach(async () => {
    await Promise.allSettled([
      stopSharedClientForAccount(authFor("main")),
      stopSharedClientForAccount(authFor("ops")),
    ]);
    vi.clearAllMocks();
  });

  it.each(["monitor release", "account stop"])(
    "drains monitor tasks during %s while transient leases release",
    async (retirementOwner) => {
      const { client, auth, monitor, tasks } = await createMonitor();
      const transient = await acquireSharedMatrixClient({
        auth,
        role: "transient",
        startClient: false,
      });
      const sendFinished = createDeferred<void>();
      const releaseTestDrain = createDeferred<void>();
      const taskFinished = vi.fn();
      const task = tasks.runDetachedTask("join introduction", async () => {
        await sendFinished.promise;
        await transient.release({ mode: "persist" });
        taskFinished();
      });
      // The escape lets a failed assertion still join every task.
      const closed = registerRetirement(monitor, tasks, () =>
        Promise.race([tasks.waitForIdle(), releaseTestDrain.promise]),
      );
      const retirement =
        retirementOwner === "account stop"
          ? stopSharedClientForAccount(auth)
          : monitor.release({ mode: "persist" });
      await closed;
      sendFinished.resolve();
      try {
        await vi.waitFor(() => expect(taskFinished).toHaveBeenCalledOnce());
        await retirement;
        expect(client.stopAndPersist).toHaveBeenCalledOnce();
        expect(client.stopWithoutPersist).not.toHaveBeenCalled();
        expect(tasks.logger.warn).not.toHaveBeenCalled();
      } finally {
        releaseTestDrain.resolve();
        await Promise.all([task, retirement]);
      }
    },
  );

  it("allows retained async acquisitions after the owning monitor task settles", async () => {
    const { client, auth, monitor, tasks } = await createMonitor();
    const resume = createDeferred<void>();
    let retained: Promise<Lease> | undefined;
    let retainedLease: Lease | undefined;
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

  it("allows a retained acquisition suspended during client creation to finish after owner settlement", async () => {
    const { acquisition, replacementClient, monitor, resume } =
      await createSuspendedAcquisition("client creation");
    resume();
    try {
      const lease = await acquisition;
      expect(lease.client).toBe(replacementClient);
      await lease.release();
    } finally {
      await acquisition.catch(() => undefined);
      await monitor.release();
    }
  });

  it("keeps shutdown cancellation when retirement starts after the task settles", async () => {
    const { client, auth, monitor, tasks } = await createMonitor();
    const resume = createDeferred<void>();
    let retained: Promise<Lease> | undefined;
    await tasks.runDetachedTask("retained continuation", async () => {
      retained = resume.promise.then(() => acquireSharedMatrixClient({ auth, startClient: false }));
    });
    const closed = registerRetirement(monitor, tasks);
    await stopSharedClientForAccount(auth);
    await closed;
    const rejected = expect(retained).rejects.toMatchObject({ name: "AbortError" });
    resume.resolve();
    await rejected;
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
  });

  it.each(["authentication", "client creation"])(
    "aborts a retained acquisition suspended during %s when retirement starts after settlement",
    async (phase) => {
      const { client, auth, monitor, tasks, replacementClient, acquisition, resume } =
        await createSuspendedAcquisition(phase);
      const closed = registerRetirement(monitor, tasks);
      await stopSharedClientForAccount(auth);
      await closed;
      const rejected = expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
      resume();
      await rejected;
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
    const entered = createDeferred<void>();
    resolveMatrixAuthMock.mockResolvedValue(auth);
    createMatrixClientMock.mockImplementation(() => {
      entered.resolve();
      return clientReady.promise;
    });
    const tasks = createTasks();
    const caller = new AbortController();
    let lease: Lease | undefined;
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
      await entered.promise;
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
