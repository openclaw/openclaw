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

## Locked decisions

- Week 1 scope follows `CONSUMER.md` + execution spec (power mode, no safety-profile build in week 1).
- Browser path priority is CDP first:
  1. `browser profile=user` (existing-session / Chrome MCP)
  2. `browser profile=openclaw` (managed isolated browser)
  3. Claude-in-Chrome investigation/adaptation
  4. Browserbase (currently credential-blocked; run when creds arrive)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
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

- Branch: `codex/consumer-openclaw-smoke`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-openclaw-smoke...origin/main`: ahead 22, behind 5
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  - `profile=user` control lane passes on a clean direct-built gateway (`status`, `tabs`, `open https://example.com`).
  - `profile=openclaw` control lane passes on a clean direct-built gateway (`start`, `status`, `tabs`, `open https://example.com`).
  - Gateway/browser control is no longer the main blocker.
  - A benchmark-only runtime at `/tmp/openclaw-consumer-bench` disables Telegram and removes the stale `plugins.entries.openai` config noise so browser checks do not collide with shared bot traffic.
  - The current hard blocker is the local `openclaw-agent` / embedded runner path timing out on trivial prompts even after fresh Codex OAuth and a healthy gateway.
  - Handshake tracing on the clean bench gateway is fast (roughly 23 ms from connect auth resolution to `hello_ok`), so connect/auth is not where the timeout budget is disappearing.
  - `pnpm openclaw ...` runs from a dirty tree can trigger rebuild churn via `scripts/run-node.mjs`; use the already-built `node dist/entry.js ...` path for clean benchmark/debug runs to avoid false negatives.

## Execution phases and gates

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
  - Control lane verified on direct-built gateway; task execution now blocked by agent/model runtime timeout, not browser attach.
- [ ] Run approach: `openclaw` managed profile path
  - Control lane verified on direct-built gateway; task execution now blocked by agent/model runtime timeout, not browser attach.
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

| Approach                | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Status             | Notes                                                                                          |
| ----------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| user (existing-session) | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes on direct-built gateway; current blocker is local `openclaw-agent` timeout |
| openclaw (managed)      | blocked       | blocked     | blocked            | blocked          | blocked           | blocked            | control lane passes on direct-built gateway; current blocker is local `openclaw-agent` timeout |
| Claude-in-Chrome        | TODO          | TODO        | TODO               | TODO             | TODO              | pending            | feasibility + adaptation                                                                       |
| Browserbase             | blocked       | blocked     | blocked            | blocked          | blocked           | credential-blocked | run after creds                                                                                |

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
  - Cleared a stale OAuth callback listener on `127.0.0.1:1455`; Codex login now completes when only one auth window is active.
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

### 2026-03-19

- Done:
  - Proved gateway/browser control works on a clean direct-built runtime rather than the rebuild-prone `pnpm openclaw ...` path.
  - Verified `profile=user` and `profile=openclaw` both pass `status` checks and can open `https://example.com` on the clean gateway.
  - Created `/tmp/openclaw-consumer-bench` as a benchmark-only copy with Telegram disabled and stale `plugins.entries.openai` removed.
  - Added gateway handshake tracing and increased the handshake timeout so slow local connects can be measured instead of failing blind.
  - Measured the bench gateway handshake at roughly 23 ms end to end, which rules out gateway connect/auth as the current bottleneck.
- Blocked:
  - Trivial `agent --local` runs still time out on `openai-codex/gpt-5.1-codex-mini`, even with fresh OAuth and a healthy clean gateway.
  - `openclaw-agent` is the hot process; samples show heavy filesystem callback churn during startup/bootstrap rather than a gateway wait.
- Evidence links:
  - `/tmp/openclaw-consumer-bench/.openclaw/openclaw.json`
  - `/tmp/openclaw-bench-gateway.log`
  - `/tmp/openclaw-stage.log`
  - `/tmp/openclaw-agent-bench.err`
  - `/tmp/openclaw-agent-bench-minimal.err`
- Next 3 actions:
  - Trace the `openclaw-agent` startup path to isolate which bootstrap block is burning the timeout budget.
  - Keep benchmark/debug runs on `node dist/entry.js ...` until the rebuild-churn path is out of the picture.
  - Resume the browser matrix only after a trivial local `OK` run finishes reliably on the bench runtime.
