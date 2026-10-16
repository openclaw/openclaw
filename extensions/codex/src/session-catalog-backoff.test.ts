import { setImmediate as nextTurn } from "node:timers/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
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
function createClientHarness(options?: Parameters<typeof createHarness>[0]) {
  const harness = createHarness(options);
  clients.push(harness.client);
  return harness;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.closeAndWait()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog failure recovery", () => {
  it("shrinks oversized wire pages and retains the working limit for later refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const native = Array.from({ length: 20 }, (_, i) =>
      idleThread({ id: `large-${i}`, source: "cli", preview: "x".repeat(600_000) }),
    );
    const pages: { limit: number; bytes: number }[] = [];
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        const offset = Number(request.params.cursor ?? 0);
        const limit = request.params.limit;
        const response = {
          id: request.id,
          result: {
            data: native.slice(offset, offset + limit),
            nextCursor: offset + limit < native.length ? String(offset + limit) : null,
          },
        };
        pages.push({ limit, bytes: Buffer.byteLength(JSON.stringify(response)) });
        send(response);
      },
    });
    commandRpcMocks.codexControlRequest.mockImplementation((_plugin, method, params, options) =>
      harness.client.request(method, params, options),
    );
    const factory = catalogFactory();
    const control = factory.forRequest("main");
    await control.initialize();
    expect((await control.listPage({ limit: 64 })).sessions).toHaveLength(20);
    expect(pages.map((page) => page.limit)).toEqual([16, 8, 8, 8]);
    expect(pages[0]!.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(pages.slice(1).every((page) => page.bytes < 8 * 1024 * 1024)).toBe(true);
    pages.length = 0;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await control.listPage({});
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    expect(pages.map((page) => page.limit)).toEqual([8, 8, 8]);
    expect((await control.listPage({ limit: 64 })).sessions).toHaveLength(20);
  });

  it("defers an oversized single thread for 15 minutes without repeated background warnings", async () => {
    let now = 0;
    let oversized = true;
    const limits: number[] = [];
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        limits.push(request.params.limit);
        send({
          id: request.id,
          result: {
            data: [
              idleThread({
                source: "cli",
                name: null,
                preview: oversized ? "x".repeat(8 * 1024 * 1024) : "Recovered",
              }),
            ],
          },
        });
      },
    });
    commandRpcMocks.codexControlRequest.mockImplementation((_plugin, method, params, options) =>
      harness.client.request(method, params, options),
    );
    const warnings = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
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
      warnings.mock.calls.filter(
        ([message]) => message === "Codex resident catalog background update failed",
      ),
    ).toHaveLength(1);
    oversized = false;
    await control.initialize();
    expect(limits).toEqual([16, 8, 4, 2, 1, 1]);
    expect((await control.listPage({})).sessions[0]?.fallbackName).toBe("Recovered");
  });

  it("settles a successful prefix recovery probe before the next activity check", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const native = Array.from({ length: 96 }, (_, i) =>
      idleThread({ id: `prefix-${i}`, source: "cli", recencyAt: 1_000 - i }),
    );
    commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
      expect(method).toBe("thread/list");
      const offset = Number(params.cursor ?? 0);
      return {
        data: native.slice(offset, offset + 64),
        nextCursor: offset + 64 < native.length ? String(offset + 64) : null,
      };
    });
    const factory = remoteCatalogFactory("prefix-recovery");
    const source = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", source);
    const harness = createClientHarness();
    await observeCodexCatalogClient(harness.client, {
      startOptions: source.appServer.start,
      agentDir: source.agentDir,
    });
    await control.initialize();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    const notify = async (name: string) => {
      native[0]!.name = name;
      harness.send({ method: "thread/started", params: { thread: native[0]! } });
      await vi.waitFor(async () => {
        expect((await control.listPage({})).sessions[0]?.name).toBe(name);
      });
    };
    await notify("First activity");
    commandRpcMocks.codexControlRequest.mockRejectedValueOnce(new Error("temporary outage"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    await notify("Recovery activity");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);
    await notify("Later activity");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(5);
    expect(
      commandRpcMocks.codexControlRequest.mock.calls
        .slice(2)
        .every((call) => call[2].useStateDbOnly === true && call[2].cursor === undefined),
    ).toBe(true);
  });

  it.each([true, false])(
    "backs off complete home hydration independently of memory queries (runtime config %s)",
    async (hasConfig) => {
      let now = 0;
      let recovered = false;
      const failure = new Error("third native page failed");
      const control = catalogFactory({
        getRuntimeConfig: () => (hasConfig ? config : undefined),
        now: () => now,
      }).forRequest("main");
      commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, _method, params) => {
        if (params.cursor === "page-three") {
          if (!recovered) {
            throw failure;
          }
          return { data: [idleThread({ id: "match", source: "cli", name: "Wanted" })] };
        }
        return {
          data: [
            idleThread({ id: params.cursor ? "second" : "head", source: "cli", name: "Other" }),
          ],
          nextCursor: params.cursor ? "page-three" : "page-two",
        };
      });
      const search = () => control.listPage({ limit: 1, searchTerm: "Wanted" });
      await expect(control.initialize()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
      await expect(control.initialize()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(6);

      await expect(control.initialize()).rejects.toBe(failure);
      const partial = await search();
      expect(partial.sessions).toEqual([]);
      expect(partial.nextCursor).toEqual(expect.any(String));
      await expect(
        control.listPage({ limit: 1, searchTerm: "Wanted", cursor: partial.nextCursor }),
      ).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(6);

      now += 5_000;
      recovered = true;
      await control.initialize();
      expect((await search()).sessions[0]?.threadId).toBe("match");
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(9);
      expect((await control.listPage({ limit: 10 })).sessions).toHaveLength(3);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(9);
    },
  );

  it("shares cold initialization and keeps host backoff observable to catalog callers", async () => {
    let now = 0;
    const control = catalogFactory({
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const home = (await control.homesForAgent("main"))[0]!;
    const request = control.forRequest("main", home);
    const provider = catalogProvider(control);
    const list = (search?: string) =>
      provider.list({ agentId: "main", hostIds: [home.hostId], limitPerHost: 1, search });
    const failed = createDeferred<unknown>();
    const started = createDeferred<void>();
    const failure = new Error("native host timed out");
    commandRpcMocks.codexControlRequest.mockImplementation(() => {
      started.resolve();
      return failed.promise;
    });
    const calls = Array.from({ length: 18 }, () => request.initialize());
    const settled = Promise.allSettled(calls);
    let listDelivered = false;
    const pendingList = list().then((result) => {
      listDelivered = true;
      return result;
    });
    const observedList = Promise.allSettled([pendingList]);
    try {
      await started.promise;
      await nextTurn();
      expect(listDelivered).toBe(false);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      now += 60_000;
      failed.reject(failure);
      expect(await settled).toEqual(
        Array.from({ length: 18 }, () => ({ status: "rejected", reason: failure })),
      );
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      expect((await pendingList)[0]).toMatchObject({
        connected: false,
        sessions: [],
        error: { code: "APP_SERVER_UNAVAILABLE" },
      });

      // The background producer retains its immediate retry and source backoff.
      await expect(request.initialize()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      const duringBackoff = await Promise.all(Array.from({ length: 18 }, () => list("other")));
      expect(
        duringBackoff.every(
          (result) =>
            result[0]?.connected === false && result[0]?.error?.code === "APP_SERVER_UNAVAILABLE",
        ),
      ).toBe(true);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      const blocked = await Promise.allSettled(
        Array.from({ length: 18 }, () => request.initialize()),
      );
      expect(blocked.every((result) => result.status === "rejected")).toBe(true);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

      now += 5_000;
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      await Promise.all(Array.from({ length: 18 }, () => request.initialize()));
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
      const recovered = await Promise.all(Array.from({ length: 18 }, () => list()));
      expect(
        recovered.every(
          (result) => result[0]?.connected && !result[0]?.error && result[0]?.sessions.length === 0,
        ),
      ).toBe(true);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    } finally {
      failed.resolve({ data: [] });
      await Promise.all([settled, observedList]);
    }
  });

  it.each([-32600, -32602])(
    "does not treat invalid-request error %s as a host outage",
    async (code) => {
      const control = catalogFactory({
        getRuntimeConfig: () => config,
      }).forRequest("main");
      const failure = new CodexAppServerRpcError(
        { code, message: "invalid cursor" },
        "thread/list",
      );
      commandRpcMocks.codexControlRequest.mockRejectedValue(failure);
      await expect(control.initialize()).rejects.toBe(failure);
      await expect(control.initialize()).rejects.toBe(failure);
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      await control.initialize();
      await expect(control.listPage({ limit: 1 })).resolves.toEqual({ sessions: [] });
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    },
  );
});

describe("Codex catalog launch failures", () => {
  it.each(["cold", "refresh"])(
    "stops background and foreground retries after a terminal spawn failure during %s",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const factory = remoteCatalogFactory("failed-catalog");
      const control = factory.forRequest("main");
      const failure = describeCodexSpawnError(
        Object.assign(new Error("spawn failed"), { code: "EBADARCH", syscall: "spawn" }),
        `/installed/EBADARCH/${phase}/codex`,
      );
      if (phase === "refresh") {
        commandRpcMocks.codexControlRequest.mockResolvedValueOnce({ data: [] });
        await control.initialize();
      }
      commandRpcMocks.codexControlRequest.mockRejectedValue(failure);
      if (phase === "cold") {
        await expect(control.initialize()).rejects.toBe(failure);
      } else {
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await control.listPage({ limit: 1 });
        await vi.waitFor(() =>
          expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2),
        );
      }
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      await expect(control.initialize()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(phase === "cold" ? 1 : 2);
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
});

it("leaves explicit homes cold until a catalog request admits them", async () => {
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const factory = remoteCatalogFactory("retired-catalog");
  await factory.start();
  expect(factory.hasActiveWork()).toBe(false);
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();

  const source = (await factory.homesForAgent("main"))[0]!;
  await factory.forRequest("main", source).initialize();
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  await factory.stop();
  expect(factory.hasActiveWork()).toBe(false);
});

it("retires the resident refresh loop when its catalog owner stops", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const factory = remoteCatalogFactory("retired-catalog");
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  await control.initialize();
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  await control.listPage({ limit: 1 });
  await vi.waitFor(() => expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2));

  await factory.stop();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  await expect(control.initialize()).rejects.toThrow("Codex resident catalog is closed");
  expect(factory.hasActiveWork()).toBe(false);
});

it("does not publish a late launch advisory after its catalog owner stops", async () => {
  const started = createDeferred<void>();
  const pending = createDeferred<unknown>();
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  const factory = remoteCatalogFactory("retired-catalog");
  const failure = describeCodexSpawnError(
    Object.assign(new Error("spawn failed"), {
      errno: -86,
      syscall: "spawn",
    }),
    "/retired/codex",
  );
  commandRpcMocks.codexControlRequest.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
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
