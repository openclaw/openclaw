# Browser Spike Results (Week 1)

Last updated: 2026-03-19
Owner: consumer execution team
Status: In progress

## References

- `CONSUMER.md`
- `docs/consumer/openclaw-consumer-execution-spec.md`
- `docs/consumer/CODEX-PROMPT.md`
- `docs/consumer/consumer-execution-tracker.md`

## Baseline snapshot

- Runtime branch: `codex/consumer-openclaw-smoke`
- Synced base: `consumer` merged with `origin/main` on 2026-03-16
- Browser priority order:
  1. `user` (existing-session / Chrome MCP)
  2. `openclaw` (managed browser profile)
  3. Claude-in-Chrome investigation
  4. Browserbase (credential-blocked until keys are provided)

## Scoring rubric (fixed)

- Real logged-in session access: 40
- Reliability: 25
- Speed: 15
- Bot protection handling: 10
- Session persistence: 10

## Matrix (2 runs per approach x task, median time)

Legend:

- `PASS`, `FAIL`, `BLOCKED`, `PENDING`

| Approach                  | Task 1 Flight | Task 2 Form | Task 3 Web Summary | Task 4 X Summary | Task 5 Multi-step | Notes                                                                                                                                    |
| ------------------------- | ------------- | ----------- | ------------------ | ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `user` (existing-session) | BLOCKED       | BLOCKED     | BLOCKED            | BLOCKED          | BLOCKED           | Control lane passes on clean direct-built gateway (`status`, `tabs`, `open`); current blocker is local `openclaw-agent` timeout          |
| `openclaw` (managed)      | BLOCKED       | BLOCKED     | BLOCKED            | BLOCKED          | BLOCKED           | Control lane passes on clean direct-built gateway (`start`, `status`, `tabs`, `open`); current blocker is local `openclaw-agent` timeout |
| Claude-in-Chrome          | PENDING       | PENDING     | PENDING            | PENDING          | PENDING           | Investigation/adaptation track                                                                                                           |
| Browserbase               | BLOCKED       | BLOCKED     | BLOCKED            | BLOCKED          | BLOCKED           | Credential-blocked (no Browserbase key configured)                                                                                       |

## Current blocker summary

- Browser attach is no longer the primary blocker.
- Gateway/browser control is healthy on a clean direct-built runtime:
  - `user`: `status`, `tabs`, and `open https://example.com` succeed
  - `openclaw`: `start`, `status`, `tabs`, and `open https://example.com` succeed
- The benchmark-specific runtime now lives at `/tmp/openclaw-consumer-bench`:
  - copied from `/tmp/openclaw-consumer`
  - `channels.telegram.enabled=false`
  - stale `plugins.entries.openai` removed
- Gateway handshake tracing on the bench runtime is fast, around 23 ms from connect auth resolution to `hello_ok`, so the timeout budget is not being lost in gateway auth or browser attach.
- The current hard blocker is local `openclaw-agent` startup/bootstrap on trivial prompts:
  - `agent --local --message 'Reply with exactly OK and nothing else.' --timeout 120` still times out on `openai-codex/gpt-5.1-codex-mini`
  - logs show `candidate_failed ... reason=timeout`, not gateway failure
  - sampled `openclaw-agent` processes show heavy `fs.stat` callback churn during startup/bootstrap
- Codex OAuth is healthy enough again to rule out the old auth-window collision:
  - the previous `state mismatch` was caused by overlapping OAuth tabs / stale `127.0.0.1:1455` listener state
  - current failure mode is runtime timeout, not OAuth rejection

Interpretation:

- This is not currently a browser failure.
- This is no longer primarily a model-auth failure either.
- The next fix loop belongs in the local runner / `openclaw-agent` startup path.
- Once a trivial local `OK` run finishes reliably, both `user` and `openclaw` browser lanes can resume the real task matrix immediately.

## Command-level benchmark runbook (week 1)

This runbook is for current mainline browser architecture only:

- `profile=user` (Chrome existing-session via MCP)
- `profile=openclaw` (OpenClaw-managed isolated browser)

### 0) Preflight and artifact root

```bash
cd ~/Programming_Projects/openclaw
git checkout consumer
pnpm install && pnpm build

export OPENCLAW_HOME=/tmp/openclaw-consumer
export OPENCLAW_PROFILE=consumer-test
export OPENCLAW_GATEWAY_PORT=19001
export RUN_ROOT="$PWD/.artifacts/browser-spike/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_ROOT"/{logs,prompts,runs}

oc() {
  OPENCLAW_HOME="$OPENCLAW_HOME" \
  OPENCLAW_PROFILE="$OPENCLAW_PROFILE" \
  OPENCLAW_GATEWAY_PORT="$OPENCLAW_GATEWAY_PORT" \
  pnpm openclaw "$@"
}

now_ms() { node -e 'console.log(Date.now())'; }
```

### 1) Gateway startup and health

```bash
oc gateway run --port 19001 --bind loopback >"$RUN_ROOT/logs/gateway.log" 2>&1 &
export GATEWAY_PID=$!
echo "$GATEWAY_PID" >"$RUN_ROOT/logs/gateway.pid"
sleep 4

oc gateway status --deep --require-rpc --json >"$RUN_ROOT/logs/gateway-status.json"
oc channels status --probe --json >"$RUN_ROOT/logs/channels-probe.json"
```

If `19001` is already used by another active gateway, pick a different isolated port for the benchmark run instead of using `--force`.

### 2) Browserbase credential check and blocked-state mark

Do this before any signup flow.

```bash
grep -nEi "browserbase|connect\\.browserbase\\.com|BROWSERBASE_API_KEY|apiKey=" \
  ~/.openclaw/openclaw.json \
  ~/.openclaw-consumer-test/openclaw.json \
  "$OPENCLAW_HOME/openclaw.json" \
  2>/dev/null | tee "$RUN_ROOT/logs/browserbase-config-hits.txt"

if [ ! -s "$RUN_ROOT/logs/browserbase-config-hits.txt" ]; then
  echo "credential-blocked" > "$RUN_ROOT/logs/browserbase-status.txt"
  printf "Browserbase\tcredential-blocked\tno creds in config\n" >> "$RUN_ROOT/logs/benchmark-status.tsv"
fi
```

Keep Browserbase cells in the matrix as `BLOCKED` and notes as `credential-blocked` until credentials are provided.

### 3) Profile readiness

`profile=user` requires local Chrome running with remote debugging enabled at `chrome://inspect/#remote-debugging`.

```bash
open -a "Google Chrome" || true

oc browser --json --browser-profile user start >"$RUN_ROOT/logs/user-start.json" || true
oc browser --json --browser-profile user status >"$RUN_ROOT/logs/user-status.json" || true
oc browser --json --browser-profile user tabs >"$RUN_ROOT/logs/user-tabs.json" || true

oc browser --json --browser-profile openclaw start >"$RUN_ROOT/logs/openclaw-start.json"
oc browser --json --browser-profile openclaw status >"$RUN_ROOT/logs/openclaw-status.json"
oc browser --json --browser-profile openclaw tabs >"$RUN_ROOT/logs/openclaw-tabs.json"
```

### 4) Task prompt files

```bash
cat >"$RUN_ROOT/prompts/task1-flight.txt" <<'EOF'
Search flights NYC -> London in April and compare top 3 options by total price and duration.
EOF

cat >"$RUN_ROOT/prompts/task2-form.txt" <<'EOF'
Open a real signup or booking-style form and fill it with clearly fake test data without submitting payment.
EOF

cat >"$RUN_ROOT/prompts/task3-web-summary.txt" <<'EOF'
Open a public article URL and return a concise summary with 5 key points.
EOF

cat >"$RUN_ROOT/prompts/task4-x-summary.txt" <<'EOF'
Open an X/Twitter post and summarize the main point plus any linked context.
EOF

cat >"$RUN_ROOT/prompts/task5-multistep.txt" <<'EOF'
Run a multi-step flow: search, compare 3 results, then take one action (save, add to cart, or equivalent non-destructive action).
EOF
```

### 5) Timed run harness (per-task runs + evidence capture)

```bash
capture_failure() {
  local profile="$1"
  local run_dir="$2"
  oc browser --json --browser-profile "$profile" status >"$run_dir/fail.status.json" || true
  oc browser --json --browser-profile "$profile" tabs >"$run_dir/fail.tabs.json" || true
  oc browser --browser-profile "$profile" snapshot --format ai --limit 800 --out "$run_dir/fail.snapshot.ai.txt" || true
  oc browser --browser-profile "$profile" screenshot --full-page >"$run_dir/fail.screenshot.txt" 2>&1 || true
  oc browser --json --browser-profile "$profile" console --level error >"$run_dir/fail.console.json" || true
  oc browser --json --browser-profile "$profile" errors >"$run_dir/fail.errors.json" || true
  oc browser --json --browser-profile "$profile" requests >"$run_dir/fail.requests.json" || true
  oc logs --json --limit 400 >"$run_dir/fail.gateway-log-tail.json" || true
}

run_case() {
  local profile="$1"
  local task_id="$2"
  local run_no="$3"
  local task_file="$4"
  local run_id="${profile}_${task_id}_r${run_no}"
  local run_dir="$RUN_ROOT/runs/$run_id"
  mkdir -p "$run_dir"

  oc browser --browser-profile "$profile" trace start --sources >"$run_dir/trace-start.txt" 2>&1 || true

  local task_text
  task_text="$(cat "$task_file")"
  local prompt
  prompt=$'Week-1 browser benchmark run.\nUse browser tool only with profile="'"$profile"$'".\nDo not switch profiles.\nReturn exactly:\nRESULT: PASS or FAIL\nSUMMARY: one paragraph\n\nTask:\n'"$task_text"
  printf "%s\n" "$prompt" >"$run_dir/prompt.txt"

  local start_ms end_ms duration_ms exit_code
  start_ms="$(now_ms)"
  oc agent --local --agent main --json --message "$prompt" >"$run_dir/agent.json" 2>"$run_dir/agent.stderr.log"
  exit_code=$?
  end_ms="$(now_ms)"
  duration_ms=$((end_ms - start_ms))

  oc browser --browser-profile "$profile" trace stop --out "$run_dir/trace.zip" >"$run_dir/trace-stop.txt" 2>&1 || true
  oc browser --json --browser-profile "$profile" status >"$run_dir/post.status.json" || true
  oc browser --json --browser-profile "$profile" tabs >"$run_dir/post.tabs.json" || true
  oc browser --browser-profile "$profile" screenshot --full-page >"$run_dir/post.screenshot.txt" 2>&1 || true

  printf "%s\t%s\t%s\t%s\t%s\n" "$profile" "$task_id" "$run_no" "$duration_ms" "$exit_code" >> "$RUN_ROOT/timings.tsv"
  if [ "$exit_code" -ne 0 ]; then
    capture_failure "$profile" "$run_dir"
  fi
}
```

### 6) Execute full matrix (2 runs x 5 tasks x 2 profiles)

```bash
for profile in user openclaw; do
  run_case "$profile" task1 1 "$RUN_ROOT/prompts/task1-flight.txt"
  run_case "$profile" task1 2 "$RUN_ROOT/prompts/task1-flight.txt"
  run_case "$profile" task2 1 "$RUN_ROOT/prompts/task2-form.txt"
  run_case "$profile" task2 2 "$RUN_ROOT/prompts/task2-form.txt"
  run_case "$profile" task3 1 "$RUN_ROOT/prompts/task3-web-summary.txt"
  run_case "$profile" task3 2 "$RUN_ROOT/prompts/task3-web-summary.txt"
  run_case "$profile" task4 1 "$RUN_ROOT/prompts/task4-x-summary.txt"
  run_case "$profile" task4 2 "$RUN_ROOT/prompts/task4-x-summary.txt"
  run_case "$profile" task5 1 "$RUN_ROOT/prompts/task5-multistep.txt"
  run_case "$profile" task5 2 "$RUN_ROOT/prompts/task5-multistep.txt"
done
```

### 7) Median timing extract + teardown

```bash
node - "$RUN_ROOT/timings.tsv" <<'NODE' > "$RUN_ROOT/timings-median.tsv"
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n")
  .map((line) => line.split("\t"))
  .filter((cols) => cols.length === 5);
const byKey = new Map();
for (const [profile, task, runNo, durationMs, exitCode] of rows) {
  const key = `${profile}\t${task}`;
  const item = byKey.get(key) ?? [];
  item.push({ runNo: Number(runNo), durationMs: Number(durationMs), exitCode: Number(exitCode) });
  byKey.set(key, item);
}
for (const [key, vals] of [...byKey.entries()].sort()) {
  const d = vals.map((v) => v.durationMs).sort((a, b) => a - b);
  const median = d.length % 2 ? d[(d.length - 1) / 2] : Math.round((d[d.length / 2 - 1] + d[d.length / 2]) / 2);
  const exitSummary = vals.map((v) => v.exitCode).join(",");
  console.log(`${key}\t${median}\t${exitSummary}`);
}
NODE

kill "$GATEWAY_PID" 2>/dev/null || true
```

### OAuth callback recovery note

If `models auth login --provider openai-codex --method oauth` lands on a `State mismatch` page:

1. Close every existing OpenAI/Codex auth tab in the browser.
2. Check whether anything is still listening on `127.0.0.1:1455`.
3. Kill the stale `openclaw-models` / auth listener process if one is still bound there.
4. Rerun the login from a single fresh terminal session.

That sequence cleared the repeated mismatch for this worktree.

### 8) Failure evidence checklist (required when a run fails)

- `runs/<run_id>/prompt.txt`
- `runs/<run_id>/agent.json` and `agent.stderr.log`
- `runs/<run_id>/trace.zip`
- `runs/<run_id>/fail.snapshot.ai.txt`
- `runs/<run_id>/fail.screenshot.txt`
- `runs/<run_id>/fail.console.json`
- `runs/<run_id>/fail.errors.json`
- `runs/<run_id>/fail.requests.json`
- `runs/<run_id>/fail.gateway-log-tail.json`

## Run log

### 2026-03-16 - Phase A smoke evidence

Commands:

```bash
pnpm install
pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway --port 19001 --bind loopback --allow-unconfigured
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user tabs
```

Observed:

- `channels status --probe`: gateway reachable on `19001`
- `browser --browser-profile openclaw status`: PASS
- `browser --browser-profile user status|tabs`: FAIL
  - error: `Could not connect to Chrome. Could not find DevToolsActivePort ...`
  - implication: existing-session attach path is blocked on Chrome-side readiness/config

### 2026-03-16 - Existing-session readiness retest

Commands:

```bash
open -a "Google Chrome"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user tabs
```

Observed:

- `user start`: returned error path tied to missing `DevToolsActivePort`
- `user status|tabs`: still FAIL with same error
- conclusion: we need explicit Chrome MCP readiness setup (remote debugging/doctor migration), not just launching Chrome app

### 2026-03-16 - Existing-session root cause (confirmed)

Commands:

```bash
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
open -na "Google Chrome" --args --remote-debugging-port=9222
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile user status
```

Observed:

- `DevToolsActivePort` is missing before and after launching Chrome with `--remote-debugging-port`.
- `browser --browser-profile user status` fails with:
  - `Could not connect to Chrome. Check if Chrome is running.`
  - `Cause: Could not find DevToolsActivePort ...`
- This confirms the blocker is Chrome-side existing-session readiness, not OpenClaw browser profile mapping.

### 2026-03-16 - Managed profile gateway-stability blocker

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw start --json
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --browser-profile openclaw tabs --json
```

Observed:

- Probe shows `Gateway reachable`.
- `openclaw start` succeeds and reports `running=true`, `cdpReady=true`.
- Immediate follow-up `openclaw tabs` can fail with:
  - `gateway closed (1006 abnormal closure (no close frame))`
- Full matrix run stayed blocked because gateway process lifetime was unstable in this CLI automation environment.

### 2026-03-16 - LaunchAgent lane mismatch (not suitable for isolated runtime)

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway install --port 19001 --bind loopback
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway start
launchctl print gui/$UID/ai.openclaw.consumer-test
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
```

Observed:

- LaunchAgent starts and listens on `19001`.
- Runtime identity in logs is `stateDir=/Users/user/.openclaw` (not `/tmp/openclaw-consumer/.openclaw`).
- Probe from isolated runtime times out because auth/state do not match isolated config.
- Result: LaunchAgent flow is unsuitable for this benchmark's isolated state model; reverted with `gateway stop` + `gateway uninstall`.

### 2026-03-16 - Harness validation error (command shape)

Commands:

```bash
cat .artifacts/browser-spike/20260316-184600-openclaw-pass1/runs/openclaw_task1_r1/agent.stderr.log
pnpm openclaw agent --help
```

Observed:

- Harness used `oc agent --local --json --message ...` and failed with:
  - `Error: Pass --to <E.164>, --session-id, or --agent to choose a session`
- Benchmark harness must include explicit routing (`--agent`, `--session-id`, or `--to`) for each run.

### 2026-03-16 - Consumer profile bootstrap fix

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw doctor --non-interactive
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test pnpm openclaw config set gateway.mode local
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw gateway --port 19001 --bind loopback
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
```

Observed:

- `doctor` identified unset `gateway.mode` as startup blocker for non-allow-unconfigured runs.
- After setting `gateway.mode=local`, gateway starts cleanly on `19001` without `--allow-unconfigured`.
- Probe remains PASS (`Gateway reachable`).

### 2026-03-17 - Control-lane retest after Chrome remote debugging enablement

Commands:

```bash
ls -l "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw channels status --probe
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile user tabs
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw start
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw status
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw browser --json --browser-profile openclaw tabs
```

Observed:

- `DevToolsActivePort` exists and reports `9222`.
- All control-lane commands succeeded (`probe=0 user_start=0 user_status=0 user_tabs=0 open_start=0 open_status=0 open_tabs=0`).
- Evidence bundle: `.artifacts/browser-spike/20260317-140720-post-remote-debug/`.

### 2026-03-17 - Local agent-turn blocker after lane recovery

Commands:

```bash
OPENCLAW_HOME=/tmp/openclaw-consumer OPENCLAW_PROFILE=consumer-test OPENCLAW_GATEWAY_PORT=19001 pnpm openclaw agent --local --agent main --timeout 90 --json --message "Use browser with profile user. Open a snapshot and reply exactly: RESULT: PASS"
```

Observed:

- First failure was missing isolated auth profile (`No API key found for provider "anthropic"`).
- After copying `~/.openclaw/agents/main/agent/auth-profiles.json` into `/tmp/openclaw-consumer/.openclaw/agents/main/agent/auth-profiles.json`, immediate auth failure cleared.
- Local agent turn still did not complete reliably within expected timeout window in this harness run, so task-matrix execution remains blocked at agent-turn reliability (not browser attach).

## Next actions

1. Keep existing-session precondition on (`DevToolsActivePort` present, Chrome open).
2. Make local agent turns deterministic for isolated runtime (routing + timeout behavior), then execute the full 2x5 matrix.
3. Run Claude-in-Chrome investigation track.
4. Fill final weighted recommendation with task-level timings and reliability.
