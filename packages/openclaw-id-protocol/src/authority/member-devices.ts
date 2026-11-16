// Member browser additions and offline recovery-device registration.
import {
  fingerprint,
  formatIrohEndpointKey,
  rawPublicKey,
  type Ed25519PublicKey,
} from "../keys.js";
import {
  MAX_MEMBER_PEER_KEYS,
  type SignedStatement,
  type UnixSeconds,
} from "../statements/types.js";
import type { Authority } from "../statements/verify.js";
import { peerKeyListedSeq } from "./allowlist.js";
import {
  applied,
  isMemberRecoveryKey,
  refuse,
  type AuthorityState,
  type AuthorityResult,
  type MemberDeviceApprover,
} from "./state.js";

export function deviceSigningKeyListed(
  state: AuthorityState,
  devicePub: Ed25519PublicKey,
): boolean {
  return (
    Object.values(state.owner_devices).some((owner) => owner.cert.body.device_pub === devicePub) ||
    Object.values(state.members).some((member) =>
      member.peer_keys.some((peer) => member.devices?.[peer]?.device_pub === devicePub),
    )
  );
}

export function setMemberRecoveryKit(
  state: AuthorityState,
  target: Extract<
    SignedStatement<"MembershipChange">["body"]["target"],
    { op: "set_member_recovery_kit" }
  >,
  authority: Authority,
): AuthorityResult {
  if (
    authority.kind !== "root" &&
    authority.kind !== "owner_device" &&
    authority.kind !== "member_device"
  ) {
    return refuse(state, "not_an_owner", "a recovery key cannot replace itself");
  }
  const member = state.members[target.account_id];
  if (
    !member ||
    (authority.kind === "member_device" && authority.account_id !== target.account_id)
  ) {
    return refuse(state, "target_mismatch", "a member may manage only their own recovery kit");
  }
  const key = target.device_pub;
  if (key) {
    const peer = formatIrohEndpointKey(rawPublicKey(key));
    if (
      key === state.anchor.root_pub ||
      deviceSigningKeyListed(state, key) ||
      peerKeyListedSeq(state, peer) !== undefined ||
      isMemberRecoveryKey(state, key)
    ) {
      return refuse(state, "target_mismatch", "recovery signing key is already listed");
    }
  }
  const { recovery_kit: _kit, ...rest } = member;
  return applied(
    {
      ...state,
      members: {
        ...state.members,
        [target.account_id]: { ...rest, ...(key ? { recovery_kit: { device_pub: key } } : {}) },
      },
    },
    [{ type: "publish_snapshot" }],
  );
}

export async function addMemberDevice(
  state: AuthorityState,
  target: Extract<
    SignedStatement<"MembershipChange">["body"]["target"],
    { op: "add_member_device" }
  >,
  authority: Authority,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  if (
    authority.kind !== "root" &&
    authority.kind !== "owner_device" &&
    authority.kind !== "member_device" &&
    authority.kind !== "member_recovery_kit"
  ) {
    return refuse(state, "not_an_owner", "signer cannot add a member device");
  }
  const member = state.members[target.account_id];
  if (!member) {
    return refuse(state, "target_mismatch", "unknown member");
  }
  if (
    (authority.kind === "member_device" || authority.kind === "member_recovery_kit") &&
    authority.account_id !== target.account_id
  ) {
    return refuse(state, "target_mismatch", "a member may add devices only to their own account");
  }
  if (member.peer_keys.length >= MAX_MEMBER_PEER_KEYS) {
    return refuse(
      state,
      "limit_reached",
      `a member has at most ${MAX_MEMBER_PEER_KEYS} devices at a claw`,
    );
  }
  if (peerKeyListedSeq(state, target.peer_key) !== undefined) {
    return refuse(state, "target_mismatch", "peer key is already listed");
  }
  if (
    deviceSigningKeyListed(state, target.device_pub) ||
    isMemberRecoveryKey(state, target.device_pub) ||
    isMemberRecoveryKey(state, target.peer_key)
  ) {
    return refuse(state, "target_mismatch", "device signing key is already listed");
  }
  if (authority.kind === "member_recovery_kit") {
    return admitRecoveredMemberDevice(state, target, authority, now);
  }
  const approvedBy: MemberDeviceApprover =
    authority.kind === "member_device"
      ? { kind: "member_device", device_fp: await fingerprint(authority.device_pub) }
      : {
          kind: "owner",
          by: authority.kind === "root" ? "root" : await fingerprint(authority.device_pub),
        };
  return admitVerifiedMemberDevice(state, target, approvedBy, now);
}

// The recovery admission decision: a verified kit currently takes effect immediately.
// Owner notification and durable Gateway evidence accompany the ordinary admission effects.
async function admitRecoveredMemberDevice(
  state: AuthorityState,
  target: Parameters<typeof addMemberDevice>[1],
  authority: Extract<Authority, { kind: "member_recovery_kit" }>,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  return admitVerifiedMemberDevice(
    state,
    target,
    {
      kind: "member_recovery_kit",
      device_fp: await fingerprint(authority.device_pub),
    },
    now,
  );
}

async function admitVerifiedMemberDevice(
  state: AuthorityState,
  target: Parameters<typeof addMemberDevice>[1],
  approved_by: MemberDeviceApprover,
  now: UnixSeconds,
): Promise<AuthorityResult> {
  const member = state.members[target.account_id]!;
  return applied(
    {
      ...state,
      members: {
        ...state.members,
        [target.account_id]: {
          ...member,
          peer_keys: [...member.peer_keys, target.peer_key],
          listed_seq: [...member.peer_keys.map((_, i) => member.listed_seq?.[i] ?? 0), state.seq],
          last_seen: { ...member.last_seen, [target.peer_key]: now },
          devices: {
            ...member.devices,
            [target.peer_key]: { device_pub: target.device_pub, label: target.label, approved_by },
          },
        },
      },
    },
    [
      { type: "publish_snapshot" },
      {
        type: "notify_owners",
        event: "member_device_added",
        ref: await fingerprint(target.peer_key),
      },
    ],
  );
}
