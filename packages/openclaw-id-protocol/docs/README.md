# OpenClaw ID remote access protocol (v1-draft)

**Status: v1-draft.** Nothing here is a stable or shipped contract. Field names, codes and
paths can still change; every change lands in this package first, with its tests.

This package is the shared contract for the OpenClaw ID remote access work (Linear
initiative I-8). Gateway core, the tunnel child, the Discovery Worker and the loader build
against it. It runs unchanged in Node (>= 24), browsers and Workers: WebCrypto only, no
`node:crypto`, no runtime dependencies.

| Document                       | Linear  | What it defines                                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| [statements.md](statements.md) | OCF-190 | Keys, signed statement envelope, the allowlist model, pin verification, rollback rules              |
| [tunnel.md](tunnel.md)         | OCF-189 | `openclaw/tunnel/1` over iroh: framing, limits, close codes, headers                                |
| [discovery.md](discovery.md)   | OCF-191 | Discovery API v1: descriptor, devices, claws, snapshot mirror, mailbox, relay admission, enrollment |
| [enrollment.md](enrollment.md) | OCF-190 | Invites, SAS device approval, kit enrollment, reference membership authority rules                  |
| [acceptance.md](acceptance.md) | OCF-274 | Spec section 11 acceptance tests: which run here, which need the full system                        |
| [versioning.md](versioning.md) | -       | Version markers, unsupported versions, unknown fields, bootstrap, support window                    |

Source material: the owner-key spec v0.2 ("OpenClaw ID remote access: owner key and device
approval protocol", 2026-10-29) and the iroh spike (`tailcat-spike/docs/iroh/`). Spec
vocabulary maps to iroh as follows: W -> device iroh endpoint key, K_srv -> claw iroh
endpoint key held by the tunnel child, sidecar -> tunnel child process, DERP -> iroh-relay.

## Invariants every consumer relies on

1. **The Gateway is the membership authority. Discovery is a mirror and a mailbox.** Nothing
   Discovery stores or returns is trusted because Discovery returned it: every
   security-relevant fact is a signed statement that the consumer verifies against its own
   pin (fp(R), claw_id, binding_seq).
2. **Discovery cannot forge an accepted statement.** It holds no owner key, no Gateway key
   (K_gw) and no device key. It can withhold, delay, replay or reorder; it cannot add a member,
   an owner device, a node, an invite, an approval or a binding, and a replayed revocation cannot
   remove a key that was approved again.
3. **No credential before verification.** A client opens a tunnel only to the K_srv of a
   ServerBinding it has verified against its pin, and releases stored tokens only after that.
4. **Approvals travel directly.** Membership changes and invite approvals reach the Gateway
   over the tunnel or direct loopback, never through the mailbox. The mailbox carries only
   requests and root-signed statements (kit enrollment, revocation).
5. **Only the machine replaces a claw's root.** R is pinned at linking, only by the local
   operator on direct loopback. Owner reset on the machine replaces it, vouched for by the
   Gateway key K_gw; a client never moves its pin to the new root, it is set up again
   (enrollment.md, "Owner reset"). Certificates have no expiry unless one is entered
   explicitly (enrollment.md).

6. **Nodes are a separate key class.** Node W has no owner/member authority. An owner or R
   signs every node admission; neither Discovery nor K_gw alone can add a node. A redemption
   is pending only. Keys stay local; join links carry only a short-lived invitation and pin.

## Layout

```
src/            protocol code (statements/, tunnel/, discovery/, shared key, JCS and crypto helpers)
src/testing/    deterministic vector builder (exported as ./testing)
fixtures/v1-draft/  JSON test vectors for other languages and repositories
docs/           these documents
```

Run the tests: `pnpm test packages/openclaw-id-protocol`.

Check portable source types without Node ambient types or `DOM.Iterable`:
`node scripts/run-tsgo.mjs -p packages/openclaw-id-protocol/tsconfig.portable.json`.
The language library is ES2023 because canonicalization and snapshots use `Array.toSorted`.
Avoid DOM iterators even when the local compiler exposes them in `DOM`: vendored Discovery
and loader consumers may use DOM declarations that require a separate `DOM.Iterable` library.
Their vendor builds remain the final consumer compatibility check.
