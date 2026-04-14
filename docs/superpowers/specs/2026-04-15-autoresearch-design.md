# Autoresearch Skill — Design Spec

**Date:** 2026-04-15
**Status:** Design approved, awaiting implementation plan
**Location (target):** `C:\AI\openclaw\skills\autoresearch\`

---

## 1. Purpose & Scope

An autonomous self-improvement loop for OpenClaw, modeled on Karpathy's `program.md + editable target + locked evaluate.js` pattern. Runs in a single 10:30 AM – 12:00 PM window when a Claude Code session starts.

**v1 target:** skill-description trigger accuracy (55 OpenClaw skills at `C:\AI\openclaw\skills\`). The loop edits only the `description` field of each skill's frontmatter.

**Not in v1 (deferred upgrade paths):**
- Voice agent system prompts (requires LLM-as-judge eval — build after v1 proves reward hacking is controllable)
- MC page-load perf (requires Lighthouse + build sandboxing)
- Real conversation mining for eval set (replaces synthetic pairs at volume)
- Per-client autoresearch (B2B Supreme Package differentiator)

**Success criteria for v1 (after 5-day trial):**
- Loop runs end-to-end without human intervention during the morning window
- Produces daily PDF report with diffs + score deltas, auto-opens
- ≥10% routing-F1 improvement on ≥5 of the 10 pool skills over 5 days
- Zero commits to main without explicit approval
- Total API spend ≤ $4/day

**Relationship to existing systems:**
- **Dreaming system** (Phase 1 shipped 2026-04-06): optimizes memories via heuristic scoring. Autoresearch optimizes skills via LLM-routed eval. Different organs of the same "self-maintaining OpenClaw" body. No conflict.

---

## 2. Architecture & Data Flow

```
10:30 AM — OnSessionStart hook fires
  │
  ├─▶ Check panic file (~/.autoresearch/STOP) — exists? → exit silently
  ├─▶ Check time window (10:30–12:00) — outside? → exit silently
  ├─▶ Check "already ran today" lock — yes? → exit silently
  │
  ▼
Bootstrap (first run only — gated by presence of `bootstrap-complete.flag`)
  ├─▶ Generate eval-set.json (Opus, 1,100 pairs: 10+ / 10− per skill) — ~$8-12 one-time
  ├─▶ Score all 55 skills → rank → pool.json = 10 worst
  ├─▶ Touch `bootstrap-complete.flag` so subsequent runs skip this phase
  │
  ▼
Create branch autoresearch/YYYY-MM-DD (refuse if prior autoresearch branch has uncommitted work)
  │
  ▼
Phase 1 — Max OAuth (via Claude Code Task tool)
  ├─▶ 15 Opus experiments + 5 Sonnet experiments
  ├─▶ Per experiment: propose → validate → apply → eval → commit or reset
  ├─▶ 7 stalls per skill → rotate to next
  ├─▶ Exit on: 20 experiments done, pool exhausted, or 11:30 AM
  │
  ▼
Phase 2 — API (Sonnet via ANTHROPIC_API_KEY, $4 cap)
  ├─▶ Continues on same branch, same pool minus exhausted
  ├─▶ Budget tracker: tokens × Sonnet pricing ($3/M in, $15/M out)
  ├─▶ Exit on: $4 cap, pool exhausted, or 12:00 PM
  │
  ▼
Graduation check — any skill crossing 95% P+R? → remove from pool, backfill from next-worst
  │
  ▼
Generate report
  ├─▶ reports/YYYY-MM-DD-report.md
  ├─▶ reports/YYYY-MM-DD-report.pdf (msedge --headless --print-to-pdf)
  ├─▶ Append one line to autoresearch-log.md
  │
  ▼
Spawn approval webserver (localhost:9876, 2hr TTL)
  │
  ▼
`start reports/YYYY-MM-DD-report.pdf` — auto-opens in default viewer
  │
  ▼
User clicks APPROVE → squash-merges branch to main → webserver exits
User clicks REJECT  → deletes branch → webserver exits
No click in 2hr → webserver dies, branch sits for CLI fallback
```

**Key files:**

| File | Purpose | Mutable by loop? |
|---|---|---|
| `SKILL.md` | Skill definition + OpenClaw metadata | No (static) |
| `program.md` | Plain-English goal | No (human-edited) |
| `evaluate.js` | Locked scorer, returns scalar | **No — locked** |
| `eval-set.json` | 1,100 synthetic pairs, regenerated monthly | Regeneration only |
| `pool.json` | Current 10 target skills, status | Updated at run end |
| `loop.js` | Experiment runner | No (code) |
| `hooks/autoresearch-morning.ts` | OnSessionStart hook | No (code) |
| `reports/YYYY-MM-DD-report.{md,pdf}` | Daily reports | Written once per run |
| `reports/YYYY-MM-DD-experiments.jsonl` | Raw per-experiment log | Append-only |
| `autoresearch-log.md` | One-line-per-day rolling log | Append-only |

**State durability:** All persistent state lives in git. No external DB. Laptop wipe → clone repo → system restored.

**Failure isolation:**
- Phase 2 failure does not undo Phase 1 commits
- Mid-experiment crash: `git reset --hard HEAD` handles the uncommitted edit
- Webserver crash: branch still exists, CLI fallback available

---

## 3. The Eval Harness — `evaluate.js`

**The most critical file.** Locked during runs. Buggy eval → loop optimizes garbage. Slow eval → budget exhausted before progress.

### Contract

- **Input:** State of `C:\AI\openclaw\skills\*/SKILL.md` (reads `frontmatter.description` of each)
- **Output:** Single JSON object to stdout: `{global_f1, per_skill: {...}, total_cost_usd, duration_ms}`
- **Exit code:** 0 = success, non-zero = crash (treated as failed experiment, reverted)

### Scoring algorithm

For each `{user_message, correct_skill}` pair in `eval-set.json`:
1. Build prompt: *"Given these 55 skills and their descriptions: [...]. Which skill should handle this message: '{user_message}'? Respond with only the skill name, or 'none' if no skill fits."*
2. Call **Haiku** (the router).
3. Compare predicted vs. correct.

Aggregate:
- Per-skill precision, recall, F1
- Global F1 = macro-average across all skills

### Why Haiku is the router, not Opus

- Haiku: ~$0.0005/call. Full eval (1,100 pairs): ~$0.55.
- Opus: ~$0.015/call. Full eval: ~$16.50. Per-experiment Opus eval = ~$330/day, blows budget 80×.
- **Descriptions robust enough for Haiku will also route correctly on Opus.** Tuning for the weaker model produces universally robust descriptions.

### Opus sanity-check pass (end of run only)

After all experiments, re-score *edited* skills once using Opus. Report both scores side-by-side in PDF:

> `gog: Haiku F1 0.87 → 0.94 (+0.07) ✓ Opus confirms: 0.91 → 0.96 (+0.05)`

Sharp disagreement (e.g., Haiku says +0.07 but Opus says −0.03) → **🚩 POSSIBLE REWARD HACK** flag in report.

### Performance

- **Concurrency:** 20 parallel Haiku calls (respect rate limits) → full eval ~90 sec
- **Caching:** Results cached by SHA256 of concatenated skill descriptions. Unchanged state → instant cached return.
- **Target:** 20 experiments/morning = ~30 min wall clock, fits 90-min window.

### Reward-hack tripwires

All reported as warnings, not hard rejections — user decides at approval:
1. **Length sanity:** <50 chars or >500 chars → reject at edit time (no eval run spent)
2. **Keyword stuffing:** same word ≥5 times → flag in report
3. **Semantic drift:** cosine similarity (old vs new description embeddings) < 0.5 → flag as rewrite-not-refine

### Internal structure

```
evaluate.js
├─ loadEvalSet()
├─ loadCurrentSkills()           — reads all 55 SKILL.md, extracts descriptions
├─ routeMessage(msg, skills, model)  — Haiku or Opus API call
├─ scorePair(pair, prediction)
├─ computeMetrics(results)       — per-skill + global F1
├─ checkTripwires(skill, oldDesc, newDesc)
├─ cacheKey(skills)              — SHA256
└─ main()                        — returns JSON to stdout
```

---

## 4. The Experiment Loop — `loop.js`

### Single experiment cycle (applies to Phase 1 and Phase 2)

1. **Pick target skill** — round-robin through non-exhausted pool (avoid grinding one skill before trying others)
2. **Snapshot baseline** — load cached F1 for this skill
3. **Spawn hypothesis subagent** — input: current description, worst recent misroutes for this skill, reward-hack rules. Output: new description only.
4. **Validate proposal** — length floor/ceiling, stuffing, drift. Trip? Reject without eval, **don't** count against stall budget (bad proposal, not a bad experiment).
5. **Apply edit** — write new description into SKILL.md frontmatter
6. **Run eval** — `node evaluate.js` → new F1
7. **Decide:**
   - new > old → `git commit -m "autoresearch: {skill} +{delta}"`, reset stall counter
   - new ≤ old → `git reset --hard HEAD`, stall++
8. **Stall check** — stall ≥ 7 for this skill → mark `exhausted: true`
9. **Budget check (Phase 2 only):** cumulative $ ≥ $4 → exit
10. **Time check:** clock ≥ phase deadline → exit
11. **Next experiment**

### Phase 1 vs Phase 2

Same algorithm, different runtime.

**Phase 1 — Max OAuth (via Claude Code Task tool):**
- 15 Opus + 5 Sonnet experiments via Claude Code's Task tool (hypothesis subagent spawning)
- Cost tracking: read usage JSON post-run for telemetry only (Max is flat-rate)
- Exit: 20 experiments, pool exhausted, or 11:30 AM (30-min buffer for Phase 2)

**Phase 2 — API (Sonnet, $4 cap):**
- Hypothesis calls direct via `@anthropic-ai/sdk` using `ANTHROPIC_API_KEY` from `~/.openclaw/.env` (per `secrets-index.md`)
- Hard $ cap enforced by token accounting — costed at **full non-cached input price ($3/M in, $15/M out)** even if cache hits occur. Conservative under-spend is preferred over over-spend.
- Exit: $4 cap, pool exhausted, or 12:00 PM

### Git branch management

- Branch: `autoresearch/YYYY-MM-DD`
- Start: `git checkout -b autoresearch/YYYY-MM-DD` from main. Refuse if prior autoresearch branch has uncommitted work.
- During run: `git reset --hard HEAD` only affects uncommitted edit — prior winning commits preserved
- Approval: `git checkout main && git merge --squash <branch> && git commit -m "autoresearch YYYY-MM-DD: N wins"`
- Rejection: `git branch -D <branch>`

### Misroute-aware hypothesis generation

After pre-run eval, loop extracts each pool skill's worst misroutes:

```json
{
  "skill": "gog",
  "worst_misroutes": [
    { "message": "check my inbox for receipts", "predicted": "himalaya", "expected": "gog" },
    { "message": "send an email to Sarah", "predicted": "apple-notes", "expected": "gog" }
  ]
}
```

Passed into hypothesis subagent prompt. **Agent is told exactly which cases the current description fails on.** This is what makes the loop converge in 5-15 experiments per skill instead of 100+.

### Concurrency

**Sequential experiments, not parallel.** Parallel git ops corrupt the branch. Parallel eval.js hammers rate limits. Sequential is simpler, fewer v1 bugs.

### Logging

One JSONL line per experiment to `reports/YYYY-MM-DD-experiments.jsonl`:

```json
{"exp": 7, "skill": "gog", "model": "opus", "old_f1": 0.87, "new_f1": 0.91, "delta": 0.04, "outcome": "commit", "cost_usd": 0.00, "tokens": {...}, "timestamp": "..."}
```

This file is the sole data source for the report generator.

### Internal structure

```
loop.js
├─ checkPreconditions()          — panic file, time window, already-ran-today
├─ createBranch()                 — git checkout -b, uncleanness refusal
├─ loadPool()                     — filter exhausted/graduated
├─ runPhase(phase, budget)        — main experiment loop, returns stats
├─ proposeEdit(skill, misroutes, model)   — spawns hypothesis subagent
├─ applyEdit(skill, newDesc)      — writes frontmatter description
├─ runEval()                      — spawns evaluate.js, parses stdout JSON
├─ decideKeep(oldScore, newScore) — git commit or reset
├─ updatePool(results)            — exhaustion, graduation, backfill
├─ generateReport(jsonl)          — md + PDF
├─ spawnWebserver(branch)         — localhost:9876, 2hr TTL
└─ main()                         — Phase 1 → Phase 2 → report → server
```

---

## 5. Approval Mechanism

### Primary: link-button PDF

The PDF auto-opens when the loop finishes. Top of page 1 shows two large links:

- **✅ APPROVE** → `http://localhost:9876/approve?date=YYYY-MM-DD`
- **❌ REJECT** → `http://localhost:9876/reject?date=YYYY-MM-DD`

A local Node webserver (spawned by loop.js, TTL 2 hours) listens on `127.0.0.1:9876` (loopback-only — not bound to network interfaces). Each run generates a random 16-char token (`?token=...` in both URLs); requests without matching token return 403. Origin header check rejects requests not from `localhost`/`127.0.0.1`/`file://`. Prevents rogue local processes or network-based attackers from triggering approve/reject without the user's PDF.

- Click APPROVE → squash-merges branch to main, writes "approved" to log line, exits
- Click REJECT → deletes branch, writes "rejected" to log line, exits
- No click in 2 hours → server dies, branch stays on disk

### Fallback CLI (for later-day decisions)

- `/autoresearch-approve YYYY-MM-DD`
- `/autoresearch-reject YYYY-MM-DD`

Works against any untouched autoresearch branch regardless of webserver state.

### Safety rails

1. **Hard $ cap:** $4 API spend → Phase 2 exits
2. **Hard time cap:** 12:00 PM → whole loop exits
3. **Per-skill stall cap:** 7 consecutive no-improvement experiments → mark skill exhausted, rotate
4. **Full-pool stall:** all 10 skills exhausted → loop exits
5. **Regression guard:** single experiment drops score >10% → pause that skill for rest of run
6. **Git safety:** dedicated `autoresearch/YYYY-MM-DD` branch; refuse to start if prior branch has uncommitted work
7. **Description length ceiling:** reject proposals >500 chars
8. **Description length floor:** reject proposals <50 chars
9. **Panic file:** `~/.autoresearch/STOP` exists → loop refuses to start

---

## 6. Testing Strategy

### Unit tests (run on every commit)

- `evaluate.js`: scoring math (P/R/F1), cache key determinism, tripwire detectors
- `loop.js`: decide-keep logic (+0.01 → commit, 0.00 → reset), pool management (exhaust/graduate/backfill), budget tracker ($ math matches Anthropic pricing)
- Report generator: given fake experiments.jsonl, produces well-formed markdown

### Integration test (one-time, pre-first-day)

- Seed eval-set.json with 10 fake pairs
- Run loop.js against a `/tmp` fork of skills dir
- Verify: branch created, experiments recorded, commits on wins, PDF generated, webserver responds to both endpoints

### Artifact test (SKILL.md)

- Frontmatter parses
- Description triggers on expected phrases ("optimize skills overnight", "tune skill descriptions", "autoresearch")
- Doesn't false-trigger on unrelated ("research topic X", "search for Y")

### What's deliberately NOT tested

LLM output quality. The eval set *is* the test. F1 improves → works.

---

## 7. Rollout & 5-Day Trial

### Day 0 — Build session

1. TDD: unit tests fail first
2. Write `evaluate.js` to pass
3. Write `loop.js` to pass
4. Write hook, report generator, approval webserver
5. Manual integration test in `/tmp`
6. Generate `eval-set.json` via Opus (1,100 synthetic pairs)
7. Baseline eval → populate `pool.json` with 10 worst skills
8. Commit all, create `~/.autoresearch/` directory
9. Register SKILL.md metadata + OnSessionStart hook

### Days 1-5 — Trial

- 10:30 AM: open laptop + Claude Code, walk dog
- Return: PDF auto-opens, 2 min review, click APPROVE or REJECT
- One line added to `autoresearch-log.md` per day

### Day 6 — Evaluation Report (I produce for user)

- Total experiments (Phase 1 + Phase 2)
- Tokens burned: Max subscription split (Opus vs Sonnet) + API $ spent
- Per-skill baseline → day-5 F1 deltas
- Approval rate (% days approved vs rejected)
- Reward-hack flags (count + review of each)
- Skills graduated (crossed 95% P+R)
- Projection for scaling (e.g., 30 experiments/morning cost profile)
- Recommended tuning

### v1 → v2 promotion gates

Pass all four:
- ≥3 of 5 days produced approvable results
- ≥5 of 10 pool skills showed ≥10% F1 improvement
- Zero unauthorized merges to main
- 5-day spend ≤ $20 API + within normal Max limits

If pass → v2 adds voice-agent-prompts as second target, grows eval set to mined-conversation-pairs.
If fail → post-mortem. Likely causes: weak synthetic eval, insufficient tripwires.

### Observability — health signals

- Healthy: PDF appears each used morning, log file gets fresh entry
- Warning: 🚩 reward hack flag in PDF
- Warning: Phase 2 exits at $4 without completing pool (experiments too expensive — tune down count or switch model)
- Warning: all 10 skills exhausted (eval set or hypothesis generator stuck — regenerate eval set)

---

## 8. File Layout

```
C:\AI\openclaw\skills\autoresearch\
  SKILL.md                   # skill definition + OpenClaw metadata
  program.md                 # plain-English goal
  evaluate.js                # LOCKED scorer
  eval-set.json              # 1,100 synthetic pairs
  pool.json                  # current target skills + status
  loop.js                    # main experiment runner
  hooks\
    autoresearch-morning.ts  # OnSessionStart hook
  reports\
    YYYY-MM-DD-report.md
    YYYY-MM-DD-report.pdf
    YYYY-MM-DD-experiments.jsonl
  autoresearch-log.md        # rolling one-line-per-day summary
  tests\
    evaluate.test.js
    loop.test.js
    report.test.js
    skill-artifact.test.js

~/.autoresearch\
  STOP                       # panic file (user-created, halts loop)
  .ran-today                 # per-date marker to prevent duplicate runs
```

---

## 9. Open Decisions

All brainstorm questions resolved. Pending Codex adversarial review (in progress at time of spec write — findings to be folded in via revision pass before implementation starts).

## 10. Deferred / Future Work

- Voice agent system prompts (needs LLM-as-judge eval)
- MC page-load perf (needs Lighthouse sandbox)
- Real-conversation eval mining (replace synthetic when volume justifies)
- Per-client autoresearch pools (B2B Supreme Package)
- Monthly `eval-set.json` regeneration cadence (automated via cron?)
