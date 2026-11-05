import { describe, expect, it } from "vitest";
import type { StatementSigner } from "../crypto.js";
import {
  checkDescriptorConsistency,
  checkDescriptorRootReset,
  descriptorEvidence,
  parseClawDescriptor,
  type ClawDescriptor,
} from "../discovery/descriptor.js";
import { fingerprint } from "../keys.js";
import { buildWorld, WORLD_HOST, WORLD_NOW, worldKey, type WorldKey } from "../testing/world.js";
import { signStatement } from "./envelope.js";
import { verifyBindingForPin } from "./pin.js";
import type { RootResetBody, ServerBindingBody, SignedStatement } from "./types.js";

const context = { now: WORLD_NOW, host: WORLD_HOST };

// A claw at binding_seq 1 under R, and builders for the descriptor its owner reset publishes.
async function setup() {
  const world = await buildWorld();
  const newRoot = await worldKey("root-2");
  const descriptor = (
    root_pub: ClawDescriptor["root_pub"],
    binding: SignedStatement<"ServerBinding">,
    reset?: ClawDescriptor["reset"],
  ): ClawDescriptor => ({
    v: 1,
    claw_id: world.state.claw_id,
    transport: "iroh",
    relay_url: "https://relay.example.test/",
    root_pub,
    binding,
    ...(reset ? { reset } : {}),
    published_at: WORLD_NOW,
  });
  const stored = descriptor(world.rootPub, world.binding);
  const resetDescriptor = async (change: Forgery = {}) => {
    const statement = await signStatement(
      "RootReset",
      {
        claw_id: world.state.claw_id,
        new_root_pub: newRoot.pub,
        binding_seq: 2,
        issued_at: WORLD_NOW,
        ...change.reset,
      },
      change.resetSigner ?? world.gateway.signer,
    );
    const binding = await signStatement(
      "ServerBinding",
      { ...world.binding.body, binding_seq: 2, issued_at: WORLD_NOW, ...change.binding },
      change.bindingSigner ?? newRoot.signer,
    );
    return descriptor(newRoot.pub, binding, {
      previous_root_pub: world.rootPub,
      previous_binding: world.binding,
      statement,
    });
  };
  const pin = {
    claw_id: world.state.claw_id,
    root_fp: await fingerprint(world.rootPub),
    binding_seq: 1,
  };
  return { world, newRoot, stored, resetDescriptor, pin };
}

type Forgery = {
  reset?: Partial<RootResetBody>;
  resetSigner?: StatementSigner;
  binding?: Partial<ServerBindingBody>;
  bindingSigner?: StatementSigner;
};

// Each forgery parses; it must fail on a signature or consistency check (code), not at parsing.
const FORGERIES: [string, string, (mallory: WorldKey) => Forgery][] = [
  ["reset signed by another key", "wrong_signer", (m) => ({ resetSigner: m.signer })],
  ["reset for another claw", "wrong_claw", () => ({ reset: { claw_id: "e".repeat(32) } })],
  [
    "binding_seq does not increase",
    "rollback",
    () => ({ reset: { binding_seq: 1 }, binding: { binding_seq: 1 } }),
  ],
  ["reset names another root", "root_mismatch", (m) => ({ reset: { new_root_pub: m.pub } })],
  ["new binding not signed by the new root", "wrong_signer", (m) => ({ bindingSigner: m.signer })],
  ["new binding changes K_srv", "reset_mismatch", (m) => ({ binding: { k_srv: m.peer } })],
  ["new binding changes K_gw", "reset_mismatch", (m) => ({ binding: { k_gw: m.pub } })],
  ["new binding is not the reset's", "reset_mismatch", () => ({ binding: { binding_seq: 3 } })],
];

describe("owner reset", () => {
  it("Discovery accepts a K_gw-vouched root change; an old pin gets owner_reset and dials nothing", async () => {
    const { newRoot, stored, resetDescriptor, pin } = await setup();
    const next = await resetDescriptor();
    expect(parseClawDescriptor(next)).toEqual({ ok: true, descriptor: next });
    await expect(checkDescriptorConsistency(next, context)).resolves.toMatchObject({ ok: true });
    await expect(checkDescriptorRootReset(stored, next, context)).resolves.toMatchObject({
      ok: true,
      reset: { new_root_pub: newRoot.pub, binding_seq: 2 },
    });
    await expect(
      verifyBindingForPin(descriptorEvidence(next), pin, context),
    ).resolves.toStrictEqual({
      ok: false,
      code: "owner_reset",
      detail: "the owner reset access to this claw",
    });
    // A browser set up again with the new kit pins the new root and dials as usual.
    const renewed = { claw_id: null, root_fp: await fingerprint(newRoot.pub), binding_seq: 0 };
    await expect(
      verifyBindingForPin(descriptorEvidence(next), renewed, context),
    ).resolves.toMatchObject({ ok: true, pin: { binding_seq: 2 } });
  });

  it.each(FORGERIES)(
    "refuses a forged reset after parsing: %s -> %s",
    async (_name, code, forge) => {
      const { world, stored, resetDescriptor, pin } = await setup();
      const next = await resetDescriptor(forge(world.mallory));
      expect(parseClawDescriptor(next)).toMatchObject({ ok: true });
      await expect(checkDescriptorRootReset(stored, next, context)).resolves.toMatchObject({
        ok: false,
        code,
      });
      await expect(checkDescriptorConsistency(next, context)).resolves.toMatchObject({ ok: false });
      // Without a valid reset, a new root is still a substitution for the browser.
      await expect(
        verifyBindingForPin(descriptorEvidence(next), pin, context),
      ).resolves.toMatchObject({ ok: false, code: "root_mismatch" });
    },
  );

  it("Discovery refuses a new root without a reset, or a reset from a binding it never published", async () => {
    const { world, stored, resetDescriptor } = await setup();
    const next = await resetDescriptor();
    const { reset, ...withoutReset } = next;
    await expect(checkDescriptorRootReset(stored, withoutReset, context)).resolves.toMatchObject({
      code: "root_mismatch",
    });
    const unpublished = await signStatement(
      "ServerBinding",
      { ...world.binding.body, k_gw: world.mallory.pub },
      world.root,
    );
    const elsewhere = { ...next, reset: { ...reset!, previous_binding: unpublished } };
    await expect(checkDescriptorRootReset(stored, elsewhere, context)).resolves.toMatchObject({
      code: "reset_mismatch",
    });
  });
});
