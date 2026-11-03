# Discovery API v1 (v1-draft, OCF-191)

**Status: v1-draft.** Code: `src/discovery/` (endpoint table, request/response types, error
codes, descriptor parsing, signed requests, mailbox types).

## What Discovery is, and is not

Discovery is **a mirror and a per-claw mailbox**. The Gateway is the membership authority;
the owner root R is the trust root clients pin. Discovery holds no owner key, no Gateway key
(K_gw), no tunnel key (K_srv) and no device key.

**Invariant: Discovery cannot forge an accepted statement.** Everything a consumer acts on is
a signed statement that the consumer verifies against its own state:

| Data Discovery serves                      | Signed by                          | Verified by                                             | Against                                                     |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| ServerBinding (in the descriptor)          | R or an owner device (`bind`)      | loader / transport hook                                 | the client pin {fp(R), claw_id, binding_seq}                |
| MembershipSnapshot                         | K_gw                               | relay admission (Discovery itself), clients for listing | K_gw of the verified binding                                |
| InviteRedemption (mailbox)                 | invitee's D_I + invite proof       | Gateway                                                 | registered invite (proof key, expiry, audience, single use) |
| R-signed statements, Revocations (mailbox) | R / owner device                   | Gateway                                                 | pinned root and the claw's current owner devices            |
| SAS enrollment messages (mailbox)          | end-to-end (commitment, SAS, AEAD) | the two devices                                         | the user comparing 6 digits                                 |

What Discovery **can** do, by design: withhold, delay, drop, replay or reorder messages and
snapshots; list claws and devices; assert user identity (account id, email, location hint) -
always shown as "reported by OpenClaw ID"; refuse relay admission (availability only).

What it **cannot** do: add a member, an owner device or an invite; approve a redemption
(approvals go **directly** to the Gateway over the tunnel or loopback, never through the
mailbox); change which K_srv a pinned client dials; keep a removed member connected (removal
takes effect at the Gateway and the tunnel child, G4).

The API follows from this: every write that matters carries a signed statement; Discovery's
own checks (signatures, sequence numbers) are hygiene that keeps garbage out of the mirror,
never the security boundary.

## Authentication

| Class     | How                                                                   | Used by                                                   |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| `user`    | `Authorization: Bearer <OpenClaw ID token>`                           | loader, apps                                              |
| `device`  | `user` + `OpenClaw-Signature` by a device key D bound to that account | owner/member devices reading device mail, binding devices |
| `gateway` | `OpenClaw-Signature` by the claw's registered K_gw. No bearer secret  | Gateway (control connection)                              |
| `relay`   | static bearer token; relay source address allowlisted at the edge     | iroh-relay `access.http`                                  |

`OpenClaw-Signature: keyid=ed25519:<hex>,ts=<unix>,sig=<base64url>`, where sig = Ed25519 over
`"openclaw/discovery-request/v1\0" || JCS({ body_sha256, method, path, ts })` (`path` includes
the query; `body_sha256` is hex of the raw body, empty body included). Skew <= 300 s. The
server then checks that `keyid` is the expected key. The tunnel child never talks to
Discovery directly; the Gateway does, and passes the descriptor data it gets from the child's
ready message.

## Endpoints

| Name                    | Method and path                                       | Auth                                      | Request -> response                                                                                |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| createEnrollmentCode    | `POST /v1/enrollment-codes`                           | user                                      | - -> `{ code, expires_at }` (one-time, 10 min)                                                     |
| checkClawName           | `POST /v1/claw-names`                                 | gateway (any K_gw; the code is not spent) | `{ code, name }` -> `{ name, account_tag, hostname, available }`                                   |
| registerClaw            | `POST /v1/claws`                                      | gateway (key = binding.k_gw)              | `{ code, descriptor }` -> `{ claw_id, owner_account_id }`                                          |
| getRegistration         | `GET /v1/claws/{claw_id}/registration`                | gateway (current registered K_gw only)    | -> `{ claw_id, owner_account_id, descriptor }`; no account-session fallback                        |
| listClaws               | `GET /v1/claws`                                       | user                                      | -> `{ claws: [{ claw_id, hostname, name, relationship, role, online, descriptor_published_at }] }` |
| publishDescriptor       | `PUT /v1/claws/{claw_id}/descriptor`                  | gateway                                   | `{ descriptor }` -> 204; `stale_binding` if binding_seq decreases                                  |
| getDescriptor           | `GET /v1/claws/{claw_id}/descriptor`                  | user                                      | -> `{ descriptor }`                                                                                |
| publishSnapshot         | `PUT /v1/claws/{claw_id}/snapshot`                    | gateway                                   | `{ snapshot }` -> 204; `stale_snapshot` unless newer by (seq, issued_at)                           |
| getSnapshot             | `GET /v1/claws/{claw_id}/snapshot`                    | user                                      | -> `{ snapshot }`                                                                                  |
| bindDevice              | `POST /v1/devices`                                    | device (signer = device_pub)              | `{ device_pub, peer_key, label, ts, peer_key_proof }` -> `DeviceEntry`                             |
| listDevices             | `GET /v1/devices`                                     | user                                      | -> `{ devices: [...] }`                                                                            |
| unbindDevice            | `DELETE /v1/devices/{device_fp}`                      | user                                      | -> 204                                                                                             |
| sendMail                | `POST /v1/claws/{claw_id}/mailbox`                    | user (device-signed when a device sends)  | `{ to, payload }` -> `{ message_id, expires_at }`                                                  |
| receiveMail             | `GET /v1/claws/{claw_id}/mailbox?after=&wait=`        | gateway                                   | -> `{ messages, cursor }` (to `gateway`)                                                           |
| receiveDeviceMail       | `GET /v1/claws/{claw_id}/mailbox/device?after=&wait=` | device                                    | -> `{ messages, cursor }` (to `owners` if an owner device, and to its own fp)                      |
| ackMail / ackDeviceMail | `POST .../mailbox/ack`, `POST .../mailbox/device/ack` | gateway / device                          | `{ cursor }` -> 204                                                                                |
| irohAdmit               | `POST /iroh/admit`                                    | relay                                     | header `X-Iroh-Endpoint-Id` -> body `true` / `false`                                               |

Types for every body are in `src/discovery/api.ts`; the endpoint table is
`DISCOVERY_ENDPOINTS`.

### Freshness (freshness/v1)

The Gateway re-signs its MembershipSnapshot at startup, on every membership or binding change and
at least every `SNAPSHOT_REPUBLISH_SECONDS` (1 h) even when nothing changed: the same `seq`, a
new `issued_at`. Discovery orders snapshots by (`seq`, `issued_at`) (`isOlderSnapshot`) and
refuses an older one with `stale_snapshot`. The snapshot carries current state only; there is no
revocation list to publish or serve. Clients apply `assessFreshness` (statements.md, "Pins and
rollback").

### Descriptor

```json
{ "v": 1, "claw_id": "<32 hex>", "transport": "iroh", "relay_url": "https://.../",
  "root_pub": "ed25519:<hex>", "binding": <ServerBinding>,
  "published_at": 1793318400 }
```

- No `endpointId`: the client dials `binding.body.k_srv` after `verifyBindingForPin`.
- No `rotations`: a claw's root never changes (owner reset is out of scope, OCF-319).
- `relay_url` must be https (http only for localhost testbeds). It is a hint.
- Unknown fields are rejected. On publish, Discovery runs `checkDescriptorConsistency`
  (binding verifies under the descriptor's own root) and refuses a lower binding_seq; neither
  is a security property.
- The owner account is Discovery's own record (from the enrollment code), returned by
  registerClaw and listClaws, never part of the signed data.

### Claw addresses

A claw's hostname is `<name>-<account tag>.<claw origin domain>`, e.g.
`studio-k7x2q.crabd.me`. The owner picks the name when linking; the account tag is random (not
derived from the account id), 5 lower-case Crockford base32 characters, created at the account's
first link, shared by all of its claws and never given to another account. The address carries
no identity: clients trust `claw_id` and the pinned key, and check `binding.hostname ==
location.host`.

- `checkClawName` answers which hostname the code's account would get for `name` and whether
  it is free. Names are 1-57 characters of `a-z`, `0-9` and single hyphens, start with a
  letter and do not end with a hyphen (the whole label stays within 63); some names are
  reserved for service hostnames. Invalid names are `bad_request`.
- `getRegistration` lets a Gateway recover a lost local registration receipt without relinking.
  Only the currently registered K_gw can read it; wrong keys and unknown claws get the same 404.
  Before retaining the account ID, the Gateway must match the returned claw ID, root public key
  and complete signed binding to its own committed identity. It must not adopt remote authority.
- `registerClaw` refuses a binding hostname that is not `<valid name>-<the code account's
  tag>` (`bad_request`) or that any claw ever had (`conflict`). Hostnames are never reused:
  a retired claw's hostname stays assigned.
- `listClaws` returns `name` (the `<name>` part), or null for a hostname of another form.

### Device binding

`bindDevice` links D and W to the signed-in account so Discovery can address device mail and
list devices. `peer_key_proof` is a base64url Ed25519 signature by W over
`"openclaw/peer-key-proof/v1\0" || JCS({ account_id, device_pub, peer_key, ts })`.
Binding grants nothing at any claw: admission comes from the Gateway's membership.
`peer_key` must be `iroh:`; a `nodekey:` key is `transport_mismatch`.

### Mailbox

Store-and-forward of messages for one claw. Recipients: `gateway`, `owners` (every owner
device in the latest snapshot), or one device fingerprint (`fp:<hex>`). Payload kinds:

| kind                | Sent by                   | To          | Reader's check                                                                            |
| ------------------- | ------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `invite_redemption` | invitee                   | gateway     | `InviteRedemption` self-signature + invite proof; result is only a **pending** redemption |
| `root_statement`    | a device holding the kit  | gateway     | R-signed statements under the pinned root                                                 |
| `revocation`        | owner device              | gateway     | signer must be R or a current owner device of the claw                                    |
| `enrollment`        | new device / owner device | fp / owners | SAS protocol (below)                                                                      |
| `notice`            | Gateway                   | owners / fp | none: a hint; the device confirms at the Gateway directly                                 |

Notice events are `MAILBOX_NOTICE_EVENTS`. `seq_conflict` goes only to the one device fingerprint
whose `root_statement` the Gateway refused for a stale seq (`noticeRecipientAllowed`); its `ref` is
the Gateway's current seq in decimal (`parseSeqConflictRef`). Discovery delivers it only to a
device of the claw's owner account, in the control lane. Every other event goes to `owners`.

The Gateway accepts only `GATEWAY_MAILBOX_KINDS` (`invite_redemption`, `root_statement`,
`revocation`) from the mailbox. **A device-signed MembershipChange that arrives through the
mailbox is refused**, so an approval can never be forged or replayed by Discovery.

Limits: payload <= 64 KiB, TTL 7 days, long-poll `wait` <= 30 s, rate limits per claw, per
account and per source address (`rate_limited` with `retry_after`).

Enrollment `data` per step (spec 6.1; messages are relayed verbatim):

| step     | data                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| `start`  | `{ claw_id, device_pub, peer_key, label, commit }` - commit = hex SHA-256(eph_N                                |     | JCS(start fields)) |
| `accept` | `{ eph_pub, device_pub }` - E's X25519 ephemeral key (hex) and D_E                                             |
| `key`    | `{ eph_pub }` - N's X25519 ephemeral key; E checks the commitment                                              |
| `sealed` | `{ nonce, ciphertext }` - AEAD under HKDF(ss, `openclaw/sas-mac/v1`) of {R pub, binding, OwnerDeviceCert(D_N)} |
| `abort`  | `{ reason }`                                                                                                   |

### Relay admission (`POST /iroh/admit`)

Unchanged from the spike's iroh-relay `access.http` contract: header
`X-Iroh-Endpoint-Id: <64 lowercase hex>`, `Authorization: Bearer <token>`; body exactly
`true` or `false`; malformed id -> `false`; missing/wrong bearer -> 401 (the relay fails
closed); log only `fp:` labels. v1 admits:

- the K_srv of each claw's latest descriptor;
- owner and member peer keys listed in each claw's latest **verified** snapshot (K_gw
  signature checked against the stored binding). A removed key is simply absent.

This is an **abuse and cost filter, not access control**. If Discovery serves a stale
snapshot, a removed key may still reach the relay; the tunnel child still refuses it
(`not_a_member`). Production adds a relay-side rate limit and a short deny cache.

## Errors

`{ "error": { "code": "<code>", "message": "...", "retry_after"?: <seconds> } }`. Clients
match `code` only.

| code                 | HTTP | When                                                                        |
| -------------------- | ---- | --------------------------------------------------------------------------- |
| `bad_request`        | 400  | malformed JSON or parameters                                                |
| `invalid_statement`  | 400  | a statement fails shape or signature checks                                 |
| `unauthorized`       | 401  | missing/invalid token or request signature                                  |
| `forbidden`          | 403  | authenticated but not allowed (not the claw's K_gw, not an owner device...) |
| `transport_mismatch` | 403  | key type does not match the claw's transport                                |
| `not_found`          | 404  | unknown claw, device or message                                             |
| `conflict`           | 409  | already registered / duplicate                                              |
| `stale_binding`      | 409  | descriptor binding_seq lower than stored                                    |
| `stale_snapshot`     | 409  | snapshot not newer than stored by (seq, issued_at)                          |
| `code_invalid`       | 410  | enrollment code unknown, used or expired                                    |
| `payload_too_large`  | 413  | mailbox payload over 64 KiB                                                 |
| `rate_limited`       | 429  | per claw / account / address limit                                          |
| `unavailable`        | 503  | temporary failure                                                           |

## Open questions

- Should `getDescriptor` be readable without a session (invite links before sign-in)? v1:
  user auth required.
- Device mail for `owners`: Discovery decides "is an owner device" from the snapshot's
  `owner_peer_keys` (or `owner_devices` and their caps for a certificate reader) and its own
  device bindings; withholding it only delays enrollment.
- Claw retirement (spike threat-model backlog 4) is not specified yet.
