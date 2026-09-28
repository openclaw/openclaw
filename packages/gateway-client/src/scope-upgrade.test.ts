import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";
import { GatewayScopeUpgrade } from "./scope-upgrade.js";

const binding = { clientId: "control-ui", deviceId: "device-1", role: "operator" };
const scopes = ["operator.admin", "operator.read"];

describe("GatewayScopeUpgrade", () => {
  it("persists approved credentials before reconnecting", async () => {
    const order: string[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === "device.scopes.requestUpgrade") {
        return { requestId: "upgrade-1" };
      }
      return {
        status: "approved",
        requestId: "upgrade-1",
        deviceToken: "rotated-token",
        scopes,
      };
    });
    const store = vi.fn(async () => {
      order.push("store");
    });
    const reconnect = vi.fn(() => {
      order.push("reconnect");
    });
    const onPending = vi.fn();
    const client = new GatewayScopeUpgrade({
      request,
      tokenStore: { load: vi.fn(), store, clear: vi.fn() },
      reconnect,
    });

    await expect(client.requestScopeUpgrade({ binding, scopes, onPending })).resolves.toEqual({
      status: "approved",
      requestId: "upgrade-1",
      scopes,
    });
    expect(onPending).toHaveBeenCalledWith("upgrade-1");
    expect(store).toHaveBeenCalledWith({
      ...binding,
      token: "rotated-token",
      scopes,
    });
    expect(order).toEqual(["store", "reconnect"]);
  });

  it.each(["rejected", "expired"] as const)(
    "returns %s without replacing credentials",
    async (status) => {
      const store = vi.fn();
      const reconnect = vi.fn();
      const client = new GatewayScopeUpgrade({
        request: vi
          .fn()
          .mockResolvedValueOnce({ requestId: "upgrade-1" })
          .mockResolvedValueOnce({ status, requestId: "upgrade-1" }),
        tokenStore: { load: vi.fn(), store, clear: vi.fn() },
        reconnect,
      });

      await expect(client.requestScopeUpgrade({ binding, scopes })).resolves.toEqual({
        status,
        requestId: "upgrade-1",
      });
      expect(store).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    },
  );

  it.each(["registration", "approval"] as const)(
    "retires a cancelled upgrade after its %s response has already settled",
    async (boundary) => {
      const requested = createDeferred();
      const response = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (boundary === "approval" && method === "device.scopes.requestUpgrade") {
          return Promise.resolve({ requestId: "upgrade-1" });
        }
        requested.resolve();
        return response.promise;
      });
      const store = vi.fn();
      const reconnect = vi.fn();
      const onPending = vi.fn();
      const client = new GatewayScopeUpgrade({
        request,
        tokenStore: { load: vi.fn(), store, clear: vi.fn() },
        reconnect,
      });
      const result = client.requestScopeUpgrade({ binding, scopes, onPending });
      await requested.promise;
      response.resolve({
        status: "approved",
        requestId: "upgrade-1",
        deviceToken: "rotated-token",
        scopes,
      });
      client.cancelScopeUpgrade();

      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(request).toHaveBeenCalledTimes(boundary === "registration" ? 1 : 2);
      expect(onPending).toHaveBeenCalledTimes(boundary === "registration" ? 0 : 1);
      expect(store).toHaveBeenCalledTimes(boundary === "approval" ? 1 : 0);
      expect(reconnect).not.toHaveBeenCalled();
    },
  );

  it("does not start waiting when onPending cancels the upgrade", async () => {
    const request = vi.fn().mockResolvedValue({ status: "rejected", requestId: "upgrade-1" });
    const store = vi.fn();
    const reconnect = vi.fn();
    const client = new GatewayScopeUpgrade({
      request,
      tokenStore: { load: vi.fn(), store, clear: vi.fn() },
      reconnect,
    });

    await expect(
      client.requestScopeUpgrade({
        binding,
        scopes,
        onPending: () => client.cancelScopeUpgrade(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("settles accepted token persistence without reconnecting a cancelled upgrade", async () => {
    const storing = createDeferred();
    const persisted = createDeferred();
    const store = vi.fn(() => {
      storing.resolve();
      return persisted.promise;
    });
    const reconnect = vi.fn();
    const client = new GatewayScopeUpgrade({
      request: vi.fn().mockResolvedValueOnce({ requestId: "upgrade-1" }).mockResolvedValueOnce({
        status: "approved",
        requestId: "upgrade-1",
        deviceToken: "rotated-token",
        scopes,
      }),
      tokenStore: { load: vi.fn(), store, clear: vi.fn() },
      reconnect,
    });
    const result = client.requestScopeUpgrade({ binding, scopes });
    await storing.promise;
    client.cancelScopeUpgrade();
    persisted.resolve();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(store).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("coalesces concurrent requests and allows a cancelled wait to restart", async () => {
    let waitStarted = createDeferred<AbortSignal | undefined>();
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: GatewayProtocolRequestOptions) => {
        if (method === "device.scopes.requestUpgrade") {
          return { requestId: "upgrade-1" };
        }
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("scope upgrade wait aborted")),
            { once: true },
          );
          waitStarted.resolve(options?.signal);
        });
      },
    );
    const client = new GatewayScopeUpgrade({
      request,
      tokenStore: { load: vi.fn(), store: vi.fn(), clear: vi.fn() },
      reconnect: vi.fn(),
    });
    const first = client.requestScopeUpgrade({ binding, scopes });
    const duplicate = client.requestScopeUpgrade({ binding, scopes });
    expect(duplicate).toBe(first);
    const firstWaitSignal = await withTestTimeout(
      waitStarted.promise,
      1_000,
      "Scope upgrade wait did not start",
    );
    expect(firstWaitSignal).toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);

    client.cancelScopeUpgrade();
    await expect(first).rejects.toBeDefined();
    expect(firstWaitSignal?.aborted).toBe(true);
    waitStarted = createDeferred<AbortSignal | undefined>();
    const restarted = client.requestScopeUpgrade({ binding, scopes });
    await withTestTimeout(waitStarted.promise, 1_000, "Scope upgrade wait did not restart");
    expect(request).toHaveBeenCalledTimes(4);
    client.cancelScopeUpgrade();
    await expect(restarted).rejects.toBeDefined();
  });
});
