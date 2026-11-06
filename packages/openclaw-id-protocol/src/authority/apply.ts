// Write rules of the reference membership authority: who may change what, over which channel.
import { hexToBytes } from "../bytes.js";
import { inviteSecretHash, verifyInviteRedemption, type AssertedIdentity } from "../invites.js";
import { fingerprint, formatIrohEndpointKey, rawPublicKey, type IrohEndpointKey } from "../keys.js";
import {
  MAX_INVITES,
  MAX_MEMBER_PEER_KEYS,
  MAX_MEMBERS,
  MAX_OWNER_DEVICE_PEER_KEYS,
  MAX_OWNER_DEVICES,
  MEMBER_ROLES,
  type MemberRole,
  type SignedStatement,
  type UnixSeconds,
} from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyOwnerStatement, type Authority, type VerifyOptions } from "../statements/verify.js";
import { ownerDeviceListedSeq, peerKeyListedSeq, withoutMemberPeerKeys } from "./allowlist.js";
import { inviteLifetimeError, withoutSpentInvites } from "./invite-retention.js";
import { addNode, nodeRemovalEvents, withoutNodes } from "./nodes.js";
import { applyRevocation } from "./revocation.js";
import {
  applied,
  certificateWindowError,
  ownerLookup,
  proofKeyHex,
  refuse,
  type AuthorityEvent,
  type AuthorityResult,
  type AuthorityState,
  type Channel,
  type MemberRecord,
  type OwnerApprover,
  type OwnerDeviceRecord,
} from "./state.js";

/** Context of one write. */
export type WriteContext = { channel: Channel; now: UnixSeconds };

function verifyOptions(state: AuthorityState, now: UnixSeconds): VerifyOptions {
  return { now, owners: ownerLookup(state, now) };
}

function roleRank(role: MemberRole): number {
  return MEMBER_ROLES.indexOf(role);
}

// Mailbox policy (spec sections 6 and 7): through Discovery, only root-signed statements,
// revocations and redemption requests. Device-signed approvals must arrive directly.
function mailboxAllows(statement: SignedStatement, authority: Authority): boolean {
  return statement.type === "Revocation" || authority.kind === "root";
}

/**
 * Applies a signed statement (MembershipChange or Revocation). InviteCaps use
 * `registerInvite` and redemptions use `submitRedemption`.
 */
export async function submitStatement(
  state: AuthorityState,
  input: unknown,
  context: WriteContext,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input);
  if (!parsed.ok) {
    return refuse(state, parsed.code, parsed.detail);
  }
  const statement = parsed.statement;
  switch (statement.type) {
    case "MembershipChange":
    case "Revocation":
      return applyOwnerStatement(
        state,
        // SAFETY: parseStatement validated the body against the schema for `statement.type`.
        statement as SignedStatement<"MembershipChange" | "Revocation">,
        context,
      );
    default:
      return refuse(
        state,
        "unsupported",
        `${statement.type} is not written through submitStatement`,
      );
  }
}

// Shared gate for owner-signed writes: verify, then channel rules, then dispatch.
async function applyOwnerStatement(
  state: AuthorityState,
  statement: SignedStatement<"MembershipChange" | "Revocation">,
  context: WriteContext,
): Promise<AuthorityResult> {
  const verified = await verifyOwnerStatement(
    statement,
    state.anchor,
    verifyOptions(state, context.now),
  );
  if (!verified.ok) {
    return refuse(state, verified.code, verified.detail);
  }
  if (context.channel === "mailbox" && !mailboxAllows(statement, verified.authority)) {
    return refuse(
      state,
      "not_direct",
      "device-signed changes must reach the Gateway directly, not through Discovery",
    );
  }
  if (statement.type === "Revocation") {
    // SAFETY: SignedStatement is not a discriminated union; `type` fixes the validated body.
    return applyRevocation(state, statement as SignedStatement<"Revocation">);
  }
  return applyMembershipChange(
    state,
    // SAFETY: the branch above handled the only other member of the type union.
    statement as SignedStatement<"MembershipChange">,
    verified.authority,
    context,
  );
}

async function applyMembershipChange(
  state: AuthorityState,
  change: SignedStatement<"MembershipChange">,
  authority: Authority,
  context: WriteContext,
): Promise<AuthorityResult> {
  const body = change.body;
  if (body.claw_id !== state.claw_id) {
    return refuse(state, "wrong_claw", "change is for another claw");
  }
  if (body.seq !== state.seq + 1) {
    return refuse(state, "seq_conflict", `expected seq ${state.seq + 1}`);
  }
  const result = await applyTarget({ ...state, seq: body.seq }, body.target, authority, context);
  return result.ok ? result : { ...result, state };
}

// Dispatches a MembershipChange target. `state` already carries the new seq.
async function applyTarget(
  state: AuthorityState,
  target: SignedStatement<"MembershipChange">["body"]["target"],
  authority: Authority,
  context: WriteContext,
): Promise<AuthorityResult> {
  switch (target.op) {
    case "add_node":
      if (authority.kind !== "root" && authority.kind !== "owner_device") {
        return refuse(state, "not_an_owner", "only an owner can add a node");
      }
      return addNode(state, target, authority, context.now);
    case "remove_node":
      if (!state.nodes[target.peer_key]) {
        return refuse(state, "target_mismatch", "unknown node");
      }
      return applied(withoutNodes(state, [target.peer_key]), nodeRemovalEvents([target.peer_key]));
    case "add":
      return addMember(state, target, context.now);
    case "remove": {
      const member = state.members[target.account_id];
      if (!member) {
        return refuse(state, "target_mismatch", "unknown member");
      }
      const members = Object.fromEntries(
        Object.entries(state.members).filter(([account]) => account !== target.account_id),
      );
      return applied({ ...state, members }, [
        { type: "disconnect", peer_keys: member.peer_keys },
        { type: "invalidate_tokens", peer_keys: member.peer_keys },
        { type: "cancel_runs", account_id: target.account_id },
        { type: "publish_snapshot" },
      ]);
    }
    case "set_role": {
      const member = state.members[target.account_id];
      if (!member) {
        return refuse(state, "target_mismatch", "unknown member");
      }
      return applied(
        {
          ...state,
          members: { ...state.members, [target.account_id]: { ...member, role: target.role } },
        },
        [{ type: "publish_snapshot" }],
      );
    }
    case "revoke_device":
      return applyRemovalOfPeer(state, target.peer_key);
    case "add_owner_device":
      return addOwnerDevice(state, target.cert, authority, context);
    case "deny_invite": {
      const nodeInvite = state.node_invites[target.invite_id];
      if (nodeInvite?.status === "pending") {
        return applied(
          {
            ...state,
            node_invites: {
              ...state.node_invites,
              [target.invite_id]: {
                ...nodeInvite,
                status: "consumed",
                pending: null,
              },
            },
          },
          [
            { type: "notify_owners", event: "redemption_resolved", ref: target.invite_id },
            { type: "publish_snapshot" },
          ],
        );
      }
      const invite = state.invites[target.invite_id];
      if (!invite || invite.status !== "pending") {
        return refuse(state, "invite_not_pending", "no pending redemption for this invite");
      }
      return applied(
        {
          ...state,
          invites: {
            ...state.invites,
            [target.invite_id]: { ...invite, status: "consumed", pending: null },
          },
        },
        // The seq moved: republish so clients that sign at the snapshot's seq + 1 stay current.
        [
          { type: "notify_owners", event: "redemption_resolved", ref: target.invite_id },
          { type: "publish_snapshot" },
        ],
      );
    }
    default:
      return refuse(state, "unsupported", "unknown membership operation");
  }
}

// Removes one member browser (peer key); the member stays listed.
function applyRemovalOfPeer(state: AuthorityState, peer: IrohEndpointKey): AuthorityResult {
  return applied(withoutMemberPeerKeys(state, [peer]), [
    { type: "disconnect", peer_keys: [peer] },
    { type: "invalidate_tokens", peer_keys: [peer] },
    { type: "publish_snapshot" },
  ]);
}

// Adds a member directly, or approves a pending redemption when `invite_id` is set.
// The caps hold: at most MAX_MEMBERS members and MAX_MEMBER_PEER_KEYS browsers each.
function addMember(
  state: AuthorityState,
  target: Extract<SignedStatement<"MembershipChange">["body"]["target"], { op: "add" }>,
  now: UnixSeconds,
): AuthorityResult {
  if (target.peer_keys.some((key) => state.nodes[key])) {
    return refuse(state, "target_mismatch", "a node key cannot be a member key");
  }
  const existing = state.members[target.account_id];
  if (!existing && Object.keys(state.members).length >= MAX_MEMBERS) {
    return refuse(state, "limit_reached", `a claw has at most ${MAX_MEMBERS} members`);
  }
  const peerKeys = [...new Set([...(existing?.peer_keys ?? []), ...target.peer_keys])];
  if (peerKeys.length > MAX_MEMBER_PEER_KEYS) {
    return refuse(
      state,
      "limit_reached",
      `a member has at most ${MAX_MEMBER_PEER_KEYS} devices at a claw`,
    );
  }
  const lastSeen = { ...existing?.last_seen };
  for (const key of target.peer_keys) {
    lastSeen[key] ??= now;
  }
  // A browser already listed anywhere keeps its earliest listing seq; a new one is listed at
  // this change's seq.
  const listedSeq = peerKeys.map((key) => peerKeyListedSeq(state, key) ?? state.seq);
  const member: MemberRecord = {
    role: target.role,
    peer_keys: peerKeys,
    last_seen: lastSeen,
    listed_seq: listedSeq,
  };
  if (target.invite_id === null) {
    return applied({ ...state, members: { ...state.members, [target.account_id]: member } }, [
      { type: "publish_snapshot" },
    ]);
  }
  const invite = state.invites[target.invite_id];
  if (!invite || invite.status !== "pending" || !invite.pending) {
    return refuse(state, "invite_not_pending", "no pending redemption for this invite");
  }
  const pending = invite.pending;
  if (pending.account_id !== target.account_id || !target.peer_keys.includes(pending.peer_key)) {
    return refuse(state, "target_mismatch", "approval does not match the pending redemption");
  }
  if (roleRank(target.role) < roleRank(invite.cap.role)) {
    return refuse(state, "target_mismatch", "approval grants more than the invite");
  }
  return applied(
    {
      ...state,
      members: { ...state.members, [target.account_id]: member },
      invites: {
        ...state.invites,
        [target.invite_id]: { ...invite, status: "consumed", pending: null },
      },
    },
    [
      { type: "notify_owners", event: "redemption_resolved", ref: target.invite_id },
      { type: "publish_snapshot" },
    ],
  );
}

// The certificate's signer must be R or a current owner device with approve_device, and an
// owner device may grant only caps it holds (R may grant any); the Gateway records the
// granted caps and the signer as approved_by. At most MAX_OWNER_DEVICES devices are listed.
async function addOwnerDevice(
  state: AuthorityState,
  cert: SignedStatement<"OwnerDeviceCert">,
  authority: Authority,
  context: WriteContext,
): Promise<AuthorityResult> {
  const verified = await verifyOwnerStatement(
    cert,
    state.anchor,
    verifyOptions(state, context.now),
  );
  if (!verified.ok) {
    return refuse(state, verified.code, `certificate: ${verified.detail}`);
  }
  const window = certificateWindowError(cert.body, context.now);
  if (window) {
    return refuse(state, window.code, `certificate: ${window.detail}`);
  }
  if (cert.body.peer_keys.length > MAX_OWNER_DEVICE_PEER_KEYS) {
    return refuse(
      state,
      "limit_reached",
      `an owner device has at most ${MAX_OWNER_DEVICE_PEER_KEYS} peer keys`,
    );
  }
  if (
    [formatIrohEndpointKey(rawPublicKey(cert.body.device_pub)), ...cert.body.peer_keys].some(
      (key) => state.nodes[key],
    )
  ) {
    return refuse(state, "target_mismatch", "a node key cannot be an owner device key");
  }
  const fp = await fingerprint(cert.body.device_pub);
  const existing = state.owner_devices[fp];
  // verifyOwnerStatement already held the grant within the signing device's recorded caps.
  // Re-adding a listed device through an owner device never raises what it already holds.
  if (
    existing &&
    verified.authority.kind !== "root" &&
    !cert.body.caps.every((cap) => existing.caps.includes(cap))
  ) {
    return refuse(
      state,
      "caps_escalation",
      "re-adding an owner device cannot raise its capabilities; only the recovery kit can",
    );
  }
  if (!existing && Object.keys(state.owner_devices).length >= MAX_OWNER_DEVICES) {
    return refuse(
      state,
      "limit_reached",
      `a claw has at most ${MAX_OWNER_DEVICES} owner devices; remove one to add another`,
    );
  }
  // A device already listed keeps its listing seq, and each peer key already listed anywhere
  // keeps its earliest one, so re-adding a device never moves it out of reach of a revocation
  // already signed.
  const record: OwnerDeviceRecord = {
    cert,
    caps: [...cert.body.caps],
    approved_by: verified.authority.kind === "root" ? "root" : await fingerprint(cert.signer),
    last_seen: context.now,
    listed_seq: existing ? ownerDeviceListedSeq(existing) : state.seq,
    peer_listed_seq: cert.body.peer_keys.map((key) => peerKeyListedSeq(state, key) ?? state.seq),
  };
  // A re-add replaces the device's peer keys: tear down every old key the new cert drops.
  const dropped = (existing?.cert.body.peer_keys ?? []).filter(
    (key) => !cert.body.peer_keys.includes(key),
  );
  const events: AuthorityEvent[] = [
    ...(dropped.length > 0
      ? [
          { type: "disconnect" as const, peer_keys: dropped },
          { type: "invalidate_tokens" as const, peer_keys: dropped },
        ]
      : []),
    { type: "publish_snapshot" },
  ];
  if (authority.kind === "root" && context.channel === "mailbox") {
    events.push({ type: "notify_owners", event: "kit_used", ref: fp });
  }
  return applied({ ...state, owner_devices: { ...state.owner_devices, [fp]: record } }, events);
}

/** Registers an InviteCap with its proof key. Owner devices do this directly at the Gateway. */
export async function registerInvite(
  state: AuthorityState,
  input: unknown,
  proofKey: Uint8Array,
  context: WriteContext,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input, "InviteCap");
  if (!parsed.ok) {
    return refuse(state, parsed.code, parsed.detail);
  }
  if (context.channel === "mailbox") {
    return refuse(state, "not_direct", "invites are registered directly at the Gateway");
  }
  const verified = await verifyOwnerStatement(
    parsed.statement,
    state.anchor,
    verifyOptions(state, context.now),
  );
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
  const lifetime = inviteLifetimeError(cap.expires_at, context.now);
  if (lifetime) {
    return refuse(state, lifetime.code, lifetime.detail);
  }
  // Spent records go first, so the cap counts only invites that can still matter.
  const kept = withoutSpentInvites(state, context.now).state;
  if (kept.invites[cap.invite_id] || kept.node_invites[cap.invite_id]) {
    return refuse(state, "invite_used", "invite id already registered");
  }
  if (Object.keys(kept.invites).length + Object.keys(kept.node_invites).length >= MAX_INVITES) {
    return refuse(
      state,
      "limit_reached",
      `a claw keeps at most ${MAX_INVITES} invites; wait for one to expire`,
    );
  }
  const createdBy: OwnerApprover =
    verified.authority.kind === "root" ? "root" : await fingerprint(parsed.statement.signer);
  return applied({
    ...kept,
    invites: {
      ...kept.invites,
      [cap.invite_id]: {
        cap,
        proof_key: proofKeyHex(proofKey),
        status: "open",
        pending: null,
        created_by: createdBy,
      },
    },
  });
}

/**
 * Records a redemption request (usually from the mailbox) as **pending**. It reserves
 * the invite so it cannot be redeemed twice, admits nothing, and prompts the owners.
 */
export async function submitRedemption(
  state: AuthorityState,
  input: unknown,
  identity: AssertedIdentity,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input, "InviteRedemption");
  if (!parsed.ok) {
    return refuse(state, parsed.code, parsed.detail);
  }
  const invite = state.invites[parsed.statement.body.invite_id];
  if (!invite) {
    return refuse(state, "invite_unknown", "no such invite");
  }
  if (invite.status !== "open") {
    return refuse(state, "invite_used", "invite already redeemed");
  }
  const verified = await verifyInviteRedemption(
    parsed.statement,
    invite.cap,
    hexToBytes(invite.proof_key),
    identity,
    now,
  );
  if (!verified.ok) {
    return refuse(state, verified.code, verified.detail);
  }
  const body = parsed.statement.body;
  const record = {
    ...invite,
    status: "pending" as const,
    pending: {
      account_id: body.account_id,
      device_pub: body.device_pub,
      peer_key: body.peer_key,
      requested_at: now,
    },
  };
  return {
    ok: true,
    status: "pending",
    state: { ...state, invites: { ...state.invites, [body.invite_id]: record } },
    events: [{ type: "notify_owners", event: "redemption_pending", ref: body.invite_id }],
  };
}
