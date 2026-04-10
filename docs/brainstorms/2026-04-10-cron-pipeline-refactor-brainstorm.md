# Brainstorm: OpenClaw Cron Pipeline Refactor

**Date:** 2026-04-10
**Status:** Draft
**Author:** Leonard + Claude

---

## What We're Building

A ground-up refactoring of OpenClaw's cron job architecture, replacing 11 monolithic agent sessions with a **pipeline architecture** of lightweight data collectors feeding specialized, right-sized agents. Three objectives:

1. **Morning Planning Session** — not just a briefing, but a context-aware daily planner that connects dots (Readwise → projects, email → meetings), surfaces priorities, and tells you what to do first.
2. **Knowledge Triage Engine** — consolidates inbox processing, Readwise→project linking, CONTEXT.md refresh, and knowledge compilation into a single coherent pipeline with clear results reporting.
3. **Evening Compounding Recap** — captures decisions + outcomes, progress deltas, learning extraction, and primes tomorrow's morning agent with carry-forward threads.

## Why This Approach

### Current Pain Points

| Problem                              | Evidence                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token waste on shell execution**   | Each monolithic job embeds ~2500 tokens of inline shell prompts. The LLM spends most tokens running `git pull`, `gws calendar`, `find` — things that don't need reasoning. |
| **Model mismatch**                   | GPT (expensive, via OpenRouter) used for tasks minimax could handle. Meanwhile, `gpt-5.4-mini` is available at zero marginal cost via OAuth and unused.                    |
| **OpenRouter cost leak**             | minimax/qwen charged per-token on OpenRouter for every daily run, while the ChatGPT Pro subscription already includes gpt-5.4 and gpt-5.4-mini.                            |
| **Monolithic agents**                | Single jobs try to gather data, process files, compose messages, AND deliver — making them fragile, slow, and hard to debug.                                               |
| **Overlapping jobs**                 | Daily Second-Brain Routine + Daily Knowledge Compile both fire at 21:00. Unclear what each accomplished.                                                                   |
| **No morning↔evening feedback loop** | Morning briefing is a data dump. Evening wrap is maintenance. Neither builds on the other.                                                                                 |
| **Readwise disconnected**            | Highlights get ingested but never connect to active projects or influence decisions.                                                                                       |
| **CONTEXT.md staleness**             | Project CONTEXT.md files drift. Agent updates are shallow or wrong.                                                                                                        |
| **No true daily recap**              | The evening "wrap" is vault maintenance, not reflective compounding.                                                                                                       |

### Architecture: Collect → Process → Compose → Deliver

The key insight: **separate data gathering (minimal LLM) from reasoning (right-sized LLM)**.

**Constraint:** OpenClaw's cron system only supports `agentTurn` (LLM session) and `systemEvent` (static text) payloads — there is no `script` kind. Data collectors run as `agentTurn` with a trivial one-line prompt ("Run: `python3 /path/to/collect.py`"), which costs ~200 tokens of overhead vs. ~2500 for current monolithic prompts. Not truly zero, but a 90%+ reduction. The LLM acts as a thin shell executor, not a reasoner.

```
┌─────────────────────────────────────────────────────────────────┐
│                        MORNING PIPELINE                         │
│                                                                 │
│  05:00 [COLLECTOR] Morning Data Collect (agentTurn, ~200 tok)   │
│      runs morning_collect.py → /tmp/openclaw-pipeline/am/       │
│      calendar.json, email.json, readwise.json,                  │
│      vault-health.json, projects.json                           │
│                                                                 │
│  05:10 [gpt-5.4-mini] Morning Planner                           │
│      reads /tmp/openclaw-pipeline/am/*                          │
│      connects dots, prioritizes, plans                          │
│      writes → daily note (full) + Telegram (top bullets)        │
│                                                                 │
│  06:00 [COLLECTOR] Readwise Auto-Ingest (existing pipeline)     │
│                                                                 │
│  09:00 [gpt-5.4-mini] ByteRover Miner (keep as-is, already lean)│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       EVENING PIPELINE                          │
│                                                                 │
│  20:00 [COLLECTOR] Evening Data Collect (agentTurn, ~200 tok)   │
│      runs evening_collect.py → /tmp/openclaw-pipeline/pm/       │
│      git-activity.json, session-notes.json, meetings.json,      │
│      inbox-state.json, readwise-new.json, context-diffs.json    │
│                                                                 │
│  20:30 [gpt-5.4-mini] Knowledge Processor                      │
│      reads /tmp/openclaw-pipeline/pm/*                          │
│      triages inbox (moves files, logs destinations)             │
│      links Readwise highlights to active projects               │
│      refreshes CONTEXT.md for touched projects                  │
│      runs sb-knowledge-compiler loop                            │
│      commits + pushes second-brain                              │
│      writes results → /tmp/openclaw-pipeline/pm/triage.json     │
│                                                                 │
│  21:15 [gpt-5.4-mini] Evening Analyst                           │
│      reads /tmp/openclaw-pipeline/pm/* + triage.json            │
│      extracts: decisions+outcomes, progress deltas, learnings   │
│      scans for assistant friction signals (absorbed from old job)│
│      writes → daily note (full recap) + Telegram (summary)      │
│      primes /tmp/openclaw-pipeline/tomorrow.json for morning    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      PERIODIC REVIEWS                           │
│                                                                 │
│  Sat 23:00 [gpt-5.4-mini] Weekly Review                         │
│      consolidated: weekly health + kaizen friction review        │
│      replaces: Weekly SB Review + Weekly Kaizen (merged)        │
│      gathers its own data inline (runs weekly, not worth a      │
│      separate collector)                                        │
│                                                                 │
│  1st/mo 09:15 [gpt-5.4] Monthly Kaizen                         │
│      full reasoning for standardization decisions               │
│      gathers its own data inline (runs monthly)                 │
└─────────────────────────────────────────────────────────────────┘
```

## Key Decisions

### 1. Model Routing: Zero-Cost First

| Tier      | Model                                    | Cost                   | Used for                                   |
| --------- | ---------------------------------------- | ---------------------- | ------------------------------------------ |
| Collector | `gpt-5.4-mini` (trivial prompt)          | ~200 tokens overhead   | Data collection — LLM just runs one script |
| Agent     | `openai-codex/gpt-5.4-mini`              | Included (ChatGPT Pro) | All daily agents, heartbeats               |
| Heavy     | `openai-codex/gpt-5.4`                   | Included (ChatGPT Pro) | Monthly kaizen only                        |
| Fallback  | `openrouter/minimax` → `openrouter/qwen` | Pay-per-token          | Only if OpenAI unreachable                 |

**Impact:** OpenRouter costs drop to near-zero. Better quality (gpt-5.4-mini > minimax) at zero marginal cost.

**Hard rule preserved:** Never route Anthropic or OpenAI through OpenRouter.

### 2. Pipeline Data Exchange via `/tmp/openclaw-pipeline/`

Collector scripts write structured JSON files. Agents read them via `exec` (`cat` / `jq`). Benefits:

- **Debuggable:** inspect intermediate data when something goes wrong
- **Decoupled:** scripts and agents evolve independently
- **Cacheable:** morning data available all day if needed

**Stale data protection:** Every JSON file includes a `collected_at` ISO timestamp. Collector scripts wipe and recreate the target directory (`am/` or `pm/`) at the start of each run. Agent prompts include: "If any file has `collected_at` older than 2 hours, flag it as stale in your output." This prevents agents from silently reading yesterday's data if today's collection failed to run.

**Note:** `/tmp` on this system is ext4 (not tmpfs), so files survive reboots. The wipe-before-write pattern handles cleanup.

Directory structure:

```
/tmp/openclaw-pipeline/
├── am/                    # Morning collection
│   ├── calendar.json
│   ├── email.json
│   ├── readwise.json
│   ├── vault-health.json
│   └── projects.json
├── pm/                    # Evening collection
│   ├── git-activity.json
│   ├── session-notes.json
│   ├── meetings.json
│   ├── inbox-state.json
│   ├── readwise-new.json
│   ├── context-diffs.json
│   └── triage.json        # Written by Knowledge Processor
└── tomorrow.json          # Written by Evening Analyst, read by Morning Planner
```

### 3. Morning↔Evening Feedback Loop

The Evening Analyst writes `tomorrow.json` with:

- Unfinished threads to carry forward
- Blockers surfaced today
- Key context for tomorrow's company focus
- Readwise articles mapped to projects for morning surface

The Morning Planner reads `tomorrow.json` directly (not via `morning_collect.py` — this is a hot handoff between agents, not collected data). If present, it incorporates carry-forward context into the planning session. This creates a **compounding loop** — each day's evening prep makes the next morning smarter.

**Relationship to ByteRover:** `brv curate` already provides a carry-forward mechanism via its context tree. `tomorrow.json` complements it with a higher-fidelity, structured handoff specifically between the evening and morning agents. ByteRover captures broader session knowledge; `tomorrow.json` captures the precise state of "what's unfinished and what matters tomorrow." Both coexist — they serve different scopes.

### 4. Delivery: Dual-Channel

- **Daily note** (at `second-brain/logs/daily-summaries/YYYY-MM-DD.md`): full-depth planning/recap with all context
- **Telegram**: condensed top-bullets excerpt — actionable, scannable on phone
- Use existing `cron_upsert_section.py` for daily note updates
- Telegram messages structured as before (calendar, email, project focus, etc.) but tighter

### 5. Job Consolidation: 11 → 9 (3 collectors + 6 agents)

All 9 jobs are `agentTurn` payloads (OpenClaw's only LLM-capable payload kind). Collectors use a trivial one-line prompt (~200 tokens); agents use focused prompts (~300-500 tokens).

| #   | Time         | Name                 | Role      | Model        | Prompt size                        |
| --- | ------------ | -------------------- | --------- | ------------ | ---------------------------------- |
| 1   | 05:00        | Morning Data Collect | Collector | gpt-5.4-mini | ~200 tok (runs script)             |
| 2   | 05:10        | Morning Planner      | Agent     | gpt-5.4-mini | ~400 tok (reasoning)               |
| 3   | 06:00        | Readwise Auto-Ingest | Collector | gpt-5.4-mini | ~200 tok (runs script)             |
| 4   | 09:00        | ByteRover Miner      | Agent     | gpt-5.4-mini | ~300 tok (existing)                |
| 5   | 20:00        | Evening Data Collect | Collector | gpt-5.4-mini | ~200 tok (runs script)             |
| 6   | 20:30        | Knowledge Processor  | Agent     | gpt-5.4-mini | ~500 tok (triage + link + rewrite) |
| 7   | 21:15        | Evening Analyst      | Agent     | gpt-5.4-mini | ~400 tok (analysis)                |
| 8   | Sat 23:00    | Weekly Review        | Agent     | gpt-5.4-mini | ~500 tok (inline data gathering)   |
| 9   | 1st/mo 09:15 | Monthly Kaizen       | Agent     | gpt-5.4      | ~500 tok (inline data gathering)   |

**Timing rationale:** 45-minute gap between Knowledge Processor (20:30) and Evening Analyst (21:15) accommodates inbox triage + CONTEXT.md rewrites + git push. Evening Analyst checks for `pm/triage.json` existence before proceeding; if missing, it runs without triage data and notes the gap.

**Removed/merged:**

- Daily Assistant Friction Scan → absorbed into Evening Analyst (scans for friction as part of daily recap)
- Weekly Assistant Kaizen Review → merged into Weekly Review (consolidated weekly + kaizen)
- Daily Knowledge Compile → `sb-knowledge-compiler` loop absorbed into Knowledge Processor (runs as part of evening triage, not a separate session)
- Weekly Second-Brain Review → merged into Weekly Review

**Kept unchanged:**

- ByteRover Miner (already lean, 24s, just swap model to gpt-5.4-mini)
- Readwise Auto-Ingest (collector pattern, just swap model to gpt-5.4-mini)
- Personal reminders (Dr Garcon, kaizen phase 2) — not part of this refactor

**Periodic reviews (Weekly, Monthly) gather their own data inline** — running once per week/month doesn't justify a separate collector script. The pipeline pattern (collector → agent) is reserved for daily jobs where the cost savings compound.

### 6. Agent Prompt Architecture

Each agent gets a **focused prompt** (~300-500 tokens) instead of the current ~2500-token monoliths:

```
[Morning Planner prompt sketch]
Read /tmp/openclaw-pipeline/am/*.json and /tmp/openclaw-pipeline/tomorrow.json.
You are Leonard's morning planning agent. Your job: connect dots, prioritize, plan.

Rules:
- Link Readwise articles to active projects when relevant
- Flag email threads related to today's meetings
- Surface stale blockers from CONTEXT.md
- Output a prioritized plan, not a data dump

Write full plan → daily note via cron_upsert_section.py
Send top 5 bullets → Telegram
```

The key: agents receive **pre-structured data** so they spend tokens on _reasoning and connecting_, not on running shell commands.

### 7. Data Collector Scripts

Two new Python scripts that gather all external data:

**`morning_collect.py`:**

- Git repo sync (`git pull --rebase` for all repos)
- Calendar events (today) via `gws calendar`
- Email (urgent unread) via `gws gmail`
- Readwise Reader queue via `readwise reader-list-documents`
- Vault health via `python3 scripts/daily-routine.py --json`
- Project CONTEXT.md summaries (company-scoped by day-of-week)

Note: `tomorrow.json` is read directly by the Morning Planner agent, not by the collector script. It's a hot handoff between agents.

**`evening_collect.py`:**

- Git activity since morning (`git log --since`)
- Session notes from daily log
- Meeting notes added today (`find -mtime 0`)
- Inbox state (`find inbox/ -name "*.md"`)
- New Readwise highlights since morning
- CONTEXT.md diff (what changed today vs. morning snapshot)

Both scripts output structured JSON to `/tmp/openclaw-pipeline/`, run in ~10-30 seconds. They are invoked by a collector cron job (trivial `agentTurn` prompt: `"Run: python3 /path/to/script.py"`) which adds ~200 tokens of LLM overhead per invocation.

**Every JSON file includes:**

- `collected_at`: ISO timestamp of when data was gathered
- `status`: `"ok"` or `"error"`
- `error`: error message (only if status is error)

**Wipe-before-write:** Each script deletes and recreates its target directory (`am/` or `pm/`) at the start of each run. This prevents agents from reading stale data from a previous day.

**Failure handling:** Best-effort. Each data source is wrapped in try/except. If a source fails (e.g., `gws calendar` times out), its JSON file is written with `{"status": "error", "error": "..."}` and the downstream agent runs with whatever data is available, noting which sources were unavailable in its output.

## Resolved Questions

### Q1: Pipeline failure handling

**Decision:** Run with partial data. Best-effort briefing is better than no briefing. Each data source failure is logged in the JSON output so the agent can note it.

### Q2: Script language

**Decision:** Python. Better JSON handling, error handling, reuses existing `daily-routine.py` patterns. Scripts live at `second-brain/scripts/openclaw-pipeline/`.

### Q3: Readwise→Project linking strategy

**Decision:** LLM-assisted linking via the Knowledge Processor agent. Since gpt-5.4-mini is zero marginal cost, the accuracy benefit of LLM reasoning outweighs the token cost. The agent receives Readwise highlights and active project summaries, then reasons about connections.

### Q4: CONTEXT.md refresh depth

**Decision:** Full rewrite. CONTEXT.md must be <200 lines and always reflect the current state of the project (blockers, focus, phase, next actions). LOG.md is the append-only ledger. CONTEXT.md is rewritten by the Knowledge Processor **on every evening pipeline run** for all projects that had activity today (commits, meetings, inbox items moved in, LOG.md changes). If a project had no activity, its CONTEXT.md is not touched. The rewrite uses LOG.md + recent git activity + meeting notes as inputs.

### Q5: `gpt-5.4-mini` alias in OpenClaw

**Decision:** Needs configuration. Migration Phase 0 must add the `gpt-5.4-mini` alias to `openclaw.json` and test routing before any cron jobs switch to it. Model ID: `openai-codex/gpt-5.4-mini`. Alias: `gpt-mini`.

**Fallback plan if gpt-5.4-mini is unavailable via OAuth:** If the `openai-codex` provider doesn't support `gpt-5.4-mini`, fall back to `openrouter/openai/gpt-5.4-mini` (OpenRouter does support it). This violates the "never route OpenAI through OpenRouter" rule, but for background cron jobs (not interactive) the cost is acceptable as a temporary measure until direct OAuth support is confirmed. Document the exception in the model routing memory file.

## Migration Path

0. **Phase 0:** Configure `gpt-5.4-mini` alias in `openclaw.json`, test model routing, verify it works for isolated sessions
1. **Phase 1:** Create Python data collector scripts (`morning_collect.py`, `evening_collect.py`), test manually
2. **Phase 2:** Create Morning Planner agent on gpt-5.4-mini, run in parallel with old Daily Note Prep for 2-3 days, compare quality
3. **Phase 3:** Create Knowledge Processor + Evening Analyst, keep old Daily SB Routine + Knowledge Compile disabled as fallback
4. **Phase 4:** Merge Weekly SB Review + Weekly Kaizen into single Weekly Review, swap ByteRover to gpt-5.4-mini
5. **Phase 5:** Clean up disabled old jobs, purge one-shot reminders and disabled X/LinkedIn post jobs, monitor for 1 week
6. **Phase 6:** Delete old jobs, update memory files to reflect new architecture

## Core OpenClaw File Updates

The pipeline refactor requires updating 5 of 7 core files at `/home/codex/clawd/`. SOUL.md and IDENTITY.md are untouched — this refactor changes how Clawd operates, not who Clawd is.

**Update timing matters:** Some files can update before the pipeline is validated (passive context); others must wait until new jobs exist and are proven (operational references with job IDs/names).

### 1. AGENTS.md — Workspace Operations

**Current state:** References Sonnet 4.6/Opus model routing (decommissioned). Heartbeat vs cron guidance doesn't account for pipeline architecture. Knowledge gardening section is ad-hoc.

**Changes needed:**

| Section                | Current                                                      | Updated                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model Routing          | Sonnet 4.6 default, escalate to Opus                         | `gpt-5.4` default, `gpt-5.4-mini` for cron/background, minimax/qwen as fallback only                                                                         |
| Heartbeat vs Cron      | Generic guidance                                             | Add "Pipeline jobs" as third category — scripted data collection that feeds agent sessions                                                                   |
| Knowledge Gardening    | "Process shared content automatically"                       | Reference the Knowledge Processor pipeline — inbox triage, Readwise→project linking, CONTEXT.md rewrite all happen in the 20:30 evening pipeline, not ad-hoc |
| Cron Health Check refs | References old job names (Daily SB Routine, Daily Note Prep) | Reference new pipeline jobs (Morning Data Collect, Morning Planner, Evening Data Collect, Knowledge Processor, Evening Analyst)                              |
| Memory Recall          | Current workflow is fine                                     | Add: "Check `/tmp/openclaw-pipeline/tomorrow.json` for carry-forward context from last evening"                                                              |

**Key additions:**

- Pipeline architecture section explaining the Collect → Process → Compose → Deliver pattern
- Explicit rule: cron agents receive pre-structured data, they do NOT run shell commands for data gathering
- Morning↔Evening feedback loop: evening writes `tomorrow.json`, morning reads it

### 2. SOUL.md — No changes

**Rationale:** SOUL.md defines core personality and voice. The pipeline refactor changes how Clawd operates, not who Clawd is. "Compound, don't just complete" is an operational heuristic (belongs in PRINCIPLES.md's existing "Optimize for Learning Rate" principle), not a core truth. Keep SOUL.md untouched.

### 3. IDENTITY.md — No changes

**Rationale:** IDENTITY.md is an 11-line self-description. The pipeline refactor doesn't change Clawd's identity — it's still a knowledge partner and second-brain co-pilot. Rebranding to "daily compounding engine" is cosmetic, not functional. Keep IDENTITY.md untouched.

### 4. PRINCIPLES.md — Decision-Making Heuristics

**Current state:** Strong operational heuristics. Missing pipeline-specific decision logic.

**New principles to add (2):**

```markdown
### Pipeline-First Decomposition

Before executing a complex task, decompose it: what can a script handle (data gathering,
file moves, git ops)? What needs cheap reasoning (formatting, linking)? What needs real
synthesis (planning, analysis)? Don't spend tokens on things scripts can do. Right-size
the model to the task.

**Tension resolved:** Convenience vs. efficiency. It's easier to dump everything into one
agent session, but decomposition saves tokens and makes each stage debuggable.

### CONTEXT.md Is Always-Current

CONTEXT.md is a <200-line snapshot of the project's current state — phase, blockers, focus,
next actions. It is REWRITTEN (not appended) by the Knowledge Processor for any project
that had activity today. LOG.md is the append-only ledger; CONTEXT.md is the derived view.
If they contradict, CONTEXT.md is wrong and must be regenerated from LOG.md + recent activity.

**Tension resolved:** Append safety vs. freshness. LOG.md gets append safety. CONTEXT.md
gets freshness.
```

**Note:** "Compound Over Complete" was considered but dropped — already covered by existing PRINCIPLES.md heuristic "Optimize for Learning Rate, Not Task Completion" which resolves the same tension.

**Regressions to add:**

```markdown
### 2026-04-10: Monolithic Cron Waste

**What broke:** 11 cron jobs with ~5000 tokens/day of inline prompts, LLM spending most
tokens executing shell commands instead of reasoning.
**Lesson:** Decompose cron jobs into pipeline stages. Scripts collect data (zero LLM),
agents reason over pre-structured data (right-sized LLM).
```

### 5. TOOLS.md — Environment Configuration

**Current state:** References old skill paths, has stale Sonnet/Opus references, no pipeline data paths.

**Changes needed:**

| Section                             | Change                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model routing refs                  | Remove Sonnet 4.6/Opus. Add `gpt-5.4-mini` as cron default, `gpt-5.4` as interactive default                                                               |
| Memory Tiering                      | Keep as-is (still valid)                                                                                                                                   |
| Cron job refs in "Associated Repos" | Update job names: "Daily Note Prep (05:00)" → "Morning Planner (05:10)", "Daily Routine (21:00)" → "Knowledge Processor (20:30) + Evening Analyst (21:15)" |
| ByteRover                           | Keep as-is                                                                                                                                                 |

**New section to add:**

```markdown
## Pipeline Data Exchange

Cron pipeline agents read pre-collected data from `/tmp/openclaw-pipeline/`:

- `am/` — morning collection (calendar, email, readwise, vault-health, projects). Written by `morning_collect.py`, read by Morning Planner.
- `pm/` — evening collection (git-activity, inbox-state, readwise-new, context-diffs, session-notes, meetings). Written by `evening_collect.py`, read by Knowledge Processor + Evening Analyst.
- `pm/triage.json` — written by Knowledge Processor, read by Evening Analyst.
- `tomorrow.json` — carry-forward context. Written by Evening Analyst, read directly by Morning Planner.

All JSON files include `collected_at` timestamps. See scripts at `second-brain/scripts/openclaw-pipeline/` for full schema.
```

### 6. USER.md — Human Profile

**Current state:** Good basics (name, timezone, second-brain structure). Missing operational preferences surfaced during this brainstorm.

**Additions needed:**

```markdown
## Work Preferences (discovered 2026-04-10)

### Morning = Planning Session

Leonard wants the morning briefing to be a planning session, not a data dump.
Connect dots between sources (Readwise → projects, email → meetings). Prioritize
next actions. Tell him what to do first. Context-aware, actionable, fundamentally
a daily planner.

### Evening = Compounding Machine

The evening recap should capture: decisions made + outcomes, progress deltas vs.
yesterday, learnings extracted (from meetings, reading, coding), and prep for
tomorrow (carry forward unfinished threads, flag attention items, pre-load context).

### Right-Size Everything

Match model capability to task complexity. Zero LLM where scripts suffice. Cheap
models for formatting. Real reasoning only where it adds value. Don't waste tokens
on things that don't need intelligence.

### Delivery: Telegram + Daily Note

Full-depth content goes to the daily note at `logs/daily-summaries/`. Telegram gets
the condensed top-bullets excerpt — actionable, scannable on phone.

### CONTEXT.md Convention

CONTEXT.md must be <200 lines and always reflect current project state. It is fully
rewritten (not appended) whenever LOG.md changes. LOG.md is the append-only ledger.
```

### 7. HEARTBEAT.md — Proactive Task Checklist

**Current state:** References old job IDs and names. Cron health check uses hardcoded UUIDs for "Daily Second-Brain Routine" and "Daily Note Prep".

**Model:** Heartbeat polling MUST use `gpt-5.4-mini`, not `gpt-5.4`. Heartbeats are periodic background checks — they don't need full reasoning. Configure the heartbeat model in `openclaw.json` alongside the `gpt-mini` alias in Phase 0.

**Changes needed:**

| Section                    | Change                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cron Health Check          | Update `critical_jobs` list to reference new pipeline jobs: Morning Data Collect, Morning Planner, Evening Data Collect, Knowledge Processor, Evening Analyst |
| Cron Health Check          | Add pipeline health check: verify `/tmp/openclaw-pipeline/am/` and `pm/` directories have fresh data (modified today)                                         |
| Second Brain Gardening     | Simplify: inbox triage is now handled by Knowledge Processor (20:30 cron). Heartbeat only needs to flag if cron missed it.                                    |
| MOC Verification           | Keep as-is (still valid, handled by separate automation)                                                                                                      |
| Workspace Memory Gardening | Keep as-is                                                                                                                                                    |

**New health check to add:**

````markdown
## Pipeline Health Check (EVERY heartbeat)

Verify the morning/evening data pipeline produced fresh data with valid content:

```bash
# Check pipeline data freshness AND content validity
TODAY=$(TZ=Europe/Paris date +%F)
echo "=== Morning pipeline ==="
for f in /tmp/openclaw-pipeline/am/*.json; do
  [ -f "$f" ] || continue
  ts=$(python3 -c "import json; print(json.load(open('$f')).get('collected_at','MISSING'))" 2>/dev/null)
  status=$(python3 -c "import json; print(json.load(open('$f')).get('status','MISSING'))" 2>/dev/null)
  echo "$(basename $f): collected=$ts status=$status"
done
echo "=== Evening pipeline ==="
for f in /tmp/openclaw-pipeline/pm/*.json; do
  [ -f "$f" ] || continue
  ts=$(python3 -c "import json; print(json.load(open('$f')).get('collected_at','MISSING'))" 2>/dev/null)
  status=$(python3 -c "import json; print(json.load(open('$f')).get('status','MISSING'))" 2>/dev/null)
  echo "$(basename $f): collected=$ts status=$status"
done
echo "=== Tomorrow carry-forward ==="
ls -la /tmp/openclaw-pipeline/tomorrow.json 2>/dev/null || echo "MISSING (ok if first day)"
```
````

Alert Leonard if:

- Morning pipeline has 0 files OR all files have `status: error` after 05:15
- Evening pipeline has 0 files OR all files have `status: error` after 20:15
- Any file has `collected_at` from a previous day (stale data leak)

```

---

## Migration Path

**Core file updates are split across phases** — passive context files update early, operational files update after the pipeline is validated.

0. **Phase 0: Model routing**
   - Configure `gpt-5.4-mini` alias (`gpt-mini`) in `openclaw.json`
   - Configure heartbeat model to `gpt-5.4-mini`
   - Test routing: verify gpt-5.4-mini works for isolated agentTurn sessions
   - **Fallback gate:** if OAuth doesn't support gpt-5.4-mini, evaluate OpenRouter fallback (see Q5)
   - **Clean up:** remove exposed `OPENROUTER_API_KEY` from `env` field in existing jobs.json entries

1. **Phase 1: Scripts + early file updates**
   - Create Python data collector scripts (`morning_collect.py`, `evening_collect.py`), test manually
   - Update **USER.md** (work preferences — passive context, no job references)
   - Update **TOOLS.md** model routing section only (fix stale Sonnet/Opus refs → gpt-5.4/gpt-5.4-mini)
   - Update **PRINCIPLES.md** (add Pipeline-First Decomposition + CONTEXT.md Is Always-Current + regression)

2. **Phase 2: Morning pipeline**
   - Create Morning Data Collect + Morning Planner jobs on gpt-5.4-mini
   - Run in parallel with old Daily Note Prep for 2-3 days, compare quality
   - Swap Readwise Auto-Ingest to collector pattern on gpt-5.4-mini

3. **Phase 3: Evening pipeline**
   - Create Evening Data Collect + Knowledge Processor + Evening Analyst
   - Keep old Daily SB Routine + Knowledge Compile disabled as fallback
   - Validate: does Knowledge Processor finish before Evening Analyst starts?

4. **Phase 3.5: Operational file updates (post-validation)**
   - Update **AGENTS.md** (pipeline architecture, model routing, knowledge gardening, job references)
   - Update **HEARTBEAT.md** (new job names/UUIDs, pipeline health check, heartbeat model)
   - Update **TOOLS.md** pipeline data exchange section and cron job references

5. **Phase 4:** Merge Weekly SB Review + Weekly Kaizen into single Weekly Review, swap ByteRover to gpt-5.4-mini

6. **Phase 5:** Clean up disabled old jobs, purge one-shot reminders and disabled X/LinkedIn post jobs, monitor for 1 week

7. **Phase 6:** Delete old jobs, update memory files to reflect new architecture

## What This Is NOT

- Not a rewrite of OpenClaw core (no TypeScript changes)
- Not a change to the second-brain note format or conventions
- Not adding new external integrations — uses existing CLIs (gws, readwise, brv)
- Not changing Telegram delivery (still same bot, same chat ID, same format)
- Not changing Clawd's personality (SOUL.md, IDENTITY.md untouched)

## Review Findings Applied

This document was stress-tested by three independent reviewers (scope, feasibility, coherence). Key findings resolved:

| Finding | Source | Resolution |
|---------|--------|------------|
| OpenClaw cron has no `script` payload kind | Feasibility | Reframed collectors as trivial `agentTurn` (~200 tok overhead). 90% reduction, not 100%. |
| SOUL.md / IDENTITY.md changes unjustified | Scope | Dropped. Pipeline changes operations, not identity. |
| "Compound Over Complete" duplicates existing principle | Scope | Dropped. Already covered by "Optimize for Learning Rate." |
| Phase 1.5 ordering wrong — HEARTBEAT.md can't reference jobs that don't exist yet | Scope | Split: passive files (USER.md, TOOLS.md model routing, PRINCIPLES.md) before Phase 2; operational files (AGENTS.md, HEARTBEAT.md, TOOLS.md pipeline section) after Phase 3. |
| `/tmp` stale data risk — agents could read yesterday's data | Feasibility | Added `collected_at` timestamps + wipe-before-write in collector scripts. |
| 15-min gap between Knowledge Processor and Evening Analyst too tight | Feasibility | Widened to 45 minutes (20:30 → 21:15). Added sentinel file check. |
| `tomorrow.json` overlaps with ByteRover carry-forward | Scope | Documented: both coexist. `tomorrow.json` = structured agent handoff. `brv` = broader session knowledge. Different scopes. |
| CONTEXT.md rewrite trigger ambiguous | Coherence | Clarified: rewrite on every evening pipeline run for projects with activity today. |
| Pipeline health check doesn't catch error-status files | Coherence | Updated HEARTBEAT.md check to verify `collected_at` + `status`, not just file freshness. |
| Monthly Kaizen breaks pipeline pattern | Coherence | Justified: runs monthly, not worth a separate collector. Gathers inline. |
| Exposed OpenRouter API key in jobs.json | Feasibility | Added cleanup to Phase 0. |
| AGENTS.md model routing already stale (Sonnet/Opus) | Feasibility | Pre-existing drift; fixed as part of AGENTS.md update in Phase 3.5. |
```
