import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerMatrixFullRuntime } from "../../../index.js";
import { getOptionalMatrixRuntime, setMatrixRuntime } from "../../runtime.js";
import { acquireSharedMatrixClient, stopSharedClientForAccount } from "./shared.js";
import {
  authFor,
  createMockClient,
  prepareMockMatrixClientStorage,
} from "./shared.test-support.js";

const createMatrixClientMock = vi.hoisted(() => vi.fn());

// mock-isolation: Keep disk and SDK initialization outside these generation lifecycle fixtures.
vi.mock("./create-client.js", () => ({
  createMatrixClient: createMatrixClientMock,
  prepareMatrixClientStorage: prepareMockMatrixClientStorage,
}));

type SharedLease = Awaited<ReturnType<typeof acquireSharedMatrixClient>>;
type Auth = NonNullable<Parameters<typeof acquireSharedMatrixClient>[0]>["auth"];
type Disposer = () => void | Promise<void>;
type LifecycleOwner = {
  runtime: PluginRuntime;
  acquire: (auth: Auth, abortSignal?: AbortSignal) => Promise<SharedLease>;
  snapshotDisposers: () => Disposer[];
  dispose: () => Promise<void>;
};

const { clearRuntime: clearMatrixRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

const owners: LifecycleOwner[] = [];
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
function expectBlocked(settled: ReturnType<typeof vi.fn>) {
  expect(settled).not.toHaveBeenCalled();
  expect(createMatrixClientMock).toHaveBeenCalledOnce();
}

function registerOwner(onDisposeRegistered?: () => void): LifecycleOwner {
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
  owners.push(owner);
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
  const disposals = owners.splice(0).map((owner) => owner.dispose());
  const acquired = await Promise.allSettled(acquisitions.splice(0));
  await Promise.allSettled(
    acquired.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.release({ mode: "discard" })] : [],
    ),
  );
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
  expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
  await firstOwner.dispose();

  expect([first.abortSignal.aborted, shared.abortSignal.aborted]).toEqual([true, true]);
  expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
  expect(firstClient.stopWithoutPersist).not.toHaveBeenCalled();
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
  const settled = vi.fn();
  void next.then(settled, settled);
  await setImmediate();

  expectBlocked(settled);
  const retirement = firstOwner.dispose();
  await setImmediate();
  expect(firstClient.stopAndPersist).toHaveBeenCalledOnce();
  expectBlocked(settled);

  finishStop.resolve();
  await retirement;
  const replacement = await next;
  expect(replacement.client).toBe(nextClient);
  expect(replacement.abortSignal.aborted).toBe(false);
  expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
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
  expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
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
  expect(createMatrixClientMock).toHaveBeenCalledTimes(2);
});
