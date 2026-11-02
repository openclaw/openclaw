// Write rules of the reference membership authority: who may change what, over which channel.
import { hexToBytes } from "../bytes.js";
import { inviteSecretHash, verifyInviteRedemption, type AssertedIdentity } from "../invites.js";
import { fingerprint, type IrohEndpointKey, type KeyFingerprint } from "../keys.js";
import { hasValidSignature } from "../statements/envelope.js";
import {
  MEMBER_ROLES,
  type MemberRole,
  type SignedStatement,
  type UnixSeconds,
} from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  verifyOwnerStatement,
  verifyRootRotation,
  type Authority,
  type VerifyOptions,
} from "../statements/verify.js";
import {
  certificateWindowError,
  isOwnerDeviceActive,
  nextRootEpoch,
  ownerDevicePeerKeys,
  proofKeyHex,
  refuse,
  refuseWithTransition,
  type AuthorityEvent,
  type AuthorityResult,
  type AuthorityState,
  type Channel,
  type OwnerDeviceRecord,
} from "./state.js";

/** Context of one write. */
export type WriteContext = { channel: Channel; now: UnixSeconds };

function applied(state: AuthorityState, events: AuthorityEvent[] = []): AuthorityResult {
  return { ok: true, status: "applied", state, events };
}

function verifyOptions(state: AuthorityState, now: UnixSeconds): VerifyOptions {
  return { now, isRevoked: (fp) => state.revoked.includes(fp) };
}

function roleRank(role: MemberRole): number {
  return MEMBER_ROLES.indexOf(role);
}

// Mailbox policy (spec sections 6 and 7): through Discovery, only root-signed statements,
// revocations and redemption requests. Device-signed approvals must arrive directly.
function mailboxAllows(statement: SignedStatement, authority: Authority): boolean {
  return statement.type === "Revocation" || authority.kind === "root";
}

async function chainFingerprints(
  cert: SignedStatement<"OwnerDeviceCert">,
): Promise<KeyFingerprint[]> {
  const keys = [cert.body.device_pub, ...cert.chain.map((link) => link.body.device_pub)];
  return Promise.all(keys.map((key) => fingerprint(key)));
}

/**
 * Applies a signed statement (MembershipChange, Revocation, RootRotation, or a root-signed
 * OwnerDeviceCert re-certifying a known device). InviteCaps use `registerInvite` and
 * redemptions use `submitRedemption`.
 */
export async function submitStatement(
  state: AuthorityState,
  input: unknown,
  context: WriteContext,
): Promise<AuthorityResult> {
  const parsed = parseStatement(input);
  if (!parsed.ok) {
    return refuse(state, "malformed", parsed.detail);
  }
  const statement = parsed.statement;
  switch (statement.type) {
    case "RootRotation":
      return applyRootRotation(state, statement as SignedStatement<"RootRotation">, context);
    case "MembershipChange":
    case "Revocation":
    case "OwnerDeviceCert":
      return applyOwnerStatement(
        state,
        statement as SignedStatement<"MembershipChange" | "Revocation" | "OwnerDeviceCert">,
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

// Shared gate for owner-signed writes: verify, then channel and freeze rules, then dispatch.
async function applyOwnerStatement(
  state: AuthorityState,
  statement: SignedStatement<"MembershipChange" | "Revocation" | "OwnerDeviceCert">,
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
  if (state.frozen && verified.authority.kind === "root" && context.channel !== "local_operator") {
    return refuse(
      state,
      "frozen",
      "remote root changes are frozen until the local operator resolves conflicting rotations",
    );
  }
  if (statement.type === "Revocation") {
    return applyRevocation(state, statement as SignedStatement<"Revocation">);
  }
  if (statement.type === "OwnerDeviceCert") {
    return applyRecertification(
      state,
      statement as SignedStatement<"OwnerDeviceCert">,
      verified.authority,
      context,
    );
  }
  return applyMembershipChange(
    state,
    statement as SignedStatement<"MembershipChange">,
    verified.authority,
    context,
  );
}

// A root-signed certificate for a device the Gateway already knows (chain compaction after kit use).
async function applyRecertification(
  state: AuthorityState,
  cert: SignedStatement<"OwnerDeviceCert">,
  authority: Authority,
  context: WriteContext,
): Promise<AuthorityResult> {
  const fp = await fingerprint(cert.body.device_pub);
  if (authority.kind !== "root" || !state.owner_devices[fp]) {
    return refuse(
      state,
      "unsupported",
      "only R re-certifies known owner devices; add devices with add_owner_device",
    );
  }
  const window = certificateWindowError(cert.body, context.now);
  if (window) {
    return refuse(state, window.code, window.detail);
  }
  const record: OwnerDeviceRecord = { cert, chain_fps: [fp] };
  return applied({ ...state, owner_devices: { ...state.owner_devices, [fp]: record } }, [
    { type: "publish_snapshot" },
  ]);
}

async function applyRevocation(
  state: AuthorityState,
  revocation: SignedStatement<"Revocation">,
): Promise<AuthorityResult> {
  const target = revocation.body.target_fp;
  if (state.revoked.includes(target)) {
    return applied(state);
  }
  const removedPeers: IrohEndpointKey[] = [];
  for (const [fp, record] of Object.entries(state.owner_devices)) {
    if (fp === target || record.chain_fps.includes(target)) {
      removedPeers.push(...record.cert.body.peer_keys);
    }
  }
  const memberPeers = Object.values(state.members).flatMap((member) => member.peer_keys);
  const peerFps = new Map(
    await Promise.all(memberPeers.map(async (peer) => [peer, await fingerprint(peer)] as const)),
  );
  const members = Object.fromEntries(
    Object.entries(state.members).map(([account, member]) => {
      removedPeers.push(...member.peer_keys.filter((peer) => peerFps.get(peer) === target));
      return [
        account,
        { ...member, peer_keys: member.peer_keys.filter((peer) => peerFps.get(peer) !== target) },
      ];
    }),
  );
  const next = { ...state, members, revoked: [...state.revoked, target] };
  return applied(next, [
    { type: "disconnect", peer_keys: removedPeers },
    { type: "invalidate_tokens", peer_keys: removedPeers },
    { type: "publish_snapshot" },
  ]);
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
    case "add":
      return addMember(state, target);
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
    case "revoke_device": {
      const fp = await fingerprint(target.peer_key);
      return applyRevocationOfPeer(state, target.peer_key, fp);
    }
    case "add_owner_device":
      return addOwnerDevice(state, target.cert, authority, context);
    case "deny_invite": {
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

function applyRevocationOfPeer(
  state: AuthorityState,
  peer: IrohEndpointKey,
  fp: KeyFingerprint,
): AuthorityResult {
  const members = Object.fromEntries(
    Object.entries(state.members).map(([account, member]) => [
      account,
      { ...member, peer_keys: member.peer_keys.filter((key) => key !== peer) },
    ]),
  );
  return applied(
    {
      ...state,
      members,
      revoked: state.revoked.includes(fp) ? state.revoked : [...state.revoked, fp],
    },
    [
      { type: "disconnect", peer_keys: [peer] },
      { type: "invalidate_tokens", peer_keys: [peer] },
      { type: "publish_snapshot" },
    ],
  );
}

// Adds a member directly, or approves a pending redemption when `invite_id` is set.
function addMember(
  state: AuthorityState,
  target: Extract<SignedStatement<"MembershipChange">["body"]["target"], { op: "add" }>,
): AuthorityResult {
  const existing = state.members[target.account_id];
  const member = {
    role: target.role,
    peer_keys: [...new Set([...(existing?.peer_keys ?? []), ...target.peer_keys])],
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
  // Chain verification checks the issuers; the new certificate's own window is checked here.
  const window = certificateWindowError(cert.body, context.now);
  if (window) {
    return refuse(state, window.code, `certificate: ${window.detail}`);
  }
  const fp = await fingerprint(cert.body.device_pub);
  const record: OwnerDeviceRecord = { cert, chain_fps: await chainFingerprints(cert) };
  const events: AuthorityEvent[] = [{ type: "publish_snapshot" }];
  if (authority.kind === "root" && context.channel === "mailbox") {
    events.push({ type: "notify_owners", event: "kit_used", ref: fp });
  }
  return applied({ ...state, owner_devices: { ...state.owner_devices, [fp]: record } }, events);
}

/**
 * Root rotation (spec section 8). Rotating the root is owner-key regeneration, so it
 * is accepted only from the local operator on direct loopback, even with a valid
 * signature from the current root. A second, different rotation out of an epoch that
 * already rotated, from any channel, still freezes remote root changes and alerts the
 * owners until the local operator resolves it.
 */
async function applyRootRotation(
  state: AuthorityState,
  rotation: SignedStatement<"RootRotation">,
  context: WriteContext,
): Promise<AuthorityResult> {
  const epoch = rotation.body.new_epoch;
  if (epoch <= state.anchor.root_epoch) {
    const previousRoot = state.root_history[epoch - 1];
    if (state.rotation_seen[epoch] === rotation.sig) {
      return applied(state);
    }
    if (previousRoot === rotation.signer && (await hasValidSignature(rotation))) {
      // The rotation is refused, but the freeze and the owner alert must take effect.
      return refuseWithTransition(
        { ...state, frozen: true },
        "conflicting_rotation",
        `a different rotation into epoch ${epoch} was already accepted`,
        [{ type: "notify_owners", event: "rotation_conflict", ref: String(epoch) }],
      );
    }
    return refuse(state, "wrong_epoch", "rotation is not from the current epoch");
  }
  if (state.frozen && context.channel !== "local_operator") {
    return refuse(state, "frozen", "remote root changes are frozen");
  }
  if (context.channel !== "local_operator") {
    return refuse(
      state,
      "not_local_operator",
      "owner-key regeneration needs direct loopback on the running Gateway",
    );
  }
  const verified = await verifyRootRotation(rotation, state.anchor);
  if (!verified.ok) {
    return refuse(state, verified.code, verified.detail);
  }
  // Every owner certificate is from the old epoch now: end those devices' sessions and tokens.
  const ended = ownerDevicePeerKeys(state);
  return applied(
    {
      ...state,
      anchor: verified.anchor,
      root_history: { ...state.root_history, [epoch]: verified.anchor.root_pub },
      rotation_seen: { ...state.rotation_seen, [epoch]: rotation.sig },
    },
    [
      { type: "disconnect", peer_keys: ended },
      { type: "invalidate_tokens", peer_keys: ended },
      { type: "publish_snapshot" },
    ],
  );
}

/**
 * Local-operator ceremony (spec section 8.3): pins a new root R' for this claw, clears a
 * freeze, and starts a new epoch. Refused for anything but direct loopback.
 */
export function repinRoot(
  state: AuthorityState,
  rootPub: SignedStatement["signer"],
  channel: Channel,
): AuthorityResult {
  if (channel !== "local_operator") {
    return refuse(state, "not_local_operator", "root ceremonies need direct loopback");
  }
  const epoch = nextRootEpoch(state);
  return applied(
    {
      ...state,
      frozen: false,
      anchor: { root_pub: rootPub, root_epoch: epoch },
      root_history: { ...state.root_history, [epoch]: rootPub },
    },
    [{ type: "publish_snapshot" }],
  );
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
    return refuse(state, "malformed", parsed.detail);
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
  if (state.invites[cap.invite_id]) {
    return refuse(state, "invite_used", "invite id already registered");
  }
  return applied({
    ...state,
    invites: {
      ...state.invites,
      [cap.invite_id]: { cap, proof_key: proofKeyHex(proofKey), status: "open", pending: null },
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
    return refuse(state, "malformed", parsed.detail);
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

/** Owner devices whose certificates are active at `now` (used by kit enrollment to compact chains). */
export function activeOwnerCerts(
  state: AuthorityState,
  now: UnixSeconds,
): SignedStatement<"OwnerDeviceCert">[] {
  return Object.values(state.owner_devices)
    .filter((record) => isOwnerDeviceActive(state, record, now))
    .map((record) => record.cert);
}
