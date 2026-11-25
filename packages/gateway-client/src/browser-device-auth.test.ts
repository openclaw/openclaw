import { expect, it, vi } from "vitest";
import {
  GatewayBrowserDeviceAuthLifecycle,
  type GatewayBrowserDeviceTokenRecord,
} from "./browser-device-auth.js";

const client = {
  id: "openclaw-browser-copilot" as const,
  version: "test",
  platform: "Chrome",
  deviceFamily: "Extension",
  mode: "ui" as const,
};
const planOptions = {
  client,
  role: "operator",
  defaultScopes: ["operator.read"],
  nonce: "nonce",
};
const binding = { clientId: client.id, deviceId: "device", role: "operator" };

function fixture(stored: GatewayBrowserDeviceTokenRecord | null = null) {
  const sign = vi.fn(async () => "signature");
  const store = vi.fn();
  const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
    loadIdentity: async () => ({ deviceId: "device", publicKey: "public", sign }),
    tokenStore: { load: () => stored, store, clear: vi.fn() },
    nowMs: () => 123,
  });
  return { lifecycle, sign, store };
}

it("preserves stored scopes for the same token and uses hello scopes after rotation", async () => {
  const { lifecycle, sign, store } = fixture({
    token: "test-token-placeholder",
    scopes: ["operator.admin", "operator.write"],
  });

  const plan = await lifecycle.buildPlan({
    ...planOptions,
    defaultScopes: ["operator.read", "operator.write"],
    challengeTs: 456,
  });

  expect(plan.auth).toEqual({
    token: undefined,
    bootstrapToken: undefined,
    deviceToken: "test-token-placeholder",
    password: undefined,
    approvalRuntimeToken: undefined,
    agentRuntimeIdentityToken: undefined,
  });
  expect(plan.scopes).toEqual(["operator.admin", "operator.write"]);
  expect(sign).toHaveBeenCalledWith(
    "v3|device|openclaw-browser-copilot|ui|operator|operator.admin,operator.write|456|test-token-placeholder|nonce|chrome|extension",
  );

  for (const [token, scopes] of [
    ["test-token-placeholder", ["operator.admin", "operator.write"]],
    ["rotated-token", ["operator.read"]],
  ] as const) {
    store.mockClear();
    await lifecycle.acceptHello(
      { auth: { deviceToken: token, role: "operator", scopes: ["operator.read"] } },
      plan,
    );
    expect(store).toHaveBeenCalledWith({ ...binding, token, scopes });
  }
});

it("rejects the protocol's malformed-timestamp signal", async () => {
  const { lifecycle } = fixture();

  await expect(lifecycle.buildPlan({ ...planOptions, challengeTs: null })).rejects.toThrow(
    "gateway connect challenge timestamp invalid",
  );
});

it("uses only the preferred bootstrap credential and never persists it", async () => {
  const { lifecycle, sign, store } = fixture();
  const plan = await lifecycle.buildPlan({
    ...planOptions,
    bootstrapScopes: ["operator.read", "operator.write"],
    token: "test-shared-token",
    bootstrapToken: "test-bootstrap-token",
    password: "test-password",
    preferBootstrapToken: true,
  });

  expect(plan.auth).toMatchObject({
    bootstrapToken: "test-bootstrap-token",
    token: undefined,
    password: undefined,
  });
  expect(plan.device?.signedAt).toBe(123);
  expect(plan.selectedAuth.signatureToken).toBe("test-bootstrap-token");
  expect(sign).toHaveBeenCalledWith(
    "v3|device|openclaw-browser-copilot|ui|operator|operator.read,operator.write|123|test-bootstrap-token|nonce|chrome|extension",
  );
  await lifecycle.acceptHello({ auth: { role: "operator", scopes: [] } }, plan);
  expect(store).not.toHaveBeenCalled();
});
