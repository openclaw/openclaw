import { resolve } from "node:path";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCreateOptions, PoolKey } from "./runtime.js";
import { createCopilotClientPool } from "./runtime.js";

type FakeClient = ReturnType<typeof makeClient>;

interface FakeFactoryOptions {
  readonly stop?: (client: FakeClient) => Promise<Error[]> | Error[];
}

function makeKey(overrides: Partial<PoolKey> = {}): PoolKey {
  return {
    agentId: "agent-1",
    copilotHome: "copilot-home",
    authMode: "useLoggedInUser",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ClientCreateOptions> = {}): ClientCreateOptions {
  return {
    copilotHome: "copilot-home",
    useLoggedInUser: true,
    ...overrides,
  };
}

function makeClient(id: number, stop = vi.fn(async (): Promise<Error[]> => [])) {
  return { id, stop };
}

function setup(idleTtlMs?: number, options: FakeFactoryOptions = {}) {
  const stops: number[] = [];
  const ctorCalls: CopilotClientOptions[] = [];
  let nextId = 0;

  const fake = async (clientOptions: CopilotClientOptions) => {
    ctorCalls.push(clientOptions);
    const id = ++nextId;
    const client: FakeClient = makeClient(
      id,
      vi.fn(async () => {
        stops.push(id);
        return options.stop ? options.stop(client) : [];
      }),
    );
    return client as unknown as CopilotClient;
  };

  const sdk = { fake, stops, ctorCalls };
  const pool = createCopilotClientPool({ idleTtlMs, sdkFactory: fake });
  const acquire = (key: Partial<PoolKey> = {}, clientOptions: Partial<ClientCreateOptions> = {}) =>
    pool.acquire(makeKey(key), makeOptions(clientOptions));
  return { sdk, pool, acquire };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCopilotClientPool", () => {
  it("keeps hardened empty-mode clients separate from normal clients", async () => {
    const { sdk, acquire } = setup();
    const normal = await acquire();
    const isolated = await acquire({}, { mode: "empty" });

    expect(normal.client).not.toBe(isolated.client);
    expect(normal.key.clientMode).toBeUndefined();
    expect(isolated.key.clientMode).toBe("empty");
    expect(sdk.ctorCalls.map((options) => options.mode)).toEqual([undefined, "empty"]);
  });

  it.each(["agentId", "authProfileVersion"] as const)(
    "different %s creates distinct clients",
    async (field) => {
      const { sdk, acquire } = setup();
      const key: Partial<PoolKey> =
        field === "agentId" ? {} : { authMode: "gitHubToken", authProfileId: "profile" };
      const options = field === "agentId" ? {} : { gitHubToken: "token-a", useLoggedInUser: false };
      const first = await acquire({ ...key, [field]: "v1" }, options);
      const second = await acquire({ ...key, [field]: "v2" }, options);
      expect(first.client).not.toBe(second.client);
      expect(sdk.ctorCalls.length).toBe(2);
    },
  );

  it("acquire during idle window cancels teardown and reuses", async () => {
    vi.useFakeTimers();
    const { sdk, pool, acquire } = setup(50);
    const first = await acquire();
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(25);

    const second = await acquire();

    expect(second.client).toBe(first.client);
    expect(sdk.ctorCalls.length).toBe(1);
    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    expect(sdk.stops).toEqual([]);

    await pool.release(second);
    await vi.advanceTimersByTimeAsync(50);
    expect(sdk.stops).toEqual([1]);
  });

  it("acquire during stopping awaits stop(), then creates fresh client", async () => {
    vi.useFakeTimers();
    const stopDeferred = createDeferred<Error[]>();
    const { sdk, pool, acquire } = setup(10, {
      stop: async () => stopDeferred.promise,
    });
    const first = await acquire();
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(10);

    let settled = false;
    const secondPromise = acquire().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(sdk.stops).toEqual([1]);

    stopDeferred.resolve([]);
    const second = await secondPromise;

    expect(settled).toBe(true);
    expect(second.client).not.toBe(first.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("concurrent acquire dedupes", async () => {
    vi.useFakeTimers();
    const clientDeferred = createDeferred<CopilotClient>();
    const sdkFactory = vi.fn(async () => clientDeferred.promise);
    const pool = createCopilotClientPool({ sdkFactory });
    const key = makeKey();
    const options = makeOptions();

    const firstPromise = pool.acquire(key, options);
    const secondPromise = pool.acquire(key, options);
    await Promise.resolve();

    expect(sdkFactory.mock.calls.length).toBe(1);

    const stop = vi.fn(async () => []);
    const client = makeClient(1, stop) as unknown as CopilotClient;
    clientDeferred.resolve(client);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.client).toBe(second.client);
    expect(sdkFactory.mock.calls.length).toBe(1);
    await pool.release(first);
    await vi.runAllTimersAsync();
    expect(stop).not.toHaveBeenCalled();

    await pool.release(second);
    await vi.runAllTimersAsync();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("synchronous constructor failure is not cached", async () => {
    let attempt = 0;
    const createClient = (clientOptions: CopilotClientOptions) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error(`constructor failed for ${String(clientOptions.baseDirectory)}`);
      }
      return makeClient(attempt) as unknown as CopilotClient;
    };
    const pool = createCopilotClientPool({ sdkFactory: createClient });

    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow("constructor failed for");
    expect(pool.size()).toBe(0);

    const second = await pool.acquire(makeKey(), makeOptions());

    expect(attempt).toBe(2);
    expect(second.key.agentId).toBe("agent-1");
  });

  it("double release is a no-op", async () => {
    vi.useFakeTimers();
    const { sdk, pool, acquire } = setup(100);
    const handle = await acquire();

    await pool.release(handle);
    await pool.release(handle);
    await vi.advanceTimersByTimeAsync(99);

    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.stops).toEqual([1]);
  });

  it("dispose stops all clients exactly once, aggregates errors, clears the map", async () => {
    const { sdk, pool, acquire } = setup(1000, {
      stop: (client) => [new Error(`stop-${client.id}-a`), new Error(`stop-${client.id}-b`)],
    });

    const first = await acquire({ agentId: "agent-a" }, { copilotHome: "home-a" });
    const second = await acquire({ agentId: "agent-b" }, { copilotHome: "home-b" });
    await acquire({ agentId: "agent-c" }, { copilotHome: "home-c" });
    await pool.release(second);

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual([
      "stop-1-a",
      "stop-1-b",
      "stop-2-a",
      "stop-2-b",
      "stop-3-a",
      "stop-3-b",
    ]);
    expect(sdk.stops).toEqual([1, 2, 3]);
    expect(pool.size()).toBe(0);

    const secondDispose = await pool.dispose();
    expect(secondDispose).toEqual([]);
    expect(sdk.stops).toEqual([1, 2, 3]);
    await pool.release(first);
  });

  it("dispose during in-flight acquire", async () => {
    const clientDeferred = createDeferred<CopilotClient>();
    const client = makeClient(1);
    const pool = createCopilotClientPool({ sdkFactory: async () => clientDeferred.promise });

    const acquirePromise = pool.acquire(makeKey(), makeOptions());
    const disposePromise = pool.dispose();
    clientDeferred.resolve(client as unknown as CopilotClient);

    await expect(acquirePromise).rejects.toThrow("[copilot-pool] pool disposed");
    expect(await disposePromise).toEqual([]);
    expect(client.stop).toHaveBeenCalledOnce();
    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow(
      "[copilot-pool] pool disposed",
    );
  });

  it("concurrent dispose waits for the in-flight shutdown and does not duplicate errors", async () => {
    const stopDeferred = createDeferred<Error[]>();
    const { sdk, pool, acquire } = setup(undefined, {
      stop: async () => stopDeferred.promise,
    });

    await acquire();

    const firstDisposePromise = pool.dispose();
    const secondDisposePromise = pool.dispose();
    await Promise.resolve();

    expect(sdk.stops).toEqual([1]);

    stopDeferred.resolve([new Error("stop failed")]);
    const firstErrors = await firstDisposePromise;
    const secondErrors = await secondDisposePromise;

    expect(firstErrors.map((error) => error.message)).toEqual(["stop failed"]);
    expect(secondErrors).toEqual([]);
  });

  it("normalizes non-Error stop failures during dispose", async () => {
    const { pool, acquire } = setup(undefined, {
      stop: () => {
        throw toLintErrorObject("stop-string", "Non-Error thrown");
      },
    });
    await acquire();

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual(["stop-string"]);
  });

  it("treats Windows copilotHome paths as case-insensitive when keying the pool", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    try {
      const { sdk, acquire } = setup();
      const firstHome = "C:/Users/Tester/CopilotHome/";
      const secondHome = "c:/users/tester/copilothome";

      const first = await acquire({ copilotHome: firstHome }, { copilotHome: firstHome });
      const second = await acquire({ copilotHome: secondHome }, { copilotHome: secondHome });

      const normalizedHome = resolve(firstHome).toLowerCase();
      expect(first.client).toBe(second.client);
      expect([first.key.copilotHome, second.key.copilotHome]).toEqual([
        normalizedHome,
        normalizedHome,
      ]);
      expect(String(sdk.ctorCalls[0]?.baseDirectory)).toBe(normalizedHome);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
