---
title: "refactor: Cron pipeline — collector-agent decomposition"
type: refactor
status: deepened
created: 2026-04-10
origin: docs/brainstorms/2026-04-10-cron-pipeline-refactor-brainstorm.md
detail_level: comprehensive
deepened: 2026-04-10
---

# Cron Pipeline: Collector-Agent Decomposition

Replace 11 monolithic cron agent sessions with a **pipeline architecture** of lightweight data collectors feeding specialized, right-sized agents. Three objectives:

1. **Morning Planning Session** — context-aware daily planner that connects dots (Readwise → projects, email → meetings), surfaces priorities, tells you what to do first
2. **Knowledge Triage Engine** — consolidates inbox processing, Readwise→project linking, CONTEXT.md refresh, and knowledge compilation into a single coherent pipeline
3. **Evening Compounding Recap** — captures decisions + outcomes, progress deltas, learning extraction, and primes tomorrow's morning agent with carry-forward threads

**Cost impact:** OpenRouter costs drop to near-zero. All daily jobs switch from `openrouter/minimax/minimax-m2.7` (pay-per-token) to `openai-codex/gpt-5.4-mini` (zero marginal cost via ChatGPT Pro OAuth). Better model quality at zero marginal cost.

**Token impact:** ~5000 tokens/day of inline shell prompts → ~2400 tokens/day of focused reasoning prompts + ~600 tokens of collector overhead. 40% total token reduction, with remaining tokens spent on reasoning instead of shell execution.

## Architecture

### Collect → Process → Compose → Deliver

The key insight: **separate data gathering (minimal LLM) from reasoning (right-sized LLM)**. Collectors run as `agentTurn` with a trivial one-line prompt (~200 tokens overhead — OpenClaw has no `script` payload kind). Agents receive pre-structured JSON and spend tokens on reasoning and connecting, not running shell commands. (see brainstorm: Architecture section)

### Pipeline Constraint: Sequential Execution

**`maxConcurrentRuns` defaults to 1** (`src/gateway/server-lanes.ts:7`). All cron jobs execute sequentially in the Cron command lane. This means:

- If a collector overruns its time slot, the downstream agent **queues behind it** rather than running on missing data
- No race conditions between Knowledge Processor writing `triage.json` and Evening Analyst reading it
- The 10-minute and 45-minute gaps between pipeline stages are **safety margins**, not hard timing constraints
- Pipeline correctness relies on this sequential execution — **do not increase `maxConcurrentRuns` without adding inter-job dependency checks**

### Pipeline Data Exchange

```
/tmp/openclaw-pipeline/
├── am/                    # Morning collection (wiped+recreated by morning_collect.py)
│   ├── calendar.json
│   ├── email.json
│   ├── readwise.json
│   ├── vault-health.json
│   └── projects.json
├── pm/                    # Evening collection (wiped+recreated by evening_collect.py)
│   ├── git-activity.json
│   ├── session-notes.json
│   ├── meetings.json
│   ├── inbox-state.json
│   ├── readwise-new.json
│   ├── context-diffs.json
│   └── triage.json        # Written by Knowledge Processor (atomic: write .tmp, then mv)
└── tomorrow.json          # Written by Evening Analyst, read by Morning Planner
```

**JSON schema for all collector output files:**

```json
{
  "collected_at": "2026-04-10T05:00:12+02:00",
  "status": "ok",
  "error": null,
  "items_count": 7,
  "duration_ms": 1230,
  "data": { ... }
}
```

- `items_count`: number of data items collected (e.g., calendar events, emails). Zero on a workday is a quality signal worth flagging; zero on a weekend is normal.
- `duration_ms`: how long this source took to collect. Enables duration trend tracking.

**`tomorrow.json` additionally includes:**

```json
{
  "written_at": "2026-04-10T21:45:00+02:00",
  "carry_forward": { ... }
}
```

**Stale data rules:**

- Collector scripts wipe and recreate target directory (`am/` or `pm/`) at start of each run
- Agent prompts include: "If any file has `collected_at` older than 2 hours, flag it as stale"
- `tomorrow.json` expires after 36 hours (Morning Planner ignores if `written_at` > 36h old)
- `/tmp` on this system is ext4 (not tmpfs) — files survive reboots; wipe-before-write handles cleanup

**Collector failure behavior:**

- If `/tmp/openclaw-pipeline/am/` (or `pm/`) does not exist or contains 0 JSON files after a collector run, the downstream agent must: (1) send a Telegram alert "Morning/Evening collection failed — no data available", (2) skip daily note write, (3) exit without producing a degraded briefing
- Individual data source failures within a working collector produce `{"status": "error", "error": "..."}` per file — the agent runs with available data and notes which sources were unavailable

### Job Inventory: 11 → 9 (3 collectors + 6 agents)

| #   | Time         | Name                 | Role      | Model                     | Timeout | Prompt   |
| --- | ------------ | -------------------- | --------- | ------------------------- | ------- | -------- |
| 1   | 05:00        | Morning Data Collect | Collector | openai-codex/gpt-5.4-mini | 300s    | ~200 tok |
| 2   | 05:10        | Morning Planner      | Agent     | openai-codex/gpt-5.4-mini | 1800s   | ~400 tok |
| 3   | 06:00        | Readwise Auto-Ingest | Collector | openai-codex/gpt-5.4-mini | 300s    | ~200 tok |
| 4   | 09:00        | ByteRover Miner      | Agent     | openai-codex/gpt-5.4-mini | 1800s   | ~300 tok |
| 5   | 20:00        | Evening Data Collect | Collector | openai-codex/gpt-5.4-mini | 300s    | ~200 tok |
| 6   | 20:30        | Knowledge Processor  | Agent     | openai-codex/gpt-5.4-mini | 1800s   | ~500 tok |
| 7   | 21:15        | Evening Analyst      | Agent     | openai-codex/gpt-5.4-mini | 1800s   | ~400 tok |
| 8   | Sat 23:00    | Weekly Review        | Agent     | openai-codex/gpt-5.4-mini | 1800s   | ~500 tok |
| 9   | 1st/mo 09:15 | Monthly Kaizen       | Agent     | openai-codex/gpt-5.4      | 1800s   | ~500 tok |

All schedules use `tz: "Europe/Paris"`. All daily jobs deliver via `--channel telegram --to 183115134`. Fallbacks for all jobs: `openrouter/minimax/minimax-m2.7` → `openrouter/qwen/qwen3.6-plus` (OpenRouter prefix mandatory — bare IDs cause `model_not_found`).

**Collector timeout: 300s (5 minutes)** — not the default 60-minute `agentTurn` timeout. If a collector hasn't finished in 5 minutes, something is wrong.

### Daily Note Section Headings

| Agent               | Section                                               | File                                              |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Morning Planner     | `## Plan`                                             | `second-brain/logs/daily-summaries/YYYY-MM-DD.md` |
| Evening Analyst     | `## Evening Recap`                                    | `second-brain/logs/daily-summaries/YYYY-MM-DD.md` |
| Knowledge Processor | (does not write daily note — writes CONTEXT.md files) | `second-brain/projects/*/CONTEXT.md`              |

Both use `cron_upsert_section.py` (`second-brain/scripts/cron_upsert_section.py`). The daily log template (`cron_ensure_daily_log.py`) should be updated to include `## Evening Recap` as a standard section.

### Morning↔Evening Feedback Loop

```
Evening Analyst (21:15) → writes tomorrow.json
                              ↓
Morning Planner (05:10) → reads tomorrow.json (hot handoff, not via collector)
                              ↓
                          Incorporates: unfinished threads, blockers,
                          key context, Readwise→project mappings
```

`tomorrow.json` is read **directly** by the Morning Planner, not by `morning_collect.py`. It's an agent-to-agent handoff.

**First day:** No `tomorrow.json` exists. Morning Planner proceeds without carry-forward context and notes "first run" in output.

**Weekend/holiday:** After 36 hours, `tomorrow.json` expires. Monday morning runs without stale Friday context.

### Git Push Policy (Knowledge Processor)

The Knowledge Processor commits + pushes `second-brain` after CONTEXT.md rewrites. Policy for dirty working tree:

1. `evening_collect.py` checks `git status --porcelain` for `second-brain/` and includes dirty-state in `pm/git-activity.json`
2. Knowledge Processor checks this flag before attempting git operations
3. If dirty: commit only its own CONTEXT.md changes (scoped `git add`), do NOT touch other files, log the dirty state in output
4. If push fails (rebase conflict): log the failure, continue with Telegram delivery, do not retry

### Model Routing Note

The built-in `gpt-mini` alias in `src/config/defaults.ts:21` resolves to `openai/gpt-5.4-mini` (direct API provider), **not** `openai-codex/gpt-5.4-mini` (OAuth provider). All cron jobs must use the explicit full model ID `openai-codex/gpt-5.4-mini` in their `payload.model` field — do not rely on the alias. Phase 0 can optionally override the alias in `openclaw.json` to route through `openai-codex`, but explicit IDs are safer.

---

## Migration Phases

### Phase 0: Model Routing & Cleanup

**Goal:** Confirm `openai-codex/gpt-5.4-mini` works for isolated cron `agentTurn` sessions. Clean up security issues.

**Tasks:**

Progress note (2026-04-10): completed 0.2-0.5. The optional alias override in 0.1 was attempted and rejected by OpenClaw config validation, so explicit `openai-codex/gpt-5.4-mini` job model IDs remain the safe path.

- [ ] **0.1** Add `gpt-5.4-mini` model override in `~/.openclaw/openclaw.json` to route `gpt-mini` alias through `openai-codex` provider (optional — explicit model IDs are primary)
  - File: `~/.openclaw/openclaw.json` (runtime config, not repo)
  - Add to `agents.defaults.model.aliases`: `"gpt-mini": "openai-codex/gpt-5.4-mini"`
- [x] **0.2** Configure heartbeat model to `openai-codex/gpt-5.4-mini` in `openclaw.json`
- [x] **0.3** Smoke test: create a one-shot cron job that sends a simple prompt via `openai-codex/gpt-5.4-mini` and verifies response + Telegram delivery
  ```bash
  openclaw cron add \
    --name "Model Routing Smoke Test" \
    --model openai-codex/gpt-5.4-mini \
    --session isolated \
    --message "Reply with exactly: 'gpt-5.4-mini routing OK'" \
    --announce --channel telegram --to 183115134 \
    --at 5m --delete-after-run
  ```
  Verify: Telegram message received with correct content. Check `openclaw cron list` to confirm model stuck at `openai-codex/gpt-5.4-mini`.
- [x] **0.4** Clean up exposed `OPENROUTER_API_KEY` from `env` fields in `~/.openclaw/cron/jobs.json`
  ```bash
  grep -i "OPENROUTER" ~/.openclaw/cron/jobs.json
  ```
  Remove any inline API key values from job `env` fields. OpenRouter auth should come from the provider profile, not inline env.
- [x] **0.5** Verify: `openclaw cron list` shows all existing jobs still operational (no regression from config changes)

**Rollback:** Remove alias override from `openclaw.json`. Existing jobs on OpenRouter are unaffected.

**Gate:** Phase 1 cannot start until smoke test (0.3) passes.

---

### Phase 1: Collector Scripts + Early File Updates

**Goal:** Create the Python data collector scripts and update passive Clawd context files (files that don't reference specific job IDs or names).

**Tasks:**

#### 1A. Collector Scripts

Progress note (2026-04-10): completed 1.1-1.5 and 1.9 in the canonical `second-brain` repo. Re-verified in this execution: `python3 -m unittest tests/test_openclaw_pipeline_collect_utils.py tests/test_openclaw_pipeline_collectors.py tests/test_cron_ensure_daily_log.py` passes, both collectors still perform atomic wipe-before-write correctly, and live manual runs confirmed the intended partial-failure behavior when external CLIs are unavailable from the host exec environment. Clawd file updates 1.6-1.8 were still pending at the start of this pass.

- [x] **1.1** Create directory: `second-brain/scripts/openclaw-pipeline/`
- [x] **1.2** Create `second-brain/scripts/openclaw-pipeline/morning_collect.py`
  - Wipe and recreate `/tmp/openclaw-pipeline/am/` (atomic directory swap — see Implementation Patterns)
  - Collect: calendar (today) via `gws calendar`, email (urgent unread) via `gws gmail`, Readwise queue via `readwise reader-list-documents`, vault health via `python3 scripts/daily-routine.py --json`, project CONTEXT.md summaries (company-scoped by day-of-week)
  - Git repo sync (`git -C <repo> pull --rebase` for key repos)
  - Each source wrapped in try/except with per-source timeout (45-60s) — failure writes `{"status": "error", "error": "..."}` for that file
  - Every JSON file includes `collected_at`, `status`, `items_count`, `duration_ms` fields
  - Atomic file writes: `tempfile.NamedTemporaryFile` + `os.fsync` + `os.replace` (same filesystem)
  - Stdout: 1-3 line summary for LLM consumer ("Collected 5/6 sources. Errors: readwise")
  - Stderr: JSON-lines structured logging for diagnostics
  - Note: does NOT touch `tomorrow.json` (hot handoff between agents)
- [x] **1.3** Create `second-brain/scripts/openclaw-pipeline/evening_collect.py`
  - Wipe and recreate `/tmp/openclaw-pipeline/pm/` (atomic directory swap)
  - Collect: git activity since morning (`git log --since`), session notes from daily log, meeting notes added today, inbox state (`find inbox/ -name "*.md"`), new Readwise highlights since morning, CONTEXT.md diff (today vs. morning snapshot)
  - Check `git status --porcelain` for `second-brain/` — include dirty-state flag in `git-activity.json`
  - Same implementation patterns as morning collector (atomic writes, per-source timeouts, error aggregation)
- [x] **1.3b** Create `second-brain/scripts/openclaw-pipeline/collect_utils.py` — shared utilities
  - `atomic_write_json(filepath, data)` — tempfile + fsync + os.replace
  - `atomic_replace_dir(target, populate_fn)` — write to temp dir, rename swap
  - `run_cli(cmd, timeout)` — subprocess with timeout, never `shell=True`
  - `CollectionRun` / `SourceResult` dataclasses — error aggregation with three-valued status (`ok`/`error`/`partial`)
- [x] **1.4** Manual test both scripts:
  ```bash
  python3 second-brain/scripts/openclaw-pipeline/morning_collect.py
  ls -la /tmp/openclaw-pipeline/am/
  python3 -c "import json; [print(f, json.load(open(f'/tmp/openclaw-pipeline/am/{f}')).get('status')) for f in __import__('os').listdir('/tmp/openclaw-pipeline/am/')]"
  ```
  Same for evening collector with `pm/`.
- [x] **1.5** Unit tests for both scripts (test JSON schema, error handling, wipe-before-write)

#### 1B. Early Clawd File Updates (passive context — no job IDs)

Progress note (2026-04-10): completed 1.6-1.8 in `/home/codex/clawd/` during this execution. These were passive context updates only: no job IDs, no cron wiring, no runtime behavior changes.

- [x] **1.6** Update `clawd/USER.md` — add Work Preferences section (see brainstorm: Section 6, USER.md)
  - Morning = Planning Session, Evening = Compounding Machine, Right-Size Everything, Delivery: Telegram + Daily Note, CONTEXT.md Convention
- [x] **1.7** Update `clawd/TOOLS.md` — fix stale model routing references only
  - Remove Sonnet 4.6/Opus references
  - Add `gpt-5.4-mini` as cron default, `gpt-5.4` as interactive default
  - Do NOT add pipeline data exchange section yet (depends on validated pipeline — Phase 3.5)
- [x] **1.8** Update `clawd/PRINCIPLES.md` — add two new principles + one regression
  - New: "Pipeline-First Decomposition" (see brainstorm: Section 4, PRINCIPLES.md)
  - New: "CONTEXT.md Is Always-Current" (see brainstorm: Section 4, PRINCIPLES.md)
  - Regression: "2026-04-10: Monolithic Cron Waste" (see brainstorm: Section 4, PRINCIPLES.md)
- [x] **1.9** Update `second-brain/scripts/cron_ensure_daily_log.py` — add `## Evening Recap` to the daily note template between `## Daily Capture (auto)` and `## Related`

**Rollback:** Delete scripts directory. Revert file changes via git.

**Gate:** Scripts must pass manual tests (1.4) and unit tests (1.5) before Phase 2.

---

### Phase 2: Morning Pipeline

**Goal:** Deploy the morning pipeline (collector + planner) and run in parallel with old Daily Note Prep for 2-3 days.

**Tasks:**

Progress note (2026-04-10): Phase 2 execution started from the live scheduler state after re-reading the current OpenClaw cron CLI source. This build expects `--timeout-seconds` (not `--timeout`) and `--best-effort-deliver` (not a generic delivery mode flag), so the rollout commands below should use the actual CLI surface when executed.

Live rollout note (2026-04-10): the first force-run of `Morning Data Collect` succeeded functionally, but its initial `Run: ...` prompt was too permissive for an isolated cron agent. The session wandered into `git pull`, `brv query`, and `brv curate` before/after the collector script, pushing the run to ~170s and ~30.8k tokens. The stored cron job payload still shows `openai-codex/gpt-5.4-mini`, but the persisted cron run telemetry recorded `model: gpt-5.4`; subsequent hardened reruns reproduced the same telemetry drift, so treat the model-routing/cost assumption as unresolved until the backend behavior is explained or fixed.

Collector hardening note (2026-04-10): `Morning Data Collect` was then edited to use `lightContext: true` and `toolsAllow: ["exec"]` with a strict single-command prompt. The rerun stayed within the intended scope (single `exec`, one `process` poll, no `git`/`brv`) and dropped runtime from ~170s to ~38s, but cron telemetry still reported `provider=openai-codex model=gpt-5.4` instead of the requested `openai-codex/gpt-5.4-mini`. Treat the model-routing/cost assumption as unresolved until the backend behavior is explained or fixed.

Planner validation note (2026-04-10): `Morning Planner` was hardened before first execution with `lightContext: true` and `toolsAllow: ["exec","process"]`. The force-run finished `status=ok`, delivered the Telegram payload, and wrote `## Plan (pipeline)` into `/home/codex/second-brain/logs/daily-summaries/2026-04-10.md` in ~113s. The transcript stayed off `git`/`brv`, but it still started on `provider=openai-codex model=gpt-5.4` and even invoked `update_plan` despite the narrowed tool allowlist, so the functional path is validated while the isolated-agent runtime contract still needs follow-up.

Runtime defect tracking note (2026-04-10): Linear issue `LS-1409` tracks the isolated cron runtime drift (`openai-codex/gpt-5.4-mini` payloads executing as `gpt-5.4`, plus tool-allowlist leakage in the planner transcript). Phase 2 can continue functional monitoring under `2.5`, but `2.6` must stay open until that defect is explained or fixed.

- [x] **2.1** Create Morning Data Collect cron job
  ```bash
  openclaw cron add \
    --name "Morning Data Collect" \
    --cron "0 5 * * *" --tz "Europe/Paris" \
    --model openai-codex/gpt-5.4-mini \
    --fallback openrouter/minimax/minimax-m2.7 \
    --fallback openrouter/qwen/qwen3.6-plus \
    --session isolated \
    --timeout-seconds 300 \
    --message "Run: python3 /home/codex/second-brain/scripts/openclaw-pipeline/morning_collect.py" \
    --announce --channel telegram --to 183115134 --best-effort-deliver
  ```
- [x] **2.2** Create Morning Planner cron job

  ```bash
  openclaw cron add \
    --name "Morning Planner" \
    --cron "10 5 * * *" --tz "Europe/Paris" \
    --model openai-codex/gpt-5.4-mini \
    --fallback openrouter/minimax/minimax-m2.7 \
    --fallback openrouter/qwen/qwen3.6-plus \
    --session isolated \
    --timeout-seconds 1800 \
    --message "<morning_planner_prompt>" \
    --announce --channel telegram --to 183115134
  ```

  **Morning Planner prompt** (~400 tokens, using pre-flight + steps + error table pattern):

  ```
  You are Leonard's morning planning agent. Connect dots, prioritize, plan.

  PRE-FLIGHT (Step 0):
  Run this bash block and read the output before proceeding:
    ls /tmp/openclaw-pipeline/am/*.json 2>/dev/null | wc -l > /tmp/am_count.txt
    python3 -c "
    import json, os, datetime as dt
    now = dt.datetime.now(dt.timezone.utc)
    status = {}
    for f in os.listdir('/tmp/openclaw-pipeline/am/'):
      if not f.endswith('.json'): continue
      d = json.load(open(f'/tmp/openclaw-pipeline/am/{f}'))
      age_h = (now - dt.datetime.fromisoformat(d['collected_at'])).total_seconds() / 3600
      status[f] = {'status': d['status'], 'stale': age_h > 2, 'items': d.get('items_count', '?')}
    # Check tomorrow.json
    tj = '/tmp/openclaw-pipeline/tomorrow.json'
    if os.path.exists(tj):
      d = json.load(open(tj))
      age_h = (now - dt.datetime.fromisoformat(d['written_at'])).total_seconds() / 3600
      status['tomorrow'] = {'expired': age_h > 36}
    else:
      status['tomorrow'] = {'missing': True}
    json.dump(status, open('/tmp/preflight.json','w'), indent=2)
    print(json.dumps(status, indent=2))
    "

  Step 1: Read /tmp/preflight.json. Note which sources are FRESH vs STALE vs ERROR.
  Step 2: Read FRESH data files from /tmp/openclaw-pipeline/am/.
  Step 3: If tomorrow.json is not expired, read carry-forward context.
  Step 4: Reason — connect dots: Readwise→projects, email→meetings, surface blockers.
  Step 5: Write plan to /tmp/plan.txt. Prioritized actions, not a data dump.
  Step 6: Call: python3 /home/codex/second-brain/scripts/cron_upsert_section.py \
          --path <daily_note_path> --heading "Plan (pipeline)" --level 2 --in /tmp/plan.txt
  Step 7: Verify /tmp/plan.txt exists and is non-empty.

  ERROR TABLE:
  | Condition              | Action                                              |
  |------------------------|-----------------------------------------------------|
  | 0 JSON files in am/    | Telegram: "⚠️ Morning collection failed" then EXIT  |
  | All sources STALE      | Flag in plan, skip time-sensitive recommendations   |
  | Source status: error    | Note gap, plan with available data                  |
  | tomorrow.json expired  | Skip carry-forward, note "no evening context"       |
  | cron_upsert fails      | Still send Telegram summary, log the failure        |

  Telegram: Send top 5 bullets via your response. Max 500 chars.
  ```

  Note: During Phase 2, uses heading `## Plan (pipeline)` to avoid collision with old job's `## Plan`.

- [x] **2.3** Swap Readwise Auto-Ingest model to `openai-codex/gpt-5.4-mini`
  ```bash
  openclaw cron edit <readwise-ingest-id> --model openai-codex/gpt-5.4-mini
  ```
- [x] **2.4** Force-run both new jobs to validate:
  ```bash
  openclaw cron run <morning-collect-id>
  # Wait for completion
  openclaw cron run <morning-planner-id>
  ```
  Verify: Telegram messages received, daily note has `## Plan (pipeline)` section, no errors.
- [ ] **2.5** Monitor parallel run for 2-3 days: compare old `## Plan` (Daily Note Prep) vs new `## Plan (pipeline)` (Morning Planner) side-by-side in each daily note
- [ ] **2.6** Success criteria: Morning Planner output is as good or better than old job on subjective review, no collector failures, no stale-data flags, no model fallback triggers

**Rollback:** Disable new jobs (`openclaw cron edit <id> --disable`). Old Daily Note Prep continues running.

**Gate:** 2-3 days of successful parallel runs before proceeding.

---

### Phase 3: Evening Pipeline

**Goal:** Deploy the evening pipeline (collector + Knowledge Processor + Evening Analyst). Disable old jobs as fallback.

**Tasks:**

- [ ] **3.1** Create Evening Data Collect cron job
  ```bash
  openclaw cron add \
    --name "Evening Data Collect" \
    --cron "0 20 * * *" --tz "Europe/Paris" \
    --model openai-codex/gpt-5.4-mini \
    --fallback openrouter/minimax/minimax-m2.7 \
    --fallback openrouter/qwen/qwen3.6-plus \
    --session isolated \
    --timeout 300 \
    --message "Run: python3 /home/codex/second-brain/scripts/openclaw-pipeline/evening_collect.py" \
    --announce --channel telegram --to 183115134 --delivery bestEffort
  ```
- [ ] **3.2** Create Knowledge Processor cron job (20:30)
      **Knowledge Processor prompt sketch** (~500 tokens):

  ```
  Read /tmp/openclaw-pipeline/pm/*.json.
  You are Leonard's evening knowledge processor.

  GUARD: If /tmp/openclaw-pipeline/pm/ does not exist or contains 0 JSON files,
  send Telegram: "⚠️ Evening collection failed — no data" and EXIT.

  Tasks (in order):
  1. Triage inbox: move files from second-brain/inbox/ to appropriate project folders.
     Log each move destination.
  2. Link Readwise highlights to active projects when relevant.
  3. For each project with activity today (commits, meetings, inbox items, LOG.md changes):
     Rewrite CONTEXT.md to <200 lines reflecting current state.
     CONTEXT.md is a snapshot (phase, blockers, focus, next actions), not a log.
     If CONTEXT.md and LOG.md contradict, CONTEXT.md is wrong — regenerate from LOG.md + recent activity.
  4. Run sb-knowledge-compiler loop.
  5. Git operations: scoped git add for changed CONTEXT.md files only.
     If git-activity.json shows dirty_working_tree: true, do NOT git stash. Commit only your changes.
     Attempt git push. If push fails (rebase conflict), log failure and continue.

  Write results → /tmp/openclaw-pipeline/pm/triage.json (atomic: write to .triage.json.tmp, then mv).
  ```

- [ ] **3.3** Create Evening Analyst cron job (21:15)
      **Evening Analyst prompt** (~400 tokens, pre-flight + steps + error table):

  ```
  You are Leonard's evening analyst. Extract learnings, track progress, prime tomorrow.

  PRE-FLIGHT (Step 0):
  Run preflight check (same pattern as morning — check pm/ files, triage.json existence,
  freshness). Write results to /tmp/preflight_pm.json.

  Step 1: Read /tmp/preflight_pm.json. Note available vs missing sources.
  Step 2: Read FRESH data files from /tmp/openclaw-pipeline/pm/.
  Step 3: If triage.json exists, read Knowledge Processor results.
  Step 4: Extract and synthesize:
          - Decisions made + outcomes
          - Progress deltas vs. yesterday
          - Learnings (from meetings, reading, coding)
          - Friction signals (repeated failures, slow responses, tool issues)
  Step 5: Write recap to /tmp/recap.txt.
  Step 6: Call: python3 /home/codex/second-brain/scripts/cron_upsert_section.py \
          --path <daily_note_path> --heading "Evening Recap" --level 2 --in /tmp/recap.txt
  Step 7: Write /tmp/openclaw-pipeline/tomorrow.json (atomic write) with:
          written_at, unfinished_threads, blockers, key_context, readwise_project_map.
  Step 8: Verify both /tmp/recap.txt and tomorrow.json exist and are non-empty.

  ERROR TABLE:
  | Condition              | Action                                              |
  |------------------------|-----------------------------------------------------|
  | 0 JSON files in pm/    | Telegram: "⚠️ Evening collection failed" then EXIT  |
  | triage.json missing    | Proceed without triage data, note gap in recap      |
  | All sources empty      | Minimal "quiet day" recap, still write tomorrow.json|
  | cron_upsert fails      | Still send Telegram + write tomorrow.json           |
  | tomorrow.json write fails | Log error, still send Telegram + daily note      |

  Telegram: Condensed summary via your response. Max 500 chars. Lead with outcomes.
  ```

- [ ] **3.4** Disable old jobs (keep as fallback):
  ```bash
  openclaw cron edit <daily-sb-routine-id> --disable
  openclaw cron edit <daily-knowledge-compile-id> --disable
  openclaw cron edit <daily-assistant-friction-scan-id> --disable
  ```
- [ ] **3.5** Force-run the evening pipeline sequence:
  ```bash
  openclaw cron run <evening-collect-id>
  openclaw cron run <knowledge-processor-id>
  openclaw cron run <evening-analyst-id>
  ```
  Verify: all Telegram messages received, daily note has `## Evening Recap`, CONTEXT.md files updated for active projects, `tomorrow.json` written with `written_at` timestamp.
- [ ] **3.6** Validate timing: does Knowledge Processor complete before Evening Analyst's 21:15 slot?
  - Under `maxConcurrentRuns: 1`, Evening Analyst queues behind Knowledge Processor regardless
  - Check: Knowledge Processor run duration should be under 45 minutes (the gap)
  - If consistently > 45 min, consider widening the gap

**Rollback:** Re-enable old jobs (`openclaw cron edit <id> --enable`). Disable new evening jobs.

**Gate:** 2-3 days of successful evening pipeline runs. CONTEXT.md files updated correctly. `tomorrow.json` written and consumed by next morning.

---

### Phase 3.5: Operational File Updates

**Goal:** Update Clawd files that reference specific job names, UUIDs, and pipeline operational details. Only after Phases 2+3 are validated.

**Tasks:**

- [ ] **3.5.1** Update `clawd/AGENTS.md`
  - Replace stale model routing (Sonnet 4.6/Opus) with: `gpt-5.4` default, `gpt-5.4-mini` for cron/background, minimax/qwen fallback only
  - Add pipeline architecture section: Collect → Process → Compose → Deliver pattern
  - Update knowledge gardening section: reference Knowledge Processor pipeline (20:30)
  - Update cron health check references: old job names → new pipeline job names
  - Add: "Check `/tmp/openclaw-pipeline/tomorrow.json` for carry-forward context from last evening"
  - Add rule: "Cron agents receive pre-structured data — they do NOT run shell commands for data gathering"
- [ ] **3.5.2** Update `clawd/HEARTBEAT.md`
  - Replace `critical_jobs` list: old UUIDs → new pipeline job UUIDs (Morning Data Collect, Morning Planner, Evening Data Collect, Knowledge Processor, Evening Analyst)
  - Configure heartbeat model to `openai-codex/gpt-5.4-mini`
  - Add pipeline health check (see brainstorm: HEARTBEAT.md section):
    ```bash
    # Check pipeline data freshness AND content validity
    TODAY=$(TZ=Europe/Paris date +%F)
    for f in /tmp/openclaw-pipeline/am/*.json; do
      ts=$(python3 -c "import json; print(json.load(open('$f')).get('collected_at','MISSING'))")
      status=$(python3 -c "import json; print(json.load(open('$f')).get('status','MISSING'))")
      echo "$(basename $f): collected=$ts status=$status"
    done
    # Same for pm/ and tomorrow.json
    ```
  - Alert conditions: 0 files or all-error after 05:15 (morning) / 20:15 (evening), stale `collected_at` from previous day
  - Simplify second brain gardening: inbox triage now handled by Knowledge Processor (20:30 cron)
- [ ] **3.5.3** Update `clawd/TOOLS.md` — add pipeline data exchange section
  - Add `## Pipeline Data Exchange` section (see brainstorm: TOOLS.md section)
  - Update cron job references: "Daily Note Prep (05:00)" → "Morning Planner (05:10)", etc.
- [ ] **3.5.4** Create pipeline runbook at `second-brain/projects/homelab/runbooks/cron-pipeline.md`
  - Quick status check script (30 seconds)
  - Common failure modes decision tree (gateway down, script error, model error, delivery failure)
  - Manual re-run commands per pipeline stage
  - One screen per failure mode — this is a "2am half-asleep reference", not an SRE document
- [ ] **3.5.5** Switch Morning Planner heading from `## Plan (pipeline)` back to `## Plan`
  - Update the Morning Planner cron job prompt
  - Disable old Daily Note Prep job (no longer needed — Morning Planner proven)

**Rollback:** Revert file changes via git. Job UUIDs in HEARTBEAT.md can be swapped back to old IDs.

---

### Phase 4: Weekly Consolidation + Model Swaps

**Goal:** Merge Weekly SB Review + Weekly Kaizen into single Weekly Review. Swap ByteRover model.

**Tasks:**

- [ ] **4.1** Create merged Weekly Review cron job (Sat 23:00)
  - Consolidates: weekly vault health, backlog review, kaizen friction review, weekly commits summary
  - Gathers data inline (runs weekly — not worth a separate collector)
  - Model: `openai-codex/gpt-5.4-mini`
- [ ] **4.2** Disable old Weekly SB Review and Weekly Kaizen Review jobs
- [ ] **4.3** Swap ByteRover Miner model to `openai-codex/gpt-5.4-mini`
  ```bash
  openclaw cron edit <byteerover-id> --model openai-codex/gpt-5.4-mini
  ```
- [ ] **4.4** Force-run Weekly Review and ByteRover Miner to validate
- [ ] **4.5** Monitor for 1 week

**Rollback:** Re-enable old weekly jobs. Revert ByteRover model.

---

### Phase 5: Cleanup

**Goal:** Remove disabled old jobs. Purge dead weight. Monitor.

**Tasks:**

- [ ] **5.1** Delete disabled old jobs:
  - Daily Note Prep
  - Daily Second-Brain Routine
  - Daily Knowledge Compile
  - Daily Assistant Friction Scan
  - Weekly Assistant Kaizen Review
  - Weekly Second-Brain Review
- [ ] **5.2** Purge disabled one-shot reminders (X posts, LinkedIn posts, blog reminders)
- [ ] **5.3** Purge disabled memory reindex job (OOM issue)
- [ ] **5.4** Monitor all pipeline jobs for 1 week — check daily:
  - Morning: Telegram message received by 05:30? Daily note `## Plan` populated?
  - Evening: Telegram message received by 22:00? `## Evening Recap` populated? CONTEXT.md updated? `tomorrow.json` fresh?
  - Weekly: Saturday review delivered?

**Rollback:** Jobs are already deleted — no rollback. This is why Phase 5 has a 1-week monitor period.

---

### Phase 6: Finalization

**Goal:** Clean up references. Update memory files. Document final state.

**Tasks:**

- [ ] **6.1** Update memory files to reflect new architecture:
  - `project_openclaw_architecture.md` — update cron job inventory
  - `project_openclaw_model_routing.md` — update model defaults for cron
- [ ] **6.2** Run `brv curate` from `/home/codex/projects/openclaw` to capture the architecture change
- [ ] **6.3** Run `brv curate` from `/home/codex/second-brain` to capture the script additions
- [ ] **6.4** Final `openclaw cron list` — verify exactly 9 active jobs matching the inventory table above
- [ ] **6.5** Final pipeline health check — verify all JSON files fresh, all timestamps current day

---

## Files Changed

### New Files

| File                                                        | Phase | Purpose                                                         |
| ----------------------------------------------------------- | ----- | --------------------------------------------------------------- |
| `second-brain/scripts/openclaw-pipeline/morning_collect.py` | 1     | Morning data collector                                          |
| `second-brain/scripts/openclaw-pipeline/evening_collect.py` | 1     | Evening data collector                                          |
| `second-brain/scripts/openclaw-pipeline/collect_utils.py`   | 1     | Shared utilities (atomic writes, subprocess, error aggregation) |
| `second-brain/scripts/openclaw-pipeline/__init__.py`        | 1     | Package marker                                                  |
| `second-brain/projects/homelab/runbooks/cron-pipeline.md`   | 3.5   | Pipeline runbook (status check, failure modes, re-run commands) |

### Modified Files

| File                                            | Phase  | Change                                                    |
| ----------------------------------------------- | ------ | --------------------------------------------------------- |
| `~/.openclaw/openclaw.json`                     | 0      | Model alias override, heartbeat model                     |
| `~/.openclaw/cron/jobs.json`                    | 0-5    | Job additions, edits, deletions (via CLI)                 |
| `clawd/USER.md`                                 | 1      | Work preferences section                                  |
| `clawd/TOOLS.md`                                | 1, 3.5 | Model routing refs (1), pipeline data exchange (3.5)      |
| `clawd/PRINCIPLES.md`                           | 1      | Two new principles + one regression                       |
| `second-brain/scripts/cron_ensure_daily_log.py` | 1      | Add `## Evening Recap` to template                        |
| `clawd/AGENTS.md`                               | 3.5    | Pipeline architecture, model routing, knowledge gardening |
| `clawd/HEARTBEAT.md`                            | 3.5    | New job UUIDs, pipeline health check, heartbeat model     |

### Untouched

| File                | Reason                                                |
| ------------------- | ----------------------------------------------------- |
| `clawd/SOUL.md`     | Pipeline changes operations, not personality          |
| `clawd/IDENTITY.md` | Pipeline changes operations, not identity             |
| Any `src/**/*.ts`   | No TypeScript changes — this is config + scripts only |

---

## Acceptance Criteria

### Phase 0

- [ ] `openclaw cron run` with `openai-codex/gpt-5.4-mini` succeeds and delivers to Telegram
- [ ] No `OPENROUTER_API_KEY` in `jobs.json` `env` fields
- [ ] Existing jobs unaffected

### Phase 1

- [ ] Both collector scripts run successfully and produce valid JSON
- [ ] Every JSON file has `collected_at` and `status` fields
- [ ] Wipe-before-write confirmed: re-running a collector replaces stale data
- [ ] Individual source failures produce `{"status": "error"}` without crashing the script
- [ ] Clawd file updates reviewed and committed

### Phase 2

- [ ] Morning pipeline runs for 2-3 days without failures
- [ ] Morning Planner output quality matches or exceeds old Daily Note Prep
- [ ] `tomorrow.json` consumed correctly on day 2+ (feedback loop working)
- [ ] No model fallback triggers (staying on `openai-codex/gpt-5.4-mini`)

### Phase 3

- [ ] Evening pipeline runs for 2-3 days without failures
- [ ] CONTEXT.md updated for projects with activity, untouched for inactive projects
- [ ] CONTEXT.md < 200 lines per file
- [ ] `triage.json` written and consumed by Evening Analyst
- [ ] `tomorrow.json` written with `written_at` timestamp
- [ ] Git push succeeds (or failure logged gracefully if dirty tree)
- [ ] Daily note has both `## Plan` and `## Evening Recap` sections

### Phase 4-6

- [ ] Weekly Review consolidates old weekly + kaizen coverage
- [ ] ByteRover running on gpt-5.4-mini without degradation
- [ ] Final job count: exactly 9 active jobs
- [ ] OpenRouter cost near zero (only fallback usage)
- [ ] All pipeline health checks green for 1 week

---

## Risks & Mitigations

| Risk                                                                  | Likelihood | Impact | Mitigation                                                                                             |
| --------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| gpt-5.4-mini quality insufficient for planning                        | Low        | Medium | Parallel run (Phase 2) validates before committing. Fallback: use gpt-5.4 for planner.                 |
| Collector script breaks silently                                      | Medium     | High   | Guard clauses in agent prompts. Pipeline health check in HEARTBEAT.md. Telegram alert on missing data. |
| Model override persistence bug sticks cron session on fallback        | Medium     | Medium | Check if fix from `docs/plans/2026-04-08-002` is implemented. If not, monitor for model drift.         |
| Knowledge Processor CONTEXT.md rewrite is too aggressive              | Medium     | Medium | Validate rewrites manually for first 2-3 days. CONTEXT.md < 200 lines constraint.                      |
| `maxConcurrentRuns` changed in future, breaking sequential assumption | Low        | High   | Document constraint in AGENTS.md and TOOLS.md. Add comment in pipeline scripts.                        |
| External CLI failures (gws, readwise, brv) during collection          | Medium     | Low    | Best-effort collection — individual source failures don't crash the pipeline.                          |

---

## Monitoring & Alerting

### Alert Thresholds

| Condition                              | Action                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 failure, any agent job               | Log it. No alert. `consecutiveErrors` increments.                                                                                             |
| 2 consecutive failures, same agent job | Telegram alert: "[Job Name] failed 2x. Last error: [truncated]"                                                                               |
| 1 failure, any collector job           | **Immediate alert.** Collectors are simple scripts; failure means environment issue (disk, network, auth). Cascades to all downstream agents. |
| Delivery failure (Telegram)            | **Immediate alert.** Delivery failures mean the system cannot tell you it's broken.                                                           |
| No run in expected window              | Dead man's switch: if `nextRunAtMs` is >2x expected interval in the past, alert. Catches gateway being down.                                  |
| Duration > 3x 7-day average            | Warning footnote in next Telegram briefing, not a standalone alert.                                                                           |

### Output Quality Signals

**Per-run (automated):**

- **Output structure validation**: Does the daily note contain expected H2 headings? Is Telegram message under character limit?
- **Empty-input canary**: If all data sources were empty/stale, output should contain "No activity captured" or similar. If it doesn't despite empty inputs, the model hallucinated.
- **Output length tracking**: Log character count. Sudden drop (<50% of 7-day average) or spike (>200%) signals degradation.

**Longitudinal (manual review weekly):**

- Are plans actionable (next steps, blockers, decisions) or data dumps?
- Is the evening recap synthesizing or parroting?
- Is `tomorrow.json` carry-forward actually influencing morning plans?

### Pipeline Throughput

Track daily completion count. The last evening job (Evening Analyst) writes a `pipeline_throughput` field to `tomorrow.json`: number of pipeline jobs that completed today (from cron state). If fewer than 7 of 9 completed on a weekday, flag as degraded day.

### Runbook

Create `second-brain/projects/homelab/runbooks/cron-pipeline.md` (Phase 3.5) with:

- Quick status check (30-second script)
- Common failure modes decision tree (gateway down, script error, model error, delivery failure, slow upstream)
- Manual re-run commands per pipeline stage
- Keep it to one screen per failure mode

---

## Implementation Patterns (Appendix)

### Atomic File Writes

All collector JSON output uses atomic writes to prevent partial reads:

```python
import tempfile, os, json

def atomic_write_json(filepath: str, data: dict) -> None:
    dir_ = os.path.dirname(filepath)
    fd = tempfile.NamedTemporaryFile(mode="w", suffix=".tmp", dir=dir_, delete=False)
    try:
        json.dump(data, fd, indent=2)
        fd.flush()
        os.fsync(fd.fileno())
        fd.close()
        os.replace(fd.name, filepath)  # atomic on POSIX (same filesystem)
    except BaseException:
        fd.close()
        os.unlink(fd.name)
        raise
```

Key: temp file in same directory (same filesystem for atomic `os.replace`), `fsync` before rename, cleanup on failure.

### Atomic Directory Swap

Collectors replace their target directory atomically:

```python
import tempfile, shutil, os

def atomic_replace_dir(target_dir: str, populate_fn) -> None:
    parent = os.path.dirname(target_dir)
    tmp_dir = tempfile.mkdtemp(dir=parent)
    try:
        populate_fn(tmp_dir)
        backup = target_dir + ".old"
        if os.path.exists(target_dir):
            os.rename(target_dir, backup)
        os.rename(tmp_dir, target_dir)
        if os.path.exists(backup):
            shutil.rmtree(backup)
    except BaseException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if not os.path.exists(target_dir) and os.path.exists(backup):
            os.rename(backup, target_dir)
        raise
```

### Subprocess Timeout Handling

External CLIs get per-source timeouts (45-60s), never `shell=True`:

```python
import subprocess

def run_cli(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True,
        timeout=timeout, check=True, stdin=subprocess.DEVNULL,
    )
```

Budget: 5 sources × 60s max = 300s total budget fits within the 300s collector timeout.

### Error Aggregation

```python
from dataclasses import dataclass, field

@dataclass
class SourceResult:
    name: str
    status: str  # "ok" | "error"
    data: dict | None = None
    error: str | None = None
    duration_ms: int = 0
    items_count: int = 0

@dataclass
class CollectionRun:
    results: list[SourceResult] = field(default_factory=list)

    @property
    def overall_status(self) -> str:
        statuses = {r.status for r in self.results}
        if statuses == {"ok"}: return "ok"
        if statuses == {"error"}: return "error"
        return "partial"

    @property
    def summary(self) -> str:
        ok = [r.name for r in self.results if r.status == "ok"]
        err = [r.name for r in self.results if r.status == "error"]
        return f"{len(ok)}/{len(self.results)} ok. Errors: {', '.join(err) or 'none'}"
```

Three-valued status (`ok`/`error`/`partial`) lets downstream agents decide how to handle partial data. `duration_ms` per source enables trend tracking.

### Logging Convention

- **stdout**: 1-3 line human summary for the LLM consumer (~20 tokens). Example: `Collected 5/6 sources. Errors: readwise`
- **stderr**: JSON-lines structured logging for diagnostics (timestamps, levels, source names)
- **Never put stack traces on stdout** — they blow the LLM's ~200 token context budget

### Agent Prompt Template

All pipeline agent prompts follow this structure (proven reliable on gpt-5.4-mini at ~400 tokens):

```
SYSTEM: You are [role]. You read data from [dir] and produce:
  1. Markdown section (via cron_upsert_section.py)
  2. Telegram message (via response)

PRE-FLIGHT (Step 0): [bash block → /tmp/preflight.json with freshness verdicts]

Step 1-N: [numbered sequential steps, max 5-6, clear verbs]

ERROR TABLE:
| Condition | Action |
|-----------|--------|
| ...       | ...    |
```

Design rules:

- **Max 5-7 discrete steps** — compliance drops sharply above 7 on gpt-5.4-mini
- **Pre-flight externalizes guard logic** — model reads facts (FRESH/STALE/MISSING), not timestamps
- **Error table beats inline if/then** — highest reliability pattern on smaller models
- **Separate write operations per output** — prevents model from completing one and forgetting the other
- **Verification step at the end** — "check both outputs exist and are non-empty"
- **Never ask the model to parse ISO timestamps** — externalize time math to Python in the pre-flight

---

## What This Is NOT

- Not a rewrite of OpenClaw core (no TypeScript changes)
- Not a change to the second-brain note format or conventions
- Not adding new external integrations — uses existing CLIs (gws, readwise, brv)
- Not changing Telegram delivery (same bot, same chat ID, same format)
- Not changing Clawd's personality (SOUL.md, IDENTITY.md untouched)

(see brainstorm: "What This Is NOT" section)

---

## Sources

- **Origin brainstorm:** `docs/brainstorms/2026-04-10-cron-pipeline-refactor-brainstorm.md` — all key decisions, architecture, migration path, and core file update specifications. Stress-tested by three independent reviewers (scope, feasibility, coherence) with 11 findings resolved inline.
- **Cron schema:** `src/gateway/protocol/schema/cron.ts` — payload kinds, schedule types, delivery modes
- **Sequential execution:** `src/gateway/server-lanes.ts:7` — `maxConcurrentRuns ?? 1`
- **Cron timeout:** `src/cron/service/timeout-policy.ts` — 60-min default for agentTurn
- **Model aliases:** `src/config/defaults.ts:14-28` — `gpt-mini` routes to `openai/gpt-5.4-mini`, not `openai-codex/`
- **Existing scripts:** `second-brain/scripts/cron_upsert_section.py`, `cron_ensure_daily_log.py`, `cron_utils.py`
- **Current jobs:** `~/.openclaw/cron/jobs.json` — 9 active jobs, all on `openrouter/minimax`
- **HEARTBEAT.md:** `clawd/HEARTBEAT.md` — current critical job UUIDs and health check script
- **SpecFlow analysis findings:** Identified 14 gaps including collector failure behavior, parallel-run section collision, `tomorrow.json` expiration, `maxConcurrentRuns` constraint, git push policy, and daily note section heading assignments.

### Deepening Research (external best practices)

- **Python collector patterns:** Atomic file writes via `tempfile` + `os.replace` + `os.fsync` (CPython docs). Per-source subprocess timeouts with `capture_output=True` (never `shell=True`). Error aggregation via `CollectionRun` dataclass with three-valued status. Lightweight assertions for JSON validation (not full schema).
- **Pipeline monitoring:** Alert on 2 consecutive failures for agents, immediate alert for collectors and delivery failures. Dead man's switch for missed runs. Track `items_count` and `duration_ms` per source for quality signals and trend anomaly detection. Runbook with decision tree.
- **Agent prompt patterns:** Pre-flight bash block externalizes guard logic (model reads facts, not timestamps). Max 5-7 steps for gpt-5.4-mini reliability. Error handling in table format (highest reliability on smaller models). Separate write operations per output to prevent forgotten deliveries. Verification step at end.
- **Production skill patterns in this codebase:** `sb-daily-wrap-from-pieces` and `sb-hourly-log-from-pieces` demonstrate the proven pre-flight + numbered steps + idempotency guard pattern already in use for scheduled agent skills.
