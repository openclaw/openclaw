import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCreateOptions, PoolKey } from "./runtime.js";
import { createCopilotClientPool } from "./runtime.js";

const artifactMock = vi.hoisted(() => ({ capture: vi.fn(), validate: vi.fn() }));
vi.mock("./runtime-artifact.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-artifact.js")>()),
  captureCopilotRuntimeArtifact: artifactMock.capture,
  validateCopilotRuntimeArtifact: artifactMock.validate,
}));
beforeEach(() => {
  artifactMock.capture.mockReset();
  artifactMock.validate.mockReset();
});

type FakeClient = ReturnType<typeof makeClient>;

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
  return { id, start: vi.fn(async () => undefined), stop };
}

function setup(idleTtlMs?: number, stop?: (client: FakeClient) => Promise<Error[]> | Error[]) {
  const stops: number[] = [];
  const ctorCalls: CopilotClientOptions[] = [];
  const instances: FakeClient[] = [];
  const fake = async (clientOptions: CopilotClientOptions) => {
    ctorCalls.push(clientOptions);
    const id = ctorCalls.length;
    const client: FakeClient = makeClient(
      id,
      vi.fn(async () => {
        stops.push(id);
        return stop ? stop(client) : [];
      }),
    );
    instances.push(client);
    return client as unknown as CopilotClient;
  };

  const sdk = { fake, stops, ctorCalls, instances };
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
  it("binds verified clients separately and rejects a changed implementation before creating a client", async () => {
    const { sdk, pool } = setup();
    const binding = { id: "copilot-runtime-fixture", fingerprint: "implementation-a" };
    const connection = { kind: "stdio", path: "/fixture/copilot-runtime" };
    artifactMock.capture.mockResolvedValue({ binding, connection });
    artifactMock.validate.mockResolvedValue(true);
    try {
      const normal = await pool.acquire(makeKey(), makeOptions());
      const verified = await pool.acquire(makeKey(), makeOptions(), {});
      const resumed = await pool.acquire(makeKey(), makeOptions(), { expected: binding });
      expect(verified.client).not.toBe(normal.client);
      expect(resumed.client).toBe(verified.client);
      expect(verified.runtimeArtifact).toEqual(binding);
      expect(sdk.ctorCalls[1]?.connection).toEqual(connection);
      expect(sdk.instances[1]?.start).toHaveBeenCalledOnce();
      artifactMock.capture.mockResolvedValue({
        binding: { ...binding, fingerprint: "implementation-b" },
        connection,
      });
      await expect(pool.acquire(makeKey(), makeOptions(), { expected: binding })).rejects.toThrow(
        "verified runtime changed",
      );
      expect(sdk.instances).toHaveLength(2);
      // Both verified handles share the same release identity and settle together.
      await pool.release(verified);
      await pool.release(resumed);
      await pool.release(normal);
    } finally {
      await pool.dispose();
    }
    expect(sdk.stops.toSorted((left, right) => left - right)).toEqual([1, 2]);
  });

  it("stops a client whose runtime changes during awaited startup", async () => {
    const startup = createDeferred<void>();
    const started = createDeferred<void>();
    const client = makeClient(1);
    client.start.mockImplementation(async () => {
      started.resolve();
      await startup.promise;
    });
    const pool = createCopilotClientPool({
      sdkFactory: async () => client as unknown as CopilotClient,
    });
    const binding = { id: "copilot-runtime-fixture", fingerprint: "implementation-a" };
    artifactMock.capture.mockResolvedValue({ binding, connection: { kind: "stdio" } });
    artifactMock.validate.mockResolvedValue(true);
    const acquire = pool.acquire(makeKey(), makeOptions(), {});
    const rejected = expect(acquire).rejects.toThrow("runtime changed while starting");
    await started.promise;
    artifactMock.validate.mockResolvedValue(false);
    startup.resolve();
    await rejected;
    expect(client.stop).toHaveBeenCalledOnce();
    expect(pool.size()).toBe(0);
    await pool.dispose();
  });

  it("normalizes Windows drive roots, case and trailing separators for the SDK and pool key", async () => {
    vi.resetModules();
    vi.doMock("node:path", async (importOriginal) => {
      const path = await importOriginal<typeof import("node:path")>();
      return { ...path, resolve: path.win32.resolve, sep: path.win32.sep };
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const { createCopilotClientPool: createWindowsPool } = await import("./runtime.js");
      const { sdk } = setup();
      const pool = createWindowsPool({ sdkFactory: sdk.fake });
      const handle = await pool.acquire(makeKey(), makeOptions({ copilotHome: "C:\\" }));
      expect(handle.key.copilotHome).toBe("c:\\");
      expect(sdk.ctorCalls[0]?.baseDirectory).toBe("c:\\");
      const first = await pool.acquire(
        makeKey(),
        makeOptions({ copilotHome: "C:/Users/Tester/CopilotHome/" }),
      );
      const second = await pool.acquire(
        makeKey(),
        makeOptions({ copilotHome: "c:/users/tester/copilothome" }),
      );
      expect(first.client).toBe(second.client);
      expect([first.key.copilotHome, second.key.copilotHome]).toEqual([
        "c:\\users\\tester\\copilothome",
        "c:\\users\\tester\\copilothome",
      ]);
      expect(sdk.ctorCalls[1]?.baseDirectory).toBe("c:\\users\\tester\\copilothome");
      await pool.dispose();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

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
    const { sdk, pool, acquire } = setup(10, async () => stopDeferred.promise);
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
    const { sdk, pool, acquire } = setup(1000, (client) =>
      ["a", "b"].map((suffix) => new Error(`stop-${client.id}-${suffix}`)),
    );

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
    const { sdk, pool, acquire } = setup(undefined, async () => stopDeferred.promise);

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
    const { pool, acquire } = setup(undefined, () => {
      throw toLintErrorObject("stop-string", "Non-Error thrown");
    });
    await acquire();

    const errors = await pool.dispose();

    expect(errors.map((error) => error.message)).toEqual(["stop-string"]);
  });
});
