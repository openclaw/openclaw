# Signal reaction conversations

Signal-only replacement for [original PR #195021](https://github.com/openclaw/openclaw/pull/195021), reconciled through `b0fb2cabc282f21097d2456f9d925e60eae746bf`. Original source author: Bobby Bones. Original branch/proof remain preserved. The original ee89 comprehensive review is historical and does not clear this replacement.

Base: `9a5df3d60f12b6c303225c50abeaa4d17bd27108`. This sibling PR and the Discord replacement share prerequisite commit `e542f3b2390f672de93513bae7c12dc4b9233cdb` exactly. The common commit introduces only generic typed reaction context, durable receipt support and SDK documentation. This branch includes no Discord-specific source, tests, registration or documentation changes. After the first sibling lands, reconcile the shared commit's actual upstream ancestry and refresh the remaining PR; never assume a squash merge retains it.

## Contract and proof limits

Signal authorized add/remove, group routing, bounded original context, concurrent/restart replay and denied-group/self/sync controls are preserved. Keyed outgoing reactions retain confirmed/uncertain/claimed/not-sent semantics and the 5,000-row reject-new namespace. Reactions do not accept tasks or grant approval.

## Required structural repair

The original patch grew an already-over-cap Signal handler and inbound-context test. The split moves reaction context/admission/dispatch into `monitor/reaction-conversation.ts` and covers the top-level group envelope and malformed reaction cases in the existing durable-ingress test. Approval/access order, routing, target visibility, occurrence identity and settlement are preserved. The oversized-group fixture is explicitly admitted by its test allowlists so it reaches the length guard; each invalid case has a distinct occurrence timestamp. Line-cap validation passes without a limit/baseline exception. The recalculated dedicated test allocation is 334 lines; the shared scalar is unchanged. The passive notification assertion uses a spy that calls the real system-event function.

## Validation

Code snapshot: `d36f3b1aafa45da2df993b42f6a8b267cbfb9d94`. Node 24.22.1, repository-pinned pnpm 12.15.0, frozen lockfile. Later proof-only commits do not change tested behavior.

- `pnpm exec node scripts/test-projects.mts extensions/signal/src/signal-ingress.reaction-conversation.test.ts extensions/signal/src/monitor/event-handler.inbound-context.test.ts extensions/signal/src/monitor.tool-result.autostart.test.ts --maxWorkers=1`: 58 tests passed across two shards, 148.53 seconds wall. The final real-ingress test file was rerun after fixture, passive-notification, and explicit undefined-return lint corrections: 2 passed, 60.71 seconds wall (earlier final fixture pass: 73.33 seconds). Tests exercise real ingress/receipt state with fictional provider boundaries, not live phone delivery.
- `pnpm build`: exit 0; all 162 packaged SDK subpaths verified. The Control UI build reported size warnings, including document/CSS/boot-JS budgets, with no UI changes in this diff.
- `pnpm check:test-lines-ratchet --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108`: allocation check passes; scalar baseline unchanged.
- `pnpm check:changed --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108`: the broad check is still finishing its final guards. Core/extension/test type checks, core/tooling lint, dead-export scans and format/line-cap checks passed. Extension lint found three bare guard returns in the extracted helper; `return undefined` preserves their value and passes the targeted extension lint rerun. Focused ingress/receipt tests then passed again.
- `pnpm plugin-sdk:api:diff --base 9a5df3d60f12b6c303225c50abeaa4d17bd27108 --head d36f3b1aafa45da2df993b42f6a8b267cbfb9d94`: paired API render running on the unchanged shared SDK source at Discord snapshot `b5030a15416a9bda030add922fbc9ac9ad53221c`; final result pending. Both siblings have identical generic SDK source.

## Nonpassing guards and review gates

The broad check is not green. The unchanged changelog attribution checker fails on exact-base changelog inputs. The unchanged SDK surface checker also fails on the exact base: 3,876 public exports versus 3,865 allowed, 2,237 callable exports versus 2,235 allowed, and one wildcard versus zero allowed. This feature adds four named exports and one callable, so the candidate reports 3,880 / 2,238 / one wildcard. No shipped removals were reported. The wildcard is preexisting; no caps, baseline, or unrelated public APIs were changed. This remains a visible nonpassing guard requiring maintainer disposition.

Local read-only split review found no remaining required source fixes. It does not substitute for CI or the required exact-head comprehensive OpenClaw and native ClawSweeper reviews. Those remain pending; draft PRs are not review-ready. JevSweeper is ineligible until a native published verdict exists. No live channel/phone delivery, deployment, merge, original-PR close, or original-branch mutation occurred.

## Simplification and scope

Read-only `pr-simplify` and independent source review found no further required simplification. Production delta versus the base: +302/-60 (net +242); test delta: +368/-34 (net +334). The split extracts the oversized inline handler and consolidates overlapping reaction tests into the existing real-ingress suite. Tests retain add/remove routing, original context, unique invalid occurrences, denied group/self/sync and passive-notification controls, plus receipt replay/uncertainty/refusal. No new state owner is introduced. The last three explicit undefined returns are a behavior-preserving lint correction, independently reviewed and retested.
