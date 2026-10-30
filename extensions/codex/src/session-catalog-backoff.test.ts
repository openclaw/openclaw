import { setImmediate as nextTurn } from "node:timers/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import {
  getSharedCodexAppServerClientState,
  ownCodexStartup,
} from "./app-server/shared-client-lifecycle.js";
import { describeCodexSpawnError } from "./app-server/spawn-error.js";
import { createClientHarness as createHarness } from "./app-server/test-support.js";
import { observeCodexCatalogClient } from "./session-catalog-events.js";
import {
  catalogFactory,
  catalogProvider,
  remoteCatalogFactory,
} from "./session-catalog-resident.test-support.js";
import { commandRpcMocks, config, idleThread } from "./session-catalog.test-helpers.js";

const clients: ReturnType<typeof createHarness>["client"][] = [];
const rpc = commandRpcMocks.codexControlRequest;
const expectCalls = (count: number) => expect(rpc).toHaveBeenCalledTimes(count);
const fakeClock = () => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
const warnings = () => vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
const parallel = <T>(run: () => T) => Array.from({ length: 18 }, run);
type NativePage = { data: ReturnType<typeof idleThread>[]; nextCursor?: string | null };
function nativePage(data: NativePage["data"], offset: number, limit: number): NativePage {
  return {
    data: data.slice(offset, offset + limit),
    nextCursor: offset + limit < data.length ? String(offset + limit) : null,
  };
}
function createClientHarness(options?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(options);
  clients.push(harness.client);
  return harness;
}
function wirePages(read: (offset: number, limit: number) => NativePage) {
  const limits: number[] = [];
  const harness = createClientHarness({
    onWrite(line, send) {
      const { id, params } = JSON.parse(line);
      const response = { id, result: read(Number(params.cursor ?? 0), params.limit) };
      limits.push(params.limit);
      send(response);
    },
  });
  rpc.mockImplementation((_plugin, method, params, options) =>
    harness.client.request(method, params, options),
  );
  return limits;
}
async function advanceIdle(factory: ReturnType<typeof catalogFactory>, milliseconds = 30_000) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
}
function holdRpc() {
  const started = createDeferred<void>();
  const pending = createDeferred<unknown>();
  rpc.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  return { started, pending };
}
async function remoteControl(name: string) {
  const factory = remoteCatalogFactory(name);
  const source = (await factory.homesForAgent("main"))[0]!;
  return { factory, source, control: factory.forRequest("main", source) };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.closeAndWait()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shrinks oversized wire pages and retains the working limit for later refreshes", async () => {
  fakeClock();
  const native = Array.from({ length: 20 }, (_, i) =>
    idleThread({ id: `large-${i}`, source: "cli", preview: "x".repeat(600_000) }),
  );
  const limits = wirePages((offset, limit) => nativePage(native, offset, limit));
  const factory = catalogFactory();
  const control = factory.forRequest("main");
  await control.initialize();
  expect((await control.listPage({ limit: 64 })).sessions).toHaveLength(20);
  expect(limits).toEqual([16, 8, 8, 8]);
  limits.length = 0;
  native[19]!.name = "Refreshed";
  // Unrelated shared startup must not gate this catalog's refresh assertions.
  const unrelatedStartup = createDeferred<void>();
  const startup = ownCodexStartup(
    getSharedCodexAppServerClientState().startup,
    unrelatedStartup.promise,
  );
  try {
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await control.listPage({});
    await vi.waitFor(async () => {
      const { sessions } = await control.listPage({ limit: 64 });
      expect(sessions.find((session) => session.threadId === "large-19")?.name).toBe("Refreshed");
    });
    expect(limits).toEqual([8, 8, 8]);
    expect((await control.listPage({ limit: 64 })).sessions).toHaveLength(20);
  } finally {
    unrelatedStartup.resolve();
    await startup;
  }
});

it("defers an oversized single thread for 15 minutes without repeated background warnings", async () => {
  let now = 0;
  const native = idleThread({ source: "cli", name: null, preview: "x".repeat(8 * 1024 * 1024) });
  const limits = wirePages(() => ({ data: [native] }));
  const warn = warnings();
  const factory = catalogFactory({ now: () => now });
  const control = factory.forRequest("main");
  await expect(control.listPage({})).rejects.toThrow("exceeds 8 MiB");
  await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
  expect(limits).toEqual([16, 8, 4, 2, 1]);
  for (now = 5_000; now < 15 * 60_000; now += 5_000) {
    await expect(control.listPage({})).rejects.toThrow("exceeds 8 MiB");
    await nextTurn();
  }
  expect(limits).toHaveLength(5);
  expect(
    warn.mock.calls.filter(
      ([message]) => message === "Codex resident catalog background update failed",
    ),
  ).toHaveLength(1);
  native.preview = "Recovered";
  await control.initialize();
  expect(limits).toEqual([16, 8, 4, 2, 1, 1]);
  expect((await control.listPage({})).sessions[0]?.fallbackName).toBe("Recovered");
});

it("settles a successful prefix recovery probe before the next activity check", async () => {
  fakeClock();
  const native = Array.from({ length: 96 }, (_, i) =>
    idleThread({ id: `prefix-${i}`, source: "cli", recencyAt: 1_000 - i }),
  );
  rpc.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    return nativePage(native, Number(params.cursor ?? 0), 64);
  });
  const { factory, source, control } = await remoteControl("prefix-recovery");
  const harness = createClientHarness();
  await observeCodexCatalogClient(harness.client, {
    startOptions: source.appServer.start,
    agentDir: source.agentDir,
  });
  await control.initialize();
  expectCalls(2);
  const notify = async (name: string) => {
    native[0]!.name = name;
    harness.send({ method: "thread/started", params: { thread: native[0]! } });
    await vi.waitFor(async () => {
      expect((await control.listPage({})).sessions[0]?.name).toBe(name);
    });
  };
  await notify("First activity");
  rpc.mockRejectedValueOnce(new Error("temporary outage"));
  await advanceIdle(factory);
  expectCalls(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expectCalls(3);
  await notify("Recovery activity");
  await advanceIdle(factory);
  expectCalls(4);
  await notify("Later activity");
  await advanceIdle(factory);
  expectCalls(5);
  expect(
    rpc.mock.calls
      .slice(2)
      .every((call) => call[2].useStateDbOnly === true && call[2].cursor === undefined),
  ).toBe(true);
});

it.each([true, false])("backs off hydration, not memory (config %s)", async (hasConfig) => {
  let now = 0;
  let recovered = false;
  const failure = new Error("third native page failed");
  const control = catalogFactory({
    getRuntimeConfig: () => (hasConfig ? config : undefined),
    now: () => now,
  }).forRequest("main");
  const native = ["head", "second", "match"].map((id) =>
    idleThread({ id, source: "cli", name: id === "match" ? "Wanted" : "Other" }),
  );
  rpc.mockImplementation(async (_plugin, _method, params) => {
    const offset = Number(params.cursor ?? 0);
    if (offset === 2 && !recovered) {
      throw failure;
    }
    return nativePage(native, offset, 1);
  });
  const search = () => control.listPage({ limit: 1, searchTerm: "Wanted" });
  await expect(control.initialize()).rejects.toBe(failure);
  expectCalls(3);
  await expect(control.initialize()).rejects.toBe(failure);
  expectCalls(6);

  await expect(control.initialize()).rejects.toBe(failure);
  const partial = await search();
  expect(partial).toMatchObject({ sessions: [], nextCursor: expect.any(String) });
  await expect(
    control.listPage({ limit: 1, searchTerm: "Wanted", cursor: partial.nextCursor }),
  ).rejects.toBe(failure);
  expectCalls(6);

  now += 5_000;
  recovered = true;
  await control.initialize();
  expect((await search()).sessions[0]?.threadId).toBe("match");
  expect((await control.listPage({ limit: 10 })).sessions).toHaveLength(3);
  expectCalls(9);
});

it("keeps host backoff and recovery observable to concurrent catalog callers", async () => {
  let now = 0;
  const control = catalogFactory({ getRuntimeConfig: () => config, now: () => now });
  const home = (await control.homesForAgent("main"))[0]!;
  const request = control.forRequest("main", home);
  const provider = catalogProvider(control);
  const list = (search?: string) =>
    provider.list({ agentId: "main", hostIds: [home.hostId], limitPerHost: 1, search });
  const failure = new Error("native host timed out");
  const { started, pending } = holdRpc();
  const initialized = expect(request.initialize()).rejects.toBe(failure);
  await started.promise;
  now += 60_000;
  pending.reject(failure);
  await initialized;
  await expect(request.initialize()).rejects.toBe(failure);
  const duringBackoff = await Promise.all(parallel(() => list("other")));
  expect(duringBackoff).toMatchObject(
    parallel(() => [{ connected: false, sessions: [], error: { code: "APP_SERVER_UNAVAILABLE" } }]),
  );
  const blocked = await Promise.allSettled(parallel(() => request.initialize()));
  expect(blocked.every((result) => result.status === "rejected")).toBe(true);
  expectCalls(2);

  now += 5_000;
  rpc.mockResolvedValue({ data: [] });
  await Promise.all(parallel(() => request.initialize()));
  const recovered = await Promise.all(parallel(() => list()));
  expect(recovered.every(([host]) => host?.connected && !host.error && !host.sessions.length)).toBe(
    true,
  );
  expectCalls(3);
});

it.each([-32600, -32602])("does not back off invalid-request error %s", async (code) => {
  const control = catalogFactory({ getRuntimeConfig: () => config }).forRequest("main");
  const failure = new CodexAppServerRpcError({ code, message: "invalid cursor" }, "thread/list");
  rpc.mockRejectedValue(failure);
  await expect(control.initialize()).rejects.toBe(failure);
  await expect(control.initialize()).rejects.toBe(failure);
  rpc.mockResolvedValue({ data: [] });
  await control.initialize();
  await expect(control.listPage({ limit: 1 })).resolves.toEqual({ sessions: [] });
  expectCalls(3);
});
it.each(["cold", "refresh"])(
  "stops all retries after terminal spawn failure (%s)",
  async (phase) => {
    fakeClock();
    const warn = warnings();
    const factory = remoteCatalogFactory("failed-catalog");
    const control = factory.forRequest("main");
    const failure = describeCodexSpawnError(
      Object.assign(new Error("spawn failed"), { code: "EBADARCH", syscall: "spawn" }),
      `/installed/EBADARCH/${phase}/codex`,
    );
    if (phase === "refresh") {
      rpc.mockResolvedValueOnce({ data: [] });
      await control.initialize();
    }
    rpc.mockRejectedValue(failure);
    if (phase === "cold") {
      await expect(control.initialize()).rejects.toBe(failure);
    } else {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await control.listPage({ limit: 1 });
      await vi.waitFor(() => expectCalls(2));
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await expect(control.initialize()).rejects.toBe(failure);
    expectCalls(phase === "cold" ? 1 : 2);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Codex catalog updater cannot run"),
    );
  },
);

it("selects the recorded package for passive catalogs even with a user home", async () => {
  const factory = catalogFactory({
    getPluginConfig: () => ({ appServer: { homeScope: "user" } }),
  });
  const home = (await factory.homesForAgent("main"))[0]!;
  expect(home.appServer.start).toMatchObject({
    commandSource: "managed",
    managedCommandOrder: "package-only",
  });
});

it("keeps explicit homes cold until requested and retires their refresh loop on stop", async () => {
  fakeClock();
  rpc.mockResolvedValue({ data: [] });
  const { factory, control } = await remoteControl("retired-catalog");
  await factory.start();
  expect(factory.hasActiveWork()).toBe(false);
  expectCalls(0);
  await control.initialize();
  expectCalls(1);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expectCalls(1);
  await control.listPage({ limit: 1 });
  await vi.waitFor(() => expectCalls(2));

  await factory.stop();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expectCalls(2);
  await expect(control.initialize()).rejects.toThrow("Codex resident catalog is closed");
  expect(factory.hasActiveWork()).toBe(false);
});

it("does not publish a late launch advisory after its catalog owner stops", async () => {
  const warn = warnings();
  const factory = remoteCatalogFactory("retired-catalog");
  const failure = describeCodexSpawnError(
    Object.assign(new Error("spawn failed"), { errno: -86, syscall: "spawn" }),
    "/retired/codex",
  );
  const { started, pending } = holdRpc();
  try {
    const initialized = expect(factory.forRequest("main").initialize()).rejects.toBe(failure);
    await started.promise;
    const stopped = factory.stop();
    pending.reject(failure);
    await Promise.all([initialized, stopped]);
    expect(warn).not.toHaveBeenCalled();
    expect(factory.hasActiveWork()).toBe(false);
  } finally {
    pending.resolve({ data: [] });
  }
});
