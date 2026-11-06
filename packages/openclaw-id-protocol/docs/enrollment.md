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

| Write                                         | Function                                   | Allowed channels       | Notes                                                                                               |
| --------------------------------------------- | ------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Link claw (pin R for good)                    | `linkClaw`                                 | local_operator         | spec 4                                                                                              |
| MembershipChange by an owner device           | `submitStatement`                          | tunnel, local_operator | `seq` must be current + 1                                                                           |
| MembershipChange signed by R (kit enrollment) | `submitStatement`                          | any, incl. mailbox     | `add_owner_device` via mailbox emits `notify_owners: kit_used`                                      |
| Revocation                                    | `submitStatement`                          | any                    | removes keys listed at or before its `seq`, with every owner device they approved (no history kept) |
| InviteCap + proof key                         | `registerInvite`                           | tunnel, local_operator | `secret_hash` must equal SHA-256(proof key); expires within a week; at most 100 per claw            |
| InviteRedemption                              | `submitRedemption`                         | any (normally mailbox) | becomes **pending**, reserves the invite, admits nothing                                            |
| Approve redemption                            | `submitStatement` (`add` with `invite_id`) | tunnel, local_operator | must match the pending account and peer key; role <= invite role                                    |
| Deny redemption                               | `submitStatement` (`deny_invite`)          | tunnel, local_operator | consumes the invite                                                                                 |

Root supremacy: an R-signed statement is accepted wherever a device-signed one is, plus over
the mailbox. A refusal leaves the state unchanged and has no events.

### Owner reset (OCF-319)

The person at the machine always wins. Owner reset replaces a claw's root R with a new one R'
from a new recovery kit, for a lost or leaked kit or a claw the owner no longer controls
remotely. It is offered only on the machine: `openclaw id reset` (also with the Gateway
stopped) and a Control UI button on a direct `local_operator` connection. Over the tunnel the
Gateway refuses it with `not_local_operator` and the UI does not show it. Anyone who can run
processes on the Gateway host can reset; that is accepted, because operator access already
implies it.

Reset:

- makes a new kit (S', R'). The kit is shown once and never stored on the Gateway; R' signs the
  new ServerBinding and is dropped;
- removes every owner device, member and invite, closes every tunnel session and invalidates
  every tunnel-bound token. Local access is unaffected;
- keeps K_srv, K_gw, the claw id, the hostname and all claw data. The membership `seq` keeps
  counting up (Discovery and clients order snapshots by it);
- publishes, together, the new binding (signed by R', same claw, hostname, K_srv and K_gw,
  binding_seq + 1) and a `RootReset { claw_id, new_root_pub: R', binding_seq, issued_at }`
  signed by K_gw, the key in the binding being replaced (discovery.md, "Owner reset").

There is no root rotation, no root epoch and no frozen state: `root_epoch` stays in
OwnerDeviceCert, ServerBinding and Revocation as the constant 1 (`ROOT_EPOCH`), and any other
value is `malformed`. Nothing R signed counts under R'.

A browser pinned to R that reads the new descriptor gets `owner_reset` from
`verifyBindingForPin` when the reset is valid and signed by the K_gw its pin stored: it opens no socket, keeps no new pin and shows
"The owner reset access to this claw. Set up this browser again." It is set up again with the
new kit (kit enrollment below) or an approval from a new owner device. A root change without a
valid RootReset is still `root_mismatch`, the substitution warning.

Trade-off: K_gw now vouches for a root change, so whoever holds K_gw (the machine) can reset
the claw. Moving a claw to new machine keys is a separate operation, not designed yet.

Owner device certificates have **no expiry unless the person approving the device enters
one** (`expires_at: null`). A device stops being an owner when it is removed from the claw's
allowlist.

`ownerDeviceCertBody` is the certificate builder approvers use: `expires_at` defaults to
null, and an explicit expiry must be after the issue time. Approval UIs (SAS approval, owner
devices) offer the expiry as an optional field.

### Admission

`isAdmitted(state, peerKey, now)` is what the tunnel child asks for every connection: the
key belongs to a listed member or to a listed owner device active at `now` (certificate
issued no later than `now` plus 300 seconds of clock skew and not expired).
Enrollment refuses a certificate outside its window (`expired`, `not_yet_valid`). An owner
device stays active when its approver expires or is dropped for inactivity; only an explicit
revocation removes the devices it approved. `recordSeen` and `dropInactive` maintain the
inactivity clocks (statements.md, The allowlist model).
`nextOwnerExpiry(state, now)` gives the next expiry boundary, at which the Gateway closes the
sessions that device already has open. Discovery is not consulted; withholding a
snapshot cannot keep a removed key admitted (G4).

`snapshotBody(state, bindingSeq, now)` builds the MembershipSnapshot the Gateway signs with
K_gw for Discovery (relay admission, listings).

Not modeled here (Gateway work): pending-redemption expiry after 7 days, and persistence.

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

The Gateway keeps an invite only while it can matter. `registerInvite` refuses a cap that has
expired or expires more than a week from now, deletes spent records first, and refuses a new
invite while the claw holds 100. A record is spent once its cap expired (plus the clock skew)
and no redemption is pending on it (`withoutSpentInvites`); the Gateway also deletes spent
records before its other writes. Removing an owner device deletes the open invites it
registered.

## SAS approval of a new owner device (spec 6.1)

| Step | Message                                                                          | Function                                      |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | N -> E `start` {request_id, claw_id, device_pub, peer_key, label, commit}        | `sasCommitment(eph_N, start)` = SHA-256(eph_N |                                                   | JCS(start))                   |
| 2    | E -> N `accept` {eph_E, device_pub(D_E)}                                         |                                               |
| 3    | N -> E `key` {eph_N}                                                             | E: `verifySasCommitment`                      |
| 4    | both: ss = X25519, T = SHA-256(JCS({start, commit, eph_e, eph_n, device_pub_e})) | `sasSharedSecret`, `sasTranscript`            |
| 5    | both show 6 digits: HKDF(ss, info `openclaw/sas/v1`                              |                                               | hex(T)) mod 10^6                                  | `sasCode`                     |
| 6    | user confirms "matches" on both screens                                          |                                               |
| 7    | E -> Gateway (direct): MembershipChange `add_owner_device`                       | authority                                     |
| 8    | E -> N: AES-256-GCM under HKDF(ss, `openclaw/sas-mac/v1`                         |                                               | hex(T)) of {R pub, binding, OwnerDeviceCert(D_N)} | `sealHandoff` / `openHandoff` |
| 9    | N verifies the binding under R and the binding host, pins, connects              | `verifyBindingForPin`                         |

Why the commitment matters: a relay in the middle must fix the key it gives E (inside the
commitment it forwards) before it sees eph_E, and the key it gives N before it sees eph_N.
It cannot grind, so each attempt matches with probability 10^-6. X25519 needs WebCrypto
X25519 (current Chrome, Firefox, Safari; qualify alongside Ed25519).

### Approval from the original local Control UI (OCF-287)

The original linking browser retains its non-extractable owner-device key D in IndexedDB,
scoped to that exact origin. It signs the same certificate and membership change as the loader
approver, using `ownerDeviceCertBody` and the SAS helpers above. The Gateway
holds neither D nor the recovery-kit root. Direct-loopback operator access alone cannot sign.

The local browser sends its account token and exact D-signed Discovery request through the
owner-only `openclawId.authority` `device_mail` relay. The relay constructs only fixed device
binding/mailbox paths, preserves request bytes/signature, prohibits redirects and checks current
owner authorization before and after the request. It never signs device mail with K_gw.
This avoids adding loopback origins to Discovery's CORS policy.

For mail addressing, the browser binds D with a separate non-extractable mailbox-only peer
proof key W. W is not added to its owner certificate, membership, or tunnel admission.
Discovery's optional `OpenClaw-Owner-Certificate` header names the request's own D (the
certificate's `device_pub` must equal the signing device). Discovery then requires D in the
`owner_devices` of the claw's K_gw-signed snapshot for the current binding, with
`approve_device` among the caps listed there, for the claw's owner account. It does not trust
the certificate's own caps, signature or window: the snapshot is the authority. This
lets a local certificate with no peer keys read owner mail. It does not grant
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
   reset the profile, or paste a recovery kit to make this test pass.

## Kit enrollment (spec 6.2)

N decodes the kit (`decodeKit`), derives R (`deriveRootSigner`), checks fp(R), verifies the
binding against R, then signs with R its own OwnerDeviceCert and `MembershipChange
add_owner_device` (recorded as approved by `root`). These go to
the Gateway through the mailbox; the Gateway emits `notify_owners: kit_used`. N drops R.

N signs its `add_owner_device` at the seq of Discovery's snapshot + 1. When that snapshot lags
the Gateway (a failed publication), the Gateway refuses the statement as `seq_conflict`,
republishes its snapshot and mails N's device fingerprint a `notice` with `event: "seq_conflict"`
and `ref` = its current seq. While N still holds R it re-reads the K_gw-signed snapshot, checks
it is at least `ref`, and signs again at that seq + 1; otherwise it asks the user to retry.
