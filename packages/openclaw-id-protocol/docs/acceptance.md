# Spec section 11 acceptance tests (v1-draft, OCF-274)

**Status: v1-draft.** The catalog is `SPEC_11_ACCEPTANCE` in `src/testing/acceptance.ts`
(exported from `@openclaw/openclaw-id-protocol/testing`). Protocol-level tests live in
`src/acceptance/` and use `acceptanceTitle(id)` as their describe title, so failures name the
spec test. Run: `pnpm test packages/openclaw-id-protocol`.

Integration tests are listed by exact name for the integration worker. They are not
written as skipped or todo tests (the repo lint forbids both); the catalog test checks that
every spec test has protocol coverage or a named integration test.

| #   | Spec test                                     | Protocol level (this package)                                                                                                                                                                                      | Needs the full system (name, owner)                                                                            |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | Descriptor substitution                       | `transport.test.ts`: re-signed binding -> `wrong_signer`; swapped root -> `root_mismatch`; other host -> `host_mismatch`; other claw -> `wrong_claw`; only verified K_srv is returned                              | `id-e2e: substituted descriptor opens no iroh connection and reads no stored token` (loader)                   |
| 2   | SAS relay in the middle                       | key substitution gives different codes and an unopenable handoff; a revealed key or start field that does not match the commitment is rejected                                                                     | `id-e2e: SAS mismatch through the Discovery mailbox aborts on both screens` (control-ui)                       |
| 3   | Discovery forges MembershipChange / InviteCap | unknown or removed signer -> `not_an_owner`; tampered body -> `bad_signature`; genuine change via mailbox -> `not_direct`; replay -> `seq_conflict`; forged cap -> `not_an_owner`; cap via mailbox -> `not_direct` | `id-e2e: forged statements injected into the real mailbox are refused and logged` (gateway)                    |
| 4   | Discovery withholds a revocation              | removal makes `isAdmitted` false while a stale snapshot still lists the member; owner-device revocation also drops devices it certified                                                                            | `id-e2e: removed member is refused by the tunnel child while Discovery serves a stale snapshot` (tunnel-child) |
| 5   | Token replayed from a different W             | - (token binding lives in the Gateway's auth)                                                                                                                                                                      | `id-e2e: device token presented with another W is refused and logged as a security event` (gateway)            |
| 6   | Binding rollback                              | lower binding_seq -> `rollback`; also the shared pin vectors                                                                                                                                                       | `id-e2e: loader refuses a rolled-back binding and keeps its stored pin` (loader)                               |
| 7   | Relayed root ceremony                         | `linkClaw` over `tunnel` or `mailbox` -> `not_local_operator`                                                                                                                                                      | `id-e2e: root ceremony through the tunnel child is refused; direct loopback succeeds` (gateway)                |
| 8   | Kit enrollment                                | kit decode -> R; new device recorded as approved by `root`; `kit_used` notice event; new device admitted                                                                                                           | `id-e2e: kit enrollment notifies every online owner device` (control-ui)                                       |
| 9   | Root changes only by owner reset              | another root's binding -> `root_mismatch`; `root_epoch` other than 1 or `RootRotation` -> `malformed`; another root's signature -> `not_an_owner`; K_gw-vouched reset -> `owner_reset` (`reset.test.ts`)           | `id-e2e: a descriptor naming a new root is refused by the loader` (loader)                                     |
| 10  | Invite link                                   | secret is only in the fragment (request target is `/join`); second redemption -> `invite_used`                                                                                                                     | `id-e2e: invite fragment never appears in Gateway, tunnel child, Discovery or relay logs` (discovery)          |
| 11  | Redemption without approval                   | pending admits nothing; approval via mailbox -> `not_direct`; mismatched approval -> `target_mismatch`; wrong audience -> `audience_mismatch`; deny consumes                                                       | `id-e2e: approval injected through the real mailbox is refused; pending expires after 7 days` (gateway)        |
| 12  | Removing a member mid-run                     | removal emits `cancel_runs` for the account                                                                                                                                                                        | `id-e2e: removing a member mid-run cancels the run and keeps the transcript` (gateway)                         |

The protocol tests prove the rules; they do not prove that the Gateway, tunnel child, loader
or Discovery apply them. Each integration test above is the end-to-end proof for its row.

## Node connectivity additions

`authority/nodes.test.ts` exercises the real reference-authority entry points: owner invite
registration, W proof -> pending -> owner approval -> node-only admission, denial, forged or
mailbox approval refusal, cross-class key separation, removal and pairing-cleanup events,
revocation replay after reapproval, invite retention/limits and inactivity. `node-invites.test.ts`
checks strict join-link decoding, domain-separated HMAC/code vectors and W-signed Discovery requests.
Authority tests cover the one-hour node invite ceiling, bounded signed descriptions, refusal
of tampering/replacement, and preserving the owner-reviewed description after admission.
The existing statement-vector suite validates every new signed schema and signature.

The Gateway consumer dispatches `node_redemption` to its node authority, which verifies the
redemption and persists pending enrollment without admitting the node. It settles that result
before acknowledging the mail or saving the cursor. Unhandled kinds still receive an explicit
`unsupported` refusal through the same settlement path; advertising a mailbox kind alone does
not enable a runtime handler.

These are protocol proofs, not claims of deployed transport integration. Required integration
proof belongs to the consuming stack:

- Discovery: node-auth route restrictions, source/W/claw rate limits, retry deduplication,
  current-binding snapshot checks, admitted descriptor/snapshot reads and relay admission.
- Gateway: node-only principals, one-time node pairing/capability approval, manual removal
  suppression and removal of pairings on node revocation/inactivity. Initial commands and caps
  must be subsets of the approved description; additions take normal capability approval.
- Control UI: display the same six-digit code as the node terminal, plus the declared name,
  platform, commands and caps. No approval until the owner compares and explicitly clicks;
  leaving the dialog open must never trigger approval.
- Node host: `openclaw node join` through the real mailbox and owner approval, pin/freshness
  verification before dialing, reconnect and WebSocket/HTTP worker traffic over the tunnel.
