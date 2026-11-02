# OpenClaw ID remote access protocol (v1-draft)

**Status: v1-draft.** Nothing here is a stable or shipped contract. Field names, codes and
paths can still change; every change lands in this package first, with its tests.

This package is the shared contract for the OpenClaw ID remote access work (Linear
initiative I-8). Gateway core, the tunnel child, the Discovery Worker and the loader build
against it. It runs unchanged in Node (>= 24), browsers and Workers: WebCrypto only, no
`node:crypto`, no runtime dependencies.

| Document                       | Linear  | What it defines                                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| [statements.md](statements.md) | OCF-190 | Keys, signed statement envelope, chain and pin verification, rollback rules                         |
| [tunnel.md](tunnel.md)         | OCF-189 | `openclaw/tunnel/1` over iroh: framing, limits, close codes, headers                                |
| [discovery.md](discovery.md)   | OCF-191 | Discovery API v1: descriptor, devices, claws, snapshot mirror, mailbox, relay admission, enrollment |
| [enrollment.md](enrollment.md) | OCF-190 | Invites, SAS device approval, kit enrollment, reference membership authority rules                  |
| [acceptance.md](acceptance.md) | OCF-274 | Spec section 11 acceptance tests: which run here, which need the full system                        |

Source material: the owner-key spec v0.2 ("OpenClaw ID remote access: owner key and device
approval protocol", 2026-10-29) and the iroh spike (`tailcat-spike/docs/iroh/`). Spec
vocabulary maps to iroh as follows: W -> device iroh endpoint key, K_srv -> claw iroh
endpoint key held by the tunnel child, sidecar -> tunnel child process, DERP -> iroh-relay.

## Invariants every consumer relies on

1. **The Gateway is the membership authority. Discovery is a mirror and a mailbox.** Nothing
   Discovery stores or returns is trusted because Discovery returned it: every
   security-relevant fact is a signed statement that the consumer verifies against its own
   pin (fp(R), claw_id, binding_seq, root_epoch).
2. **Discovery cannot forge an accepted statement.** It holds no owner key, no Gateway key
   (K_gw) and no device key. It can withhold, delay, replay or reorder; it cannot add a member,
   an owner device, an invite, an approval, a binding or a rotation.
3. **No credential before verification.** A client opens a tunnel only to the K_srv of a
   ServerBinding it has verified against its pin, and releases stored tokens only after that.
4. **Approvals travel directly.** Membership changes and invite approvals reach the Gateway
   over the tunnel or direct loopback, never through the mailbox. The mailbox carries only
   requests and root-signed statements (kit enrollment, revocation).
5. **Only the running Gateway changes the root.** Owner-key regeneration (a new root and
   epoch, which ends every owner certificate) needs the local operator on direct loopback.
   Certificates have no expiry unless one is entered explicitly (enrollment.md).

## Layout

```
src/            protocol code (statements/, tunnel/, discovery/, shared key, JCS and crypto helpers)
src/testing/    deterministic vector builder (exported as ./testing)
fixtures/v1-draft/  JSON test vectors for other languages and repositories
docs/           these documents
```

Run the tests: `pnpm test packages/openclaw-id-protocol`.
