# Discord reaction conversations

Discord-only replacement for [original PR #195021](https://github.com/openclaw/openclaw/pull/195021), reconciled through `b0fb2cabc282f21097d2456f9d925e60eae746bf`. Original source author: Bobby Bones. Original branch/proof remain preserved. The original ee89 comprehensive review is historical and does not clear this replacement.

Base: `9a5df3d60f12b6c303225c50abeaa4d17bd27108`. This sibling PR and the Signal replacement share prerequisite commit `e542f3b2390f672de93513bae7c12dc4b9233cdb` exactly. The common commit introduces only generic typed reaction context, durable receipt support and SDK documentation. This branch includes no Signal-specific source, tests, registration or documentation changes. After the first sibling lands, reconcile the shared commit's actual upstream ancestry and refresh the remaining PR; never assume a squash merge retains it.

## Contract and preserved controls

Authorized Discord reaction add/remove enters ordinary conversation dispatch with bounded original-target facts and gateway occurrence identity. Durable ingress suppresses retained duplicate/replayed events across monitor replacement. Keyed outgoing reactions retain confirmed/uncertain/claimed/not-sent semantics and the 5,000-row reject-new namespace. Reactions do not accept tasks or grant approval.

The original Discord production code is preserved, with a safety explanation added for validation's tentative payload type assertion. The b0fb registry-owned runtime initialization in the CLI message-authority fixture is retained. Receipt tests also cover pre-transport refusal/retry and interrupted claims so the shared primitive is independently covered in this sibling.

## Validation

Code snapshot: `b5030a15416a9bda030add922fbc9ac9ad53221c`. Node 24.22.1, repository-pinned pnpm 12.15.0, frozen lockfile. Later proof-only commits do not change tested behavior.

- `pnpm exec node scripts/test-projects.mts extensions/discord/src/monitor/reaction-conversation.test.ts extensions/discord/src/internal/gateway.test.ts extensions/discord/src/monitor/ingress.test.ts extensions/discord/src/monitor/message-handler.ingress-recovery.test.ts test/cli-message-authority.integration.test.ts --maxWorkers=1`: 94 tests passed across three shards, 150.60 seconds wall.
- `pnpm build`: exit 0; all 162 packaged SDK subpaths verified. The Control UI build reported size warnings, including document/CSS/boot-JS budgets, with no UI changes in this diff.
- `pnpm check:test-lines-ratchet --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108`: allocation check passes; scalar baseline unchanged.
- `pnpm check:changed --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108`: completed with exit 1. Core/extension/root-test type checks, all lint lanes, dead-export scans, format/line-cap checks and later runtime/security guards passed. The only failing steps were the old SAFETY marker (corrected with a passing targeted rerun), changelog attribution and SDK surface budget. Discord's initially misplaced SAFETY explanation was corrected and its targeted assertion check passes.
- `pnpm plugin-sdk:api:diff --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108 --head b5030a15416a9bda030add922fbc9ac9ad53221c`: paired API render running on the unchanged shared SDK source at Discord snapshot `b5030a15416a9bda030add922fbc9ac9ad53221c`; final result pending. Both siblings have identical generic SDK source.

## Nonpassing guards and review gates

The broad check is not green. The unchanged changelog attribution checker fails on exact-base changelog inputs. The unchanged SDK surface checker also fails on the exact base: 3,876 public exports versus 3,865 allowed, 2,237 callable exports versus 2,235 allowed, and one wildcard versus zero allowed. This feature adds four named exports and one callable, so the candidate reports 3,880 / 2,238 / one wildcard. No shipped removals were reported. The wildcard is preexisting; no caps, baseline, or unrelated public APIs were changed. This remains a visible nonpassing guard requiring maintainer disposition.

Local read-only split review found no remaining required source fixes. It does not substitute for CI or the required exact-head comprehensive OpenClaw and native ClawSweeper reviews. Those remain pending; draft PRs are not review-ready. JevSweeper is ineligible until a native published verdict exists. No live channel/phone delivery, deployment, merge, original-PR close, or original-branch mutation occurred.

## Simplification and scope

Read-only `pr-simplify` and independent source review found no further required simplification. Production delta versus the base: +477/-46 (net +431); test delta: +382/-7 (net +375). The smallest complete stage is one Discord channel: gateway occurrence identity, existing durable ingress, binding-aware conversation dispatch and receipts using the existing SQLite owner. No new schema, manager or daemon is introduced. Independent tests cover ingress replay/restart, denied actors, explicit/no-op dispatch and receipt settlement/refusal/interrupted claims.
