# OpenClaw Consumer Execution Tracker

Last updated: 2026-03-22
Owner: consumer execution team
Status: Active

## Source of truth

Use these documents in this order when there is any ambiguity:

1. `CONSUMER.md` (branch identity, north star, week-1 boundaries)
2. `docs/consumer/openclaw-consumer-execution-spec.md` (week-1 execution spec)
3. `docs/consumer/CODEX-PROMPT.md` (browser-spike task framing)
4. `docs/consumer/openclaw-consumer-brutal-execution-board.md` (30-day cadence)
5. `docs/consumer/openclaw-consumer-go-to-market-plan.md` (architecture and launch context)
6. `docs/consumer/macos-consumer-app.md` (consumer macOS app identity, UX, and distribution assumptions)
7. `docs/consumer/gui-control-mvp-decision.md` (why GUI control is deferred for MVP and what evidence would justify bringing it back)

## Locked decisions

- Week 1 scope follows `CONSUMER.md` + execution spec (power mode, no safety-profile build in week 1).
- Browser path priority is CDP first:
  1. `browser profile=user` (existing-session / Chrome MCP)
  2. `browser profile=openclaw` (managed isolated browser)
  3. Claude-in-Chrome investigation/adaptation
  4. Browserbase (currently credential-blocked; run when creds arrive)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
- Consumer GUI control is deferred for MVP by default; revisit only if the packaged consumer app plus the consumer Telegram bot can perform one safe GUI-control action reliably with low setup friction for non-technical users.
- Benchmark protocol is 2 runs per approach/task, using median time.

## Workstream registry (single source)

This file is the only master tracker. Do not create per-worktree tracker copies.

- All delegated branches should start from `origin/codex/consumer-openclaw-project`.
- Each delegated workstream owns one scoped branch and one PR.
- Workstreams should not edit files owned by another active workstream.
- Only merge-validated work should update this master tracker status.

### Active workstreams

| WS-ID                | Phase focus | Owner | Branch                             | Status      | No-touch files                                                                                                                                        | PR  |
| -------------------- | ----------- | ----- | ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| WS-B-CORE            | Phase B     | codex | `codex/consumer-openclaw-smoke`    | in-progress | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-C-PREP            | Phase C     | open  | `codex/consumer-phase-c-prep`      | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-D-PREP            | Phase D     | open  | `codex/consumer-phase-d-prep`      | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-B-SIDE (optional) | Phase B     | open  | `codex/consumer-phase-b-side-lane` | parked      | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |

### Delegation protocol

1. Assign WS-ID -> owner -> branch before coding.
2. If a needed file appears in another WS `No-touch files`, pause and coordinate before editing.
3. Open a scoped PR into `origin/codex/consumer-openclaw-project`.
4. Update this table after PR merge (status, PR link, notes).

## Current baseline snapshot

- Branch: `codex/consumer-openclaw-project`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-openclaw-project...origin/main`: ahead 22, behind 5
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  <<<<<<< HEAD
  - `profile=user` control lane passes (`start/status/tabs`) after remote debugging enablement.
  - `profile=openclaw` control lane passes (`start/status/tabs`) on isolated runtime.
  - Local `agent --local` prompt execution now exits cleanly in the isolated runtime after teardown fixes.
  - Remaining blocker is provider/auth health for full task-matrix execution:
    - `openai-codex:default` returns `API rate limit reached`.
    - `openai-codex:notblockedamazon` returns `API rate limit reached`.
    - lower-priority Codex OAuth profiles previously surfaced `refresh_token_reused`.
    - Anthropic fallback previously surfaced `overloaded`.
  - # LaunchAgent route was tested and reverted: it binds `19001` but runs against `~/.openclaw` state instead of `/tmp/openclaw-consumer`, so isolated auth/state checks fail.
  - `profile=user` is partially healthy on clean gateway (`status` passes), but `tabs`/`open` are blocked by Chrome MCP attach behavior in the current Chrome session.
  - `profile=openclaw` control lane passes on a clean direct-built gateway (`start`, `status`, `tabs`, `open https://example.com`).
  - Gateway/browser control is healthy for managed profile; existing-session remains the active blocker.
  - A benchmark-only runtime at `/tmp/openclaw-consumer-bench` disables Telegram and removes the stale `plugins.entries.openai` config noise so browser checks do not collide with shared bot traffic.
  - Local runner is no longer blocked: trivial `agent --local` prompt now returns `OK` reliably.
  - External probe confirms the same failure outside OpenClaw (`chrome-devtools-mcp list_pages` times out on `--autoConnect` against current Chrome session).
  - `pnpm openclaw ...` runs from a dirty tree can trigger rebuild churn via `scripts/run-node.mjs`; use the already-built `node dist/entry.js ...` path for clean benchmark/debug runs to avoid false negatives.
    > > > > > > > 7e0dacea11 (fix(browser): improve chrome-mcp attach reliability and diagnostics)

## Execution phases and gates

### Worktree A: Consumer macOS app simplification and isolation

- [x] Consumer app uses a separate app/runtime identity
  - [x] Separate bundle/app identity documented
  - [x] Separate state dir + port defaults implemented
  - [x] Separate launch labels/log roots implemented
- [x] Consumer onboarding is local-first
  - [x] Remote setup hidden behind Advanced
  - [x] Consumer-facing copy avoids gateway jargon in the main flow
- [x] Consumer default surface is simplified
  - [x] Menu bar trimmed to status/chat/settings/pause/quit
  - [x] Default settings tabs reduced to General/Permissions/About
  - [x] Advanced toggle reveals hidden power-user surfaces
- [x] Docs updated for the consumer app
  - [x] Tracker kept current
  - [x] Consumer app doc explains isolation and direct-download assumptions
  - [x] Safe local testing instructions included

Gate to exit Worktree A:

- [x] Consumer app can coexist with founder app on the same Mac without sharing runtime state unintentionally
- [x] Consumer default UX is materially simpler while advanced controls remain accessible
- [x] Docs match the implemented consumer behavior

Worktree A validation notes (2026-03-19):

- `swift build -c debug --product OpenClaw --build-path .build --arch arm64 -Xlinker -rpath -Xlinker @executable_path/../Frameworks` passed after fixing a missing `return` in `OnboardingView+Pages.swift`.
- `swift test --package-path apps/macos --filter GatewayEnvironmentTests` passed.
- `swift test --package-path apps/macos --filter SettingsViewSmokeTests` passed.
- A consumer bundle was packaged manually at `dist/OpenClaw Consumer.app` with:
  - bundle identifier `ai.openclaw.consumer.mac.debug`
  - URL scheme `openclaw-consumer`
  - app variant `consumer`
- Same-Mac isolation smoke passed with the founder gateway still active on `18789`:
  - consumer app process launched from `dist/OpenClaw Consumer.app`
  - consumer defaults plist written to `~/Library/Preferences/ai.openclaw.consumer.mac.debug.plist`
  - consumer runtime socket created at `~/Library/Application Support/OpenClaw Consumer/.openclaw/exec-approvals.sock`
  - consumer app held no TCP listener and did not take over the founder gateway launch label
- Gateway auto-bootstrap on consumer port `19001` was not exercised in Worktree A; that remains Worktree B scope.

Worktree A follow-up notes (2026-03-20):

- Consumer settings were reduced again after live review:
  - `General` now keeps only active, launch-at-login, dock icon, advanced toggle, and quit.
  - `Permissions` now defaults to a simple recommended checklist plus an optional disclosure for non-core permissions.
  - `About` now uses consumer branding/copy instead of the upstream project presentation.
- Consumer permission UX now reflects current macOS behavior more honestly:
  - recommended set includes `Screen Recording`, `Accessibility`, `Notifications`, `Automation`, `Microphone`, and `Location`
  - optional set currently includes `Camera` and `Speech Recognition`
  - Accessibility and Screen Recording may still require an app restart before status flips to granted
  - Screen Recording now opens the relevant System Settings pane directly because the native prompt is inconsistent on recent macOS releases
  - permission requests now fall back to the relevant System Settings panes when prompts do not appear
- Manual consumer-app check status:
  - Screen Recording flow now works and opens the expected System Settings path
  - Accessibility can be granted in System Settings, but the app still sometimes fails to reflect the granted state reliably even after refresh/restart guidance
- Remaining Worktree A cleanup before considering this surface final:
  - [ ] fix Accessibility granted-state detection / refresh behavior in the consumer app
  - [ ] verify the new `Grant recommended permissions` flow manually end to end on a clean machine/profile
  - [ ] verify Screen Recording fallback opens the correct System Settings pane on a fresh machine/profile
  - [ ] decide whether consumer onboarding needs an inline accessibility help link/video for MVP
  - [ ] decide whether `Show Dock icon` belongs in default General or should move behind Advanced

### Phase A: Branch convergence (blocking)

- [x] Merge `origin/main` into `consumer`
- [x] Resolve conflicts (runtime/browser behavior follows merged mainline)
- [x] Validate:
  - [x] `pnpm install`
  - [x] `pnpm build`
  - [x] `pnpm openclaw gateway --port 19001 --bind loopback` (after `gateway.mode=local` bootstrap)
- [x] Push updated `consumer`
- [x] Merge updated `origin/consumer` into this worktree branch

Gate to exit Phase A:

- [x] `consumer` no longer materially behind `origin/main` for runtime/browser work

Phase A validation notes (2026-03-16):

- Consumer profile configured: `gateway.mode=local`.
- Gateway probe on isolated runtime passed (`Gateway reachable`) on `19001`.
- `browser --browser-profile openclaw status` passed.
- `browser --browser-profile user status|tabs` failed with `Could not find DevToolsActivePort` (existing-session readiness not satisfied).

### Phase B: Browser spike (week 1, days 1-3)

- [ ] Finalize benchmark matrix in `docs/consumer/browser-spike-results.md`
- [ ] Run approach: `user` existing-session path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: `openclaw` managed profile path
  - Control lane verified; task execution now blocked by model auth health, not browser attach.
- [ ] Run approach: Claude-in-Chrome investigation/adaptation
- [ ] Mark Browserbase rows `credential-blocked` until credentials are available
- [ ] Re-run Browserbase rows once credentials are provided
- [ ] Select primary + fallback browser architecture

Gate to exit Phase B:

- [ ] Clear recommendation with evidence
- [ ] Reliability threshold met or explicit fix-loop declared

### Phase C: Consumer loop integration (week 1, days 4-5)

- [ ] Start isolated consumer runtime on port `19001`
- [ ] Confirm Telegram bot responds in isolated runtime
- [ ] Confirm Telegram -> agent -> browser -> Telegram roundtrip
- [ ] Confirm observability with `openclaw logs --follow`

Gate to exit Phase C:

- [ ] End-to-end loop works without manual intervention

### Phase D: Killer task hardening (week 1, days 6-7)

- [ ] Implement/test: "Find flights NYC to London in April"
- [ ] Run 3 consecutive attempts
- [ ] Ensure each run is < 3 minutes

Gate to exit Phase D:

- [ ] 3/3 consecutive successful autonomous runs

## Runbook commands

### Consumer runtime baseline

```bash
pnpm install && pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer \
OPENCLAW_PROFILE=consumer-test \
pnpm openclaw gateway run --port 19001 --bind loopback
```

### Health and probes

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw logs --follow
```

### Browser verification (post-merge)

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile user tabs
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw browser --browser-profile openclaw start
```

## Benchmark tracker template

<<<<<<< HEAD
| Approach | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status | Notes |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked | blocked | blocked | blocked | blocked | blocked | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| openclaw (managed) | blocked | blocked | blocked | blocked | blocked | blocked | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| Claude-in-Chrome | TODO | TODO | TODO | TODO | TODO | pending | feasibility + adaptation |
| Browserbase | blocked | blocked | blocked | blocked | blocked | credential-blocked | run after creds |
=======
| Approach | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status | Notes |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked | blocked | blocked | blocked | blocked | blocked | `status` passes, but Chrome MCP `list_pages` times out/attach fails with current Chrome session |
| openclaw (managed) | pending | pending | pending | pending | pending | ready-for-runs | control lane is healthy on clean gateway; benchmark task runs can proceed |
| Claude-in-Chrome | TODO | TODO | TODO | TODO | TODO | pending | feasibility + adaptation |
| Browserbase | blocked | blocked | blocked | blocked | blocked | credential-blocked | run after creds |

> > > > > > > 7e0dacea11 (fix(browser): improve chrome-mcp attach reliability and diagnostics)

## Scope guardrails (week 1)

In scope:

- Branch/runtime isolation
- Browser spike and recommendation
- Telegram end-to-end loop
- Flight killer task reliability

Out of scope:

- Safety profile implementation
- Irreversible confirmation gate implementation
- Billing/licensing
- Onboarding wizard polish
- WhatsApp and managed hosting expansion

## Daily log template

```md
### YYYY-MM-DD

- Done:
- Blocked:
- Evidence links:
- Next 3 actions:
```

## Daily log

### 2026-03-18

- Done:
  - Confirmed `profile=user` and `profile=openclaw` control lanes remain healthy.
  - Confirmed isolated `agent --local` turns now complete and exit cleanly after CLI teardown fixes.
  - Pinned `openai-codex` auth order per agent to test individual profiles directly.
- Blocked:
  - `openai-codex:default` returns `⚠️ API rate limit reached. Please try again later.`
  - `openai-codex:notblockedamazon` returns `⚠️ API rate limit reached. Please try again later.`
  - Historical isolated logs show lower-priority Codex profiles hitting `refresh_token_reused`.
  - Historical isolated logs show Anthropic fallback surfacing `overloaded`.
- Evidence links:
  - `/tmp/openclaw-profile-default.out`
  - `/tmp/openclaw-profile-default.err`
  - `/tmp/openclaw-profile-nba.out`
  - `/tmp/openclaw-profile-nba.err`
  - `/tmp/openclaw-codex.err`
  - `/tmp/openclaw-agent-local.err`
- Next 3 actions:
  - Keep only the least-bad Codex profiles in isolated auth order so future runs skip known-bad refresh tokens.
  - Update `docs/consumer/browser-spike-results.md` so benchmark state reflects provider-auth blockage rather than browser failure.
  - If credentials remain unhealthy, request reauth or a non-Codex API-key-backed model for isolated runtime smoke.
    <<<<<<< HEAD
    =======

### 2026-03-19

- Done:
  - Proved gateway/browser control works on a clean direct-built runtime rather than the rebuild-prone `pnpm openclaw ...` path.
  - Landed startup-path performance fixes so local runner no longer stalls on trivial prompts (`agent --local ... -> OK`).
  - Verified `profile=openclaw` passes `start`, `status`, `tabs`, and `open https://example.com` on the clean bench gateway.
  - Added Chrome MCP attach diagnostics/timeouts so failures are explicit (no blind 45s gateway timeout).
  - Reproduced `profile=user` failure outside OpenClaw with direct MCP probe (`list_pages` timeout using `chrome-devtools-mcp --autoConnect`).
  - Created `/tmp/openclaw-consumer-bench` as a benchmark-only copy with Telegram disabled and stale `plugins.entries.openai` removed.
- Blocked:
  - `profile=user` existing-session path is still blocked by current Chrome MCP handshake behavior (`autoConnect` call timeout; `--browserUrl http://127.0.0.1:9222` returns `/json/version` 404).
- Evidence links:
  - `/tmp/openclaw-consumer-bench/.openclaw/openclaw.json`
  - `/tmp/openclaw/openclaw-2026-03-19.log`
  - `/tmp/openclaw-stage.log`
  - `/tmp/chrome-mcp-probe.log`
  - `/tmp/chrome-mcp-probe-browserurl.log`
- Next 3 actions:
  - Validate existing-session against a Chrome instance started with explicit CDP flags (`--remote-debugging-port`) and re-run `user` lane control checks.
  - Run phase-B benchmark tasks on `profile=openclaw` immediately while existing-session is being stabilized.
  - Keep benchmark/debug runs on `node dist/entry.js ...` until the rebuild-churn path is out of the picture.
    > > > > > > > 7e0dacea11 (fix(browser): improve chrome-mcp attach reliability and diagnostics)
