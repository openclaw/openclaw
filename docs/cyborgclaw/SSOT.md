# CyborgClaW SSOT

## What this is

Single Source of Truth for CyborgClaW hardening work: scope, current state, evidence, rollback, and sprint log.

---

## Current Mission

Build a hardened, rate-limit-safe concurrent agent runtime on Voltaris that can support multiple “strike teams” without API storm cascades.

---

## Environment

- Host: Voltaris
- OpenClaw: 2026.2.23
- Gateway service: systemd user `openclaw-gateway.service`
- Runtime config: `/home/spryguy/.openclaw/openclaw.json`
- Runtime logs: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (journalctl may show none)

---

## Controls Implemented

### Provider lane cap (config-only)

- Config key: `gateway.providerConcurrency.<providerId> = <maxConcurrent>`
- Current setting: `gateway.providerConcurrency.openai-codex = 2`
- Lane nesting enforced: `session → provider → global`
- Proof log line on startup:
  - `[gateway/lanes] providerConcurrency overrides: openai-codex=2`

---

## Smoke Test Gate

### `scripts/strike_echo.sh`

Purpose: deterministically validate burst behavior and assert the run used Codex.

Assertions:

- Resets are isolated (`/reset` is its own message)
- 10 unique sessions per run; one request per session (no A/B cross-talk)
- Forced agent: `--agent main`
- JSON receipt pin:
  - provider = `openai-codex`
  - model = `gpt-5.3-codex`
- PASS requires 10/10 exact echoes + no error patterns

---

## Evidence (Feb 26, 2026)

### Runtime receipts

- Provider cap configured:
  - `jq '.gateway.providerConcurrency' /home/spryguy/.openclaw/openclaw.json` → `{ "openai-codex": 2 }`
- Smoke test (pinned) PASS:
  - `./scripts/strike_echo.sh` → `[PASS] 10/10 echoes returned; provider/model pinned to openai-codex/gpt-5.3-codex; no error patterns detected.`
- JSON receipt sample (single run):
  - `openclaw agent --agent main --session-id 9998 ... --json`
  - `.result.meta.agentMeta.provider = openai-codex`
  - `.result.meta.agentMeta.model = gpt-5.3-codex`

### Git commits

- `2c569fcbf` — provider lane concurrency override + schema support
- `a68a8ebb2` — initial strike echo smoke test
- `008a49e65` — make strike echo deterministic (reset phase + unique sessions)
- `d173bf1db` — pin strike echo to agent main + assert codex via JSON

---

## Rollback

### Roll back provider concurrency cap (runtime)

1. Edit `/home/spryguy/.openclaw/openclaw.json` and remove:
   - `gateway.providerConcurrency.openai-codex`
2. Restart gateway:
   - `systemctl --user restart openclaw-gateway.service`
3. Verify:
   - `rg -n "\[gateway/lanes\] providerConcurrency overrides" /tmp/openclaw/openclaw-*.log | tail -n 5` (should be absent or different)

### Roll back code changes (repo)

- `git revert d173bf1db 008a49e65 2c569fcbf a68a8ebb2` (choose as needed)
- `git push origin main`

---

## Sprint Log

### 2026-02-26

- Added `gateway.providerConcurrency` config knob and enforced provider lane nesting.
- Added proof log line for provider concurrency overrides.
- Rebuilt smoke test to be deterministic and then pinned to Codex using JSON receipts.

---

## Next Sprint: Telemetry MVP (planned)

### Goals

Add minimal observability so we can prove the governor behaves under strike-team load without guessing from logs.

### Core live signals (must-have)

- Active runs: global, provider-level (`openai-codex`), optionally per-agent
- Queue depth: global pending + provider pending (`openai-codex` lane)
- Outcome counters: success, error, timeout, cancel (rolling 1h + since-start)

### Operational guardrails (derived checks)

- Assert `openai-codex active <= 2` at all times
- Alert if provider queue depth stays >0 for sustained window (e.g., >60s)
- Alert on error-rate spike (e.g., >5% over last 50 runs)

### Minimal implementation shape

- Emit structured events at run lifecycle points:
  - `queued`, `started`, `completed`, `failed`, `timed_out`, `cancelled`
- Tags on each event: `provider`, `model`, `agentId`, `sessionKey`, `runId`, `durationMs`
- Maintain in-memory counters + rolling window aggregates
- Expose one JSON snapshot endpoint/view for dashboard + automation

### Dashboard MVP (single panel)

- Big numbers: `Codex Active`, `Codex Queue`, `Global Queue`, `Success% (1h)`, `Errors (1h)`
- Trend: queue depth + error count
- Last 20 failures: timestamp, agent, error class, duration

### First controlled strike-team run (go/no-go)

- Preflight: smoke test PASS + config invariants match SSOT
- During run: `Codex Active <= 2` always; queue drains predictably; no cascading retries
- Pass threshold:
  - ≥95% success
  - 0 uncaught systemic failure modes
  - queue returns to baseline within 2–5 min cool-down
  - no silent model/provider fallback
- Rollback trigger:
  - sustained provider queue growth + elevated error rate for >N minutes

### 2026-02-26 — Strike Team Alpha PASS (Codex-only)

- Execution path: `openclaw nodes invoke --command system.run` (allowlisted)
- Reason: `openclaw nodes run --raw` repeatedly failed with `approval expired`
- Output dir: `/tmp/cc-alpha-codex-010838-535892`
- Results:
  - 4/4 runs `ok`
  - Echoes: `ALPHA-010838-535892-{1..4}` verified
  - Provider/model: `openai-codex / gpt-5.3-codex` for all four
- Telemetry post: queues drained to baseline
  - `lanes.global.queueDepth = 0`
  - `lanes.provider_openai_codex.queueDepth = 0`
  - last Codex wait observed: `4 ms`
