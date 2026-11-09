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
| MembershipChange by an owner device           | `submitStatement`                          | tunnel, local_operator | `seq` must be current + 1; an `add_owner_device` certificate has the change's signer                |
| MembershipChange signed by R (kit enrollment) | `submitStatement`                          | any, incl. mailbox     | `add_owner_device` via mailbox emits `notify_owners: kit_used`                                      |
| Revocation                                    | `submitStatement`                          | any                    | removes keys listed at or before its `seq`, with every owner device they approved (no history kept) |
| InviteCap + proof key                         | `registerInvite`                           | tunnel, local_operator | `secret_hash` must equal SHA-256(proof key); expires within a week; at most 100 per claw            |
| InviteRedemption                              | `submitRedemption`                         | any (normally mailbox) | becomes **pending**, reserves the invite, admits nothing                                            |
| Approve redemption                            | `submitStatement` (`add` with `invite_id`) | tunnel, local_operator | must match the pending account and peer key; role <= invite role                                    |
| Deny redemption                               | `submitStatement` (`deny_invite`)          | tunnel, local_operator | consumes the invite                                                                                 |
| Re-bind (proposed, below)                     | Gateway `rebind_prepare` / `rebind_commit` | local_operator         | a new R-signed ServerBinding at a higher binding_seq naming new K_srv and K_gw                      |

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
the claw. Moving a claw to new machine keys under the same root is the re-bind, below.

Owner device certificates have **no expiry unless the person approving the device enters
one** (`expires_at: null`). A device stops being an owner when it is removed from the claw's
allowlist.

`ownerDeviceCertBody` is the certificate builder approvers use: `expires_at` defaults to
null, and an explicit expiry must be after the issue time. Approval UIs (SAS approval, owner
devices) offer the expiry as an optional field.

### Re-bind: moving a claw to new machine keys (proposed, openclaw-bec)

**Status: proposed for review, not implemented.** Nothing below exists in the Gateway yet. The
pieces it relies on already exist: pins follow an R-signed ServerBinding at a higher
binding_seq (this package), and Discovery accepts a descriptor signed by the K_gw its new
binding names (Discovery `main`).

A re-bind moves a claw to new machine keys under the **same** root R: R signs a new
ServerBinding with binding_seq + 1, naming a new K_srv and a new K_gw. Nothing else changes:
the claw id, hostname, root, owner devices, members, nodes, invites, membership `seq`, device
tokens and device pairings all stay. Clients follow it with rules they already apply: the
binding verifies under the pinned root, its binding_seq is higher than the pin's, and the pin
stores the new K_gw (statements.md, "Pins and rollback"). There is **no new statement type**.

Re-bind and owner reset are opposites. Owner reset changes who controls the claw (a new R)
and keeps the machine keys. Re-bind changes which machine keys the claw answers on and keeps
who controls it.

#### When to re-bind

| Trigger                                                        | Keys that must change | What the ceremony changes                  |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------ |
| Lost key file (disk loss, deleted, restore that skipped keys)  | the lost one          | both                                       |
| Suspected leak of K_srv (the tunnel child's key)               | K_srv                 | both                                       |
| Suspected leak of K_gw (the Gateway key)                       | K_gw                  | both                                       |
| Moved to a new machine without the key files                   | both                  | both                                       |
| Moved to a new machine with the whole state directory          | none                  | nothing: no re-bind needed                 |
| Routine rotation                                               | owner's choice        | both                                       |
| Someone could run processes on the Gateway host, or kit leaked | -                     | owner reset (then re-bind if keys are bad) |

The ceremony always replaces both keys. Both live on the same host under the same user, so a
reason to distrust one usually covers the other; a client verifies one new binding whatever
changed, so replacing an intact key costs it nothing; and one path means one set of tests.

A re-bind does not audit membership. If someone may have changed the Gateway's state (host
compromise), owner reset is the tool: it removes every owner device and member.

#### Who signs

Only R signs, from the recovery kit, on the machine. Alternatives considered:

- **An owner device with the `bind` capability.** Rejected. Clients pin only fp(R) and have
  no allowlist; the only document that lists owner devices to a client is the snapshot, which
  is signed by K_gw, the key being replaced. Whoever holds the old K_gw could list a device of
  their own with `bind`. Bindings stay R-only (statements.md); `bind` stays reserved.
- **The old K_gw vouches for the new keys**, as it does for a RootReset. Rejected. It cannot
  work when K_gw is lost, it hands the decision to the attacker when K_gw leaked, and it would
  let K_gw alone point clients at any K_srv, a power K_gw does not have today.
- **A standby binding pre-signed at link time** for spare keys. Rejected. It is an escrowed
  R signature over keys stored next to the ones it replaces, so the loss it covers usually
  takes it too.

#### Where it runs

On the machine only: `local_operator` (direct loopback), like linking and owner reset. Over
the tunnel the Gateway refuses it with `not_local_operator` and the Control UI does not show
it. It works with the tunnel down, which is the lost-key case. The new keys are created on the
machine and the binding must name them, and the kit is typed where the link ceremony typed it:
in the CLI on the machine or the Control UI on direct loopback.

The Gateway must be running; OpenClaw ID in it may be stopped by the key check below. If the
Gateway cannot start at all, that is a separate repair.

#### Steps

1. **Prepare** (`rebind_prepare`, local_operator). Requires a linked claw. Creates the staged
   keys if they do not exist yet: K_gw' in `openclaw-id/gateway.key.next` (by the Gateway) and
   K_srv' in `openclaw-id/endpoint.key.next` (by the tunnel child in a one-shot `stage` run;
   the Gateway never reads a K_srv file). Returns `{ claw_id, hostname, root_pub, k_srv, k_gw,
   binding_seq, root_epoch }` for the new binding, plus the current keys for display.
   binding_seq is the stored binding's + 1, or a higher value the operator gives. Preparing
   again returns the same staged keys; cancelling deletes them. Prepare commits nothing.
2. **Sign** (in the CLI process or the local Control UI browser). Decode the kit, derive R,
   check that fp(R) equals the claw's pinned root (else stop: "this kit is for another
   claw"), show the old and new key fingerprints, sign the ServerBinding, drop R and S.
3. **Commit** (`rebind_commit`, local_operator). The authority checks, serialized with every
   other write: the binding verifies under the pinned root (`wrong_signer`, `bad_signature`);
   it names this claw and hostname and exactly the staged K_srv' and K_gw' (`target_mismatch`);
   its binding_seq is the prepared one and above the stored one (`rollback`); both keys differ
   from the stored binding's (`target_mismatch`). Accepted: the binding replaces the stored one
   in one write. From here the stored binding alone says which keys are current.
4. **Activate.** The Gateway switches to K_gw' and restarts the tunnel child on K_srv'
   (promotion follows the key rule below, so a crash anywhere completes it on the next start).
   Every live tunnel connection closes with `shutdown` (code 0, reconnect allowed).
5. **Publish** the descriptor and its snapshot **in one request**, signed by K_gw', with the
   owner-account code (discovery.md, "Re-bind"). The snapshot has the new binding_seq and the
   current membership `seq`. Discovery stores both or neither, so members, owners and nodes
   never see a descriptor without a matching snapshot. The Gateway keeps the code in memory
   for this publication and its retries and drops it once the publish is confirmed. If the code
   is gone (Gateway restart) or expired (10 minutes), status reports `needs_link_code` and the
   owner runs `openclaw id publish --code`. A publish that was accepted but whose answer was
   lost is harmless to repeat: Discovery then already stores K_gw', so no code is needed and an
   identical binding at the same seq is accepted. Until publication succeeds, remote clients
   cannot reach the claw. The Gateway also mails owners a `rebind` notice (discovery.md,
   "Mailbox").

Events: `restart_tunnel`, `publish_rebind`, `notify_owners: rebind`. No `disconnect` or `invalidate_tokens`: nobody lost access.

#### Key files at every start (fail closed, openclaw-aab)

A linked Gateway never creates a machine key. The stored binding names the current K_srv and
K_gw, and at every start:

1. The key file holds the named key: use it, and delete a leftover `.next` file.
2. Otherwise the `.next` file holds it: rename it over the key file (this finishes an
   interrupted re-bind) and use it.
3. Otherwise: refuse that key, with the reason `keys_missing` (no file) or `key_mismatch`
   (another key). Status and the Control UI point to the re-bind. The rest of the Gateway runs.

"Holds the named key" means the public key derived from the file's seed equals the one the
binding names; a planted `.next` file with any other seed is never promoted.

The Gateway applies this to K_gw. The tunnel child applies it to K_srv: its start message
carries the K_srv the binding names, and it exits with a code the supervisor does not retry.
A refused K_srv means no tunnel. A refused K_gw means nothing is signed with K_gw: no
publication, snapshot or Discovery request. An intact key keeps working, so with K_srv lost
and K_gw intact the Gateway can still publish the local ceremonies (owner reset, re-bind).
An unlinked Gateway creates keys as it does today.

#### What stays, and why

Owner reset removes everyone because control of the claw changed, and is often used because
an owner device can no longer be trusted. A re-bind does not change control. Every owner
device and member traces its approval to R, which is unchanged. Device tokens and pairings
are bound to the client's own key W, not to K_srv. Invites and node join links name the
claw id, fp(R) and hostname, none of the machine keys. The membership is unchanged, so its
`seq` does not move.

#### Concurrency and failures

- **Owner reset or link at the same time.** All three are serialized by the authority. Commit
  re-checks the pinned root and the stored binding_seq, so a reset between prepare and commit
  fails the commit (`wrong_signer` or `rollback`) and the operator starts over with the new
  kit. A reset after a re-bind is vouched for by the new K_gw.
- **Reset and re-bind in sequence.** Discovery accepts a reset only when its previous binding
  is exactly the stored one (discovery.md, "Owner reset"), and a reset keeps the machine keys.
  So neither ceremony may start while the other's publication is pending: the Gateway refuses
  it with `publication_pending` until Discovery confirmed the earlier one. Owner reset is a
  dependency of the reset paths below: the Gateway does not implement it yet, and Discovery
  `main` does not yet accept a root change.
- **Kit unavailable.** No re-bind. If K_gw is intact: owner reset with a new kit (published
  by the intact K_gw, even with K_srv lost), then re-bind with it if K_srv is the problem. If the kit and K_gw are both gone, neither works:
  Discovery accepts a new root only with a RootReset by its registered K_gw (discovery.md).
  The claw must be linked again as a new claw (hostnames are never reused).
- **Rollback.** An older binding is refused by Discovery (`stale_binding`) and by every
  client whose pin moved past it (`rollback`). Only Discovery refuses an equal seq with other
  bytes (`conflict`); clients accept an equal seq, so a signer must never sign two different
  bindings at the same binding_seq (a restored or copied kit included).
- **Restore from an older backup.** The local binding_seq can be below Discovery's.
  Publication then fails with `stale_binding` or `conflict`; the operator re-binds again with
  a binding_seq above Discovery's. (A restored older membership has its own seq problem,
  outside this design.)
- **Leaked old keys.** Discovery stops accepting the old K_gw at the descriptor publish, and
  no longer admits the old K_srv to the relay. A client that verified the new binding ignores
  anything signed by the old K_gw. A client still pinned to the old binding stays exposed as
  statements.md describes until it reads the new descriptor. A stolen K_gw can also sign a
  snapshot with an inflated membership `seq` or a future `issued_at` before the re-bind; so
  that this cannot block the honest snapshots afterwards, Discovery and clients order
  snapshots only among those signed by the same K_gw (discovery.md, "Re-bind";
  statements.md, "Freshness").
- **A leaked kit.** R alone moves a claw: every pinned client follows any binding R signs at
  a higher seq. Discovery therefore asks for a one-time code from the claw's owner account
  before it accepts a new K_gw (discovery.md, "Re-bind"). A Gateway whose publication is
  refused because Discovery holds a newer binding this Gateway did not commit reports
  `binding_superseded`.

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

## Headless node enrollment

Nodes have their own W key class: no account, member role, owner device D or owner
capabilities. W is generated and kept locally by the node. A node must never be enrolled as
an owner device or member to make connectivity work. The authority rejects overlap in either
direction, including an owner D or R with the same raw bytes as node W.

1. An owner device with `invite` (or R) creates an invite ID and 32-byte secret with
   `generateInviteSecret`, derives the existing `deriveInviteProofKey(secret)`, signs
   `NodeInviteCap { claw_id, invite_id, label, created_at, expires_at, secret_hash }`, and
   calls `registerNodeInvite(state, cap, proofKey, context)` directly. K_gw alone cannot
   register one. Node invites are always single-use; no audience/account or role is present.
   Creators default to `DEFAULT_NODE_INVITE_LIFETIME_SECONDS` (600 seconds / 10 minutes).
   Registration enforces `MAX_NODE_INVITE_LIFETIME_SECONDS` (3600 seconds / 1 hour) from
   creation and from registration, without a clock-skew extension. Expired caps are refused.
2. `buildNodeJoinLink` encodes `NodeJoinLink` as
   `openclaw-node://join#i=<invite_id>.<base64url secret>&c=<claw_id>&r=<fp(R) hex>&h=<hostname>&relay=<URL>`.
   Values are URL-encoded. `parseNodeJoinLink` is the strict CLI/deep-link decoder. All five
   fields must occur exactly once; unknown fields, query, path, credentials and malformed
   secrets/pins are refused. The relay must be HTTPS (HTTP only on localhost testbeds),
   without credentials, query or fragment. The link has no long-lived key. Treat the whole
   fragment as a secret: never put it in logs, analytics or an HTTP request target.
3. The node generates W locally, computes `computeNodeRedemptionProof(proofKey, parts)`:
   HMAC-SHA-256(proof key, `"openclaw/node-invite-proof/v1\0"` || JCS({ claw_id, invite_id,
   peer_key })), lowercase hex. The existing proof-key derivation is shared, but the HMAC
   domain and signed statement type are separate from member invitations.
4. W signs `NodeRedemption { claw_id, invite_id, peer_key, description, proof, requested_at }`. The
   envelope's `signer` is `ed25519:` with the same raw 32 bytes as `peer_key` (`iroh:`).
   The node sends `node_redemption` mail with W-signed Discovery authentication, no bearer
   token. `submitNodeRedemption(state, input, now)` checks W, invite, expiry and HMAC, then
   records **pending**, including the signed self-reported `description`, reserves the invite
   and notifies owners. It admits nothing. A pending redemption cannot be replaced in place.
5. The node terminal and owner approval dialog both show `nodeVerificationCode` for the
   pending redemption. The dialog shows its display name, platform, commands and capabilities.
   The owner must compare the codes and review that surface, then **explicitly click Approve**.
   Opening or leaving the dialog open never approves a node automatically.
   An owner with `manage_members` (or R) signs `MembershipChange` at current seq + 1,
   `add_node { peer_key, label, invite_id }`, directly at the Gateway. It must match the
   pending node W; it consumes the invite and retains its approved description in `NodeRecord`. `deny_invite { invite_id }` also handles nodes.
   Owner-device approval through the mailbox is refused. R retains its existing mailbox
   supremacy, but must still name a matching pending node redemption.
6. The node polls `getNodeDescriptor` using W, honoring rate-limit backoff. Only when W is
   in the verified current-binding snapshot's `node_peer_keys` may Discovery return the
   descriptor and snapshot. The node checks the link's claw ID, root fingerprint and hostname
   with `verifyBindingForPin`, applies `assessFreshness` to the snapshot, and dials only the
   verified K_srv. A pending/denied node gets no descriptor through node authentication.
   No node mailbox-read permission or user sign-in is needed.

### Verification code and self-reported surface

`NodeDescription` is `{ display_name, platform, commands: string[], caps: string[] }`.
It is required in W-signed `NodeRedemption.description`, retained in
`NodeInviteRecord.pending.description` and copied to `NodeRecord.description` on approval.
The name/platform describe what the node claims to be; they are not verified identity or authority.
Render them as untrusted text, never HTML, terminal escapes or instructions.

The strict schema rejects missing/unknown fields, duplicate list entries, malformed Unicode,
empty strings, C0 controls and DEL. Lengths use UTF-16 code units: display name at most
`MAX_NODE_DISPLAY_NAME` (128), platform `MAX_NODE_PLATFORM` (64); commands and caps each
contain at most `MAX_NODE_SURFACE_ITEMS` (64) unique names of at most
`MAX_NODE_SURFACE_NAME` (128) units each. Empty command/capability lists are allowed.
These bounds also bound the serialized signed description; no free-form nested payload is allowed.

`nodeVerificationCode({ claw_id, invite_id, peer_key, description })` computes SHA-256 over
UTF-8 `"openclaw/node-verification-code/v1\0"` followed by JCS of exactly those four fields.
Interpret the first four digest bytes as an unsigned big-endian integer, reduce modulo
1,000,000 and display six decimal digits with leading zeroes. List order is signed and stays
unchanged for code calculation. Proof and timestamps are excluded so Gateway receipt time
cannot change the code. The fixture `node_invite.verification_code` is a cross-language vector.
The code is for human comparison, not a credential, signature or automatic-approval signal.

### Discovery bootstrap routing

The join link deliberately does not identify a Discovery API origin. A claw hostname and
an iroh relay URL may both differ from Discovery; clients **must not infer** the API origin
from either. Joining therefore takes two inputs: the link and a deployment-selected Discovery
base URL. The headless command contract is
`openclaw node join <link> --discovery-url <https-origin>`.
An explicit flag wins over the node's saved deployment configuration; a distribution may
supply a documented deployment default only when neither exists. This protocol defines no
universal production origin. With no configured origin, fail before generating W or sending
mail and request `--discovery-url`. The Control UI's copyable join command must include its
configured Discovery origin, especially for staging and independently hosted deployments.

The Discovery base is an HTTPS origin without userinfo, path (except `/`), query or fragment;
HTTP is permitted only for localhost testbeds. API paths in `DISCOVERY_ENDPOINTS` are resolved
against that origin. Store the chosen origin alongside the node's enrollment for subsequent
polling/reconnect. This is routing configuration, not authority: the link's claw ID, hostname
and root fingerprint must still verify the descriptor, binding and snapshot before dialing.
Never send the invite secret or proof key to the configured Discovery origin.

### Node authority and lifecycle

`AuthorityState.nodes` is keyed by W. `NodeRecord` holds `label`, `listed_seq`, `added_by`
(root or approving owner fingerprint), `last_seen`, `invite_id` and `description`. `node_invites` is a
separate map of `NodeInviteRecord`. Both invite maps share an ID namespace and a total
`MAX_INVITES` cap (100) and spent-record cleanup. Node links have the stricter one-hour
registration limit above; the member-invite lifetime is unchanged.
Removing an owner deletes the open node invites it registered, as for member invites;
already admitted nodes do not become owner approval descendants.

`MAX_NODES` is 256. Reapproving a still-listed node through a fresh pending invitation
preserves its listing seq and inactivity clock. `isAdmitted` includes node keys; `isNode`
distinguishes node-only principals. `snapshotBody` includes sorted `node_peer_keys` in the
K_gw-signed snapshot, never in owner/member lists.

When loading a claw persisted before node enrollment, the Gateway initializes the missing
unsigned `nodes` and `node_invites` maps before exposing its authority. Existing membership,
listing sequences and signed statements remain unchanged. The upgrade schedules a newly
signed snapshot with `node_peer_keys`; it never inserts fields into an old signed envelope.

`remove_node { peer_key }` and `Revocation { target_kind: "peer_key" }` remove nodes.
Revocation obeys the existing listing-seq rule, so replay cannot remove a fresh reapproval.
Removal emits `disconnect`, `invalidate_tokens`, `remove_node_pairings` (all naming W),
and `publish_snapshot`. The Gateway removes only node-role pairings whose provenance is
that W, never unrelated pairings. The authority itself stores no device pairing IDs.

`recordSeen` rate-limits node `last_seen` writes to hourly. The Gateway calls it for node
admission and authenticated node tunnel activity (including heartbeats), so a healthy
long-lived connection does not expire just because it has not reconnected. `InactivityWindows.nodeSeconds`
defaults to `NODE_INACTIVITY_SECONDS` (30 days); `nextInactivityDrop` includes nodes.
`dropInactive` returns the dropped peer keys and node-removal `events`; the Gateway performs
its existing owner/member inactivity effects too and advances/publishes its membership state.
As for existing member invites, expiry of an unresolved pending redemption after seven days
belongs to the Gateway's persistence/scheduling owner.

On the first node-role connect after signed admission, the Gateway may automatically approve
that W's node device pairing and initial command surface **only within the owner-approved
`NodeRecord.description.commands` and `.caps`**. Both announced sets must be subsets of those
stored sets (exact names, no wildcard expansion). Any additional command or capability goes
through normal capability approval; do not silently approve it or overwrite the stored consent.
The self-reported description by itself is informational: only the explicit owner approval
establishes this upper bound, and existing execution policy still applies. This is a one-time Gateway action,
not owner/member authority. A later manual pairing removal must suppress automatic re-pairing;
it does not silently become a new invitation. The Gateway owns that provenance and suppression.
