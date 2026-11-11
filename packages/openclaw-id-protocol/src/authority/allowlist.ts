// Allowlist maintenance of the reference membership authority: removing an owner device
// together with every device it approved, recording when keys were last admitted, and
// dropping keys that have not been used for a long time. Nothing here keeps a history:
// a removed key is simply no longer listed. Each listed key carries the seq at which it
// was listed, so a revocation can tell whether it covers that listing.
import type { IrohEndpointKey, KeyFingerprint } from "../keys.js";
import type { UnixSeconds } from "../statements/types.js";
import type { AuthorityState, MemberRecord, OwnerDeviceRecord } from "./state.js";

/** Default: owner devices not admitted for 90 days are dropped. */
export const OWNER_DEVICE_INACTIVITY_SECONDS = 90 * 86400;
/** Default: member peer keys not admitted for 30 days are dropped. */
export const MEMBER_PEER_KEY_INACTIVITY_SECONDS = 30 * 86400;
/** `last_seen` moves only when it is at least this much older, so admissions rarely write. */
export const LAST_SEEN_RESOLUTION_SECONDS = 3600;

/** How long keys may go unused before the Gateway drops them. */
export type InactivityWindows = { ownerDeviceSeconds: number; memberPeerKeySeconds: number };

/** The default {@link InactivityWindows}. */
export const DEFAULT_INACTIVITY_WINDOWS: InactivityWindows = {
  ownerDeviceSeconds: OWNER_DEVICE_INACTIVITY_SECONDS,
  memberPeerKeySeconds: MEMBER_PEER_KEY_INACTIVITY_SECONDS,
};

/** The seq at which an owner device was listed (0 when its record predates listing seqs). */
export function ownerDeviceListedSeq(record: OwnerDeviceRecord): number {
  return record.listed_seq ?? 0;
}

/** The seq at which this owner device was given `key`, or undefined when it does not hold it. */
export function ownerPeerListedSeq(
  record: OwnerDeviceRecord,
  key: IrohEndpointKey,
): number | undefined {
  const index = record.cert.body.peer_keys.indexOf(key);
  return index < 0 ? undefined : (record.peer_listed_seq?.[index] ?? 0);
}

/** The seq at which the member's browser `key` was listed, or undefined when it is not listed. */
export function memberPeerListedSeq(
  member: MemberRecord,
  key: IrohEndpointKey,
): number | undefined {
  const index = member.peer_keys.indexOf(key);
  return index < 0 ? undefined : (member.listed_seq?.[index] ?? 0);
}

/**
 * The earliest seq at which `key` is listed anywhere at the claw (as an owner device's peer key
 * or a member's browser), or undefined when it is not listed. Listing a key that is still listed
 * somewhere keeps this seq, so copying it into another record cannot move it out of reach of a
 * revocation already signed; only a key absent from every listing is listed afresh.
 */
export function peerKeyListedSeq(state: AuthorityState, key: IrohEndpointKey): number | undefined {
  const seqs = [
    ...Object.values(state.owner_devices).map((record) => ownerPeerListedSeq(record, key)),
    ...Object.values(state.members).map((member) => memberPeerListedSeq(member, key)),
  ].filter((seq): seq is number => seq !== undefined);
  return seqs.length > 0 ? Math.min(...seqs) : undefined;
}

/**
 * `fp` and every owner device it approved, directly or through devices it approved,
 * computed from `approved_by` now. Devices whose approver is already gone are not included.
 */
export function approvalDescendants(state: AuthorityState, fp: KeyFingerprint): KeyFingerprint[] {
  if (!state.owner_devices[fp]) {
    return [];
  }
  const found = new Set<KeyFingerprint>([fp]);
  let grew = true;
  // Fixed point over the allowlist; it holds at most MAX_OWNER_DEVICES entries.
  while (grew) {
    grew = false;
    for (const [candidate, record] of Object.entries(state.owner_devices)) {
      // SAFETY: owner_devices is keyed by KeyFingerprint; Object.entries widens keys to string.
      const child = candidate as KeyFingerprint;
      if (!found.has(child) && record.approved_by !== "root" && found.has(record.approved_by)) {
        found.add(child);
        grew = true;
      }
    }
  }
  return [...found];
}

/**
 * Removes owner devices from the allowlist, with the invites they registered that are still
 * open; returns the new state and the devices' peer keys.
 */
export function withoutOwnerDevices(
  state: AuthorityState,
  fps: readonly KeyFingerprint[],
): { state: AuthorityState; peers: IrohEndpointKey[] } {
  const remove = new Set(fps);
  const peers = fps.flatMap((fp) => state.owner_devices[fp]?.cert.body.peer_keys ?? []);
  const owner_devices = Object.fromEntries(
    // SAFETY: owner_devices is keyed by KeyFingerprint; Object.entries widens keys to string.
    Object.entries(state.owner_devices).filter(([fp]) => !remove.has(fp as KeyFingerprint)),
  );
  const invites = Object.fromEntries(
    Object.entries(state.invites).filter(
      ([, invite]) =>
        invite.status !== "open" ||
        invite.created_by === undefined ||
        invite.created_by === "root" ||
        !remove.has(invite.created_by),
    ),
  );
  return { state: { ...state, owner_devices, invites }, peers: [...new Set(peers)] };
}

/** Removes peer keys from every member (members themselves stay listed). */
export function withoutMemberPeerKeys(
  state: AuthorityState,
  peers: readonly IrohEndpointKey[],
): AuthorityState {
  const remove = new Set(peers);
  return withoutMemberBrowsers(state, (_account, key) => remove.has(key));
}

/** Removes the member browsers `drop` selects, keeping each remaining browser's listing seq. */
export function withoutMemberBrowsers(
  state: AuthorityState,
  drop: (account: string, key: IrohEndpointKey) => boolean,
): AuthorityState {
  const members = Object.fromEntries(
    Object.entries(state.members).map(([account, member]) => {
      const kept = member.peer_keys.flatMap((key, index) =>
        drop(account, key) ? [] : [{ key, seq: member.listed_seq?.[index] ?? 0 }],
      );
      return [
        account,
        {
          ...member,
          peer_keys: kept.map((entry) => entry.key),
          listed_seq: kept.map((entry) => entry.seq),
          last_seen: Object.fromEntries(
            Object.entries(member.last_seen).filter(
              // SAFETY: last_seen is keyed by IrohEndpointKey; Object.entries widens keys to string.
              ([key]) => !drop(account, key as IrohEndpointKey),
            ),
          ),
        } satisfies MemberRecord,
      ];
    }),
  );
  return { ...state, members };
}

/**
 * Records that `peerKey` was admitted at `now`, on its owner device or member entry.
 * Returns null when nothing moved (unknown key, or seen within the resolution).
 */
export function recordSeen(
  state: AuthorityState,
  peerKey: IrohEndpointKey,
  now: UnixSeconds,
): AuthorityState | null {
  const stale = (seen: UnixSeconds | undefined) =>
    seen === undefined || now - seen >= LAST_SEEN_RESOLUTION_SECONDS;
  let changed = false;
  const owner_devices = Object.fromEntries(
    Object.entries(state.owner_devices).map(([fp, record]) => {
      if (!record.cert.body.peer_keys.includes(peerKey) || !stale(record.last_seen)) {
        return [fp, record];
      }
      changed = true;
      return [fp, { ...record, last_seen: now }];
    }),
  );
  const members = Object.fromEntries(
    Object.entries(state.members).map(([account, member]) => {
      if (!member.peer_keys.includes(peerKey) || !stale(member.last_seen[peerKey])) {
        return [account, member];
      }
      changed = true;
      return [account, { ...member, last_seen: { ...member.last_seen, [peerKey]: now } }];
    }),
  );
  return changed ? { ...state, owner_devices, members } : null;
}

// When a member peer key was last admitted; a key without a record counts from `fallback`.
function memberKeySeen(member: MemberRecord, key: IrohEndpointKey, fallback: UnixSeconds) {
  return member.last_seen[key] ?? fallback;
}

/**
 * Drops owner devices and member peer keys unused for longer than `windows` at `now`.
 * Inactivity never cascades: devices a dropped device approved stay listed. Returns null
 * when nothing is due, else the new state and every dropped peer key.
 */
export function dropInactive(
  state: AuthorityState,
  now: UnixSeconds,
  windows: InactivityWindows = DEFAULT_INACTIVITY_WINDOWS,
): { state: AuthorityState; peers: IrohEndpointKey[] } | null {
  const idleOwners = Object.entries(state.owner_devices)
    .filter(([, record]) => now - record.last_seen > windows.ownerDeviceSeconds)
    // SAFETY: owner_devices is keyed by KeyFingerprint; Object.entries widens keys to string.
    .map(([fp]) => fp as KeyFingerprint);
  const idleKeys = Object.values(state.members).flatMap((member) =>
    member.peer_keys.filter(
      (key) => now - memberKeySeen(member, key, now) > windows.memberPeerKeySeconds,
    ),
  );
  if (idleOwners.length === 0 && idleKeys.length === 0) {
    return null;
  }
  const owners = withoutOwnerDevices(state, idleOwners);
  return {
    state: withoutMemberPeerKeys(owners.state, idleKeys),
    peers: [...new Set([...owners.peers, ...idleKeys])],
  };
}

/** When the next owner device or member peer key becomes due for the inactivity drop. */
export function nextInactivityDrop(
  state: AuthorityState,
  windows: InactivityWindows = DEFAULT_INACTIVITY_WINDOWS,
): UnixSeconds | null {
  const due = [
    ...Object.values(state.owner_devices).map(
      (record) => record.last_seen + windows.ownerDeviceSeconds + 1,
    ),
    ...Object.values(state.members).flatMap((member) =>
      member.peer_keys.flatMap((key) => {
        const seen = member.last_seen[key];
        return seen === undefined ? [] : [seen + windows.memberPeerKeySeconds + 1];
      }),
    ),
  ];
  return due.length > 0 ? Math.min(...due) : null;
}
