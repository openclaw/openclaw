import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { CodexAppServerRpcError } from "./app-server/rpc-error.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

describe("Codex catalog failure recovery", () => {
  it("ignores an older page failure after a successful recovery", async () => {
    const control = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
    }).forRequest("main");
    const older = createDeferred<unknown>();
    const started = createDeferred<void>();
    const held = createDeferred<unknown>();
    const currentStarted = createDeferred<void>();
    commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
      started.resolve();
      return older.promise;
    });
    const failure = new Error("obsolete outage");
    const oldPage = control
      .listPage({ cursor: "older", limit: 1 })
      .catch((error: unknown) => error);
    let current: Promise<unknown> | undefined;
    try {
      await started.promise;
      commandRpcMocks.codexControlRequest.mockRejectedValueOnce(failure);
      await expect(control.listPage({ limit: 1 })).rejects.toBe(failure);
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      await expect(control.listPage({ limit: 1 })).resolves.toEqual({ sessions: [] });
      older.reject(failure);
      await expect(oldPage).resolves.toBe(failure);

      commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
        currentStarted.resolve();
        return held.promise;
      });
      current = control.listPage({ cursor: "current", limit: 1 });
      await currentStarted.promise;
      await expect(control.listPage({ cursor: "independent", limit: 1 })).resolves.toEqual({
        sessions: [],
      });
    } finally {
      older.resolve({ data: [] });
      held.resolve({ data: [] });
      await Promise.allSettled([oldPage, current]);
    }
  });

  it("shares native results across concurrent lists and backs off a repeatedly failing host", async () => {
    let now = 0;
    const control = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => now,
    });
    const home = control.homesForAgent("main")[0]!;
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
    commandRpcMocks.codexControlRequest.mockImplementation(() => {
      started.resolve();
      return failed.promise;
    });
    const calls = Array.from({ length: 18 }, () => list());
    try {
      await started.promise;
      now += 60_000;
      failed.reject(new Error("native host timed out"));
      const hosts = await Promise.all(calls);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      for (const result of hosts) {
        expect(result).toEqual(hosts[0]);
        expect(result).toMatchObject([
          {
            hostId: home.hostId,
            connected: false,
            sessions: [],
            error: { code: "APP_SERVER_UNAVAILABLE" },
          },
        ]);
      }

      // One immediate recovery attempt is allowed; another failure opens backoff.
      await list();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      const duringBackoff = await Promise.all(Array.from({ length: 18 }, () => list("other")));
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      expect(
        duringBackoff.every((result) => result[0]?.error?.code === "APP_SERVER_UNAVAILABLE"),
      ).toBe(true);

      now += 5_000;
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      const recovered = await Promise.all(Array.from({ length: 18 }, () => list()));
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
      expect(recovered.every((result) => result[0]?.connected && !result[0]?.error)).toBe(true);
    } finally {
      failed.resolve({ data: [] });
      await Promise.allSettled(calls);
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
      await expect(control.listPage({ cursor: "bad", limit: 1 })).rejects.toBe(failure);
      await expect(control.listPage({ cursor: "bad", limit: 1 })).rejects.toBe(failure);
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      await expect(control.listPage({ limit: 1 })).resolves.toEqual({ sessions: [] });
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(3);
    },
  );
});
