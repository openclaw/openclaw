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
   an owner device, an invite, an approval or a binding, and a replayed revocation cannot
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

## What these guarantees assume

The invariants above hold against a hostile Discovery and a hostile relay. They assume that
the code a client runs is trustworthy: for browsers, the loader and Service Worker served at
the claw origin, and every update to them. Code delivery is trusted, like the Gateway host.
Whoever can replace that code can skip pin verification, read stored tokens and the
extractable peer key W, sign with the device key D (a non-extractable key cannot be exported,
but code running in its origin can still use it), and read a recovery kit typed into the page.
The protocol cannot detect this.

The loader integration must therefore document, before remote access is on by default, who
serves the initial loader and its updates, how that path is separated from Discovery's
deployment and credentials, and how claw origins are isolated from each other.

## Layout

```
src/            protocol code (statements/, tunnel/, discovery/, shared key, JCS and crypto helpers)
src/testing/    deterministic vector builder (exported as ./testing)
fixtures/v1-draft/  JSON test vectors for other languages and repositories
docs/           these documents
```

Run the tests: `pnpm test packages/openclaw-id-protocol`.
