import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";
import { GatewayScopeUpgrade } from "./scope-upgrade.js";

const binding = { clientId: "control-ui", deviceId: "device-1", role: "operator" };
const scopes = ["operator.admin", "operator.read"];
const registration = { requestId: "upgrade-1" };
const approved = { ...registration, status: "approved", deviceToken: "rotated-token", scopes };
type UpgradeDependencies = ConstructorParameters<typeof GatewayScopeUpgrade>[0];
function upgrade(
  request: UpgradeDependencies["request"],
  store: UpgradeDependencies["tokenStore"]["store"] = vi.fn(),
  reconnect: UpgradeDependencies["reconnect"] = vi.fn(),
) {
  return new GatewayScopeUpgrade({
    request,
    tokenStore: { load: vi.fn(), store, clear: vi.fn() },
    reconnect,
  });
}

it.each(["approved", "rejected", "expired"] as const)(
  "settles %s credentials before reconnecting",
  async (status) => {
    const order: string[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === "device.scopes.requestUpgrade") {
        return registration;
      }
      return status === "approved" ? approved : { status, ...registration };
    });
    const store = vi.fn(async () => {
      order.push("store");
    });
    const reconnect = vi.fn(() => {
      order.push("reconnect");
    });
    const onPending = vi.fn();
    const client = upgrade(request, store, reconnect);

    await expect(client.requestScopeUpgrade({ binding, scopes, onPending })).resolves.toEqual(
      status === "approved" ? { status, ...registration, scopes } : { status, ...registration },
    );
    expect(onPending).toHaveBeenCalledWith("upgrade-1");
    if (status === "approved") {
      expect(store).toHaveBeenCalledWith({ ...binding, token: "rotated-token", scopes });
      expect(order).toEqual(["store", "reconnect"]);
    } else {
      expect(store).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    }
  },
);

it.each([
  ["registration", 1, 0, 0],
  ["approval", 2, 1, 1],
  ["onPending", 1, 1, 0],
  ["persistence", 2, 1, 1],
] as const)(
  "retires a cancelled upgrade at %s without reconnecting",
  async (boundary, requests, pending, stores) => {
    const requested = createDeferred();
    const response = createDeferred<unknown>();
    const persisted = createDeferred();
    const request = vi.fn((method: string) => {
      if (
        boundary === "registration" ||
        (boundary === "approval" && method === "device.scopes.waitUpgrade")
      ) {
        requested.resolve();
        return response.promise;
      }
      return Promise.resolve(method === "device.scopes.requestUpgrade" ? registration : approved);
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
    const client = upgrade(request, store, reconnect);
    const result = client.requestScopeUpgrade({ binding, scopes, onPending });
    await requested.promise;
    response.resolve(approved);
    client.cancelScopeUpgrade();
    persisted.resolve();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(requests);
    expect(onPending).toHaveBeenCalledTimes(pending);
    expect(store).toHaveBeenCalledTimes(stores);
    expect(reconnect).not.toHaveBeenCalled();
  },
);

it("coalesces concurrent requests and allows a cancelled wait to restart", async () => {
  let waitStarted = createDeferred<AbortSignal | undefined>();
  const request = vi.fn(
    async (method: string, _params?: unknown, options?: GatewayProtocolRequestOptions) => {
      if (method === "device.scopes.requestUpgrade") {
        return registration;
      }
      return await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
        waitStarted.resolve(options?.signal);
      });
    },
  );
  const client = upgrade(request);
  const first = client.requestScopeUpgrade({ binding, scopes });
  const duplicate = client.requestScopeUpgrade({ binding, scopes });
  expect(duplicate).toBe(first);
  const firstWaitSignal = await withTestTimeout(waitStarted.promise, 1_000, "Wait did not start");
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
