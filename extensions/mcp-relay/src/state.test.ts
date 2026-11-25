import { beforeEach, expect, it } from "vitest";
import { CLIENT, createStateFixture, grantFixture } from "./relay.test-helpers.js";

let f: ReturnType<typeof createStateFixture>;
let state: ReturnType<typeof f.open>;
let identity: Awaited<ReturnType<typeof state.initialize>>;
const owner = {
  principal: { kind: "owner" },
  ceiling: ["operator.read", "operator.write"],
} as const;
const create = (id: string, codeHash: string, target = state) =>
  target.createGrant({ grantId: id, codeHash, client: CLIENT }, 0);
beforeEach(async () => {
  f = createStateFixture();
  state = f.open();
  identity = await state.initialize();
});

it("preserves authority and rejected replacement codes across restart", async () => {
  await state.issue("owner-code", 1_000, 0);
  await create("active", "owner-code");
  const replacementAuthority = {
    principal: { kind: "person", profileId: "new-person" },
    ceiling: ["operator.read"],
  } as const;
  await state.issue("replacement-code", 1_000, 0, undefined, replacementAuthority);
  await expect(create("active", "replacement-code")).rejects.toMatchObject({
    code: "invalid_params",
  });

  const restarted = f.open();
  await restarted.initialize();
  for (const current of [state, restarted]) {
    expect(current.getGrant("active")).toMatchObject(owner);
  }
  await expect(create("fresh", "replacement-code", restarted)).resolves.toBe(true);
  expect(restarted.getGrant("fresh")).toMatchObject(replacementAuthority);
});

it.each(["code", "approval"] as const)("revokes pending %s on restart", async (source) => {
  if (source === "code") {
    await state.issue("pending-code-hash", 1_000, 0);
  }
  const entered = Promise.withResolvers<void>();
  const persist = Promise.withResolvers<void>();
  f.effects.beforeWrite = async () => {
    entered.resolve();
    await persist.promise;
  };
  const creating =
    source === "code"
      ? create("pending-grant", "pending-code-hash")
      : state.approveGrant(grantFixture({ grantId: "pending-grant" }), () => {});
  await entered.promise;
  const revoking = state.revoke("pending-grant");
  persist.resolve();
  await Promise.all([creating, revoking]);

  const restarted = f.open();
  await restarted.initialize();
  await expect(restarted.grants()).resolves.toEqual([]);
  expect(() => state.assertGrantCurrent("pending-grant")).toThrow("revoked");
  expect(() => restarted.assertGrantCurrent("pending-grant")).toThrow("revoked");
});

it("preserves identity across restart and refuses a different relay", async () => {
  const restarted = await f.open().initialize();
  expect(restarted).toMatchObject({ publicKey: identity.publicKey, gatewayId: identity.gatewayId });
  expect(restarted.signChallenge("challenge", "mcp.openclaw.ai")).toBe(
    identity.signChallenge("challenge", "mcp.openclaw.ai"),
  );
  const saved = f.persisted();
  await expect(f.open("https://other.example").initialize()).rejects.toThrow("bound to");
  expect(f.persisted()).toBe(saved);
});

it("preserves invalid state and storage failures for recovery", async () => {
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
