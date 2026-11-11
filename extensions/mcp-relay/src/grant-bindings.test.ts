import type {
  GatewayControlUiIngressFactoryV2,
  GatewayIngressPrincipalRecovery,
} from "openclaw/plugin-sdk/gateway-ingress";
import { assert, expect, it } from "vitest";
import { registerRelayPrincipalRecovery } from "./grant-bindings.js";
import { createStateFixture, grantFixture } from "./relay.test-helpers.js";

it.each(["code", "approval", "legacy", "delegated-code", "delegated-approval"] as const)(
  "rehydrates %s issuance and refuses same-clock replacement",
  async (origin) => {
    const fixture = createStateFixture();
    const principal = origin.startsWith("delegated-")
      ? {
          kind: "delegated-person" as const,
          profileId: "person",
          admission: "opaque-host-admission",
        }
      : { kind: "owner" as const };
    const saved = grantFixture({
      grantId: "continuation",
      createdAt: 100,
      ceiling: ["operator.read"],
      principal,
    });
    if (origin === "legacy") {
      fixture.seed({ ...saved, issuanceId: undefined }, "grant:continuation");
    }
    const issue = async (state: ReturnType<typeof fixture.open>, ceiling: string[]) => {
      if (origin === "code" || origin === "delegated-code") {
        await state.issue("same-clock-code", 1_000, 100, undefined, {
          principal: saved.principal,
          ceiling,
        });
        expect(
          await state.createGrant(
            {
              grantId: saved.grantId,
              codeHash: "same-clock-code",
              client: { id: saved.clientId, name: saved.clientName },
            },
            100,
          ),
        ).toBe(true);
      } else {
        await state.approveGrant({ ...saved, ceiling }, () => {});
      }
    };
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
    if (origin !== "legacy") {
      await issue(first, ["operator.read"]);
    }
    const originalService = new AbortController();
    await registerRelayPrincipalRecovery(factory, first, originalService.signal);
    assert(owner.resume);
    const initial = await owner.resume("continuation");
    assert(initial);
    expect(initial).toMatchObject({
      principal,
      operatorScopeCeiling: ["operator.read"],
    });
    const issuedId = initial.recoveryId;
    expect(fixture.persisted()).toContain(issuedId);
    originalService.abort();
    expect(initial.signal.aborted).toBe(true);
    const reloaded = fixture.open();
    await reloaded.initialize();
    const nextService = new AbortController();
    await registerRelayPrincipalRecovery(factory, reloaded, nextService.signal);
    const recovered = await owner.resume("continuation");
    assert(recovered);
    expect(recovered.recoveryId).toBe(issuedId);
    expect(recovered.principal).toEqual(principal);
    expect(recovered.assertCurrent).not.toThrow();
    await reloaded.revoke("continuation");
    expect(await owner.resume("continuation")).toBeUndefined();
    expect(recovered.assertCurrent).toThrow("revoked");
    // A consent ID may be reused in the same millisecond; time is not issuance identity.
    await issue(reloaded, ["operator.read", "operator.write"]);
    const replacement = await owner.resume("continuation");
    expect(replacement?.recoveryId).not.toBe(issuedId);
    expect(replacement?.recoveryId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(recovered.operatorScopeCeiling).toEqual(["operator.read"]);
    expect(recovered.assertCurrent).toThrow("replaced");
    nextService.abort();
  },
);
