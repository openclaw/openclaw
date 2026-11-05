import type {
  GatewayControlUiIngressFactoryV2,
  GatewayIngressPrincipalRecovery,
} from "openclaw/plugin-sdk/gateway-ingress";
import { assert, expect, it } from "vitest";
import { registerRelayPrincipalRecovery } from "./grant-bindings.js";
import { createStateFixture, grantFixture } from "./relay.test-helpers.js";

it("rehydrates exact consent issuance and refuses revoked or replaced relay grants", async () => {
  const fixture = createStateFixture();
  const saved = grantFixture({ grantId: "continuation", createdAt: 100 });
  fixture.seed(saved, "grant:continuation");
  const owner: { resume?: GatewayIngressPrincipalRecovery } = {};
  const factory: GatewayControlUiIngressFactoryV2 = {
    capabilityVersion: 2,
    open: async () => {
      throw new Error("Only owner registration is exercised here.");
    },
    bindPrincipal: async () => {
      throw new Error("Transport is exercised by the core ingress integration.");
    },
    registerPrincipalRecovery: async (callback) => {
      owner.resume = callback;
    },
  };
  const first = fixture.open();
  await first.initialize();
  const originalService = new AbortController();
  await registerRelayPrincipalRecovery(factory, first, originalService.signal);
  assert(owner.resume);
  const initial = await owner.resume("continuation");
  assert(initial);
  expect(initial).toMatchObject({
    recoveryId: "100",
    principal: { kind: "owner" },
    operatorScopeCeiling: ["operator.read", "operator.write"],
  });
  originalService.abort();
  expect(initial.signal.aborted).toBe(true);
  const reloaded = fixture.open();
  await reloaded.initialize();
  const nextService = new AbortController();
  await registerRelayPrincipalRecovery(factory, reloaded, nextService.signal);
  const recovered = await owner.resume("continuation");
  assert(recovered);
  expect(recovered.recoveryId).toBe("100");
  expect(recovered.assertCurrent).not.toThrow();
  await reloaded.revoke("continuation");
  expect(await owner.resume("continuation")).toBeUndefined();
  expect(recovered.assertCurrent).toThrow("revoked");
  fixture.seed({ ...saved, createdAt: 101 }, "grant:continuation");
  await reloaded.initialize();
  expect((await owner.resume("continuation"))?.recoveryId).toBe("101");
  expect(recovered.assertCurrent).toThrow("replaced");
  nextService.abort();
});
