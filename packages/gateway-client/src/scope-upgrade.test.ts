import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";
import { GatewayScopeUpgrade } from "./scope-upgrade.js";

const binding = { clientId: "control-ui", deviceId: "device-1", role: "operator" };
const scopes = ["operator.admin", "operator.read"];

describe("GatewayScopeUpgrade", () => {
  it.each(["approved", "rejected", "expired"] as const)(
    "settles %s credentials before reconnecting",
    async (status) => {
      const order: string[] = [];
      const request = vi.fn(async (method: string) => {
        if (method === "device.scopes.requestUpgrade") {
          return { requestId: "upgrade-1" };
        }
        return status === "approved"
          ? { status, requestId: "upgrade-1", deviceToken: "rotated-token", scopes }
          : { status, requestId: "upgrade-1" };
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

      await expect(client.requestScopeUpgrade({ binding, scopes, onPending })).resolves.toEqual(
        status === "approved"
          ? { status, requestId: "upgrade-1", scopes }
          : { status, requestId: "upgrade-1" },
      );
      expect(onPending).toHaveBeenCalledWith("upgrade-1");
      if (status === "approved") {
        expect(store).toHaveBeenCalledWith({
          ...binding,
          token: "rotated-token",
          scopes,
        });
        expect(order).toEqual(["store", "reconnect"]);
      } else {
        expect(store).not.toHaveBeenCalled();
        expect(reconnect).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["registration", "approval", "onPending", "persistence"] as const)(
    "retires a cancelled upgrade at %s without reconnecting",
    async (boundary) => {
      const requested = createDeferred();
      const response = createDeferred<unknown>();
      const persisted = createDeferred();
      const approved = {
        status: "approved",
        requestId: "upgrade-1",
        deviceToken: "rotated-token",
        scopes,
      };
      const request = vi.fn((method: string) => {
        if (
          boundary === "registration" ||
          (boundary === "approval" && method === "device.scopes.waitUpgrade")
        ) {
          requested.resolve();
          return response.promise;
        }
        return Promise.resolve(
          method === "device.scopes.requestUpgrade" ? { requestId: "upgrade-1" } : approved,
        );
      });
      const store = vi.fn(() => {
        if (boundary === "persistence") {
          requested.resolve();
          return persisted.promise;
        }
        return undefined;
      });
      const reconnect = vi.fn();
      const onPending = vi.fn(() => {
        if (boundary === "onPending") {
          client.cancelScopeUpgrade();
          requested.resolve();
        }
      });
      const client = new GatewayScopeUpgrade({
        request,
        tokenStore: { load: vi.fn(), store, clear: vi.fn() },
        reconnect,
      });
      const result = client.requestScopeUpgrade({ binding, scopes, onPending });
      await requested.promise;
      response.resolve(approved);
      client.cancelScopeUpgrade();
      persisted.resolve();

      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(request).toHaveBeenCalledTimes(
        boundary === "registration" || boundary === "onPending" ? 1 : 2,
      );
      expect(onPending).toHaveBeenCalledTimes(boundary === "registration" ? 0 : 1);
      expect(store).toHaveBeenCalledTimes(
        boundary === "approval" || boundary === "persistence" ? 1 : 0,
      );
      expect(reconnect).not.toHaveBeenCalled();
    },
  );

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
