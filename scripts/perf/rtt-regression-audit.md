# RTT regression audit checkpoint

Status: branch-local checkpoint, not release notes.

## Signals

- `openclaw-rtt` Discord main rows appeared to jump from about 5-7s p50 to about
  24-27s p50 after the 2026-05-16 main window.
- Downloaded fast/slow Discord artifacts showed the old "fast" run included
  observed message `triggerTimestamp` and `timestamp`, while newer redacted runs
  kept only scenario metadata.
- `openclaw-rtt` `scripts/import-discord-rtt.mjs` falls back to whole summary
  duration when observed-message timestamps are missing. That made a redaction
  shape change look like transport RTT regression.
- Slack and WhatsApp RSS rows showed recurring first-sample max RSS outliers
  around 6-9GB while later warm samples sat far lower. That points at
  command-level cold-start RSS measurement before retained gateway heap.

## Fixes in this branch

- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts`
  preserves safe timing fields through metadata redaction so importers can keep
  measuring reply RTT without exposing Discord IDs or content.
- Discord QA scenario summaries now include `rttMs` for direct importer use.
- `extensions/qa-lab/src/suite.ts` records gateway-process RSS start/end/peak
  and checkpoint samples in `qa-suite-summary.json`, giving RTT importers a
  gateway-level metric separate from `/usr/bin/time` command max RSS.

## Proof so far

- Focused local wrapper:
  `node scripts/run-vitest.mjs extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts`
  passed 30 tests.
- Focused local wrapper:
  `node scripts/run-vitest.mjs extensions/qa-lab/src/suite.test.ts extensions/qa-lab/src/suite.summary-json.test.ts extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts`
  passed 52 tests after the final rebase.
- Testbox `tbx_01krvces8y0c99nzra2a90jg13` ran
  `pnpm openclaw qa suite --scenario channel-chat-baseline` and emitted gateway
  RSS trace fields. Observed sample: wall `15784ms`, gateway RSS
  `664403968 -> 689852416`, peak `689852416`.
- Testbox `tbx_01krwb9k7cbktytpjprxcydfbk` ran `pnpm check:changed` and the
  command exited 0. The wrapper Actions run `26008757251` still reported
  `in_progress` after the box was stopped.
- Testbox `tbx_01krwbsg15xvjdgpcz8fxq1htz` ran
  `OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS=1 pnpm openclaw qa suite --scenario channel-chat-baseline`.
  The sample passed and recorded heap checkpoints plus RSS trace: wall
  `20112ms`, gateway RSS `655036416 -> 953790464`, peak `1051258880`, heap
  snapshots `154M` and `165M`.
- After rebasing onto `b5046968f61`, a fresh Testbox `pnpm check:changed`
  attempt on `tbx_01krwbsg15xvjdgpcz8fxq1htz` was blocked before reaching the
  changed gate: pnpm install rejected newly published
  `@earendil-works/pi-ai@0.74.1` under `minimumReleaseAge`.
- After rebasing again, Testbox-through-Crabbox
  `tbx_01krwcxpxx1n22t8jmvcj40228` ran
  `pnpm check:changed` with an explicit `origin/main` fetch to repair the
  delegated shallow checkout's merge base, and passed. The run escalated to all
  changed-gate lanes in the delegated checkout, so it covered typecheck, lint,
  and runtime import-cycle checks rather than only the narrow qa-lab diff.
- Follow-up branch `perf/discord-rtt-summary-import` in `openclaw-rtt` updates
  `scripts/import-discord-rtt.mjs` to prefer the new summary `rttMs` field
  before observed-message or summary-duration fallback, and teaches Discord and
  live-transport importers to ingest gateway RSS summary metrics. `npm test -- scripts/import-discord-rtt.test.mjs scripts/import-live-transport-rtt.test.mjs`
  passed 19 tests and `npm run check` passed.
- Branch commit `657538faff3` makes WhatsApp composing presence best-effort
  before outbound sends. Focused wrapper proof:
  `node scripts/run-vitest.mjs extensions/whatsapp/src/send.test.ts` passed 30
  tests, `git diff --check` passed, and
  `node scripts/run-oxlint.mjs -c .oxlintrc.json extensions/whatsapp/src/send.ts extensions/whatsapp/src/send.test.ts`
  passed.
- Testbox `tbx_01ksg810w0c20mpwd1ew3b991z` reran
  `CI=1 OPENCLAW_TESTBOX=1 corepack pnpm check:changed` after fetching
  `origin/main`; the command exited 0 after typecheck, lint, and runtime
  import-cycle checks.
- After rebasing on `origin/main`, Testbox
  `tbx_01ksgbx1x9pv8pxxzf8bg31k55` reran the same `check:changed` command
  against head `696dae73cdbe0b4630b8513c1b46e98686efe28c`; typecheck, lint,
  and runtime import-cycle checks passed.
- After rebasing onto `origin/main` `c51fa0d127c`, focused local wrapper proof
  against head `20cf1d093ad` passed:
  `node scripts/run-vitest.mjs extensions/whatsapp/src/send.test.ts extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.test.ts extensions/whatsapp/src/auto-reply/monitor/process-message.test.ts extensions/whatsapp/src/monitor-inbox.streams-inbound-messages.test-support.ts extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.test.ts src/plugins/manifest-contract-eligibility.test.ts src/plugins/provider-runtime.synthetic-auth-discovery.test.ts src/auto-reply/reply/get-reply-run.media-only.test.ts src/auto-reply/reply/get-reply.fast-path.test.ts src/auto-reply/reply/model-selection.test.ts`
  passed 277 tests.
- Direct AWS Crabbox `cbx_b9b51ba1de42` (`run_9f69ee5db7bb`, `c7a.8xlarge`)
  ran `pnpm check:changed` against `20cf1d093ad` over `origin/main`
  `c51fa0d127c`. The command exited 0 after changed-gate markers, attribution,
  guard checks, `tsgo`, oxlint, and runtime import-cycle checks. Remote timing:
  sync `42.195s`, command `3m37.34s`, total `5m42.476s`; the lease stopped
  cleanly.

## Still weak

- No retained-heap regression has been proven. The first heap-checkpoint sample
  grew by about 11M on disk across the scenario, which is worth comparing
  across repeated warm samples before calling it a leak.
- The branch fixes OpenClaw artifact quality. `openclaw-rtt` has a paired
  importer branch for summary `rttMs` and gateway RSS metric ingestion;
  dashboard presentation of gateway RSS remains a later reporting decision.
- Gitcrawl data was stale for the newest RTT window, so live `gh` history was
  the source of truth for 2026-05-16 and 2026-05-17 PR attribution.
- Live WhatsApp RTT proof is currently blocked by Convex credential state, not
  by the harness path. Run `26416240998` proved the branch workflow can request
  `whatsapp_credential_role=maintainer`, but Actions does not currently expose
  `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`. CI-role rerun `26416377533` still
  leased logged-out credential fingerprint `6b2d34243bac` with driver archive
  fingerprint `a8ebbdf4bbdd` and SUT archive fingerprint `c9a96833bbc0`, then
  failed before scenario completion after the harness rejected the repeated
  lease.
- A post-refresh CI-role retry on rebased head
  `696dae73cdbe0b4630b8513c1b46e98686efe28c` (`26417931799`) still returned
  the same logged-out credential `6b2d34243bac` with driver archive fingerprint
  `a8ebbdf4bbdd` and SUT archive fingerprint `c9a96833bbc0`; the
  `whatsapp-canary-rtt` scenario failed before startup because the Convex pool
  returned no usable WhatsApp lease after rejecting the repeated logged-out
  session.
- Current post-refresh live retries still cannot produce before/after WhatsApp
  RTT because the credential pool is not returning a usable logged-in session.
  Maintainer-role workflow attempts `26419407629` and `26419416564` failed
  before credential acquisition because `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
  is not exposed in the GitHub environment. CI-role branch run `26419662925`
  on `20cf1d093ad` failed `whatsapp-canary` after rejecting every returned
  WhatsApp lease as logged out. CI-role main baseline run `26419661390` on
  `f6a49a4e8a1` failed the same scenario with Baileys `401 Unauthorized /
  Connection Failure`. The only valid perf numbers from this checkpoint are
  harness/check timings, not WhatsApp message RTT: branch Crabbox changed gate
  sync `42.195s`, command `3m37.34s`, total `5m42.476s`; live WhatsApp before
  and after remain `blocked-before-scenario`.
- Latest QALab/CI repair on `5f851a52e8f` removes the WhatsApp
  maintainer-role workflow input/secret dependency, keeps GitHub live lanes on
  the CI Convex secret, quarantines logged-out WhatsApp leases until final
  cleanup, and forwards `excludeCredentialIds` on Convex acquire retries. The
  pre-push changed gate passed on AWS Crabbox `cbx_d98d892e0a6f`
  (`run_e9c89bbd79c4`): sync `43.234s`, command `3m39.296s`, total
  `5m44.301s`.
- Fresh live before/after still cannot report WhatsApp message RTT because the
  live Convex CI pool/broker returned the same logged-out credential after the
  branch explicitly excluded it. Current-main before run `26422757876`
  (`00f98095316a`) failed `whatsapp-canary` with Baileys `401 Unauthorized /
  Connection Failure` in `3.730s` of scenario runtime
  (`2026-05-25T22:49:58.141Z` -> `2026-05-25T22:50:01.871Z`). Branch after run
  `26422778357` (`5f851a52e8f`) failed `whatsapp-canary-rtt` after
  `302.862s` (`2026-05-25T22:52:54.940Z` -> `2026-05-25T22:57:57.802Z`):
  it rejected credential fingerprint `6b2d34243bac`, then the broker returned
  the same excluded credential again. Driver/SUT archive fingerprints stayed
  `a8ebbdf4bbdd` / `c9a96833bbc0`, so the remaining blocker is live credential
  pool or broker-side exclusion support, not the workflow secret shape.
