// Node-only authority: pending invitations never admit a key; an owner signs every addition.
import { hexToBytes } from "../bytes.js";
import { inviteSecretHash } from "../invites.js";
import { fingerprint, formatIrohEndpointKey, rawPublicKey, type IrohEndpointKey } from "../keys.js";
import { MAX_NODE_INVITE_LIFETIME_SECONDS, verifyNodeRedemption } from "../node-invites.js";
import {
  MAX_INVITES,
  MAX_NODES,
  type MembershipTarget,
  type UnixSeconds,
} from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyOwnerStatement, type Authority } from "../statements/verify.js";
import type { WriteContext } from "./apply.js";
import { withoutSpentInvites } from "./invite-retention.js";
import {
  applied,
  ownerLookup,
  proofKeyHex,
  refuse,
  type AuthorityEvent,
  type AuthorityResult,
  type AuthorityState,
} from "./state.js";

/** Register a single-use NodeInviteCap directly; member and node invite IDs share one namespace. */
export async function registerNodeInvite(
  state: AuthorityState,
  input: unknown,
  proofKey: Uint8Array,
  context: WriteContext,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input, "NodeInviteCap");
  if (!parsed.ok) {
    return refuse(state, parsed.code, parsed.detail);
  }
  if (context.channel === "mailbox") {
    return refuse(state, "not_direct", "invites are registered directly at the Gateway");
  }
  const verified = await verifyOwnerStatement(parsed.statement, state.anchor, {
    now: context.now,
    owners: ownerLookup(state, context.now),
  });
  if (!verified.ok) {
    return refuse(state, verified.code, verified.detail);
  }
  const cap = parsed.statement.body;
  if (cap.claw_id !== state.claw_id) {
    return refuse(state, "wrong_claw", "invite is for another claw");
  }
  if ((await inviteSecretHash(proofKey)) !== cap.secret_hash) {
    return refuse(state, "bad_proof", "proof key does not match secret_hash");
  }
  if (cap.expires_at <= context.now) {
    return refuse(state, "expired", "invite expired");
  }
  if (
    cap.expires_at <= cap.created_at ||
    cap.expires_at - cap.created_at > MAX_NODE_INVITE_LIFETIME_SECONDS ||
    cap.expires_at - context.now > MAX_NODE_INVITE_LIFETIME_SECONDS
  ) {
    return refuse(state, "limit_reached", "a node invite lasts at most one hour");
  }
  const kept = withoutSpentInvites(state, context.now).state;
  if (kept.invites[cap.invite_id] || kept.node_invites[cap.invite_id]) {
    return refuse(state, "invite_used", "invite id already registered");
  }
  if (Object.keys(kept.invites).length + Object.keys(kept.node_invites).length >= MAX_INVITES) {
    return refuse(state, "limit_reached", `a claw keeps at most ${MAX_INVITES} invites`);
  }
  return applied({
    ...kept,
    node_invites: {
      ...kept.node_invites,
      [cap.invite_id]: {
        cap,
        proof_key: proofKeyHex(proofKey),
        status: "open",
        pending: null,
        created_by:
          verified.authority.kind === "root" ? "root" : await fingerprint(parsed.statement.signer),
      },
    },
  });
}

/** Accountless W-signed redemption; reserves the invite but grants no access. */
export async function submitNodeRedemption(
  state: AuthorityState,
  input: unknown,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input, "NodeRedemption");
  if (!parsed.ok) {
    return refuse(state, parsed.code, parsed.detail);
  }
  const body = parsed.statement.body;
  const invite = state.node_invites[body.invite_id];
  if (!invite) {
    return refuse(state, "invite_unknown", "no such node invite");
  }
  if (invite.status !== "open") {
    return refuse(state, "invite_used", "invite already redeemed");
  }
  const verified = await verifyNodeRedemption(
    parsed.statement,
    invite.cap,
    hexToBytes(invite.proof_key),
    now,
  );
  if (!verified.ok) {
    return refuse(state, verified.code, verified.detail);
  }
  return {
    ok: true,
    status: "pending",
    state: {
      ...state,
      node_invites: {
        ...state.node_invites,
        [body.invite_id]: {
          ...invite,
          status: "pending",
          pending: { peer_key: body.peer_key, requested_at: now, description: body.description },
        },
      },
    },
    events: [{ type: "notify_owners", event: "redemption_pending", ref: body.invite_id }],
  };
}

/** Owner-signed approval, called only after signature, channel and seq checks. */
export async function addNode(
  state: AuthorityState,
  target: Extract<MembershipTarget, { op: "add_node" }>,
  authority: Extract<Authority, { kind: "root" | "owner_device" }>,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  const invite = state.node_invites[target.invite_id];
  if (!invite || invite.status !== "pending" || !invite.pending) {
    return refuse(state, "invite_not_pending", "no pending node redemption");
  }
  if (invite.pending.peer_key !== target.peer_key) {
    return refuse(state, "target_mismatch", "approval does not match pending node");
  }
  // A raw key cannot have both node authority and human/root authority, even with a different prefix.
  if (
    formatIrohEndpointKey(rawPublicKey(state.anchor.root_pub)) === target.peer_key ||
    Object.values(state.owner_devices).some(
      (record) =>
        formatIrohEndpointKey(rawPublicKey(record.cert.body.device_pub)) === target.peer_key ||
        record.cert.body.peer_keys.includes(target.peer_key),
    ) ||
    Object.values(state.members).some((member) => member.peer_keys.includes(target.peer_key))
  ) {
    return refuse(state, "target_mismatch", "node key is already a human authority key");
  }
  const existing = state.nodes[target.peer_key];
  if (!existing && Object.keys(state.nodes).length >= MAX_NODES) {
    return refuse(state, "limit_reached", `a claw has at most ${MAX_NODES} nodes`);
  }
  return applied(
    {
      ...state,
      nodes: {
        ...state.nodes,
        [target.peer_key]: {
          label: target.label,
          description: invite.pending.description,
          listed_seq: existing?.listed_seq ?? state.seq,
          added_by: authority.kind === "root" ? "root" : await fingerprint(authority.device_pub),
          last_seen: existing?.last_seen ?? now,
          invite_id: target.invite_id,
        },
      },
      node_invites: {
        ...state.node_invites,
        [target.invite_id]: { ...invite, status: "consumed", pending: null },
      },
    },
    [
      { type: "notify_owners", event: "redemption_resolved", ref: target.invite_id },
      { type: "publish_snapshot" },
    ],
  );
}

/** Deletes node listings only; caller decides the seq and combines other removal effects. */
export function withoutNodes(
  state: AuthorityState,
  peers: readonly IrohEndpointKey[],
): AuthorityState {
  const nodes = { ...state.nodes };
  for (const key of peers) {
    delete nodes[key];
  }
  return { ...state, nodes };
}

/** Every node removal also removes the node-role device pairings associated with W. */
export function nodeRemovalEvents(peers: IrohEndpointKey[]): AuthorityEvent[] {
  return [
    { type: "disconnect", peer_keys: peers },
    { type: "invalidate_tokens", peer_keys: peers },
    { type: "remove_node_pairings", peer_keys: peers },
    { type: "publish_snapshot" },
  ];
}
