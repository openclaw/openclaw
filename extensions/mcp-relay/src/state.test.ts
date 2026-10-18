import { describe, expect, it } from "vitest";
import { CLIENT, createStateFixture } from "./relay.test-helpers.js";

describe("MCP relay persisted state", () => {
  it("preserves active grant authority and its rejected replacement code across restart", async () => {
    const f = createStateFixture();
    const state = f.open();
    await state.initialize();
    await state.issue("owner-code", 1_000, 0);
    await state.createGrant({ grantId: "active", codeHash: "owner-code", client: CLIENT }, 0);
    const replacementAuthority = {
      principal: { kind: "person", profileId: "new-person" },
      ceiling: ["operator.read"],
    } as const;
    await state.issue("replacement-code", 1_000, 0, undefined, replacementAuthority);
    await expect(
      state.createGrant({ grantId: "active", codeHash: "replacement-code", client: CLIENT }, 0),
    ).rejects.toMatchObject({ code: "invalid_params" });

    const restarted = f.open();
    await restarted.initialize();
    for (const current of [state, restarted]) {
      expect(current.getGrant("active")).toMatchObject({
        principal: { kind: "owner" },
        ceiling: ["operator.read", "operator.write"],
      });
    }
    await expect(
      restarted.createGrant({ grantId: "fresh", codeHash: "replacement-code", client: CLIENT }, 0),
    ).resolves.toBe(true);
    expect(restarted.getGrant("fresh")).toMatchObject(replacementAuthority);
  });

  it.each(["pairing code", "approval"] as const)(
    "keeps a revocation after pending %s grant persistence and restart",
    async (source) => {
      const f = createStateFixture();
      const state = f.open();
      await state.initialize();
      if (source === "pairing code") {
        await state.issue("pending-code-hash", 1_000, 0);
      }
      const entered = Promise.withResolvers<void>();
      const persist = Promise.withResolvers<void>();
      f.effects.beforeWrite = async () => {
        entered.resolve();
        await persist.promise;
      };
      const creating =
        source === "pairing code"
          ? state.createGrant(
              { grantId: "pending-grant", codeHash: "pending-code-hash", client: CLIENT },
              0,
            )
          : state.approveGrant(
              {
                grantId: "pending-grant",
                clientId: CLIENT.id,
                clientName: CLIENT.name,
                createdAt: 0,
                principal: { kind: "owner" },
                ceiling: ["operator.read", "operator.write"],
              },
              () => {},
            );
      await entered.promise;
      const revoking = state.revoke("pending-grant");
      persist.resolve();
      await Promise.all([creating, revoking]);

      const restarted = f.open();
      await restarted.initialize();
      await expect(restarted.grants()).resolves.toEqual([]);
      expect(() => state.assertGrantCurrent("pending-grant")).toThrow("revoked");
      expect(() => restarted.assertGrantCurrent("pending-grant")).toThrow("revoked");
    },
  );

  it("keeps its Ed25519 identity across restart and refuses a different relay", async () => {
    const f = createStateFixture();
    const identity = await f.open().initialize();
    const restarted = await f.open().initialize();
    expect(restarted.publicKey).toBe(identity.publicKey);
    expect(restarted.gatewayId).toBe(identity.gatewayId);
    expect(restarted.signChallenge("challenge", "mcp.openclaw.ai")).toBe(
      identity.signChallenge("challenge", "mcp.openclaw.ai"),
    );
    const saved = f.persisted();
    await expect(f.open("https://other.example").initialize()).rejects.toThrow("bound to");
    expect(f.persisted()).toBe(saved);
  });

  it("preserves invalid state and storage failures for operator recovery", async () => {
    const f = createStateFixture();
    await f.open().initialize();
    const saved = f.persisted();
    f.effects.failure = new Error("Storage unavailable");
    await expect(f.open().initialize()).rejects.toThrow("Storage unavailable");
    expect(f.persisted()).toBe(saved);
    f.effects.failure = undefined;
    for (const value of [
      null,
      { relayOrigin: "https://mcp.openclaw.ai", privateKey: "invalid-key" },
    ]) {
      f.seed(value);
      const invalid = f.persisted();
      await expect(f.open().initialize()).rejects.toThrow("Restore a valid OpenClaw state backup");
      expect(f.persisted()).toBe(invalid);
    }
  });
});
