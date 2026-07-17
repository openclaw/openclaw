import { describe, expect, it } from "vitest";
import {
  createCopilotTokenStore,
  isDefinitiveGatewayRejection,
  loadOrCreateCopilotIdentity,
  resolveCopilotClose,
} from "./copilot-gateway.js";
import { GatewayProtocolRequestError } from "./copilot-runtime.js";

function storageArea() {
  const values: Record<string, unknown> = {};
  return {
    async get(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(update: Record<string, unknown>) {
      Object.assign(values, update);
    },
  };
}

describe("browser copilot Gateway custody", () => {
  it("scopes device identities and issued tokens to one Gateway", async () => {
    const storage = storageArea();
    const gatewayA = "ws://127.0.0.1:18789/";
    const gatewayB = "ws://127.0.0.1:28789/";
    const identityA = await loadOrCreateCopilotIdentity(storage, gatewayA);
    const identityAAgain = await loadOrCreateCopilotIdentity(storage, gatewayA);
    const identityB = await loadOrCreateCopilotIdentity(storage, gatewayB);

    expect(identityAAgain.deviceId).toBe(identityA.deviceId);
    expect(identityB.deviceId).not.toBe(identityA.deviceId);

    const tokenParams = {
      clientId: "openclaw-browser-copilot",
      deviceId: identityA.deviceId,
      role: "operator",
    };
    const tokenA = createCopilotTokenStore(storage, gatewayA);
    const tokenB = createCopilotTokenStore(storage, gatewayB);
    await tokenA.store({ ...tokenParams, token: "test-token", scopes: ["operator.read"] });

    await expect(tokenA.load(tokenParams)).resolves.toEqual({
      token: "test-token",
      scopes: ["operator.read"],
    });
    await expect(tokenB.load(tokenParams)).resolves.toBeNull();
  });

  it("keeps the pairing approval state when the failed socket closes", () => {
    const error = { details: { code: "PAIRING_REQUIRED", pauseReconnect: true } };

    expect(resolveCopilotClose({ connectFailure: { error } })).toEqual({
      retry: true,
      notify: false,
      pendingError: error,
    });
    expect(
      resolveCopilotClose({
        connectFailure: { error: { details: { pauseReconnect: true } } },
      }).retry,
    ).toBe(false);
    expect(resolveCopilotClose({})).toEqual({
      retry: true,
      notify: true,
      pendingError: undefined,
    });
  });

  it("distinguishes server rejection from ambiguous transport failure", () => {
    expect(
      isDefinitiveGatewayRejection(
        new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message: "fixture rejection" }),
      ),
    ).toBe(true);
    expect(isDefinitiveGatewayRejection(new Error("fixture socket closed"))).toBe(false);
  });
});
