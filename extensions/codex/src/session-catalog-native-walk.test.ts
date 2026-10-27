import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexAppServerCloseResult } from "./app-server/transport.js";
import { CodexCatalogNativeWalks } from "./session-catalog-native-walk.js";

const native = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./app-server/shared-client.js", () => ({
  createIsolatedCodexAppServerClient: native.acquire,
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const closed = { exited: true, cleanup: "closed" } as const;
const options = { authProfileId: null, timeoutMs: 60_000 };
const owners = new Set<CodexCatalogNativeWalks>();
const owner = () => {
  const value = new CodexCatalogNativeWalks();
  owners.add(value);
  return value;
};
const fakeClient = (close: () => Promise<CodexAppServerCloseResult> = async () => closed) =>
  ({ closeAndWait: close }) as unknown as CodexAppServerClient;

beforeEach(() => {
  native.acquire.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled([...owners].map((value) => value.close()));
  owners.clear();
});

describe("native catalog walk custody", () => {
  it("serializes nine homes through physical close and retains one client across pages", async () => {
    const walks = owner();
    let live = 0;
    let peak = 0;
    native.acquire.mockImplementation(async (acquireOptions) => {
      live++;
      peak = Math.max(peak, live);
      const client = fakeClient(
        vi.fn(async () => {
          live--;
          return closed;
        }),
      );
      acquireOptions.onStartingClient(Promise.resolve(client));
      return client;
    });
    const visited: number[] = [];
    await Promise.all(
      Array.from({ length: 9 }, (_, home) =>
        walks.run(options, async (walk) => {
          expect(await walk.client(60_000)).toBe(await walk.client(60_000));
          visited.push(home);
        }),
      ),
    );
    expect({ peak, live, visited }).toEqual({
      peak: 1,
      live: 0,
      visited: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });
    expect(native.acquire).toHaveBeenCalledTimes(9);
    expect(native.acquire.mock.calls.every(([value]) => value.authProfileId === null)).toBe(true);
  });

  it("retirement cancels queued startup and waits active physical cleanup", async () => {
    const walks = owner();
    const entered = deferred();
    const cleanup = deferred<typeof closed>();
    native.acquire.mockResolvedValue(fakeClient(vi.fn(() => cleanup.promise)));
    const active = walks.run(options, async (walk) => {
      await walk.client(60_000);
      entered.resolve();
      await new Promise<never>((_, reject) => {
        walk.signal.addEventListener("abort", () => reject(walk.signal.reason), { once: true });
      });
    });
    const rejected = expect(active).rejects.toThrow("retired");
    await entered.promise;
    const queued = walks.run(options, async (walk) => {
      await walk.client(60_000);
    });
    const queuedRejected = expect(queued).rejects.toThrow("retired");
    let stopped = false;
    const closing = walks.close().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(native.acquire).toHaveBeenCalledTimes(1);
    cleanup.resolve(closed);
    await Promise.all([rejected, queuedRejected, closing]);
    expect(stopped).toBe(true);
    expect(native.acquire).toHaveBeenCalledTimes(1);
  });

  it("a page deadline retains admission until a late startup candidate physically closes", async () => {
    const walks = owner();
    const registration = deferred<CodexAppServerClient>();
    const cleanup = deferred<typeof closed>();
    const entered = deferred();
    const lateClient = fakeClient(vi.fn(() => cleanup.promise));
    native.acquire
      .mockImplementationOnce(async (acquireOptions) => {
        acquireOptions.onStartingClient(registration.promise);
        entered.resolve();
        throw new Error("page deadline");
      })
      .mockResolvedValue(fakeClient());
    const first = walks.run(options, async (walk) => await walk.client(60_000));
    const rejected = expect(first).rejects.toThrow("page deadline");
    await entered.promise;
    const next = walks.run(options, async (walk) => await walk.client(60_000));
    await Promise.resolve();
    expect(native.acquire).toHaveBeenCalledTimes(1);
    registration.resolve(lateClient);
    await Promise.resolve();
    expect(native.acquire).toHaveBeenCalledTimes(1);
    cleanup.resolve(closed);
    await Promise.all([rejected, next]);
    expect(lateClient.closeAndWait).toHaveBeenCalledTimes(1);
    expect(lateClient.closeAndWait).toHaveBeenCalledWith({ terminateOwnedProcess: true });
    expect(native.acquire).toHaveBeenCalledTimes(2);
  });

  it.each(["non-exit", "uncertain", "throw"] as const)(
    "refuses later native startup after %s cleanup",
    async (failure) => {
      const walks = owner();
      const close = vi.fn(async () => {
        if (failure === "throw") {
          throw new Error("cleanup failed");
        }
        return failure === "non-exit"
          ? { exited: false, cleanup: "uncertain" }
          : { exited: true, cleanup: "uncertain" };
      });
      native.acquire.mockResolvedValue(fakeClient(close));
      const first = walks.run(options, async (walk) => await walk.client(60_000));
      const next = walks.run(options, async (walk) => await walk.client(60_000));
      await expect(first).rejects.toThrow("cleanup is uncertain");
      await expect(next).rejects.toThrow("cleanup is uncertain");
      await expect(walks.close()).rejects.toThrow("cleanup is uncertain");
      expect(native.acquire).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ terminateOwnedProcess: true });
    },
  );

  it("a rejected native registration cannot certify cleanup for the next home", async () => {
    const walks = owner();
    native.acquire.mockImplementation(async (acquireOptions) => {
      const rejected = Promise.reject(new Error("registration failed"));
      void rejected.catch(() => {});
      acquireOptions.onStartingClient(rejected);
      return await rejected;
    });
    const first = walks.run(options, async (walk) => await walk.client(60_000));
    const next = walks.run(options, async (walk) => await walk.client(60_000));
    await expect(first).rejects.toThrow("registration cleanup is uncertain");
    await expect(next).rejects.toThrow("registration cleanup is uncertain");
    expect(native.acquire).toHaveBeenCalledTimes(1);
  });
});
