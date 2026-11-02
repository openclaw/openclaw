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
  "chain": [ <OwnerDeviceCert>, ... ], "alg": "ed25519", "sig": "<base64url>" }
```

- `sig` = Ed25519(signer, UTF-8(`"openclaw/" + type + "/v1\0"`) || UTF-8(JCS(body))).
  JCS is RFC 8785. The type prefix gives domain separation: a signature on one statement
  type never verifies as another (tested).
- `signer` is the **full public key**, not only its fingerprint (spec says "key
  fingerprint"): a verifier that pinned only fp(R) must still be able to check R's signature.
- `chain` is empty when R signs. Otherwise `chain[0]` certifies `signer`, `chain[i]` is
  signed by the key `chain[i+1]` certifies, and the last link is signed by R. Links carry
  an empty `chain` of their own (flattened; `certificateChain(cert)` builds it). Signatures
  do not cover `chain` or `signer`, which is safe: changing either breaks verification.
- `sig` is unpadded base64url. Unknown envelope or body fields are rejected in v1-draft.
- Timestamps are unix **seconds** (integers).

## Statement types

| Type               | Body                                                                                                     | Valid signer                        | Owner capability needed                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| OwnerDeviceCert    | device_pub, peer_keys[W], label, scope `owner`, caps, issued_at, expires_at\|null, root_epoch            | R, or an owner device (chain)       | `approve_device`; caps must not exceed the signer's; resulting depth <= 4 |
| ServerBinding      | claw_id, hostname, k_srv, k_gw, binding_seq, root_epoch, issued_at                                       | R or owner device                   | `bind`                                                                    |
| InviteCap          | claw_id, invite_id, role, audience {kind, value}, label, created_at, expires_at, single_use, secret_hash | owner device (or R)                 | `invite`                                                                  |
| MembershipChange   | claw_id, seq, target (by op), issued_at                                                                  | owner device (or R)                 | `manage_members`; `approve_device` for `add_owner_device`                 |
| Revocation         | target_fp, target_kind, reason, root_epoch, issued_at                                                    | R or any owner device               | none                                                                      |
| RootRotation       | old_root_fp, new_root_pub, new_epoch (= old + 1), issued_at                                              | the old R only; local operator only | n/a                                                                       |
| MembershipSnapshot | claw_id, seq, binding_seq, owner_peer_keys, members[], revoked[], issued_at                              | K_gw of the verified binding        | n/a (a mirror, never an authority)                                        |
| InviteRedemption   | claw_id, invite_id, account_id, device_pub, peer_key, proof, requested_at                                | the invitee's own D_I (self-signed) | n/a                                                                       |

Capabilities: `approve_device`, `bind`, `invite`, `manage_members`. R holds all of them.
Member roles: `operator`, `viewer` (open question: final role set; invites grant at most
`operator`).

MembershipChange targets:

| op                 | target fields                                                                           |
| ------------------ | --------------------------------------------------------------------------------------- |
| `add`              | account_id, role, peer_keys (>= 1), invite_id (null, or the invite this approves)       |
| `remove`           | account_id                                                                              |
| `set_role`         | account_id, role                                                                        |
| `revoke_device`    | peer_key                                                                                |
| `add_owner_device` | cert: the new device's OwnerDeviceCert with its own chain (verified like any statement) |
| `deny_invite`      | invite_id (declines a pending redemption; the invite is consumed)                       |

`seq` must equal the Gateway's current membership seq + 1 (compare-and-set). This stops a
captured change from being replayed later; a concurrent writer gets a conflict and retries.

## Verification

`verifyOwnerStatement(statement, anchor, { now, isRevoked })`, where anchor = {R public key,
current root_epoch}:

1. The envelope signature verifies under `signer`.
2. A body `root_epoch` equals the anchor epoch.
3. `signer == R` and an empty chain -> authority `root`. Otherwise walk the chain from R:
   every link verifies under its issuer, is a flat OwnerDeviceCert, is in the anchor epoch,
   is not issued in the future (300 s skew), is unexpired and not revoked; a device issuer
   holds `approve_device`; a link's caps are a subset of its issuer's. Depth <= 4.
4. The signer holds the capability the type needs.

**Root supremacy**: authority `root` overrides `owner_device` (for example, two devices
revoking each other: the kit decides).

Other verifiers: `verifyRootRotation` (signed by the current R, old_root_fp matches,
new_epoch = epoch + 1), `verifyMembershipSnapshot` (signed by the binding's K_gw, same
claw), `verifyInviteRedemptionSignature` (self-signed by device_pub).

Failure codes (stable; callers match codes, never detail text): `malformed`,
`bad_signature`, `wrong_signer`, `chain_too_long`, `chain_broken`, `chain_expired`,
`chain_revoked`, `wrong_epoch`, `missing_capability`, `not_yet_valid`, `root_mismatch`,
`conflicting_rotation`, `wrong_claw`, `host_mismatch`, `rollback`, `server_key_revoked`,
`bad_proof`.

## Revoking an owner device (OCF-280)

An owner device is active only while its certificate is in the current root epoch, has not
expired, and no fingerprint in its chain is revoked (`isOwnerDeviceActive`). A Revocation of an owner device
therefore also ends every owner device it approved, directly or further down the chain
(phone approved by a laptop approved by the first browser). The Gateway lists, admits and
accepts statements from active owner devices only, and it cuts the connections of every
device that stops being active.

The Control UI says this before it signs: "Your devices" (account menu) names the devices that
will lose access with the one being revoked. A device can come back only with the recovery
kit (which re-certifies it directly under R) or a fresh approval from another active owner
device. This browser cannot revoke itself from the Control UI.

**Decision pending (Josh):** this cascade is the current behaviour, chosen on 2026-10-31 by
the coordinator. The alternative is to revoke only the target and re-certify the devices it
approved under the approver's own approver (or R). Handoff README section 4a left this open.

## Pins and rollback (spec section 5, step 3)

A client stores per origin `ClawPin = { claw_id, root_fp, root_epoch, binding_seq }`. A pin
from an invite link (`r=<fp(R)>`) or a kit starts as `{ claw_id: null, root_epoch: 0
(unknown), binding_seq: 0 }`.

`verifyBindingForPin(evidence, pin, { host, now, isRevoked })` runs before any socket opens.
Evidence is untrusted Discovery output: `{ root_pub, rotations[], binding }`.

1. Follow RootRotations from the pinned root fingerprint, each verified by the previous root.
   Two different rotations out of the same epoch -> `conflicting_rotation` (fail closed).
2. fp(root_pub) must equal the fingerprint reached -> else `root_mismatch`.
3. The binding verifies under that root and epoch (`bind` capability if a device signed it).
4. claw_id matches the pin (if known) -> else `wrong_claw`; `binding.hostname ==
   location.host` -> else `host_mismatch`.
5. `binding_seq >= pin.binding_seq` and the epoch does not go back -> else `rollback`.
6. fp(K_srv) is not revoked -> else `server_key_revoked`.

On success the caller stores the returned pin and dials only `binding.k_srv`.

### Revocation and freshness (freshness/v1)

A ServerBinding never expires and step 5 accepts an equal binding_seq, so the pin alone does not
stop a replayed older binding. Right after `verifyBindingForPin` succeeds and before any socket
opens, the client runs `assessFreshness(evidence, { binding, anchor, stored, now, policy })` with
Discovery's snapshot (`getSnapshot`) and revocations (`getRevocations`), both untrusted:

1. Verify each Revocation under the pinned anchor (`verifyOwnerStatement`); ignore invalid ones.
2. Verify the snapshot under the binding's K_gw (`verifyMembershipSnapshot`).
3. Merge the revoked fingerprints and the snapshot's `revoked[]` into a per-origin set that only
   ever grows. If anything was learned, re-run `verifyBindingForPin` with the merged set.
4. fp(K_srv) or fp(K_gw) revoked -> `server_key_revoked`.
5. A verified snapshot (served now or stored earlier) names a higher binding_seq than the binding
   served -> `stale_binding`.
6. The binding is fresh when a verified snapshot names exactly its binding_seq, was issued at most
   `SNAPSHOT_MAX_AGE_SECONDS` (3 h) ago and at most `SNAPSHOT_CLOCK_SKEW_SECONDS` (300 s) ahead,
   and is not older by (seq, issued_at) than the newest snapshot stored for this origin.
7. Not fresh: `enforce` refuses with `freshness_unavailable` (no socket, no credential); `report`
   dials and records the gap. Rules 4 and 5 apply under both policies.

A snapshot from the future is never stored. The Gateway re-signs at least every
`SNAPSHOT_REPUBLISH_SECONDS` (1 h), so an honest claw's snapshot is always well inside the 3 h
window. A K_srv rotation must publish the new binding and a snapshot with its binding_seq together,
with fp(old K_srv) in `revoked[]`.

**Residual risk:** an attacker holding both the old K_srv and the old K_gw can sign fresh snapshots
for the old binding. Only a Revocation of those keys stops it, and Discovery can withhold that
from a client that never saw it. Closing it needs freshness from the live Gateway over the tunnel
(a K_gw-signed answer to a client nonce), which v1 does not have. A K_gw holder can also deny
service to an origin for good by signing an inflated binding_seq; K_gw can already refuse service.

## Test vectors

`fixtures/v1-draft/statements.json` is produced by `buildStatementVectors()`
(`src/testing/vectors.ts`) from fixed seeds (SHA-256 of
`openclaw-id-protocol/v1-draft/test-seed/<name>`) and the kit secret `000102...0f`. Ed25519
is deterministic, so the file is byte-stable; a test fails if the builder and the file
disagree. It contains: the kit (text, root seed, R, fp, display fp), named keys, JCS cases,
valid statements with their signing input in hex, invalid statements with the expected
error code (and anchor when not the default), and pin checks (fresh pin, rollback,
substitution, host mismatch, rotation, conflicting rotations).

Regenerate after an intentional change:

```sh
node --import ./scripts/tsx.mjs -e 'const { buildStatementVectors } = await import("./packages/openclaw-id-protocol/src/testing/vectors.ts"); (await import("node:fs")).writeFileSync("packages/openclaw-id-protocol/fixtures/v1-draft/statements.json", JSON.stringify(await buildStatementVectors(), null, 2) + "\n");'
```

## Changes from spec v0.2 (to confirm)

- `signer` carries the public key, not a fingerprint (see Envelope).
- Capabilities are named (`approve_device`, `bind`, `invite`, `manage_members`), and a
  child certificate cannot exceed its issuer's caps.
- Owner devices are added at a claw with `MembershipChange { op: "add_owner_device", cert }`;
  a pending redemption is declined with `{ op: "deny_invite", invite_id }`.
- MembershipChange.seq is a compare-and-set on the Gateway's seq.
- New statement type `InviteRedemption` (spec section 6.3 step 2), self-signed by D_I.
- MembershipSnapshot adds `owner_peer_keys` and `binding_seq` (relay admission needs owner
  devices; consumers need to tie a snapshot to a binding).
- K_gw is separate from K_srv: the Gateway never reads the tunnel child's key file
  (process-model.md).
