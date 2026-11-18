// Invites stay bounded without history: each lasts at most a week, a claw keeps at most
// MAX_INVITES, spent records are deleted, and removing an owner device deletes its open invites.
import { describe, expect, it } from "vitest";
import { FIXTURE_INVITE_ID, inviteFixture } from "../acceptance/invite-fixture.js";
import type { StatementSigner } from "../crypto.js";
import { inviteSecretHash, MAX_INVITE_LIFETIME_SECONDS } from "../invites.js";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { MAX_INVITES } from "../statements/types.js";
import { signRevocation, WORLD_NOW } from "../testing/world.js";
import { registerInvite, submitRedemption, submitStatement } from "./apply.js";
import { withoutSpentInvites } from "./invite-retention.js";
import { CERT_CLOCK_SKEW_SECONDS, type AuthorityState } from "./state.js";

type Fixture = Awaited<ReturnType<typeof inviteFixture>>;

// Registers invite number `index` expiring at `expiresAt`, signed by `signer`, at `now`.
async function register(
  f: Fixture,
  state: AuthorityState,
  index: number,
  options: { expiresAt?: number; now?: number; signer?: StatementSigner } = {},
) {
  const now = options.now ?? WORLD_NOW;
  const cap = await signStatement(
    "InviteCap",
    {
      claw_id: state.claw_id,
      invite_id: index.toString(16).padStart(32, "0"),
      role: "viewer",
      audience: { kind: "email", value: "guest@example.com" },
      label: "guest",
      created_at: now - 60,
      expires_at: options.expiresAt ?? now + 3600,
      single_use: true,
      secret_hash: await inviteSecretHash(f.proofKey),
    },
    options.signer ?? f.world.device1.signer,
  );
  return registerInvite(state, cap, f.proofKey, { channel: "tunnel", now });
}

describe("invite retention", () => {
  it("refuses an expired invite and one lasting longer than a week", async () => {
    const f = await inviteFixture();
    const week = WORLD_NOW + MAX_INVITE_LIFETIME_SECONDS;
    await expect(register(f, f.state, 1, { expiresAt: WORLD_NOW })).resolves.toMatchObject({
      ok: false,
      code: "expired",
    });
    const tooLong = { expiresAt: week + CERT_CLOCK_SKEW_SECONDS + 1 };
    await expect(register(f, f.state, 2, tooLong)).resolves.toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    await expect(register(f, f.state, 3, { expiresAt: week })).resolves.toMatchObject({ ok: true });
  });

  it(`keeps at most ${MAX_INVITES} invites and deletes spent ones before counting`, async () => {
    const f = await inviteFixture();
    let state = f.state;
    for (let index = 1; index < MAX_INVITES; index += 1) {
      const result = await register(f, state, index);
      if (!result.ok) {
        throw new Error(result.detail);
      }
      state = result.state;
    }
    const full = await register(f, state, MAX_INVITES);
    expect(full).toMatchObject({ ok: false, code: "limit_reached", state });
    const later = WORLD_NOW + 3600 + CERT_CLOCK_SKEW_SECONDS;
    const result = await register(f, state, MAX_INVITES, { now: later });
    expect(result.ok && Object.keys(result.state.invites).toSorted()).toEqual(
      [FIXTURE_INVITE_ID, MAX_INVITES.toString(16).padStart(32, "0")].toSorted(),
    );
  });

  it("keeps a pending redemption after its invite expires", async () => {
    const f = await inviteFixture();
    const pending = await submitRedemption(f.state, f.redemption, f.identity, WORLD_NOW);
    const expired = WORLD_NOW + 86400 + CERT_CLOCK_SKEW_SECONDS;
    expect(pending.ok && withoutSpentInvites(pending.state, expired).removed).toEqual([]);
    expect(withoutSpentInvites(f.state, expired).removed).toEqual([FIXTURE_INVITE_ID]);
  });

  it("deletes the open invites of a removed owner device and keeps the others", async () => {
    const f = await inviteFixture();
    const fp2 = await fingerprint(f.world.device2.pub);
    const second = await register(f, f.state, 7, { signer: f.world.device2.signer });
    if (!second.ok) {
      throw new Error(second.detail);
    }
    expect(second.state.invites[(7).toString(16).padStart(32, "0")]?.created_by).toBe(fp2);
    const revocation = await signRevocation(second.state, f.world.device1.signer, fp2);
    const removed = await submitStatement(second.state, revocation, {
      channel: "tunnel",
      now: WORLD_NOW,
    });
    expect(removed.ok && Object.keys(removed.state.invites)).toEqual([FIXTURE_INVITE_ID]);
  });
});
