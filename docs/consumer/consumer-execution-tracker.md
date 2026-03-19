# OpenClaw Consumer Execution Tracker

Last updated: 2026-03-19
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

## Locked decisions

- Week 1 scope follows `CONSUMER.md` + execution spec (power mode, no safety-profile build in week 1).
- Browser path priority is CDP first:
  1. `browser profile=user` (existing-session / Chrome MCP)
  2. `browser profile=openclaw` (managed isolated browser)
  3. Claude-in-Chrome investigation/adaptation
  4. Browserbase (currently credential-blocked; run when creds arrive)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
- Benchmark protocol is 2 runs per approach/task, using median time.

## Current baseline snapshot

- Branch: `codex/consumer-openclaw-project`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-openclaw-project...origin/main`: ahead 22, behind 5
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  - `profile=user` control lane passes (`start/status/tabs`) after remote debugging enablement.
  - `profile=openclaw` control lane passes (`start/status/tabs`) on isolated runtime.
  - Local `agent --local` prompt execution now exits cleanly in the isolated runtime after teardown fixes.
  - Remaining blocker is provider/auth health for full task-matrix execution:
    - `openai-codex:default` returns `API rate limit reached`.
    - `openai-codex:notblockedamazon` returns `API rate limit reached`.
    - lower-priority Codex OAuth profiles previously surfaced `refresh_token_reused`.
    - Anthropic fallback previously surfaced `overloaded`.
  - LaunchAgent route was tested and reverted: it binds `19001` but runs against `~/.openclaw` state instead of `/tmp/openclaw-consumer`, so isolated auth/state checks fail.

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
  - consumer runtime socket created at `~/.openclaw-consumer/exec-approvals.sock`
  - consumer app held no TCP listener and did not take over the founder gateway launch label
- Gateway auto-bootstrap on consumer port `19001` was not exercised in Worktree A; that remains Worktree B scope.

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

| Approach                | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status             | Notes                                                                                        |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| openclaw (managed)      | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes; local agent run works; current blocker is model rate limits/auth health |
| Claude-in-Chrome        | TODO          | TODO        | TODO               | TODO             | TODO              | pending            | feasibility + adaptation                                                                     |
| Browserbase             | blocked       | blocked     | blocked            | blocked          | blocked           | credential-blocked | run after creds                                                                              |

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
