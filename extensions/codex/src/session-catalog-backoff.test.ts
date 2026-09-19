import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import { createClientHarness } from "./app-server/test-support.js";
import { observeCodexCatalogClient } from "./session-catalog-events.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  idleThread,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

describe("Codex catalog failure recovery", () => {
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
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({
        appServer: {
          transport: "websocket",
          url: "wss://prefix-recovery.example.test/codex",
          authToken: "synthetic-catalog-token",
        },
      }),
      getRuntimeConfig: () => undefined,
    });
    const source = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", source);
    const harness = createClientHarness();
    try {
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
    } finally {
      await harness.client.closeAndWait();
      await factory.stop();
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "backs off complete home hydration independently of memory queries (runtime config %s)",
    async (hasConfig) => {
      let now = 0;
      let recovered = false;
      const failure = new Error("third native page failed");
      const control = createCodexSessionCatalogControlFactory({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
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
    const control = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const home = (await control.homesForAgent("main"))[0]!;
    const request = control.forRequest("main", home);
    const { api, getProvider } = createGatewayApi(createRuntime().runtime, config);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control,
      getRuntimeConfig: () => config,
    });
    const provider = getProvider()!;
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
      const control = createCodexSessionCatalogControlFactory({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
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
