# OpenClaw Consumer Execution Tracker

Last updated: 2026-03-21
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
- Browser strategy is split into core decision lanes and side experiments:
  1. Core lane: `browser profile=openclaw` (managed isolated browser, reliability baseline)
  2. Core lane: `browser profile=user` (existing-session / Chrome MCP, ideal signed-in browser path)
  3. Core lane: Browserbase (official remote CDP fallback; run when creds arrive)
  4. Side experiment: Browser Use (direct-CDP external comparison lane)
  5. Side experiment: Agent S3 (later computer-use comparison lane)
- Benchmark output path is `docs/consumer/browser-spike-results.md`.
- Benchmark protocol is 2 runs per approach/task, using median time.
- This tracker is the handoff doc for context compaction. Update it before ending a major debugging block.
- Use `openai-codex/gpt-5.4` for the next comparison wave so results stay comparable.

## Workstream registry (single source)

This file is the only master tracker. Do not create per-worktree tracker copies.

- All delegated branches should start from `origin/codex/consumer-openclaw-project`.
- Each delegated workstream owns one scoped branch and one PR.
- Workstreams should not edit files owned by another active workstream.
- Only merge-validated work should update this master tracker status.

### Active workstreams

| WS-ID                | Phase focus | Owner | Branch                               | Status      | No-touch files                                                                                                                                        | PR  |
| -------------------- | ----------- | ----- | ------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| WS-B-CORE            | Phase B     | codex | `codex/consumer-browser-improvement` | in-progress | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-C-PREP            | Phase C     | open  | `codex/consumer-phase-c-prep`        | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-D-PREP            | Phase D     | open  | `codex/consumer-phase-d-prep`        | unassigned  | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |
| WS-B-SIDE (optional) | Phase B     | open  | `codex/consumer-phase-b-side-lane`   | parked      | `src/agents/models-config.ts`, `src/agents/models-config.providers.ts`, `src/plugins/provider-discovery.ts`, `docs/consumer/browser-spike-results.md` | -   |

### Delegation protocol

1. Assign WS-ID -> owner -> branch before coding.
2. If a needed file appears in another WS `No-touch files`, pause and coordinate before editing.
3. Open a scoped PR into `origin/codex/consumer-openclaw-project`.
4. Update this table after PR merge (status, PR link, notes).

## Current baseline snapshot

- Branch: `codex/consumer-browser-improvement`
- `consumer...origin/main`: ahead 17, behind 27
- `codex/consumer-browser-improvement...origin/main`: ahead 46, behind 20
- `origin/main...upstream/main`: ahead 88, behind 220
- Phase A merge and runtime validation are complete.
- Phase B status now:
  - `profile=user` control lane passes when Chrome is launched with explicit CDP flags (`--remote-debugging-port`) and gateway uses that browser URL.
  - `profile=user` still fails against the current UI-enabled `chrome://inspect` session (`/json/version` 404 or `list_pages` timeout).
  - `profile=openclaw` control lane passes on a clean direct-built gateway (`start`, `status`, `tabs`, `open https://example.com`).
  - Gateway/browser control is healthy for both profiles under explicit CDP attach.
  - A benchmark-only runtime at `/tmp/openclaw-consumer-bench` disables Telegram and removes the stale `plugins.entries.openai` config noise so browser checks do not collide with shared bot traffic.
  - Local runner is partially restored on the benchmark runtime after copying `agents/main/agent/auth-profiles.json` and `auth.json`; real task runs now execute again.
  - External probe confirms the same failure outside OpenClaw (`chrome-devtools-mcp list_pages` times out on `--autoConnect` against current Chrome session).
  - `pnpm openclaw ...` runs from a dirty tree can trigger rebuild churn via `scripts/run-node.mjs`; use the already-built `node dist/entry.js ...` path for clean benchmark/debug runs to avoid false negatives.
  - New benchmark evidence:
    - Task 1 runs 1-2 passed on both profiles.
    - Task 1 medians now favor `profile=openclaw` (`69.9s`) over `profile=user` (`121.0s`).
    - Task 2 run 1 passed on both profiles (`user`: `63.1s`, `openclaw`: `78.8s`) when the task used a concrete public form target.
    - Task 3 runs 1-2 passed on `profile=user` with median `39.0s`.
    - Task 3 runs 1-2 passed on `profile=openclaw` with median `33.9s`.
  - Existing-session selector/frame snapshot requests now degrade to full-page snapshot with warning (compatibility patch landed on this branch), instead of failing the snapshot call.
  - The benchmark gateway must stay alive in a persistent terminal session; backgrounding it from a short-lived exec shell causes false "silent exit" failures.
  - Port `19001` is currently owned by the desktop Consumer app runtime, so the isolated benchmark lane is now on `19011` to avoid token mismatch noise.
  - Current hardening loop status:
    - Session-path rebasing fixes landed for isolated benchmark runs; stale absolute `sessionFile` paths no longer bleed bench transcripts into shared runtime state.
    - Browser availability/status timeouts were widened; both `profile=user` and `profile=openclaw` pass direct `status` checks on the isolated benchmark gateway.
    - `profile=user` `new_page` now honors a `45000ms` timeout budget and reaches Emirates reliably; this step previously failed at the old 10-20s window.
    - Existing-session interaction helpers now forward `timeoutMs` instead of dropping or rejecting it for `click`, `fill`, `fill_form`, `hover`, `drag`, and `press`.
    - Screenshots are confirmed in real runs (`[agents/tool-images] Image resized ...`), so screenshot-first prompts are actually taking effect.
    - Upstream evidence confirms the Chrome/user-lane timeout pattern is already known and not just local environment noise:
      - `openclaw/openclaw#48182`
      - `openclaw/openclaw#46495`
      - `openclaw/openclaw#49295`
      - `ChromeDevTools/chrome-devtools-mcp#116`
      - `ChromeDevTools/chrome-devtools-mcp#863`
  - External-lane research status:
    - Browserbase remains the official remote-CDP fallback for the week-1 decision once creds are available.
    - Browser Use is a real open-source direct-CDP competitor and should be benchmarked before Agent S3.
    - Agent S3 stays on the board, but later; it is a computer-use lane, not a clean browser-native replacement.
  - External-lane execution status (2026-03-21 update):
    - Browserbase credentials are now verified.
    - Browserbase transport is viable only when sessions are created with `keepAlive: true`; the provider default (`keepAlive: false`) is not compatible with OpenClaw's current probe/connect lifecycle.
    - Direct OpenClaw Browserbase CLI smoke now passes (`status`, `open`, `tabs`) with `keepAlive: true`.
    - A fresh-session minimal local-agent Browserbase run also passes, so the local-agent/browser-tool path is not universally broken.
    - Browserbase Task 3 rerun `r3` gets past attach/open and fails later on browser-tool timeout while inspecting article contents for summarization.
    - Browserbase Task 1 split rerun on this worktree is more precise: `r1` still fails early on Google Flights with `Remote CDP ... not reachable`, but a fresh-session warm-up run (`status` + `open https://www.google.com/travel/flights`) succeeds on the same lane and then moves the next concrete blocker downstream to a Google Flights `locator.fill` timeout.
    - Browserbase account concurrency is currently very tight (`3` concurrent sessions), so leaked probe sessions quickly trigger `429 Too Many Requests`.
    - Browser Use setup research is done, but execution is honestly blocked on missing model/API keys on this machine.

## Phase B hardening tracker

Current objective: convert the Chrome/user Emirates flow from "transport works but task flakes" into a clean benchmarkable run with trustworthy artifacts.

### Confirmed fixed

- [x] Existing-session attach path reaches explicit CDP Chrome via `OPENCLAW_CHROME_MCP_BROWSER_URL`
- [x] Existing-session `new_page` uses the widened timeout budget
- [x] Existing-session action helpers accept and forward `timeoutMs`
- [x] Screenshot-first prompts produce image artifacts during real runs
- [x] Isolated bench session state no longer leaks into shared runtime state

### Still open

- [ ] Capture one clean `profile=user` Emirates result artifact on the latest dist
- [ ] Capture one clean `profile=openclaw` Emirates result artifact on the latest dist
- [ ] Clean up benchmark artifact capture so JSON results are not polluted by service log lines
- [ ] Decide whether remaining failures are browser-lane bugs or benchmark-harness bugs
- [ ] Capture one clean Browserbase Task 1 artifact now that the split rerun has moved the blocker from attach to field interaction
- [ ] Re-run Browserbase benchmark tasks after clearing leaked provider sessions / avoiding 429 concurrency caps
- [ ] Run Browser Use as the first external comparison lane once a usable model/API key is available
- [ ] Keep Agent S3 documented as a later experiment, not a week-1 gate

### Immediate next 7 actions

1. Inspect `r6` and classify it as real browser failure, real success, or harness/artifact failure.
2. If `r6` lacks a deterministic terminal artifact, fix benchmark artifact writing before any more lane comparisons.
3. Keep benchmark lane on `/tmp/openclaw-consumer-bench` and port `19011`; do not reuse the desktop Consumer app runtime.
4. Re-run screenshots-first Emirates flow on `profile=openclaw` as the stability baseline once the harness is trustworthy.
5. Re-run screenshots-first Emirates flow on `profile=user` only after the harness is trustworthy and Chrome CDP is explicitly healthy.
6. Re-run Browserbase with fresh `keepAlive: true` sessions and isolate the remaining deeper browser-tool inspection timeout on real tasks.
7. Run Browser Use on the smallest 2-3 task smoke set once a usable model/API key is available, before Agent S3.

### Auth and rate-limit sanity checks

Before any long benchmark wave:

1. Verify the isolated bench runtime still points at `openai-codex/gpt-5.4`.
2. Verify the auth order is pinned to the intended `openai-codex` profile set; do not let the run silently rotate into known-bad tokens.
3. Run one tiny local sanity turn (`Reply exactly OK`) before starting expensive browser tasks.
4. If logs/status show `refresh_token_reused`, repeated `API rate limit reached`, or repeated `overloaded`, stop retrying and reauth or change the auth order before continuing.
5. Treat repeated auth/provider failures as a runtime-preflight failure, not as browser evidence.

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
- [ ] Run approach: `openclaw` managed profile path
  - Control lane verified on direct-built gateway; Tasks 1-3 now have passing evidence on the managed profile lane.
- [ ] Run approach: `user` existing-session path
  - Control lane verified on direct-built gateway; Tasks 1-3 now have passing evidence on the dedicated CDP Chrome lane.
- [ ] Replace old Browserbase `credential-blocked` notes with the new `keepAlive: true` compatibility rule
- [ ] Re-run Browserbase rows using the fresh-session pattern and concurrent-session cleanup discipline
- [ ] Run side experiment: Browser Use on 2-3 benchmark tasks once model/API key access exists
- [ ] Record side experiment: Agent S3 deferred until after Browser Use
- [ ] Run approach: Claude-in-Chrome investigation/adaptation only if it still looks useful after the direct-CDP comparisons
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

| Approach                | Task 1 Flight | Task 2 Form | Task 3 Web Summary    | Task 4 X Summary | Task 5 Multi-step | Status             | Notes                                                                                                                                                                                                              |
| ----------------------- | ------------- | ----------- | --------------------- | ---------------- | ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| user (existing-session) | pending       | pending     | pending               | pending          | pending           | ready-with-cdp-url | control lane passes when Chrome exposes standard CDP endpoint (for example `http://127.0.0.1:9333`)                                                                                                                |
| openclaw (managed)      | pending       | pending     | pending               | pending          | pending           | ready-for-runs     | control lane is healthy on clean gateway; benchmark task runs can proceed                                                                                                                                          |
| Browserbase             | fail (`r1`)   | pending     | fail (`r1`,`r2`,`r3`) | pending          | pending           | transport-proven   | creds verified; `keepAlive: true` required; direct CLI smoke passes and minimal local-agent smoke passes, but real benchmark tasks still fail on either early remote-CDP reachability or later inspection timeouts |
| Browser Use             | pending       | pending     | pending               | pending          | pending           | side-experiment    | direct-CDP external comparison; promote only if it materially beats current lanes                                                                                                                                  |
| Agent S3                | later         | later       | later                 | later            | later             | deferred           | computer-use comparison, not part of the default week-1 gate                                                                                                                                                       |
| Claude-in-Chrome        | TODO          | TODO        | TODO                  | TODO             | TODO              | pending            | revisit only if the direct-CDP paths still leave a clear gap                                                                                                                                                       |

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
  - Landed startup-path performance fixes so local runner no longer stalls on trivial prompts (`agent --local ... -> OK`).
  - Verified `profile=openclaw` passes `start`, `status`, `tabs`, and `open https://example.com` on the clean bench gateway.
  - Added Chrome MCP attach diagnostics/timeouts so failures are explicit (no blind 45s gateway timeout).
  - Reproduced `profile=user` failure outside OpenClaw with direct MCP probe (`list_pages` timeout using `chrome-devtools-mcp --autoConnect`).
  - Created `/tmp/openclaw-consumer-bench` as a benchmark-only copy with Telegram disabled and stale `plugins.entries.openai` removed.
- Blocked:
  - Existing desktop Chrome in `chrome://inspect` remote-debug mode still fails OpenClaw existing-session path (`/json/version` 404 on `127.0.0.1:9222`).
- Evidence links:
  - `/tmp/openclaw-consumer-bench/.openclaw/openclaw.json`
  - `/tmp/openclaw/openclaw-2026-03-19.log`
  - `/tmp/openclaw-stage.log`
  - `/tmp/chrome-mcp-probe.log`
  - `/tmp/chrome-mcp-probe-browserurl.log`
- Next 3 actions:
  - Capture and codify the exact existing-session prerequisite: launch Chrome with explicit CDP endpoint and point gateway Chrome MCP to it.

### 2026-03-20

- Done:
  - Rebuilt `/tmp/openclaw-consumer-bench` from local config, then trimmed it into a browser-only benchmark runtime (`bindings=[]`, Telegram disabled, WhatsApp disabled).
  - Restored isolated `main` agent auth by copying `agents/main/agent/auth-profiles.json` and `auth.json` into the benchmark runtime.
  - Proved the benchmark gateway has to stay alive in a persistent terminal session; short-lived exec shells were reaping the child gateway and creating fake silent-exit failures.
  - Validated control lanes again on the persistent session:
    - `profile=user status` PASS
    - `profile=openclaw start` PASS
    - `profile=openclaw status` PASS

### 2026-03-21

- Done:
  - Confirmed the existing tracker remains the single source of truth and upgraded it into the explicit compaction handoff doc.
  - Verified that screenshots are being taken during the Emirates runs.
  - Proved the first Chrome/user timeout fix is real: `new_page` now runs with `timeoutMs=45000` and completes on Emirates instead of dying at the old open-page timeout.
  - Found and fixed the next deeper timeout bug: existing-session interaction helpers were silently dropping `timeoutMs` for `click`, `fill`, `fill_form`, `hover`, `drag`, and `press`.
  - Fixed the current test drift in `src/browser/chrome-mcp.test.ts` so the timeout-plumbing patch is asserted against the real MCP call signature.
  - Cleared stale wrapper shells from this worktree that were polluting the benchmark lane and contributing to false startup/debug noise.
  - Re-established the isolated benchmark lane after cleanup:
    - dedicated CDP Chrome on `9333`
    - benchmark gateway on `19011`
    - browser control on `19013`
    - managed `openclaw` browser started and healthy
  - Re-ran screenshot-first Emirates flows on both lanes and pushed the failure boundary deeper than transport.
- Blocked:
  - Clean benchmark artifact capture is still messy; `stdout.log` can be polluted by service logs instead of a single JSON line or end on `toolUse` without a clean summary payload.
  - `profile=user` is still non-deterministic on the heavy Emirates prompt:
    - one rerun ended with `LLM request timed out`
    - a fresh spot check regressed to `Chrome MCP attach timed out for profile "user" after 15000ms`
  - `profile=openclaw` gets further into the booking flow, but still hits repeated-field ambiguity and short interaction timeouts on real Emirates form controls.
- Evidence links:
  - `/tmp/openclaw-bench-stage.log`
  - `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_final/`
  - `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_final_r2/`
  - `.artifacts/browser-spike-20260321-emirates-clean/runs/user_task6_final_r3/`
  - `.artifacts/browser-spike-20260321-emirates-clean/runs/openclaw_task6_final/`
  - `docs/consumer/browser-spike-results.md`
- Next 3 actions:
  - Finish validating the timeout/session hardening patch set with targeted tests plus `pnpm build`.
  - Commit the hardening code and latest docs once validation is green.
  - Decide whether the next engineering loop should target model/runtime timeout on the heavy `user` prompt or repeated-field disambiguation on real booking pages.
