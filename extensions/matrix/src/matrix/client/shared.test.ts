import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixFullRuntime } from "../../../index.js";
import { getOptionalMatrixRuntime, setMatrixRuntime } from "../../runtime.js";
import { createMatrixMonitorTaskRunner } from "../monitor/task-runner.js";
import { acquireSharedMatrixClient, stopSharedClientForAccount } from "./shared.js";
import {
  authFor,
  createMockClient,
  prepareMockMatrixClientStorage,
} from "./shared.test-support.js";
import type { MatrixAuth } from "./types.js";

const resolveMatrixAuthMock = vi.hoisted(() => vi.fn());
const createMatrixClientMock = vi.hoisted(() => vi.fn());

// mock-isolation: These shared-client fixtures supply resolved auth without loading disk config.
vi.mock("./config.js", () => ({
  resolveMatrixAuth: resolveMatrixAuthMock,
}));

// mock-isolation: Keep disk and SDK initialization outside these generation lifecycle fixtures.
vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
  prepareMatrixClientStorage: prepareMockMatrixClientStorage,
}));

function acquireStoppedClient(auth: MatrixAuth, role?: "monitor" | "transient") {
  return acquireSharedMatrixClient({ auth, role });
}

function createTaskRunner() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { ...createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() }), logger };
}

function clients(callOrder: string[] = [], accountId = "main", replace = true) {
  const client = createMockClient("first", callOrder);
  const replacementClient = createMockClient("replacement");
  if (replace) {
    createMatrixClientMock.mockResolvedValueOnce(client).mockResolvedValueOnce(replacementClient);
  } else {
    createMatrixClientMock.mockResolvedValue(client);
  }
  return { auth: authFor(accountId), client, replacementClient };
}

type MockCall = { mock: { calls: unknown[][] } };
function expectCalls(count: number, ...mocks: MockCall[]) {
  for (const mock of mocks) {
    expect(mock.mock.calls).toHaveLength(count);
  }
}
const calledOnce = (mock: MockCall) => vi.waitFor(() => expectCalls(1, mock));
const monitorCleanup = ["close-admission", "detach-listeners", "wait-tasks", "monitor-cleanup"];

function expectShutdown(client: ReturnType<typeof createMockClient>, mode: "persist" | "discard") {
  expectCalls(1, mode === "persist" ? client.stopAndPersist : client.stopWithoutPersist);
  expectCalls(0, mode === "persist" ? client.stopWithoutPersist : client.stopAndPersist);
}

async function expectReplacement(
  acquisition: ReturnType<typeof acquireStoppedClient>,
  client: ReturnType<typeof createMockClient>,
  calls?: number,
) {
  const lease = await acquisition;
  expect(lease.client).toBe(client);
  if (calls !== undefined) {
    expect(createMatrixClientMock).toHaveBeenCalledTimes(calls);
  }
  await lease.release({ mode: "discard" });
}

function registerTasks(
  monitor: Awaited<ReturnType<typeof acquireStoppedClient>>,
  tasks: ReturnType<typeof createTaskRunner>,
  onClose = () => {},
  waitForTasks = tasks.waitForIdle,
) {
  monitor.registerMonitorRetirement({
    closeTaskAdmission: () => {
      tasks.close();
      onClose();
    },
    detachListeners: vi.fn(),
    waitForTasks,
    cleanup: vi.fn(),
  });
}

function createMonitorRetirement(callOrder: string[]) {
  return {
    closeTaskAdmission: vi.fn(() => callOrder.push("close-admission")),
    detachListeners: vi.fn(() => callOrder.push("detach-listeners")),
    waitForTasks: vi.fn<() => Promise<void>>(async () => {
      callOrder.push("wait-tasks");
    }),
    cleanup: vi.fn(async () => void callOrder.push("monitor-cleanup")),
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
  beforeEach(() => {
    resolveMatrixAuthMock.mockReset();
    createMatrixClientMock.mockReset();
  });

  afterEach(async () => {
    await stopSharedClientForAccount(authFor("main")).catch(() => undefined);
  });

  it("keeps colliding delimiter-shaped auth tuples isolated", async () => {
    const firstAuth = {
      ...authFor("main"),
      homeserver: "https://matrix.example.org/base|@alice",
      userId: "@bob:example.org",
    } satisfies MatrixAuth;
    const secondAuth = {
      ...firstAuth,
      homeserver: "https://matrix.example.org/base",
      // Historical Matrix user IDs may contain both characters in the localpart.
      userId: "@alice|@bob:example.org",
    } satisfies MatrixAuth;
    const { client, replacementClient } = clients();
    const first = await acquireStoppedClient(firstAuth);
    const second = await acquireStoppedClient(secondAuth);
    expect(first.client).toBe(client);
    expect(second.client).toBe(replacementClient);
    await first.release();
    expect(replacementClient.stopAndPersist).not.toHaveBeenCalled();
    await second.release();
  });

  it("converges concurrent creation and rejects incompatible policy before another SDK client", async () => {
    const auth = authFor("main");
    const client = createMockClient("main");
    const creation = createDeferred<typeof client>();
    createMatrixClientMock.mockReturnValueOnce(creation.promise);
    const first = acquireStoppedClient(auth, "monitor");
    const concurrent = acquireStoppedClient(auth);
    await calledOnce(createMatrixClientMock);
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
    const { auth, client: oldClient, replacementClient: nextClient } = clients();
    const stopFinished = createDeferred<void>();
    oldClient.stopWithoutPersist.mockReturnValue(stopFinished.promise);
    const monitor = await acquireStoppedClient(auth, "monitor");
    const retirement = monitor.release({ mode: "discard" });
    await calledOnce(oldClient.stopWithoutPersist);
    const caller = new AbortController();
    const cancelled = acquireSharedMatrixClient({
      auth: { ...auth, allowPrivateNetwork: true },
      abortSignal: caller.signal,
    });
    caller.abort();
    await expectMatrixStartupAbort(cancelled);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    const successor = acquireStoppedClient({ ...auth, allowPrivateNetwork: true });
    await expectPending(successor);
    stopFinished.resolve();
    await retirement;
    const replacement = await successor;
    expect(replacement.client).toBe(nextClient);
    await replacement.release();
  });

  it("shares one client generation across duplicate module identities", async () => {
    const fresh = (scope: string) =>
      importFreshModule<typeof import("./shared.js")>(
        import.meta.url,
        `./shared.js?scope=${scope}`,
      );
    const moduleA = await fresh("duplicate-a");
    const moduleB = await fresh("duplicate-b");
    const auth = authFor("main");
    const client = createMockClient("shared");
    createMatrixClientMock.mockResolvedValue(client);

    const first = await moduleA.acquireSharedMatrixClient({ auth });
    const second = await moduleB.acquireSharedMatrixClient({ auth });
    await first.start();
    await second.start();
    expectCalls(1, client.start);
    expect(first.client).toBe(second.client);
    expect(createMatrixClientMock).toHaveBeenCalledOnce();
    await Promise.all([first.release(), second.release()]);
    expect(client.stopAndPersist).toHaveBeenCalledOnce();
  });

  it.each([1, 2])(
    "retires only the final monitor and drains transient work (%s monitors)",
    async (count) => {
      const callOrder: string[] = [];
      const { auth, client } = clients(callOrder, "main", false);
      const first = await acquireStoppedClient(auth, "monitor");
      const final = count === 1 ? first : await acquireStoppedClient(auth, "monitor");
      for (const monitor of new Set([first, final])) {
        monitor.registerMonitorRetirement(createMonitorRetirement(callOrder));
      }
      const transient = await acquireStoppedClient(auth, "transient");
      transient.abortSignal.addEventListener(
        "abort",
        () => {
          callOrder.push("transient-cancel");
          void transient.release();
        },
        { once: true },
      );
      const prior = count === 2 ? monitorCleanup : [];
      if (count === 2) {
        const releasing = first.release({ mode: "persist" });
        expect(first.release({ mode: "discard" })).toBe(releasing);
        await releasing;
        expect(callOrder).toEqual(prior);
        expectCalls(0, client.quiesceSync, client.stopAndPersist, client.stopWithoutPersist);
      }
      await final.release({ mode: "persist" });
      expect(transient.abortSignal.aborted).toBe(true);
      expect(callOrder).toEqual([
        ...prior,
        "transient-cancel",
        "quiesce",
        "drain-quiesce",
        ...monitorCleanup,
        "persist",
      ]);
      expect(client.stopWithoutPersist).not.toHaveBeenCalled();
    },
  );

  it.each(["quiesceSync", "drainPendingDecryptions"] as const)(
    "poisons a failed %s generation until transient work and the final drain settle",
    async (method) => {
      const cause = new Error("shutdown failed");
      const { auth, client, replacementClient } = clients();
      client[method].mockRejectedValueOnce(cause);
      const draining = createDeferred<void>();
      const drained = createDeferred<void>();
      client.drainPendingDecryptions.mockImplementationOnce(() => {
        draining.resolve();
        return drained.promise;
      });
      const monitor = await acquireStoppedClient(auth, "monitor");
      const transient = await acquireStoppedClient(auth, "transient");
      const cleaned = createDeferred<void>();
      monitor.registerMonitorRetirement({
        ...createMonitorRetirement([]),
        cleanup: cleaned.resolve,
      });
      const release = expect(monitor.release({ mode: "persist" })).rejects.toBe(cause);
      await cleaned.promise;
      await expect(acquireStoppedClient(auth)).rejects.toBe(cause);
      await expect(transient.release()).rejects.toBe(cause);
      await draining.promise;
      expect(client.stopWithoutPersist).not.toHaveBeenCalled();
      drained.resolve();
      await release;
      expectShutdown(client, "discard");
      await expectReplacement(acquireStoppedClient(auth), replacementClient);
    },
  );

  it.each(["earlier stop requirement", "discard"] as const)(
    "keeps a generation unavailable until async shutdown settles: %s",
    async (mode) => {
      const stopping = createDeferred<void>();
      const { auth, client, replacementClient } = clients();
      const persist = mode === "earlier stop requirement";
      const stop = persist ? client.stopAndPersist : client.stopWithoutPersist;
      stop.mockReturnValue(stopping.promise);
      const lease = await acquireStoppedClient(auth);
      let final = lease;
      if (persist) {
        final = await acquireStoppedClient(auth);
        await lease.release({ mode: "stop" });
        expectCalls(0, client.stopAndPersist);
      }
      const release = final.release({ mode: "discard" });
      await calledOnce(stop);
      const replacement = acquireStoppedClient(auth);
      await expectPending(replacement);
      if (!persist) {
        expectCalls(0, client.stopAndPersist);
      }
      if (persist) {
        stopping.reject(new Error("best-effort persistence failed"));
      } else {
        stopping.resolve();
      }
      await release;
      if (persist) {
        expectCalls(1, client.stopWithoutPersist);
      }
      await expectReplacement(replacement, replacementClient, persist ? undefined : 2);
    },
  );

  it.each([false, true])("awaits strict persistence fallback (discard fails=%s)", async (fails) => {
    const persistFailure = new Error("crypto persist failed");
    const discardFailure = new Error("discard failed");
    const discard = createDeferred<void>();
    const { auth, client, replacementClient } = clients([], `strict-persist-${fails}`);
    client.stopAndPersist.mockRejectedValue(persistFailure);
    client.stopWithoutPersist.mockReturnValue(discard.promise);
    const lease = await acquireStoppedClient(auth);
    const failure = fails ? discardFailure : persistFailure;
    const releaseError = expect(lease.release({ mode: "persist" })).rejects.toBe(failure);
    await calledOnce(client.stopWithoutPersist);
    await expect(acquireStoppedClient(auth)).rejects.toBe(persistFailure);
    const forcedRetirement = stopSharedClientForAccount(auth);
    await expectPending(forcedRetirement);
    const forcedError = expect(forcedRetirement).rejects.toBe(failure);
    if (fails) {
      discard.reject(discardFailure);
    } else {
      discard.resolve();
    }
    await releaseError;
    await forcedError;
    if (fails) {
      await expect(acquireStoppedClient(auth)).rejects.toBe(discardFailure);
    } else {
      await expectReplacement(acquireStoppedClient(auth), replacementClient);
    }
  });

  it("joins an in-flight startup during forced retirement", async () => {
    const start = createDeferred<void>();
    const { auth, client: firstClient, replacementClient } = clients();
    let startupSignal: AbortSignal | undefined;
    firstClient.start.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal } = {}) => {
      startupSignal = abortSignal;
      return start.promise;
    });
    const owner = await acquireStoppedClient(auth);
    const waiter = await acquireStoppedClient(auth);
    const callerAbort = new AbortController();

    const ownerStart = owner.start(callerAbort.signal);
    await calledOnce(firstClient.start);
    const waiterStart = waiter.start();
    const ownerAbort = expectMatrixStartupAbort(ownerStart);
    const waiterAbort = expectMatrixStartupAbort(waiterStart);

    const retirement = stopSharedClientForAccount(auth);
    await Promise.all([ownerAbort, waiterAbort]);
    expect([
      callerAbort.signal.aborted,
      startupSignal?.aborted,
      owner.abortSignal.aborted,
      waiter.abortSignal.aborted,
    ]).toEqual([false, true, true, true]);
    expect(firstClient.stopAndPersist).not.toHaveBeenCalled();

    await expectPending(retirement);

    start.resolve();
    await retirement;
    expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
    await expectReplacement(acquireStoppedClient(auth), replacementClient);
  });

  it.each([
    { retirementOwner: "monitor release", operation: "release" },
    { retirementOwner: "account stop", operation: "release" },
    { retirementOwner: "monitor release", operation: "late acquisition" },
  ])(
    "drains monitor tasks during $retirementOwner with a transient $operation",
    async ({ retirementOwner, operation }) => {
      const { auth, client } = clients([], "main", false);
      const monitor = await acquireStoppedClient(auth, "monitor");
      const transient =
        operation === "release" ? await acquireStoppedClient(auth, "transient") : undefined;
      const tasks = createTaskRunner();
      const sendFinished = createDeferred<void>();
      const releaseTestDrain = createDeferred<void>();
      const taskAdmissionClosed = createDeferred<void>();
      const taskFinished = vi.fn();
      let lateLease: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
      const task = tasks.runDetachedTask("join introduction", async () => {
        await sendFinished.promise;
        if (transient) {
          await transient.release({ mode: "persist" });
        } else {
          await expect(
            acquireStoppedClient(auth).then((lease) => {
              lateLease = lease;
            }),
          ).rejects.toMatchObject({ name: "AbortError" });
        }
        taskFinished();
      });
      // Finally releases the escape so a failed assertion still joins every task.
      registerTasks(monitor, tasks, taskAdmissionClosed.resolve, () =>
        Promise.race([tasks.waitForIdle(), releaseTestDrain.promise]),
      );

      const retirement =
        retirementOwner === "account stop"
          ? stopSharedClientForAccount(auth)
          : monitor.release({ mode: "persist" });
      await taskAdmissionClosed.promise;
      const lateRelease =
        retirementOwner === "account stop" ? monitor.release({ mode: "persist" }) : undefined;
      if (lateRelease) {
        expect(monitor.release({ mode: "discard" })).toBe(lateRelease);
        await expectPending(lateRelease);
      }
      sendFinished.resolve();
      try {
        await calledOnce(taskFinished);
        await Promise.all([retirement, lateRelease]);
        expectShutdown(client, "persist");
        expect(tasks.logger.warn).not.toHaveBeenCalled();
      } finally {
        releaseTestDrain.resolve();
        await Promise.all([task, retirement]);
        await lateLease?.release();
      }
    },
  );

  it.each([
    ["continuation", true],
    ["authentication", false],
    ["client creation", false],
    ["authentication", true],
    ["client creation", true],
  ] as const)(
    "settles retained acquisition during %s after task settlement (retirement=%s)",
    async (phase, retire) => {
      const auth = authFor("main");
      const client = createMockClient("main");
      const replacementClient = createMockClient("main-replacement");
      createMatrixClientMock.mockResolvedValueOnce(client);
      const monitor = await acquireStoppedClient(auth, "monitor");
      const tasks = createTaskRunner();
      const resume = createDeferred<void>();
      const entered = vi.fn();
      const pause = <T>(value: T) => {
        entered();
        return resume.promise.then(() => value);
      };
      const created = phase === "client creation";
      if (created) {
        resolveMatrixAuthMock.mockResolvedValue({
          ...auth,
          accessToken: `${auth.accessToken}-rotated`,
        });
        createMatrixClientMock.mockImplementationOnce(() => pause(replacementClient));
      } else {
        resolveMatrixAuthMock.mockImplementation(() => pause(auth));
      }
      let retained: ReturnType<typeof acquireSharedMatrixClient> | undefined;
      const task = tasks.runTask(async () => {
        retained =
          phase === "continuation"
            ? resume.promise.then(() => acquireStoppedClient(auth))
            : acquireSharedMatrixClient({ cfg: {}, accountId: "main" });
        if (phase !== "continuation") {
          await calledOnce(entered);
        }
      });
      registerTasks(monitor, tasks);
      try {
        await task;
        if (!retained) {
          throw new Error("Expected retained acquisition to start before owner settlement");
        }
        if (retire) {
          await stopSharedClientForAccount(auth);
        }
        const aborted = retire && expect(retained).rejects.toMatchObject({ name: "AbortError" });
        resume.resolve();
        if (aborted) {
          await aborted;
          expectCalls(1, client.stopAndPersist);
          expectCalls(0, replacementClient.start);
          expectCalls(created ? 1 : 0, replacementClient.stopWithoutPersist);
          if (phase === "continuation") {
            expectCalls(1, createMatrixClientMock);
          }
        } else {
          const lease = await retained;
          expect(lease.client).toBe(phase === "authentication" ? client : replacementClient);
          await lease.release();
        }
      } finally {
        resume.resolve();
        await task;
        await retained?.catch(() => undefined);
        await monitor.release();
      }
    },
  );
});

describe("shared Matrix client runtime ownership", () => {
  type SharedLease = Awaited<ReturnType<typeof acquireSharedMatrixClient>>;
  type Auth = NonNullable<Parameters<typeof acquireSharedMatrixClient>[0]>["auth"];
  type Disposer = () => void | Promise<void>;

  const { clearRuntime: clearMatrixRuntime } = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "matrix",
    errorMessage: "Matrix runtime not initialized",
  });

  const owners: Array<() => Promise<void>> = [];
  const acquisitions: Promise<SharedLease>[] = [];
  const releaseBlockedIo: Array<() => void> = [];
  let previousRuntime: PluginRuntime | null;

  function ownerPair(onNextClientCreated = () => {}) {
    const firstOwner = registerOwner();
    const nextOwner = registerOwner();
    const firstClient = createMockClient("first");
    const nextClient = createMockClient("next");
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockImplementationOnce(async () => {
      onNextClientCreated();
      return nextClient;
    });
    return { firstOwner, nextOwner, firstClient, nextClient };
  }

  function registerOwner(onDisposeRegistered?: () => void) {
    const controller = new AbortController();
    const disposers = new Set<Disposer>();
    const api = createTestPluginApi({ id: "matrix", name: "Matrix" });
    api.lifecycle = {
      ...api.lifecycle,
      signal: controller.signal,
      onDispose: (dispose) => {
        controller.signal.throwIfAborted();
        disposers.add(dispose);
        onDisposeRegistered?.();
        return () => void disposers.delete(dispose);
      },
    };
    registerMatrixFullRuntime(api);
    let disposal: Promise<void> | undefined;
    const owner = {
      runtime: api.runtime,
      acquire(auth: Auth, abortSignal?: AbortSignal) {
        setMatrixRuntime(api.runtime);
        const pending = acquireSharedMatrixClient({ auth, abortSignal });
        acquisitions.push(pending);
        void pending.catch(() => undefined);
        return pending;
      },
      snapshotDisposers: () => [...disposers],
      dispose: () => {
        disposal ??= (async () => {
          controller.abort();
          for (const dispose of [...disposers].toReversed()) {
            await dispose();
          }
        })();
        return disposal;
      },
    };
    owners.push(owner.dispose);
    return owner;
  }

  beforeEach(() => {
    previousRuntime = getOptionalMatrixRuntime();
    createMatrixClientMock.mockReset();
  });

  afterEach(async () => {
    for (const release of releaseBlockedIo.splice(0)) {
      release();
    }
    const disposals = owners.splice(0).map((dispose) => dispose());
    await Promise.allSettled(acquisitions.splice(0));
    await Promise.allSettled(disposals);
    if (previousRuntime) {
      setMatrixRuntime(previousRuntime);
    } else {
      clearMatrixRuntime();
    }
  });

  it("retires the disposed owner's shared client while another runtime stays live", async () => {
    const { firstOwner, nextOwner: otherOwner, firstClient, nextClient: otherClient } = ownerPair();
    const auth = authFor("lifecycle-first");
    const first = await firstOwner.acquire(auth);
    const shared = await firstOwner.acquire(auth);
    const other = await otherOwner.acquire(authFor("lifecycle-other"));

    expect(shared.client).toBe(first.client);
    await firstOwner.dispose();

    expect([first.abortSignal.aborted, shared.abortSignal.aborted]).toEqual([true, true]);
    expectShutdown(firstClient, "persist");
    expect(other.abortSignal.aborted).toBe(false);
    expect(otherClient.quiesceSync).not.toHaveBeenCalled();
    await expect(first.start()).rejects.toThrow("released");
    await other.start();
    expect(otherClient.start).toHaveBeenCalledOnce();
  });

  it("waits for the previous owner's physical shutdown before reusing the same auth", async () => {
    let physicallyStopped = false;
    const { firstOwner, nextOwner, firstClient, nextClient } = ownerPair(() => {
      expect(physicallyStopped).toBe(true);
    });
    const finishStop = createDeferred<void>();
    releaseBlockedIo.push(() => finishStop.resolve());
    firstClient.stopAndPersist.mockImplementation(async () => {
      await finishStop.promise;
      physicallyStopped = true;
    });
    const auth = authFor("lifecycle-transfer");
    await firstOwner.acquire(auth);
    const next = nextOwner.acquire(auth);
    await setImmediate();
    await expectPending(next);
    const retirement = firstOwner.dispose();
    await calledOnce(firstClient.stopAndPersist);
    await expectPending(next);

    finishStop.resolve();
    await retirement;
    const replacement = await next;
    expect(replacement.client).toBe(nextClient);
    expect(replacement.abortSignal.aborted).toBe(false);
  });

  it("keeps a successor alive when the previous owner's captured cleanup runs late", async () => {
    const { firstOwner, nextOwner, firstClient, nextClient } = ownerPair();
    const auth = authFor("lifecycle-late-cleanup");
    const first = await firstOwner.acquire(auth);
    const capturedDisposers = firstOwner.snapshotDisposers();
    await first.release({ mode: "persist" });
    expect(firstOwner.snapshotDisposers()).toEqual([]);
    const replacement = await nextOwner.acquire(auth);

    await firstOwner.dispose();
    for (const dispose of capturedDisposers) {
      await dispose();
    }
    setMatrixRuntime(firstOwner.runtime);
    await stopSharedClientForAccount(auth);

    expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
    expect(nextClient.quiesceSync).not.toHaveBeenCalled();
    expect(replacement.abortSignal.aborted).toBe(false);
    const sharedReplacement = await nextOwner.acquire(auth);
    expect(sharedReplacement.client).toBe(nextClient);
  });

  it("wakes an existing successor waiter when creation is cancelled before its first lease", async () => {
    const nextOwner = registerOwner();
    const caller = new AbortController();
    const auth = authFor("lifecycle-cancelled-creation");
    let next: Promise<SharedLease> | undefined;
    const firstOwner = registerOwner(() => {
      // Registration exposes the created client before its first lease is admitted.
      // Let the successor wait for that custody before cancelling the first caller.
      next = nextOwner.acquire(auth);
      queueMicrotask(() => caller.abort());
    });
    const firstClient = createMockClient("unclaimed");
    const nextClient = createMockClient("next");
    createMatrixClientMock.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(nextClient);

    await expect(firstOwner.acquire(auth, caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(firstClient.start).not.toHaveBeenCalled();
    expect(firstClient.stopWithoutPersist).toHaveBeenCalledOnce();
    if (!next) {
      throw new Error("Expected successor acquisition during client lifecycle registration");
    }
    const replacement = await next;
    expect(replacement.client).toBe(nextClient);
  });
});
