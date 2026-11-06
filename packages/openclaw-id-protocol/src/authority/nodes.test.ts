import { beforeAll, describe, expect, it } from "vitest";
import { deriveInviteProofKey, inviteSecretHash, MAX_INVITE_LIFETIME_SECONDS } from "../invites.js";
import { fingerprint, formatIrohEndpointKey } from "../keys.js";
import { computeNodeRedemptionProof } from "../node-invites.js";
import { signStatement } from "../statements/envelope.js";
import { MAX_INVITES, MAX_NODES } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { buildWorld, certBody, signChange, signRevocation, WORLD_NOW } from "../testing/world.js";
import {
  dropInactive,
  nextInactivityDrop,
  recordSeen,
  DEFAULT_INACTIVITY_WINDOWS,
} from "./allowlist.js";
import { submitStatement } from "./apply.js";
import { withoutSpentInvites } from "./invite-retention.js";
import { registerNodeInvite, submitNodeRedemption } from "./nodes.js";
import {
  isAdmitted,
  isNode,
  ownerLookup,
  snapshotBody,
  type AuthorityResult,
  type AuthorityState,
} from "./state.js";

const context = { channel: "tunnel" as const, now: WORLD_NOW };
let world: Awaited<ReturnType<typeof buildWorld>>;
let proofKey: Uint8Array;
let cap: Awaited<ReturnType<typeof nodeCap>>;
let redemption: Awaited<ReturnType<typeof nodeRedemption>>;
let registered: AuthorityState;
let pending: AuthorityState;
let admitted: AuthorityState;
let peer: ReturnType<typeof formatIrohEndpointKey>;
const inviteId = "ab".repeat(16);

function stateOf(result: AuthorityResult): AuthorityState {
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.detail}`);
  }
  return result.state;
}
async function nodeCap(id = inviteId) {
  return signStatement(
    "NodeInviteCap",
    {
      claw_id: world.state.claw_id,
      invite_id: id,
      label: "build node",
      created_at: WORLD_NOW,
      expires_at: WORLD_NOW + 3600,
      secret_hash: await inviteSecretHash(proofKey),
    },
    world.device1.signer,
  );
}
async function nodeRedemption(id = inviteId, key = peer) {
  const parts = { claw_id: world.state.claw_id, invite_id: id, peer_key: key };
  return signStatement(
    "NodeRedemption",
    { ...parts, requested_at: WORLD_NOW, proof: await computeNodeRedemptionProof(proofKey, parts) },
    world.invitee.signer,
  );
}
async function approve(state: AuthorityState, id = inviteId, key = peer) {
  return submitStatement(
    state,
    await signChange(state, world.device1.signer, {
      op: "add_node",
      peer_key: key,
      label: "build node",
      invite_id: id,
    }),
    context,
  );
}

beforeAll(async () => {
  world = await buildWorld();
  // This fixture uses the invitee signing key itself as W, not its separate browser peer key.
  peer = formatIrohEndpointKey(world.invitee.signer.publicKey);
  proofKey = await deriveInviteProofKey(new Uint8Array(32).fill(8));
  cap = await nodeCap();
  redemption = await nodeRedemption();
  registered = stateOf(await registerNodeInvite(world.state, cap, proofKey, context));
  pending = stateOf(await submitNodeRedemption(registered, redemption, WORLD_NOW));
  admitted = stateOf(await approve(pending));
});

describe("node authority boundary", () => {
  it("requires pending W possession and owner approval, then admits only a node", async () => {
    expect(isAdmitted(registered, peer, WORLD_NOW)).toBe(false);
    expect(isAdmitted(pending, peer, WORLD_NOW)).toBe(false);
    expect(await approve(registered)).toMatchObject({ ok: false, code: "invite_not_pending" });
    expect(await approve(pending, inviteId, world.mallory.peer)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    expect(isAdmitted(admitted, peer, WORLD_NOW)).toBe(true);
    expect(isNode(admitted, peer)).toBe(true);
    expect(ownerLookup(admitted, WORLD_NOW)(world.invitee.pub)).toBeUndefined();
    expect(snapshotBody(admitted, 1, WORLD_NOW)).toMatchObject({
      node_peer_keys: [peer],
      members: [],
    });
    expect(admitted.nodes[peer]).toMatchObject({
      listed_seq: admitted.seq,
      invite_id: inviteId,
      added_by: await fingerprint(world.device1.pub),
    });
    expect(await submitNodeRedemption(admitted, redemption, WORLD_NOW)).toMatchObject({
      ok: false,
      code: "invite_used",
    });
  });

  it("refuses Discovery, Gateway and node signatures, and mailbox owner approvals", async () => {
    for (const signer of [world.gateway.signer, world.invitee.signer, world.mallory.signer]) {
      expect(
        await registerNodeInvite(
          world.state,
          await signStatement("NodeInviteCap", cap.body, signer),
          proofKey,
          context,
        ),
      ).toMatchObject({ ok: false, code: "not_an_owner", state: world.state, events: [] });
      expect(
        await submitStatement(
          pending,
          await signChange(pending, signer, {
            op: "add_node",
            peer_key: peer,
            label: "x",
            invite_id: inviteId,
          }),
          context,
        ),
      ).toMatchObject({ ok: false, code: "not_an_owner" });
    }
    expect(
      await registerNodeInvite(world.state, cap, proofKey, { ...context, channel: "mailbox" }),
    ).toMatchObject({ ok: false, code: "not_direct" });
    const change = await signChange(pending, world.device1.signer, {
      op: "add_node",
      peer_key: peer,
      label: "x",
      invite_id: inviteId,
    });
    expect(
      await submitStatement(pending, change, { ...context, channel: "mailbox" }),
    ).toMatchObject({ ok: false, code: "not_direct" });
    expect(await submitStatement(admitted, change, context)).toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
    expect(
      await submitStatement(pending, await signChange(pending, world.root, change.body.target), {
        ...context,
        channel: "mailbox",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects invalid W proofs, expired invites and unknown signed fields", async () => {
    for (const [input, code] of [
      [
        await signStatement("NodeRedemption", redemption.body, world.mallory.signer),
        "wrong_signer",
      ],
      [
        await signStatement(
          "NodeRedemption",
          { ...redemption.body, proof: "00".repeat(32) },
          world.invitee.signer,
        ),
        "bad_proof",
      ],
      [
        await signStatement(
          "NodeRedemption",
          { ...redemption.body, claw_id: "00".repeat(16) },
          world.invitee.signer,
        ),
        "wrong_claw",
      ],
    ] as const) {
      expect(await submitNodeRedemption(registered, input, WORLD_NOW)).toMatchObject({
        ok: false,
        code,
        state: registered,
        events: [],
      });
    }
    expect(await submitNodeRedemption(registered, redemption, cap.body.expires_at)).toMatchObject({
      ok: false,
      code: "expired",
    });
    for (const statement of [cap, redemption]) {
      expect(
        parseStatement({ ...statement, body: { ...statement.body, role: "operator" } }),
      ).toMatchObject({ ok: false, code: "malformed" });
    }
  });

  it("denies a pending node invite without admission, and enforces shared invite limits", async () => {
    const denied = stateOf(
      await submitStatement(
        pending,
        await signChange(pending, world.device1.signer, { op: "deny_invite", invite_id: inviteId }),
        context,
      ),
    );
    expect(denied.node_invites[inviteId]).toMatchObject({ status: "consumed", pending: null });
    expect(isAdmitted(denied, peer, WORLD_NOW)).toBe(false);
    expect(await approve(denied)).toMatchObject({ ok: false, code: "invite_not_pending" });
    expect(await registerNodeInvite(registered, cap, proofKey, context)).toMatchObject({
      ok: false,
      code: "invite_used",
    });
    const tooLong = await signStatement(
      "NodeInviteCap",
      { ...cap.body, expires_at: WORLD_NOW + MAX_INVITE_LIFETIME_SECONDS + 301 },
      world.device1.signer,
    );
    expect(await registerNodeInvite(world.state, tooLong, proofKey, context)).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    const full = {
      ...world.state,
      node_invites: Object.fromEntries(
        Array.from({ length: MAX_INVITES }, (_, i) => [
          i.toString(16).padStart(32, "0"),
          registered.node_invites[inviteId]!,
        ]),
      ),
    };
    expect(await registerNodeInvite(full, cap, proofKey, context)).toMatchObject({
      ok: false,
      code: "limit_reached",
    });
    expect(withoutSpentInvites(denied, cap.body.expires_at + 300).state.node_invites).toEqual({});
    expect(
      withoutSpentInvites(pending, cap.body.expires_at + 300).state.node_invites[inviteId]?.status,
    ).toBe("pending");
  });

  it("prevents human/node key overlap in both directions and enforces MAX_NODES", async () => {
    for (const target of [
      {
        op: "add" as const,
        account_id: "acct",
        role: "operator" as const,
        peer_keys: [peer],
        invite_id: null,
      },
      {
        op: "add_owner_device" as const,
        cert: await signStatement(
          "OwnerDeviceCert",
          { ...certBody(world.invitee), peer_keys: [] },
          world.root,
        ),
      },
      {
        op: "add_owner_device" as const,
        cert: await signStatement(
          "OwnerDeviceCert",
          { ...certBody(world.mallory), peer_keys: [peer] },
          world.root,
        ),
      },
    ]) {
      expect(
        await submitStatement(admitted, await signChange(admitted, world.root, target), context),
      ).toMatchObject({ ok: false, code: "target_mismatch" });
    }
    const ownerW = formatIrohEndpointKey(world.device1.signer.publicKey);
    const parts = { claw_id: world.state.claw_id, invite_id: inviteId, peer_key: ownerW };
    const request = await signStatement(
      "NodeRedemption",
      {
        ...parts,
        requested_at: WORLD_NOW,
        proof: await computeNodeRedemptionProof(proofKey, parts),
      },
      world.device1.signer,
    );
    const ownerPending = stateOf(await submitNodeRedemption(registered, request, WORLD_NOW));
    expect(await approve(ownerPending, inviteId, ownerW)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const full = {
      ...pending,
      nodes: Object.fromEntries(
        Array.from({ length: MAX_NODES }, (_, i) => [
          `iroh:${i.toString(16).padStart(64, "0")}`,
          admitted.nodes[peer]!,
        ]),
      ),
    };
    expect(await approve(full)).toMatchObject({ ok: false, code: "limit_reached" });
  });

  it("removes node pairings and refuses revocation replay after fresh approval", async () => {
    const revoke = await signRevocation(
      admitted,
      world.device1.signer,
      await fingerprint(peer),
      "peer_key",
    );
    for (const statement of [
      revoke,
      await signChange(admitted, world.device1.signer, { op: "remove_node", peer_key: peer }),
    ]) {
      const removed = await submitStatement(admitted, statement, context);
      expect(isAdmitted(stateOf(removed), peer, WORLD_NOW)).toBe(false);
      expect(removed.events).toEqual([
        { type: "disconnect", peer_keys: [peer] },
        { type: "invalidate_tokens", peer_keys: [peer] },
        { type: "remove_node_pairings", peer_keys: [peer] },
        { type: "publish_snapshot" },
      ]);
    }
    let next = stateOf(await submitStatement(admitted, revoke, context));
    const freshId = "cd".repeat(16);
    next = stateOf(await registerNodeInvite(next, await nodeCap(freshId), proofKey, context));
    next = stateOf(await submitNodeRedemption(next, await nodeRedemption(freshId), WORLD_NOW));
    next = stateOf(await approve(next, freshId));
    expect(next.nodes[peer]?.listed_seq).toBeGreaterThan(admitted.seq);
    expect(await submitStatement(next, revoke, context)).toMatchObject({
      ok: false,
      code: "seq_conflict",
      state: next,
      events: [],
    });
  });

  it("expires idle nodes with pairing cleanup, rate-limits seen writes and removes open invites with their creator", async () => {
    expect(recordSeen(admitted, peer, WORLD_NOW + 60)).toBeNull();
    const seen = recordSeen(admitted, peer, WORLD_NOW + 3600)!;
    expect(seen.nodes[peer]?.last_seen).toBe(WORLD_NOW + 3600);
    const windows = { ...DEFAULT_INACTIVITY_WINDOWS, nodeSeconds: 10 };
    expect(nextInactivityDrop(admitted, windows)).toBe(WORLD_NOW + 11);
    const dropped = dropInactive(admitted, WORLD_NOW + 11, windows)!;
    expect(dropped.peers).toEqual([peer]);
    expect(dropped.events).toContainEqual({ type: "remove_node_pairings", peer_keys: [peer] });
    expect(isNode(dropped.state, peer)).toBe(false);
    const removed = stateOf(
      await submitStatement(
        registered,
        await signRevocation(registered, world.root, await fingerprint(world.device1.pub)),
        context,
      ),
    );
    expect(removed.node_invites).toEqual({});
  });
});
