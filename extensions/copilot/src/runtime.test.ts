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
    agentId: overrides.agentId ?? "agent-1",
    copilotHome: overrides.copilotHome ?? "copilot-home",
    authMode: overrides.authMode ?? "useLoggedInUser",
    authProfileId: overrides.authProfileId,
    authProfileVersion: overrides.authProfileVersion,
  };
}

function makeOptions(overrides: Partial<ClientCreateOptions> = {}): ClientCreateOptions {
  return {
    copilotHome: overrides.copilotHome ?? "copilot-home",
    useLoggedInUser: overrides.useLoggedInUser ?? true,
    gitHubToken: overrides.gitHubToken,
  };
}

function makeClient(
  id: number,
  copilotHome: string,
  stop = vi.fn(async (): Promise<Error[]> => []),
) {
  return {
    id,
    copilotHome,
    stop,
    start: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({})),
    disconnect: vi.fn(),
  };
}

function makeFake(options: FakeFactoryOptions = {}) {
  const stops: number[] = [];
  const ctorCalls: CopilotClientOptions[] = [];
  let nextId = 0;

  const fake = async (clientOptions: CopilotClientOptions) => {
    ctorCalls.push(clientOptions);
    const id = ++nextId;
    const client: FakeClient = makeClient(
      id,
      clientOptions.baseDirectory ?? "",
      vi.fn(async () => {
        stops.push(id);
        return options.stop ? options.stop(client) : [];
      }),
    );
    return client as unknown as CopilotClient;
  };

  return { fake, stops, ctorCalls };
}

function setup(idleTtlMs?: number, options: FakeFactoryOptions = {}) {
  const sdk = makeFake(options);
  return { sdk, pool: createCopilotClientPool({ idleTtlMs, sdkFactory: sdk.fake }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCopilotClientPool", () => {
  it("keeps hardened empty-mode clients separate from normal clients", async () => {
    const { sdk, pool } = setup(undefined);
    const key = makeKey();

    const normal = await pool.acquire(key, makeOptions());
    const isolated = await pool.acquire(key, { ...makeOptions(), mode: "empty" });

    expect(normal.client).not.toBe(isolated.client);
    expect(normal.key.clientMode).toBeUndefined();
    expect(isolated.key.clientMode).toBe("empty");
    expect(sdk.ctorCalls.map((options) => options.mode)).toEqual([undefined, "empty"]);
  });

  it("different agentId same copilotHome creates distinct clients", async () => {
    const { sdk, pool } = setup(undefined);
    const options = makeOptions();

    const first = await pool.acquire(makeKey({ agentId: "agent-a" }), options);
    const second = await pool.acquire(makeKey({ agentId: "agent-b" }), options);

    expect(first.client).not.toBe(second.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("different authProfileVersion creates distinct clients", async () => {
    const { sdk, pool } = setup(undefined);
    const options = makeOptions({ gitHubToken: "token-a", useLoggedInUser: false });

    const first = await pool.acquire(
      makeKey({ authMode: "gitHubToken", authProfileId: "profile", authProfileVersion: "v1" }),
      options,
    );
    const second = await pool.acquire(
      makeKey({ authMode: "gitHubToken", authProfileId: "profile", authProfileVersion: "v2" }),
      options,
    );

    expect(first.client).not.toBe(second.client);
    expect(sdk.ctorCalls.length).toBe(2);
  });

  it("acquire during idle window cancels teardown and reuses", async () => {
    vi.useFakeTimers();
    const { sdk, pool } = setup(50);
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(25);

    const second = await pool.acquire(key, options);

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
    const { sdk, pool } = setup(10, {
      stop: async () => stopDeferred.promise,
    });
    const key = makeKey();
    const options = makeOptions();

    const first = await pool.acquire(key, options);
    await pool.release(first);
    await vi.advanceTimersByTimeAsync(10);

    let settled = false;
    const secondPromise = pool.acquire(key, options).then((value) => {
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
    const client = makeClient(1, "copilot-home", stop) as unknown as CopilotClient;
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
      return makeClient(attempt, clientOptions.baseDirectory ?? "") as unknown as CopilotClient;
    };
    const pool = createCopilotClientPool({
      sdkFactory: createClient,
    });

    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow("constructor failed for");
    expect(pool.size()).toBe(0);

    const second = await pool.acquire(makeKey(), makeOptions());

    expect(attempt).toBe(2);
    expect(second.key.agentId).toBe("agent-1");
  });

  it("double release is a no-op", async () => {
    vi.useFakeTimers();
    const { sdk, pool } = setup(100);
    const handle = await pool.acquire(makeKey(), makeOptions());

    await pool.release(handle);
    await pool.release(handle);
    await vi.advanceTimersByTimeAsync(99);

    expect(sdk.stops).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.stops).toEqual([1]);
  });

  it("dispose stops all clients exactly once, aggregates errors, clears the map", async () => {
    const { sdk, pool } = setup(1000, {
      stop: (client) => [new Error(`stop-${client.id}-a`), new Error(`stop-${client.id}-b`)],
    });

    const first = await pool.acquire(
      makeKey({ agentId: "agent-a", copilotHome: "home-a" }),
      makeOptions({ copilotHome: "home-a" }),
    );
    const second = await pool.acquire(
      makeKey({ agentId: "agent-b", copilotHome: "home-b" }),
      makeOptions({ copilotHome: "home-b" }),
    );
    await pool.acquire(
      makeKey({ agentId: "agent-c", copilotHome: "home-c" }),
      makeOptions({ copilotHome: "home-c" }),
    );
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
    const clientDeferred = createDeferred<void>();
    const stopped: number[] = [];
    const sdkFactory = async () => {
      const client = makeClient(
        1,
        "copilot-home",
        vi.fn(async () => {
          stopped.push(1);
          return [];
        }),
      ) as unknown as CopilotClient;
      await clientDeferred.promise;
      return client;
    };
    const pool = createCopilotClientPool({ sdkFactory });

    const acquirePromise = pool.acquire(makeKey(), makeOptions());
    const disposePromise = pool.dispose();
    clientDeferred.resolve();

    await expect(acquirePromise).rejects.toThrow("[copilot-pool] pool disposed");
    expect(await disposePromise).toEqual([]);
    expect(stopped).toEqual([1]);
    await expect(pool.acquire(makeKey(), makeOptions())).rejects.toThrow(
      "[copilot-pool] pool disposed",
    );
  });

  it("concurrent dispose waits for the in-flight shutdown and does not duplicate errors", async () => {
    const stopDeferred = createDeferred<Error[]>();
    const { sdk, pool } = setup(undefined, {
      stop: async () => stopDeferred.promise,
    });

    await pool.acquire(makeKey(), makeOptions());

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
    const sdk = makeFake({
      stop: () => {
        throw toLintErrorObject("stop-string", "Non-Error thrown");
      },
    });
    const pool = createCopilotClientPool({ sdkFactory: sdk.fake });

    await pool.acquire(makeKey(), makeOptions());

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual(["stop-string"]);
  });

  it("treats Windows copilotHome paths as case-insensitive when keying the pool", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    try {
      const { sdk, pool } = setup(undefined);
      const firstHome = "C:/Users/Tester/CopilotHome/";
      const secondHome = "c:/users/tester/copilothome";

      const first = await pool.acquire(
        makeKey({ copilotHome: firstHome }),
        makeOptions({ copilotHome: firstHome }),
      );
      const second = await pool.acquire(
        makeKey({ copilotHome: secondHome }),
        makeOptions({ copilotHome: secondHome }),
      );

      const normalizedHome = resolve(firstHome).toLowerCase();
      expect(first.client).toBe(second.client);
      expect(first.key.copilotHome).toBe(normalizedHome);
      expect(second.key.copilotHome).toBe(normalizedHome);
      expect(String(sdk.ctorCalls[0]?.baseDirectory)).toBe(normalizedHome);
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
