# Enrollment, invites and the membership authority (v1-draft, OCF-190)

**Status: v1-draft.** Code: `src/invites.ts`, `src/enrollment/sas.ts`, `src/authority/`.
Implements owner-key spec sections 6 and 7 at the protocol level.

## Reference membership authority

`src/authority/` is the Gateway's acceptance rules as pure functions over an in-memory
`AuthorityState`. The Gateway owns persistence (SQLite), the transport, and the side effects;
it either calls these functions or must pass the same acceptance tests (acceptance.md).
Every write returns `{ ok, status, state, events }`; events are the side effects the Gateway
must perform (`disconnect`, `invalidate_tokens`, `cancel_runs`, `notify_owners`,
`publish_snapshot`).

### Channels

| Channel          | Meaning                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `local_operator` | authenticated **direct loopback** (never traffic that came through the tunnel child, even though it arrives on loopback) |
| `tunnel`         | an authenticated device over the iroh tunnel                                                                             |
| `mailbox`        | through Discovery                                                                                                        |

### Write rules

| Write                                             | Function                                   | Allowed channels       | Notes                                                                       |
| ------------------------------------------------- | ------------------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| Link claw (pin fp(R), epoch 1)                    | `linkClaw`                                 | local_operator         | spec 4                                                                      |
| Re-pin a new root (lost kit, conflict resolution) | `repinRoot`                                | local_operator         | spec 8.2 option A, 8.3; clears a freeze                                     |
| Regenerate the owner key                          | `regenerateOwnerKey`                       | local_operator         | re-pins R', drops older owner devices, enrolls the regenerating device      |
| MembershipChange by an owner device               | `submitStatement`                          | tunnel, local_operator | `seq` must be current + 1                                                   |
| MembershipChange signed by R (kit enrollment)     | `submitStatement`                          | any, incl. mailbox     | `add_owner_device` via mailbox emits `notify_owners: kit_used`              |
| OwnerDeviceCert signed by R for a known device    | `submitStatement`                          | any                    | chain compaction after kit use                                              |
| Revocation                                        | `submitStatement`                          | any                    | revokes the key and every device certified through it                       |
| RootRotation                                      | `submitStatement`                          | local_operator         | refused elsewhere even when validly signed; a conflicting one still freezes |
| InviteCap + proof key                             | `registerInvite`                           | tunnel, local_operator | `secret_hash` must equal SHA-256(proof key)                                 |
| InviteRedemption                                  | `submitRedemption`                         | any (normally mailbox) | becomes **pending**, reserves the invite, admits nothing                    |
| Approve redemption                                | `submitStatement` (`add` with `invite_id`) | tunnel, local_operator | must match the pending account and peer key; role <= invite role            |
| Deny redemption                                   | `submitStatement` (`deny_invite`)          | tunnel, local_operator | consumes the invite                                                         |

Root supremacy: an R-signed statement is accepted wherever a device-signed one is, plus over
the mailbox. The exception is RootRotation: changing the root needs the local operator.
When the state is frozen, root-signed writes are refused except from the local operator.

The conflicting rotation itself is refused (`conflicting_rotation`), but the refusal has
`persist: true`: its `state` is frozen and its `events` carry the `rotation_conflict` owner
notice. The Gateway persists that state and performs those events before it reports the
refusal. Every other refusal leaves the state unchanged and has no events.

### Owner-key regeneration (decision 2026-10-31, OCF-319)

Owner device certificates have **no expiry unless the person approving the device enters
one** (`expires_at: null`). The only way to end every owner key at once is to **regenerate
the owner key**, and that needs actual access to the running Gateway: the local operator on
authenticated direct loopback. Tunnel traffic (relayed or direct path), the mailbox and LAN
clients can never regenerate the owner key or rotate the root, even with a valid signature
from the current root.

`regenerateOwnerKey(state, { root_pub, owner_device }, context)`:

1. Refuses anything but `local_operator` (`not_local_operator`) and a root this claw has
   used in any epoch (`root_reused`). `owner_device` must be `MembershipChange
   add_owner_device` at seq + 1, signed by R' alone (`target_mismatch`).
2. Pins R' in a new epoch, one past every epoch the claw has seen (`nextRootEpoch`), and
   clears a conflicting-rotation freeze. This is how a frozen claw is unfrozen.
3. Drops every owner device of earlier epochs and enrolls the regenerating device as the first
   owner device under R'. Members, invites and revocations are kept.
4. Events: `disconnect` and `invalidate_tokens` for every old owner device key, and
   `publish_snapshot`.

The regenerating browser generates the new kit secret S and R' itself, shows the new recovery
kit once and signs (`signOwnerKeyRegeneration`) its own enrollment and a new ServerBinding
(binding_seq + 1, the new epoch, the same claw id, hostname, K_srv and K_gw). The Gateway
receives public keys and signed statements only. The old kit stops working. The Gateway
exposes this as `openclawId.authority` `prepare_regeneration` and `regenerate`; it
persists the new state and binding, closes the old devices' sessions, revokes their
tunnel-bound tokens, pushes the new admission list to the tunnel child and republishes.

A RootRotation statement is never accepted by the Gateway's `submit`: from the tunnel or the
mailbox the protocol refuses it, and on loopback the Gateway answers `unsupported` because a
rotation alone would leave the binding signed by the old root. A conflicting rotation (a
different rotation into an epoch the claw already moved past, signed by that epoch's previous
root) is still detected from every channel and freezes the claw.

`ownerDeviceCertBody` is the certificate builder approvers use: `expires_at` defaults to
null, and an explicit expiry must be after the issue time. Approval UIs (SAS approval, owner
devices) offer the expiry as an optional field.

### Admission

`isAdmitted(state, peerKey, fp, now)` is what the tunnel child asks for every connection: the
key is not revoked and belongs to a member or to an owner device active at `now` (certificate
in the current epoch, nothing in its chain revoked, and the certificate and every ancestor
issued no later than `now` plus 300 seconds of clock skew and not expired). Enrollment and
root re-certification refuse a certificate outside its window (`expired`, `not_yet_valid`).
`nextOwnerExpiry(state, now)` gives the next expiry boundary, at which the Gateway closes the
sessions that device already has open. Discovery is not consulted; withholding a
snapshot cannot keep a removed key admitted (G4).

`snapshotBody(state, bindingSeq, now)` builds the MembershipSnapshot the Gateway signs with
K_gw for Discovery (relay admission, listings).

Not modeled here (Gateway work): pending-redemption expiry after 7 days, holding mailbox
items from an older root epoch until an owner device confirms them directly (spec 8.4), and
persistence.

## Invites (spec 6.3)

1. The owner device generates `invite_id` (128 bits) and a 32-byte link secret, derives the
   **proof key** = HKDF-SHA-256(secret, salt `openclaw/invite/v1`, info `proof-key`), signs an
   InviteCap with `secret_hash = SHA-256(proof key)`, and registers cap + proof key
   **directly** at the Gateway. Discovery never sees the secret or the proof key.
2. Link: `https://<host>/join#i=<invite_id>.<base64url secret>&r=<fp(R) hex>`. The fragment
   never reaches a server.
3. The invitee signs in, makes D_I and W_I, and mails a self-signed `InviteRedemption` with
   `proof = HMAC-SHA-256(proof key, "openclaw/invite-proof/v1\0" || JCS({ account_id,
   claw_id, device_pub, invite_id, peer_key }))`.
4. The Gateway verifies (`verifyInviteRedemption`): self-signature, invite match, expiry,
   proof, audience (account id or email asserted by OpenClaw ID). Result: **pending**.
5. An owner approves (`add` with `invite_id`) or denies (`deny_invite`) **directly**.

## SAS approval of a new owner device (spec 6.1)

| Step | Message                                                                          | Function                                      |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | N -> E `start` {request_id, claw_id, device_pub, peer_key, label, commit}        | `sasCommitment(eph_N, start)` = SHA-256(eph_N |                                                                  | JCS(start))                   |
| 2    | E -> N `accept` {eph_E, device_pub(D_E)}                                         |                                               |
| 3    | N -> E `key` {eph_N}                                                             | E: `verifySasCommitment`                      |
| 4    | both: ss = X25519, T = SHA-256(JCS({start, commit, eph_e, eph_n, device_pub_e})) | `sasSharedSecret`, `sasTranscript`            |
| 5    | both show 6 digits: HKDF(ss, info `openclaw/sas/v1`                              |                                               | hex(T)) mod 10^6                                                 | `sasCode`                     |
| 6    | user confirms "matches" on both screens                                          |                                               |
| 7    | E -> Gateway (direct): MembershipChange `add_owner_device`                       | authority                                     |
| 8    | E -> N: AES-256-GCM under HKDF(ss, `openclaw/sas-mac/v1`                         |                                               | hex(T)) of {R pub, binding + chain, epoch, OwnerDeviceCert(D_N)} | `sealHandoff` / `openHandoff` |
| 9    | N verifies the chain to R and the binding host, pins, connects                   | `verifyBindingForPin`                         |

Why the commitment matters: a relay in the middle must fix the key it gives E (inside the
commitment it forwards) before it sees eph_E, and the key it gives N before it sees eph_N.
It cannot grind, so each attempt matches with probability 10^-6. X25519 needs WebCrypto
X25519 (current Chrome, Firefox, Safari; qualify alongside Ed25519).

### Approval from the original local Control UI (OCF-287)

The original linking browser retains its non-extractable owner-device key D in IndexedDB,
scoped to that exact origin. It signs the same certificate and membership change as the loader
approver, using `certificateChain`, `ownerDeviceCertBody`, and the SAS helpers above. The Gateway
holds neither D nor the recovery-kit root. Direct-loopback operator access alone cannot sign.

The local browser sends its account token and exact D-signed Discovery request through the
owner-only `openclawId.authority` `device_mail` relay. The relay constructs only fixed device
binding/mailbox paths, preserves request bytes/signature, prohibits redirects and checks current
owner authorization before and after the request. It never signs device mail with K_gw.
This avoids adding loopback origins to Discovery's CORS policy.

For mail addressing, the browser binds D with a separate non-extractable mailbox-only peer
proof key W. W is not added to its owner certificate, membership, or tunnel admission.
Discovery's optional `OpenClaw-Owner-Certificate` header verifies the local D's certificate under
the claw's current root and epoch, owner account, validity window and current snapshot
revocations. This lets a local certificate with no peer keys read owner mail. It does not grant
membership or give an account session owner-device authority.

A single connection-owned mailbox long poll updates the notification and **Your devices →
Approve a new device** without refreshing. Approval requires matching six-digit numbers.
Expiry is optional and defaults to none. Failed or uncertain membership submissions are not
resubmitted by the attempt; no sealed handoff is sent before confirmed admission.

Manual verification on an existing claw:

1. Use the original browser profile and exact local origin that linked the claw. `localhost`
   and `127.0.0.1` have different IndexedDB key stores. Sign in to OpenClaw ID if needed.
2. Open the claw's remote address in a separate fresh browser profile. Sign in as the same
   owner and choose **Approve from another device**.
3. In the original local Control UI, open the new-browser notification or **Your devices →
   Approve a new device**. Compare all six digits on both screens; deny if they differ.
4. Leave expiry blank for no expiry, or enter the desired number of days. Confirm matching
   numbers on both screens and approve. The new browser must reach the Control UI on its own.
5. For a test browser, revoke its named device from the original browser's **Your devices**
   afterward. Confirm that its remote connection ends. Do not revoke the original device,
   regenerate the owner key, reset the profile, or paste a recovery kit to make this test pass.

## Kit enrollment (spec 6.2)

N decodes the kit (`decodeKit`), derives R (`deriveRootSigner`), checks fp(R), verifies the
binding against R, then signs with R: its own OwnerDeviceCert, a re-certification of every
active owner device (chain compaction), and `MembershipChange add_owner_device`. These go to
the Gateway through the mailbox; the Gateway emits `notify_owners: kit_used`. N drops R.

N signs its `add_owner_device` at the seq of Discovery's snapshot + 1. When that snapshot lags
the Gateway (a failed publication), the Gateway refuses the statement as `seq_conflict`,
republishes its snapshot and mails N's device fingerprint a `notice` with `event: "seq_conflict"`
and `ref` = its current seq. While N still holds R it re-reads the K_gw-signed snapshot, checks
it is at least `ref`, and signs again at that seq + 1; otherwise it asks the user to retry.
