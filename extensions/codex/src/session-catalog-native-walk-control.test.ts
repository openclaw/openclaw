import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { afterEach, beforeEach, expect, it, onTestFailed, vi } from "vitest";
import * as commandRpc from "./command-rpc.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import * as catalogIndex from "./session-catalog-index.js";

vi.mock("./command-rpc.js");

const fixture = vi.hoisted(() => ({
  warn: vi.fn(),
  homeKey: vi.fn(),
  clear: vi.fn(),
  sharedClients: new Set<object>(),
  acquire: vi.fn(),
  request: vi.fn(),
  legacy: vi.fn(),
  indices: [] as Array<{ initialize(): Promise<void>; rows: unknown[] }>,
  created: () => {},
  writes: Promise.resolve(),
  count: 9,
  homeCalls: [] as string[],
  indexHomes: [] as string[],
}));
vi.mock("openclaw/plugin-sdk/agent-harness-registration", () => ({
  embeddedAgentLog: {
    warn: (message: string, detail: { error: { message?: string; stack?: string } }) =>
      fixture.warn(message, { message: detail.error?.message, stack: detail.error?.stack }),
  },
}));
vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  sanitizeTerminalText: (text: string) => text,
}));
vi.mock("./session-catalog-homes.js", () => ({
  createCodexCatalogHomeResolver: () => ({
    forAgent: async (id: string) => {
      fixture.homeCalls.push(id);
      return [source(id)];
    },
  }),
}));
vi.mock("./session-catalog-events.js", () => ({
  codexCatalogResidentHomeKey: (value: unknown) => fixture.homeKey(value),
}));
vi.mock("./session-catalog-projection.js", () => ({
  canReuseCodexCatalogPreview: () => false,
  projectCodexCatalogPage: (response: { data: unknown[]; nextCursor?: string }) => ({
    rows: response.data,
    nextCursor: response.nextCursor,
  }),
  projectCodexCatalogDeltaPage: (response: { data: unknown[]; nextCursor?: string }) => ({
    rows: response.data,
    nextCursor: response.nextCursor,
  }),
}));
vi.mock("./app-server/shared-client.js", () => ({
  createIsolatedCodexAppServerClient: (options: unknown) => fixture.acquire(options),
  clearSharedCodexAppServerClientAndWait: () => fixture.clear(),
  getLeasedSharedCodexAppServerClient: (options: unknown) => fixture.acquire(options),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));
vi.mock("./app-server/shared-client-lifecycle.js", () => ({
  hasActiveSharedCodexAppServerWork: () => false,
  getSharedCodexAppServerClientState: () => ({
    liveClients: fixture.sharedClients,
    startup: { pending: new Set() },
  }),
}));
vi.mock("./app-server/client.js", () => ({
  resolveCodexAppServerClientInstanceId: () => "foreground-client",
}));
vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerClientJson: (options: unknown) => fixture.request(options),
}));
class CatalogIndexFixture {
  private pending?: Promise<void>;
  readonly rows: unknown[] = [];
  constructor(
    private options: {
      homeId: string;
      runNativeWalk<T>(run: () => Promise<T>): Promise<T>;
      readNative(
        query: { cursor?: string },
        remaining: number,
      ): Promise<{ rows: unknown[]; nextCursor?: string }>;
    },
  ) {
    fixture.indices.push(this);
    fixture.indexHomes.push(this.options.homeId);
    fixture.created();
  }
  initialize() {
    return (this.pending ??= this.options.runNativeWalk(async () => {
      let cursor: string | undefined;
      do {
        const page = await this.options.readNative({ cursor }, 64);
        this.rows.push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor);
    }));
  }
  get() {
    return undefined;
  }
  hasActiveWork() {
    return false;
  }
  retire() {
    return fixture.writes;
  }
  async close() {
    await Promise.allSettled([this.pending, fixture.writes]);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function source(id: string, transport = "stdio") {
  return {
    assertCurrent() {},
    sourceHomeId: id,
    agentDir: `/synthetic/${id}`,
    usesProcessHomeFallback: false,
    localSessionsRoot: `/synthetic/${id}/sessions`,
    appServer: runtime(id, transport),
  };
}
function runtime(id = "default", transport = "stdio") {
  return {
    requestTimeoutMs: 60_000,
    connectionClass: transport === "stdio" ? "local" : "remote",
    start: {
      transport,
      commandSource: "managed",
      command: "codex",
      args: [],
      env: {},
      headers: {},
      codexHome: `/synthetic/${id}/codex`,
    },
  };
}
const factories = new Set<ReturnType<typeof createCodexSessionCatalogControl>>();
let live: number, peak: number;
const pool = new Map<string, ReturnType<typeof makeClient>>();
function makeClient(home: string) {
  live++;
  peak = Math.max(peak, live);
  let closed = false;
  return {
    request: vi.fn(async (_method: string, query: { cursor?: string }) => ({
      data: [{ id: home + (query.cursor ? ":second" : ":first") }],
      ...(!query.cursor ? { nextCursor: "second" } : {}),
    })),
    closeAndWait: vi.fn(async () => {
      if (!closed) {
        closed = true;
        live--;
      }
      return { exited: true, cleanup: "closed" } as const;
    }),
  };
}
const factory = () => {
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        Array.from({ length: fixture.count }, (_, n) => [
          `agent-${n}`,
          { agentDir: `/synthetic/agent-${n}`, workspace: `/synthetic/workspace-${n}` },
        ]),
      ),
    },
  };
  const value = createCodexSessionCatalogControl({
    config,
    getRuntimeConfig: () => config,
    getPluginConfig: () => ({}),
    resolveRuntimeOptions: (() => runtime()) as never,
  });
  expect(listAgentIds(config)).toEqual(
    Array.from({ length: fixture.count }, (_, n) => `agent-${n}`),
  );
  factories.add(value);
  return value;
};
let allCreated: ReturnType<typeof deferred>;
beforeEach(() => {
  vi.mocked(commandRpc.codexControlRequest).mockImplementation(fixture.legacy);
  vi.spyOn(catalogIndex, "CodexCatalogIndex").mockImplementation(
    CatalogIndexFixture as unknown as typeof catalogIndex.CodexCatalogIndex,
  );
  fixture.warn.mockReset();
  fixture.homeKey.mockReset().mockImplementation(async (value) => value.sourceHomeId);
  fixture.clear.mockReset().mockResolvedValue(undefined);
  fixture.sharedClients.clear();
  live = peak = 0;
  pool.clear();
  fixture.indices = [];
  fixture.count = 9;
  fixture.homeCalls = [];
  fixture.indexHomes = [];
  fixture.writes = Promise.resolve();
  allCreated = deferred();
  fixture.created = () => {
    if (fixture.indices.length === fixture.count) {
      allCreated.resolve();
    }
  };
  fixture.acquire.mockReset().mockImplementation(async (options) => {
    const client = makeClient(options.startOptions.codexHome);
    options.onStartingClient?.(Promise.resolve(client));
    return client;
  });
  fixture.request.mockReset().mockImplementation(async (options) => {
    options.assertCurrent?.();
    return await options.client.request(options.method, options.requestParams);
  });
  fixture.legacy.mockReset().mockImplementation(async (_plugin, method, query, options) => {
    const home = options.startOptions.codexHome;
    let client = pool.get(home);
    if (!client) {
      client = makeClient(home);
      pool.set(home, client);
    }
    return await client.request(method, query);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled([...factories].map((value) => value.stop()));
  factories.clear();
});

it("real factory startup hydrates all nine homes without retaining idle native clients", async () => {
  const service = factory();
  onTestFailed(() => {
    console.info(
      JSON.stringify({
        homeCalls: fixture.homeCalls,
        indexHomes: fixture.indexHomes,
        indexCount: fixture.indices.length,
        expected: fixture.count,
        peak,
        live,
        warnings: fixture.warn.mock.calls.map((args) =>
          args.map((value) =>
            value instanceof Error ? { message: value.message, stack: value.stack } : value,
          ),
        ),
      }),
    );
  });
  await service.start();
  expect(fixture.homeCalls).toEqual(Array.from({ length: fixture.count }, (_, n) => `agent-${n}`));
  await allCreated.promise;
  await Promise.all(fixture.indices.map((index) => index.initialize()));
  expect(fixture.warn).not.toHaveBeenCalled();
  expect({ peak, live }).toEqual({ peak: 1, live: 0 });
  expect(fixture.indices.map((index) => index.rows.length)).toEqual(Array(9).fill(2));
  expect(fixture.acquire).toHaveBeenCalledTimes(9);
  expect(fixture.request).toHaveBeenCalledTimes(18);
  for (const [options] of fixture.acquire.mock.calls) {
    expect(options.authProfileId).toBe(null);
  }
  for (const [options] of fixture.request.mock.calls) {
    expect(options).toMatchObject({ catalogPreview: true, catalogRows: 64 });
  }
});

it("subtracts startup time from the first page RPC budget", async () => {
  vi.useFakeTimers();
  fixture.count = 1;
  const entered = deferred();
  const acquired = deferred<ReturnType<typeof makeClient>>();
  fixture.acquire.mockImplementationOnce(async (options) => {
    options.onStartingClient(acquired.promise);
    entered.resolve();
    return await acquired.promise;
  });
  const service = factory();
  await service.start();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(59_000);
  acquired.resolve(makeClient("budget"));
  await allCreated.promise;
  await Promise.all(fixture.indices.map((index) => index.initialize()));
  expect(fixture.request.mock.calls[0]![0].timeoutMs).toBeGreaterThan(0);
  expect(fixture.request.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(1_000);
});

it("keeps stop pending for index writes even when native close cannot prove exit", async () => {
  fixture.count = 1;
  const writes = deferred();
  fixture.writes = writes.promise;
  fixture.acquire.mockResolvedValue({
    ...makeClient("uncertain"),
    closeAndWait: vi.fn(async () => ({ exited: false, cleanup: "uncertain" })),
  });
  const service = factory();
  await service.start();
  await allCreated.promise;
  await Promise.allSettled(fixture.indices.map((index) => index.initialize()));
  let settled = false;
  const stopped = service.stop().finally(() => {
    settled = true;
  });
  const rejected = expect(stopped).rejects.toThrow("cleanup is uncertain");
  await Promise.resolve();
  expect(settled).toBe(false);
  writes.resolve();
  await rejected;
});

it("keeps a foreground pinned shared client alive while background clients drain", async () => {
  fixture.count = 1;
  const foreground = makeClient("foreground");
  const defaultAcquire = fixture.acquire.getMockImplementation()!;
  fixture.acquire.mockImplementation((options) =>
    options.onStartingClient ? defaultAcquire(options) : Promise.resolve(foreground),
  );
  const service = factory();
  await service.start();
  await allCreated.promise;
  await service
    .forRequest("agent-0", source("agent-0") as never)
    .withPinnedConnection(async (control) => {
      await control.listDescendantPage({});
    });
  await Promise.all(fixture.indices.map((index) => index.initialize()));
  expect(foreground.closeAndWait).not.toHaveBeenCalled();
  expect(live).toBe(1);
});

it("retains remote catalog hydration through its existing shared request path", async () => {
  fixture.count = 1;
  const service = factory();
  await service.forRequest("agent-0", source("agent-0", "websocket") as never).initialize();
  expect(fixture.acquire).not.toHaveBeenCalled();
  expect(fixture.legacy).toHaveBeenCalledTimes(2);
  expect(live).toBe(1);
});

it("disconnect drains resident requests and shared clients before reporting uncertain native cleanup", async () => {
  fixture.count = 1;
  fixture.sharedClients.add({});
  fixture.acquire.mockResolvedValue({
    ...makeClient("uncertain"),
    closeAndWait: vi.fn(async () => ({ exited: false, cleanup: "uncertain" })),
  });
  const service = factory();
  await service.start();
  await allCreated.promise;
  await Promise.allSettled(fixture.indices.map((index) => index.initialize()));
  const home = deferred<string>();
  const resolving = deferred();
  fixture.homeKey.mockImplementationOnce(() => {
    resolving.resolve();
    return home.promise;
  });
  const resident = Promise.allSettled([service.forRequest(undefined).initialize()]);
  await resolving.promise;
  const clearing = deferred();
  const sharedClosed = deferred();
  fixture.clear.mockImplementationOnce(async () => {
    clearing.resolve();
    await sharedClosed.promise;
  });
  let settled = false;
  const disconnected = service.disconnect().finally(() => {
    settled = true;
  });
  const rejected = expect(disconnected).rejects.toThrow("cleanup is uncertain");
  await Promise.resolve();
  expect(fixture.clear).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  home.resolve("retired-home");
  await resident;
  await clearing.promise;
  expect(fixture.clear).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  sharedClosed.resolve();
  await rejected;
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.indices).toHaveLength(1);
});
