# Protocol versions (v1-draft)

**Status: v1-draft.** Code: `src/version.ts`, `src/statements/validate.ts`,
`src/statements/envelope.ts`, `src/discovery/descriptor.ts`.

This document says how the protocol changes after release: what carries a version, what a
reader does with a version it does not implement, which changes need a new version, and how
long an old version stays supported.

## What carries a version

| Surface                   | Marker                                     | Where                              |
| ------------------------- | ------------------------------------------ | ---------------------------------- |
| Signed statement envelope | `v` (integer), plus the signing-domain tag | `SUPPORTED_STATEMENT_VERSIONS`     |
| Claw descriptor           | `v` (integer)                              | `SUPPORTED_DESCRIPTOR_VERSIONS`    |
| Tunnel                    | QUIC ALPN `openclaw/tunnel/<n>`            | `TUNNEL_ALPN` (tunnel.md)          |
| Discovery HTTP API        | `/v<n>/` path prefix                       | `DISCOVERY_ENDPOINTS`              |
| Discovery request signing | `openclaw/discovery-request/v<n>\0` domain | `src/discovery/request-signing.ts` |
| Recovery kit text         | `OCK<n>-` prefix and version byte          | `KIT_FORMAT_VERSION`               |

The versions are independent. A new tunnel version does not need a new statement version,
and none of them changes the owner root (below).

## Reading a version

Each supported version has its own complete implementation: its own schema table and, for
statements, its own signing domain (`openclaw/<type>/v1\0` for v1). A reader never parses one
version with another version's rules and never accepts a version because it falls in a numeric
range.

A version field is classified as one of:

- **supported**: listed in the table; validated with that version's schema.
- **unsupported**: a well-formed version (integer >= 1) this build does not implement. The
  reader refuses it with `unsupported_version`, which callers present as "update required",
  not as tampering.
- **malformed**: anything else (missing, not an integer, below 1). Refused as `malformed`.

The version is checked before anything else, because a later version may add statement types
or fields this build does not know.

## Unknown fields

- **Signed statements reject unknown fields** in the envelope and the body. A new signed field
  needs a new envelope version, implemented by every party that must enforce it. A reader that
  does not implement that version refuses the statement; it never drops the field and accepts
  the rest. This matters most for fields that restrict authority (an expiry, an audience, a
  narrower capability): an old reader that ignored them would grant more than the signer meant.
- **New values** of an existing enumerated field (a capability, a membership operation, a
  mailbox kind) are a new version too, for the same reason.
- **Unsigned, informational payloads** may ignore unknown fields where their section says so
  (for example the tunnel HEAD frame). They carry no authority.

## Bootstrap

The descriptor is what a client reads before it can talk to the claw, so an old client must be
able to read it while the claw supports both an old and a new protocol. Rules:

- Descriptor v1 is the stable bootstrap. A claw keeps publishing a v1-readable descriptor for as
  long as it supports any protocol version an old client can use.
- A breaking descriptor change is published as an explicitly versioned view next to v1, never by
  replacing v1. Both views come from one authority state; each signed part in them is signed by
  its own signer (R for the binding, K_gw for snapshots). Discovery stores and serves them and
  cannot create or convert signed data.
- After bootstrap, a client chooses versions as described next.

## Choosing a version

The Gateway lists the versions it accepts for new input in its MembershipSnapshot:

```json
"protocols": { "statement": [1], "descriptor": [1] }
```

Each list is non-empty, ascending and contains only versions the Gateway implements
(`SUPPORTED_*_VERSIONS`). A retired version is simply absent; there is no separate minimum.

Negotiation is for compatibility, not security. **The Gateway enforces its own list**: it parses
input with its own version table and refuses an unlisted version with `unsupported_version`.
Every listed version is one the Gateway accepts as safe; a version with a security problem is
removed from the list (see "Support window"), and from then on no client can use it, whatever list
it was shown. So the worst Discovery can do by tampering with negotiation is make a client pick
an older version the Gateway still accepts, or one it no longer accepts and refuses.

- **Where the list comes from.** A client takes `protocols` only from a snapshot that passed
  `assessFreshness` (statements.md, "Pins and rollback"): signed by the verified binding's K_gw,
  recent, and not older than a snapshot the client has already seen. Discovery cannot edit a list
  (the signature breaks). It can replay an older signed list the client has not yet seen, for up
  to `SNAPSHOT_MAX_AGE_SECONDS`, or withhold snapshots; both are covered by the Gateway's own
  enforcement above. A list from anywhere else, including an unsigned Discovery field, is never
  used.
- **Choosing.** `selectVersion(advertised, local)` returns the highest version both sides
  implement. With nothing in common it returns `update_required` (the Gateway only accepts newer
  versions than this client implements) or `gateway_outdated` (only older ones). Only these two
  results, from a fresh list, mean the user must update something.
- **Without fresh evidence** (report policy, or before the first snapshot) a client has no list
  and may use any version it implements; a reasonable default is the oldest. The Gateway may
  refuse it with `unsupported_version` even when the client implements another version the
  Gateway accepts. That refusal means "get fresh evidence and choose again", not "update".
- **The tunnel is not listed.** Its version is the QUIC ALPN (`openclaw/tunnel/<n>`), chosen
  inside the TLS handshake that K_srv authenticates, so the relay cannot change it.

## Support window

- A party supports the **current and the previous protocol major** of each surface.
- The previous major stays supported for **at least six months after its successor is generally
  available**, and is retired only after an announced date and a migration path.
- A security problem in an old version can force an earlier cutoff.
- The window counts protocol versions, not OpenClaw releases.
- Connection support and stored data are separate. Retiring an envelope version for new
  connections does not invalidate statements already stored under it: they are migrated or
  re-issued, not silently dropped.

## Versions and the owner root

A protocol version is not an owner-root change. Adding a statement version, a descriptor view or
a tunnel version never needs a new root key, a new recovery kit or a root epoch. `root_epoch`
stays the constant 1 so existing signatures verify (enrollment.md). Replacing a claw's root is
owner reset (OCF-319), a separate, machine-local operation.

A new envelope version must not change how an existing recovery kit derives its root key:
the kit format has its own version (`OCK1`).
