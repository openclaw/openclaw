# Signed statements and keys (v1-draft, OCF-190)

**Status: v1-draft.** Implements owner-key spec v0.2 sections 2, 3, 5, 7 and 8 at the
statement level. Code: `src/keys.ts`, `src/kit.ts`, `src/crypto.ts`, `src/statements/`.

## Keys and text formats

All hex is lowercase. One value has one spelling; anything else is rejected.

| Name                  | Algorithm                                                                           | Text form                | Held by                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| Kit secret S          | 128 random bits                                                                     | `OCK1-XXXXX-...` (below) | the recovery kit only                                   |
| Owner root R          | Ed25519, seed = HKDF-SHA-256(S, salt `openclaw/owner-root/v1`, info `ed25519-seed`) | `ed25519:<64 hex>`       | nobody at rest; memory during a ceremony                |
| Owner device D        | Ed25519 (non-extractable WebCrypto key)                                             | `ed25519:<64 hex>`       | one per device and origin                               |
| Device peer key W     | iroh endpoint key (Ed25519)                                                         | `iroh:<64 hex>`          | the device (IndexedDB, extractable: iroh signs in WASM) |
| Server key K_srv      | iroh endpoint key                                                                   | `iroh:<64 hex>`          | the tunnel child (key file, 0600)                       |
| Gateway key K_gw      | Ed25519                                                                             | `ed25519:<64 hex>`       | the Gateway (never the tunnel child)                    |
| claw_id               | 128 random bits                                                                     | 32 hex                   | everywhere                                              |
| invite_id, request_id | 128 random bits                                                                     | 32 hex                   |                                                         |

- **Fingerprint** `fp(K)` = SHA-256 over the raw 32 key bytes, written `fp:<64 hex>`. The
  prefix is not hashed, so `ed25519:X` and `iroh:X` share a fingerprint; a revocation by
  fingerprint covers the key in every role.
- **Display fingerprint**: the first 100 bits of fp as four groups of five Crockford base32
  characters (`XXXXX-XXXXX-XXXXX-XXXXX`). Shown on the kit and in approval prompts.
- **Kit text**: `OCK1-` + Crockford base32 of (version byte `1` || S || first two bytes of
  SHA-256(version || S)), in groups of five. Decoding accepts lower case, spaces, and the
  O->0, I/L->1 aliases; the checksum catches typing mistakes. No key stretching: S has full
  entropy.

### Algorithm: Ed25519, with a P-256 decision point

Ed25519 is used for R, D and K_gw, and is what iroh endpoint keys already are. WebCrypto
Ed25519 ships in current Chrome, Edge, Firefox and Safari, and `generateKey("Ed25519", false,
...)` produces a non-extractable key that IndexedDB can store.

Caveats:

- **Qualification needed** (spec open question 4): the target browser list and embedded
  web views (iOS WKWebView, Android WebView, Electron) must be checked for _non-extractable_
  Ed25519 support. Feature-detect at device creation with `crypto.subtle.generateKey("Ed25519",
  false, ["sign", "verify"])`.
- **W is never non-extractable.** iroh's TLS signs inside WASM, so W stays a raw seed in
  IndexedDB (threat model section 5). That is why D and W are separate keys: approvals and
  invites never depend on the extractable key.
- R is derived from S and imported only for the ceremony (`deriveRootSigner`), then dropped.

**Decision point:** if qualification finds a required target without non-extractable
Ed25519, add `alg: "p256"` (ECDSA P-256 / SHA-256, IEEE P1363 `r||s` signature, key text
`p256:<66 hex compressed SEC1>`) **for owner device keys only**. R and K_gw stay Ed25519.
The envelope's `alg` field and the key prefix already carry the algorithm, so this is an
additive change. v1-draft accepts only `ed25519`.

## Envelope

```json
{ "v": 1, "type": "<StatementType>", "body": { ... }, "signer": "ed25519:<hex>",
  "alg": "ed25519", "sig": "<base64url>" }
```

- `sig` = Ed25519(signer, UTF-8(`"openclaw/" + type + "/v1\0"`) || UTF-8(JCS(body))).
  JCS is RFC 8785. The type prefix gives domain separation: a signature on one statement
  type never verifies as another (tested).
- `signer` is the **full public key**, not only its fingerprint (spec says "key
  fingerprint"): a verifier that pinned only fp(R) must still be able to check R's signature.
- There is no certificate chain. A statement signed by an owner device is checked against
  the claw's **current owner devices** (its allowlist), which only the Gateway holds.
- `sig` is unpadded base64url. Unknown envelope or body fields are rejected (an envelope
  that still carries a `chain` member is malformed); after release, a new signed field needs a new envelope
  version (the unshipped draft is revised in place).
- `v` selects the schema and the signing domain. A well-formed `v` this build does not
  implement is refused as `unsupported_version`, not `malformed` (versioning.md).
- Timestamps are unix **seconds** (integers).

## Statement types

| Type               | Body                                                                                                           | Valid signer                             | Owner capability needed                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| OwnerDeviceCert    | device_pub, peer_keys[W] (<= 10), label, scope `owner`, caps, issued_at, expires_at\|null, root_epoch          | R, or a current owner device of the claw | `approve_device`; caps within the signer's (`caps_escalation`) |
| ServerBinding      | claw_id, hostname, k_srv, k_gw, binding_seq, root_epoch, issued_at                                             | R only                                   | n/a                                                            |
| InviteCap          | claw_id, invite_id, role, audience {kind, value}, label, created_at, expires_at, single_use, secret_hash       | current owner device (or R)              | `invite`                                                       |
| MembershipChange   | claw_id, seq, target (by op), issued_at                                                                        | current owner device (or R)              | `manage_members`; `approve_device` for `add_owner_device`      |
| Revocation         | target_fp, target_kind (`owner_device` \| `peer_key`), reason, root_epoch, issued_at                           | R or any current owner device            | none                                                           |
| MembershipSnapshot | claw_id, seq, binding_seq, owner_devices[{device_pub, caps}], owner_peer_keys, members[], protocols, issued_at | K_gw of the verified binding             | n/a (a mirror of current state, never an authority)            |
| InviteRedemption   | claw_id, invite_id, account_id, device_pub, peer_key, proof, requested_at                                      | the invitee's own D_I (self-signed)      | n/a                                                            |
| RootReset          | claw_id, new_root_pub, binding_seq, issued_at                                                                  | K_gw of the binding being replaced       | n/a (owner reset on the machine, enrollment.md)                |

`root_epoch` is the constant 1 (`ROOT_EPOCH`); any other value is `malformed`. There is no
RootRotation statement and no root epoch: a root is replaced only by an owner reset on the
machine, vouched for by K_gw with a RootReset (enrollment.md, "Owner reset"). The field stays
so that statements signed before epochs were removed still verify.

Capabilities: `approve_device`, `bind`, `invite`, `manage_members`. R holds all of them.
(`bind` stays a certificate capability, but bindings are signed by R alone: clients that pin
only fp(R) must be able to verify them.) Member roles: `operator`, `viewer` (open question:
final role set; invites grant at most `operator`).

MembershipChange targets:

| op                 | target fields                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| `add`              | account_id, role, peer_keys (>= 1), invite_id (null, or the invite this approves) |
| `remove`           | account_id                                                                        |
| `set_role`         | account_id, role                                                                  |
| `revoke_device`    | peer_key (one member browser)                                                     |
| `add_owner_device` | cert: the new device's OwnerDeviceCert (signed by R or a current owner device)    |
| `deny_invite`      | invite_id (declines a pending redemption; the invite is consumed)                 |

`seq` must equal the Gateway's current membership seq + 1 (compare-and-set). This stops a
captured change from being replayed later; a concurrent writer gets a conflict and retries.

## Verification

`verifyOwnerStatement(statement, anchor, { now, owners })`, where anchor = {R public key}
and `owners(devicePub)` returns the capabilities of a device the claw currently lists as an
active owner device (undefined otherwise):

1. The envelope signature verifies under `signer`.
2. `signer == R` -> authority `root`.
3. A ServerBinding not signed by R -> `wrong_signer`.
4. `owners(signer)` is undefined (no lookup, a stranger, or a removed device) -> `not_an_owner`.
5. The signer holds the capability the type needs -> else `missing_capability`; an
   OwnerDeviceCert grants no caps the signer lacks -> else `caps_escalation`.

Only the Gateway can run steps 4 and 5. Clients and Discovery verify R's signatures only.

**Root supremacy**: authority `root` overrides `owner_device` (for example, two devices
removing each other: the kit decides).

Other verifiers: `verifyMembershipSnapshot` (signed by the binding's K_gw, same claw),
`verifyInviteRedemptionSignature` (self-signed by device_pub), `verifyRootResetSignature`
(signed by the binding's K_gw, same claw) and `verifyRootReset` (below).

Failure codes (stable; callers match codes, never detail text): `malformed`,
`bad_signature`, `wrong_signer`, `not_an_owner`, `missing_capability`, `caps_escalation`,
`not_yet_valid`, `root_mismatch`, `owner_reset`, `reset_mismatch`, `wrong_claw`,
`host_mismatch`, `rollback`, `bad_proof`, `expired`, `audience_mismatch`. The Gateway adds `limit_reached`
for the caps below.

## The allowlist model

Each claw's Gateway keeps an **allowlist**: the owner devices, members and nodes it has added, and
nothing else. There are no certificate chains and no list of revoked keys.

- **Approval.** A new owner device needs a certificate signed by R (the recovery kit) or by a
  device currently on the claw's owner list with `approve_device`. The Gateway stores
  `approved_by` with the device (`root`, or the approver's fingerprint) and its granted
  `caps`: an owner device grants only caps it holds itself, and re-adding a listed device
  through an owner device never raises its caps (`caps_escalation`). R may grant any caps.
  Signing checks read the stored caps, not the certificate.
- **Removal deletes.** Revoking an owner device (a Revocation with `target_kind`
  `owner_device`) deletes it **and every device it approved**, directly or through devices it
  approved, computed from `approved_by` at removal time. A `peer_key` Revocation removes that
  member browser, or the owner device holding it (with its approvals). `revoke_device` removes
  one member browser; `remove` removes a member. The Gateway disconnects the removed keys and
  invalidates their device tokens. Nothing is remembered: a later Revocation of a key the
  claw no longer lists changes nothing.
- **A revocation covers what its signer saw.** A Revocation names its `claw_id` and the
  membership `seq` its signer last saw (the snapshot's seq; it may not be ahead of the claw's,
  `seq_conflict`). Every listed key records the seq at which it was listed (`listed_seq`, and
  per peer key on owner devices); listing a key that is still listed anywhere at the claw keeps
  its earliest seq, so re-adding or copying it never puts it out of reach. A
  Revocation removes a target only if it was listed at or before the Revocation's seq; the
  devices the target approved go with it whenever they were listed. A key listed again after
  that seq is a new approval the signer never saw: replaying the captured bytes is refused
  with `seq_conflict` and changes nothing, and stopping the replay needs no list of past
  revocations. To remove the new listing, sign a new Revocation at the current seq.
- **Invites expire.** An InviteCap may expire at most a week after the Gateway registers it
  (`MAX_INVITE_LIFETIME_SECONDS`, `limit_reached`), one that already expired is refused
  (`expired`), and a claw keeps at most 100 invites (`MAX_INVITES`, `limit_reached`). An
  invite record is deleted once its cap expired (plus the 300 seconds of clock skew) unless a
  redemption is still pending on it: registration and redemption already refuse an expired
  cap, so nothing is left to replay. Removing an owner device also deletes the open invites
  it registered (`created_by`).
- **Inactivity.** The Gateway records `last_seen` per owner device and per member browser
  whenever the tunnel admits it (at most once an hour). Owner devices unused for 90 days and
  member browsers unused for 30 days are dropped (Gateway config
  `ownerDeviceInactivityDays` / `memberDeviceInactivityDays`). Inactivity never cascades: the
  devices a dropped device approved stay.
- **Caps.** A claw lists at most 20 owner devices (`MAX_OWNER_DEVICES`), 256 members
  (`MAX_MEMBERS`) and 10 browsers per member (`MAX_MEMBER_PEER_KEYS`); an owner device
  certificate carries at most 10 peer keys (`MAX_OWNER_DEVICE_PEER_KEYS`). Adding past a cap is
  refused with `limit_reached` ("remove one to add another"). The snapshot therefore always fits
  the 256-entry list limit: at most 256 members and 200 owner peer keys. A snapshot at every cap,
  with 256-character account ids, is about 275 KiB of JSON (about 600 KiB if every id
  character needs a JSON escape); Discovery sizes its snapshot publication limit for it.
- **Snapshots** carry current state only: each owner device's key and granted caps, owner peer
  keys and members. Readers outside the claw (Discovery) take an owner device's caps from the
  snapshot; a certificate a browser presents is only the Gateway's approval record.

Device keys are per claw origin, so the same browser holds a different D and W at each claw;
removing "a device" applies to the claw it is removed from.

The Control UI says this before it signs: "Your devices" (account menu) shows who approved each
device and names the devices that will lose access with the one being revoked. A removed device
can come back only with the recovery kit or a fresh approval from a current owner device. This
browser cannot revoke itself from the Control UI.

## Pins and rollback (spec section 5, step 3)

A client stores per origin `ClawPin = { claw_id, root_fp, binding_seq, k_gw? }`; `k_gw` is the
K_gw of the last binding verified under the pin (owner reset, below). A pin from an invite link
(`r=<fp(R)>`) or a kit starts as `{ claw_id: null, binding_seq: 0 }`. A pin never moves to
another root: after an owner reset the browser is set up again and gets a new pin.

`verifyBindingForPin(evidence, pin, { host, now })` runs before any socket opens.
Evidence is untrusted Discovery output: `{ root_pub, binding, reset? }` (`descriptorEvidence`).

1. fp(root_pub) must equal the pinned fingerprint -> else `root_mismatch`, or `owner_reset`
   when the evidence carries a valid owner reset from the pinned root (below). A new root is
   never pinned, whatever signs it.
2. The binding is signed by that root -> else `wrong_signer`.
3. claw_id matches the pin (if known) -> else `wrong_claw`; `binding.hostname ==
   location.host` -> else `host_mismatch`.
4. `binding_seq >= pin.binding_seq` -> else `rollback`.

On success the caller stores the returned pin and dials only `binding.k_srv`.

### Owner reset

`owner_reset` means: the pin stored a K_gw, the descriptor's `reset.previous_binding` passes
steps 2-4 under the pinned root (`reset.previous_root_pub`) and names that same K_gw, and
`verifyRootReset(previous, reset.statement, evidence)` passes:

1. The RootReset is signed by the previous binding's K_gw (`wrong_signer`, `bad_signature`) for
   the same claw (`wrong_claw`).
2. Its binding_seq is higher than the previous binding's (`rollback`).
3. It names the served root (`root_mismatch`), which differs from the previous one
   (`reset_mismatch`).
4. The served binding is signed by that root (`wrong_signer`, `bad_signature`), for the same claw
   and hostname (`wrong_claw`, `host_mismatch`), with the same K_srv and K_gw and the reset's
   binding_seq (`reset_mismatch`).

Any failure is reported as `root_mismatch` (the detail names the step), so a forged reset
still shows the substitution warning. `owner_reset` is not a pass: the client dials nothing,
stores nothing, and offers to set the browser up again with the new kit. It proves only that
whoever holds the K_gw this browser already verified changed the root, which is what owner
reset means.

The K_gw must come from the pin, not from the descriptor: the previous binding is signed only by
the old root, and a reset is often done because that root's kit leaked. With the old kit alone,
an attacker could sign a previous binding naming their own K_gw. A pin without `k_gw` (a fresh
pin from an invite link or kit that never verified a binding, or a pin stored before this field
existed) therefore always gets `root_mismatch` for a new root.

Accepted edge case: the descriptor carries only the latest reset. A browser that missed two
resets (pinned to R, the descriptor shows R' -> R'') gets `root_mismatch` and is set up again
the same way.

### Freshness (freshness/v1)

A ServerBinding never expires and step 4 accepts an equal binding_seq, so the pin alone does not
stop a replayed older binding. Right after `verifyBindingForPin` succeeds and before any socket
opens, the client runs `assessFreshness({ snapshot }, { binding, stored, now, policy })` with
Discovery's snapshot (`getSnapshot`, untrusted):

1. Verify the snapshot under the binding's K_gw (`verifyMembershipSnapshot`).
2. A verified snapshot (served now or stored earlier) names a higher binding_seq than the binding
   served -> `stale_binding`. This is how a replaced server key is retired: the new binding's
   higher binding_seq, not a revocation list.
3. The binding is fresh when a verified snapshot names exactly its binding_seq, was issued at most
   `SNAPSHOT_MAX_AGE_SECONDS` (3 h) ago and at most `SNAPSHOT_CLOCK_SKEW_SECONDS` (300 s) ahead,
   and is not older by (seq, issued_at) than the newest snapshot stored for this origin.
4. Not fresh: `enforce` refuses with `freshness_unavailable` (no socket, no credential); `report`
   dials and records the gap. Rule 2 applies under both policies.

A snapshot from the future is never stored. The Gateway re-signs at least every
`SNAPSHOT_REPUBLISH_SECONDS` (1 h), so an honest claw's snapshot is always well inside the 3 h
window. A K_srv rotation must publish the new binding and a snapshot with its binding_seq together.

**Residual risk:** an attacker holding both the old K_srv and the old K_gw can sign fresh snapshots
for the old binding until the client has seen a snapshot for the newer binding. Closing it needs
freshness from the live Gateway over the tunnel (a K_gw-signed answer to a client nonce), which v1
does not have. A K_gw holder can also deny service to an origin for good by signing an inflated
binding_seq; K_gw can already refuse service.

## Test vectors

`fixtures/v1-draft/statements.json` is produced by `buildStatementVectors()`
(`src/testing/vectors.ts`) from fixed seeds (SHA-256 of
`openclaw-id-protocol/v1-draft/test-seed/<name>`) and the kit secret `000102...0f`. Ed25519
is deterministic, so the file is byte-stable; a test fails if the builder and the file
disagree. It contains: the kit (text, root seed, R, fp, display fp), named keys, JCS cases,
the vector claw's current owner devices (`owners`, the allowlist device signatures are checked
against), valid statements with their signing input in hex, invalid statements with the expected
error code (and anchor when not the default), and pin checks (fresh pin, rollback,
substitution, host mismatch, a new root, an owner reset vouched for by the pinned K_gw, one
whose RootReset K_gw did not sign, and a genuine reset seen by a pin without `k_gw`).

Regenerate after an intentional change:

```sh
node --import ./scripts/tsx.mjs -e 'const { buildStatementVectors } = await import("./packages/openclaw-id-protocol/src/testing/vectors.ts"); (await import("node:fs")).writeFileSync("packages/openclaw-id-protocol/fixtures/v1-draft/statements.json", JSON.stringify(await buildStatementVectors(), null, 2) + "\n");'
```

## Changes from spec v0.2 (to confirm)

- `signer` carries the public key, not a fingerprint (see Envelope).
- Capabilities are named (`approve_device`, `bind`, `invite`, `manage_members`), and a
  certificate cannot exceed its approver's caps.
- No certificate chains or revocation lists: each claw keeps an allowlist (see The allowlist
  model); bindings are signed by R only.
- Revocation carries `claw_id` and `seq` and covers only keys listed at or before that seq, so
  a replayed revocation cannot remove a key that was approved again.
- An InviteCap lasts at most a week, and a claw keeps at most 100 invites.
- Owner devices are added at a claw with `MembershipChange { op: "add_owner_device", cert }`;
  a pending redemption is declined with `{ op: "deny_invite", invite_id }`.
- MembershipChange.seq is a compare-and-set on the Gateway's seq.
- New statement type `InviteRedemption` (spec section 6.3 step 2), self-signed by D_I.
- MembershipSnapshot adds `owner_devices` (key and granted caps), `owner_peer_keys` and
  `binding_seq` (relay admission needs owner devices, Discovery's owner mailbox needs owner
  device keys and their caps, consumers
  need to tie a snapshot to a binding), and carries no `revoked` list. It also carries
  `protocols`, the versions the Gateway accepts (versioning.md, "Choosing a version").
- K_gw is separate from K_srv: the Gateway never reads the tunnel child's key file
  (process-model.md).
- New statement type `RootReset`, signed by K_gw: owner reset on the machine replaces the
  spec's root rotation (enrollment.md, "Owner reset").

## Node-only statements and membership

All of these are additions to the unshipped **v1-draft**, not new version markers.
Unknown signed fields remain rejected. See [enrollment.md](enrollment.md#headless-node-enrollment)
for the proof and join-link bytes and [discovery.md](discovery.md#accountless-node-authentication)
for request authentication.

| Type             | Body                                                           | Signer / authority                                                |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `NodeInviteCap`  | claw_id, invite_id, label, created_at, expires_at, secret_hash | R or current owner device with `invite`; direct registration only |
| `NodeRedemption` | claw_id, invite_id, peer_key, description, proof, requested_at | the named W, represented as ed25519: in signer; pending only      |

`MembershipTarget` adds `add_node { peer_key, label, invite_id }` and
`remove_node { peer_key }`; both require R or a current owner with `manage_members`.
`deny_invite` and peer-key revocations cover nodes too. `MembershipSnapshotBody` requires
`node_peer_keys: IrohEndpointKey[]` (empty when none), separate from `owner_peer_keys` and
`members`. Existing snapshots must be re-signed by K_gw when consumers update this draft;
never insert a field into an already signed envelope.

Node W is an Ed25519 iroh endpoint key, held only by the node. It grants neither member
nor owner authority. `verifyNodeRedemptionSignature` checks that the signature is by exactly
that W. Nodes are not in `ownerLookup`; signing a membership change with W never authorizes it.
A claw admits at most `MAX_NODES` (256), so node snapshots fit the existing 256-entry list
bound (about 19 KiB additional JSON at capacity). Every node records its listing seq;
replaying an old revocation cannot remove a node approved anew at a later seq.

The deterministic fixture also includes NodeInviteCap, NodeRedemption, add/remove operations,
a snapshot with node keys, wrong-signer cases, and `node_invite` proof-key/HMAC/link/code vectors.
`NodeRedemption.description` is the strict bounded `NodeDescription` described in enrollment.md,
signed by W and retained with pending and approved nodes. Its reported commands/caps confer
no authority without explicit owner approval. Node invites default to ten minutes and are
bounded to one hour; member-invite limits are unchanged.
