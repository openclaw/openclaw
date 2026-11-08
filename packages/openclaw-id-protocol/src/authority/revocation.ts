// Revocation rules of the reference membership authority. A Revocation covers only the
// listings its signer saw (its claw, at or before its seq), so replaying captured bytes after
// a key is approved again changes nothing and no list of past revocations is kept.
import { fingerprint, type IrohEndpointKey, type KeyFingerprint } from "../keys.js";
import type { SignedStatement } from "../statements/types.js";
import {
  approvalDescendants,
  memberPeerListedSeq,
  ownerDeviceListedSeq,
  ownerPeerListedSeq,
  withoutMemberBrowsers,
  withoutOwnerDevices,
} from "./allowlist.js";
import { withoutNodes } from "./nodes.js";
import { applied, refuse, type AuthorityResult, type AuthorityState } from "./state.js";

// A listing a revocation targets: an owner device, or one member's browser, with the seq at
// which it was listed.
type RevocationMatch =
  | { kind: "owner_device"; fp: KeyFingerprint; listedSeq: number }
  | { kind: "node"; key: IrohEndpointKey; listedSeq: number }
  | { kind: "member_browser"; account: string; key: IrohEndpointKey; listedSeq: number };

/**
 * Applies a verified Revocation. It removes the key now when it covers the key's listing: the
 * revocation is for this claw, its seq is not ahead of the claw's, and the key was listed at
 * or before that seq. A key listed again later is a new approval the signer never saw, so
 * replaying the same bytes is refused and changes nothing. An owner device goes with every
 * device it approved (from approved_by now, whenever they were listed); a peer key leaves its
 * member, or takes its owner device (and that device's approvals) with it. An unknown target
 * changes nothing.
 */
export async function applyRevocation(
  state: AuthorityState,
  revocation: SignedStatement<"Revocation">,
): Promise<AuthorityResult> {
  const body = revocation.body;
  if (body.claw_id !== state.claw_id) {
    return refuse(state, "wrong_claw", "revocation is for another claw");
  }
  if (body.seq > state.seq) {
    return refuse(state, "seq_conflict", `revocation seq is ahead of the claw's seq ${state.seq}`);
  }
  const matches =
    body.target_kind === "owner_device"
      ? ownerDeviceMatches(state, body.target_fp)
      : await peerKeyMatches(state, body.target_fp);
  const covered = matches.filter((match) => match.listedSeq <= body.seq);
  if (matches.length > 0 && covered.length === 0) {
    return refuse(
      state,
      "seq_conflict",
      `the key was listed again after seq ${body.seq}; sign a new revocation`,
    );
  }
  if (covered.length === 0) {
    return applied(state);
  }
  // Each covered owner device goes with every device it approved, however recently.
  const devices = new Set(
    covered.flatMap((match) =>
      match.kind === "owner_device" ? approvalDescendants(state, match.fp) : [],
    ),
  );
  const owners = withoutOwnerDevices(state, [...devices]);
  const browsers = covered.flatMap((match) => (match.kind === "member_browser" ? [match] : []));
  const nodes = covered.flatMap((match) => (match.kind === "node" ? [match.key] : []));
  const next = withoutMemberBrowsers(owners.state, (account, key) =>
    browsers.some((browser) => browser.account === account && browser.key === key),
  );
  const removed = [
    ...new Set([...owners.peers, ...browsers.map((browser) => browser.key), ...nodes]),
  ];
  return applied(withoutNodes(next, nodes), [
    { type: "disconnect", peer_keys: removed },
    { type: "invalidate_tokens", peer_keys: removed },
    ...(nodes.length ? [{ type: "remove_node_pairings" as const, peer_keys: nodes }] : []),
    { type: "publish_snapshot" },
  ]);
}

// The owner device listed under this fingerprint, if any.
function ownerDeviceMatches(state: AuthorityState, target: KeyFingerprint): RevocationMatch[] {
  const record = state.owner_devices[target];
  return record
    ? [{ kind: "owner_device", fp: target, listedSeq: ownerDeviceListedSeq(record) }]
    : [];
}

// Every owner device and member browser holding a peer key with this fingerprint. An owner
// device is matched by when it was given that key, not by when it was first listed.
async function peerKeyMatches(
  state: AuthorityState,
  target: KeyFingerprint,
): Promise<RevocationMatch[]> {
  const matches: RevocationMatch[] = [];
  for (const [fp, record] of Object.entries(state.owner_devices)) {
    for (const key of record.cert.body.peer_keys) {
      if ((await fingerprint(key)) === target) {
        matches.push({
          kind: "owner_device",
          // SAFETY: owner_devices is keyed by KeyFingerprint; Object.entries widens keys to string.
          fp: fp as KeyFingerprint,
          listedSeq: ownerPeerListedSeq(record, key) ?? 0,
        });
      }
    }
  }
  for (const [account, member] of Object.entries(state.members)) {
    for (const key of member.peer_keys) {
      if ((await fingerprint(key)) === target) {
        const listedSeq = memberPeerListedSeq(member, key) ?? 0;
        matches.push({ kind: "member_browser", account, key, listedSeq });
      }
    }
  }
  for (const [key, node] of Object.entries(state.nodes)) {
    // SAFETY: nodes is keyed by IrohEndpointKey; Object.entries widens keys to string.
    const peer = key as IrohEndpointKey;
    if ((await fingerprint(peer)) === target) {
      matches.push({ kind: "node", key: peer, listedSeq: node.listed_seq });
    }
  }
  return matches;
}
