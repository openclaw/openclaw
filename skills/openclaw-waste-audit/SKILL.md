---
name: openclaw-waste-audit
description: OpenClaw recurring waste audit — run when user wants to find token waste, cron waste, burning tokens, or which job is wasting money. NOT for general openclaw operations — only for waste/cost analysis. Use this instead of openclaw-comprehensive when user asks about waste, tokens, cost, or cron jobs. Read-only.
category: openclaw
version: 1.3.0
created: 2026-05-16
owner: Hermes Curator
status: active
tags: [openclaw, cron, waste, audit, cost, token, read-only, token-save]
---

# OpenClaw Recurring Waste Audit

## Trigger

**MUST use this skill (NOT openclaw-comprehensive) when user asks about:**
- "帮我查 openclaw 里面有哪些浪费的工作" / "what openclaw jobs are wasting tokens"
- "帮我查 openclaw 有哪些浪费" / "which openclaw jobs are wasting money"
- "帮我查 waste"
- "which job is burning tokens"
- "cron 有没有问题" / "any cron waste"
- "cron waste audit"
- "token waste"
- "/audit"
- "哪些 cron 在烧钱" / "which cron jobs are burning tokens"

**DO NOT use this for:** general openclaw operations, job management, dispatch rules — use openclaw-comprehensive for those.

---

## Action

### Step 1 — Verify token burn from JSONL runs (use `usage.total_tokens`, NOT top-level `totalTokens`)

JSONL top-level `totalTokens` is always 0. Real data lives at `usage.total_tokens`:

```bash
python3 -c "
import json, glob, os
runs_dir = os.environ.get('OPENCLAW_HOME', os.path.expanduser('~/.openclaw'))
runs_dir = os.path.join(runs_dir, 'cron', 'runs')
for f in sorted(glob.glob(f'{runs_dir}/*.jsonl')):
    total = 0; count = 0
    with open(f) as fh:
        for line in fh:
            try:
                d = json.loads(line)
                total += d.get('usage',{}).get('total_tokens',0); count += 1
            except: pass
    if total > 0:
        print(f'{f.split(\"/\")[-1]}: {count} runs, {total:,} tokens')
"
```

### Step 2 — Run ClawSetup diagnostic (complementary classification + error rates)

```bash
python3 ~/.hermes/scripts/clawsetup_diagnostic.py
# or: python3 ~/.hermes/hermes-agent/scripts/clawsetup_diagnostic.py
```

Gives: token cost, error rate per job, job classification (EXEC_SCRIPT / LLM_NEEDED / UNCLEAR).

### Step 3 — Deep-dive on top candidates (summary_len, delivery rate)

For D8 candidates, check summary size pattern — tiny summaries every run = silent loop:

**Note:** Use `summary` field (persisted in run-log schema), NOT `response` which does not exist in cron run JSONL.

```bash
python3 -c "
import json, glob, os
runs_dir = os.environ.get('OPENCLAW_HOME', os.path.expanduser('~/.openclaw'))
runs_dir = os.path.join(runs_dir, 'cron', 'runs')
f = os.path.join(runs_dir, '<job_id>.jsonl')
total=0;count=0;errors=0;delivered=0;summary_lens=[]
with open(f) as fh:
    for line in fh:
        try:
            d=json.loads(line)
            total+=d.get('usage',{}).get('total_tokens',0)
            count+=1
            if d.get('error'): errors+=1
            if d.get('delivered'): delivered+=1
            summary_lens.append(len(str(d.get('summary','') or '')))
        except: pass
import statistics as s
print(f'runs={count} tokens={total:,} errors={errors} delivered={delivered}')
if summary_lens: print(f'summary_len: min={min(summary_lens)} median={s.median(summary_lens):.0f} max={max(summary_lens)}')
"
```

D8 signals:
- `summary_len` median ≤ 20 = job producing trivial summaries every time (CLEAN_LOOP pattern)
- `delivered=0` on external channel = structurally silent
- `errors < 10%` but `delivered=0` = "everything is fine" loop

### Step 4 — Verify model for EXEC_SCRIPT jobs

EXEC_SCRIPT tag is name-based — it doesn't mean "no LLM cost." A job named "Health Check" may still call LLM internally.

```bash
# Get model from jobs.json (file-based, always works)
cat ~/.openclaw/cron/jobs.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
    model=j.get('payload',{}).get('model','null')
    if model and model not in ('null','None',''):
        print(f'{j[\"name\"]}: {model}')
"

# Check recent runs (requires gateway)
openclaw-env cron runs --id <job_id> --limit 3
```

**Note:** `openclaw cron show` requires gateway auth. If you see `gateway token mismatch`, use jobs.json + JSONL runs instead.

---

## Delivery Mode Rules

| delivery.mode | Meaning | Waste? |
|---|---|---|
| `"none"` | Internal job, no external delivery | **NO — by design** |
| `"announce"` | Announces to own session only | **NO — by design** |
| external channel | Sends to Telegram, Discord, etc. | Check deliveryStatus |

Only `delivered=false` on an external channel = actual waste. Internal jobs with `mode=none` are not waste — they are designed that way.

---

## Output Format

**Concise — max 3 candidates. No raw dumps. No verbose explanations.**

Structure:
1. Top 3 waste candidates: Job ID, schedule (parsed), runs, tokens (daily estimate), error rate, delivery evidence, response length signal, waste reason, confidence, recommended fix
2. Other notable jobs (optional, brief)
3. Cost breakdown: top jobs by token burn + daily estimate + % of total
4. Fix commands — wrapped in "⚠️ read-only until approved" block

```
# OpenClaw Recurring Waste Audit

## Top 3 Waste Candidates

1. [D8 - CLEAN_LOOP] <Job Name>
   - Job ID: <id>
   - Schedule: <cron_expr> (every N hours/days)
   - Runs: <N> | Tokens: <N>
   - Error rate: <Y>%
   - Delivery: delivered=<N> — <typical_summary>
   - Summary: median_len=<N> chars (<typical_summary_excerpt>)
   - Waste reason: <why it's burning tokens — be specific, name the pattern>
   - Confidence: High/Medium/Low
   - **Recommended fix:** <specific actionable fix>

2. ...

3. ...

## Cost Breakdown

<top job by tokens>
• Job: <name>
• Tokens: <N>
• Daily Est.: ~<N> tokens/day

...

Total tracked: <N>M tokens (~<N> jobs)

---

⚠️ **Read-only until approved.** Run the fix commands below only after you confirm.

**Fix commands (run only after BG approval):**
```bash
# Job 1 — reduce hourly → every 6 hours
openclaw-env cron edit <job_id> --cron "0 */6 * * *"

# Job 2 — reduce to once daily
openclaw-env cron edit <job_id> --cron "0 8 * * *"

# Job 3 — disable (not needed)
openclaw-env cron disable <job_id>
```

**⚠️ CLI pitfall: use `--cron`, NOT `--schedule`.** The `openclaw-env cron edit` command uses `--cron <expr>` for cron expressions. Using `--schedule` will error with `unknown option '--schedule'`.

---

## Schedule Parsing Reference

| schedule.kind | schedule.expr / everyMs | Actual frequency |
|---|---|---|
| `cron` | `"0 */3 * * *"` | every 3 hours |
| `cron` | `"0 */6 * * *"` | every 6 hours |
| `cron` | `"0 3 * * *"` | once daily at 3am |
| `cron` | `"*/15 * * * *"` | every 15 minutes |
| `cron` | `"0 * * * *"` | once per hour (整点) |
| `every` | `everyMs: 180000` | every 3 minutes |
| `every` | `everyMs: 45000` | every 45 seconds |
| `at` | one-time scheduled | not recurring |

Rule: `everyMs < 60000` = high frequency. `cron expr` with `*/N` = every N minutes.

---

## Pattern Classification (D1-D9)

| Rule | Condition | Signal |
|---|---|---|
| D1 | Error rate ≥ 80% | Failure loop |
| D3 | Premium model (5x+ ref) + simple task | Over-paying for check job |
| D4 | Agent-turn + schedule < 60min | LLM agent on cron work |
| D6 | totalRuns > 0 but totalTokens = 0 | Token counting failed |
| D8 | totalRuns ≥ 50 + delivered=false + status=ok + **has LLM model** | Chronic "everything is fine" loop (CLEAN_LOOP) — **only for LLM jobs; pure EXEC_SCRIPT/batch jobs excluded** |
| D9 | Schedule < 30min + error rate < 20% | Over-scheduled check job |
| D2 | Burst: 3+ jobs, $50+ in 60min window | Concentrated spending spike |
| D7 | Duplicate model + schedule + task | Redundant billing |

---

## Safety Rules

**FORBIDDEN before approval:**
- `openclaw cron run / disable / edit / delete`
- `openclaw-env cron run / disable / edit / delete`

**Only read-only:**
```bash
openclaw-env cron show <job_id>
openclaw-env cron runs --id <job_id> --limit 5
cat ~/.openclaw/cron/jobs.json | python3 -m json.tool | grep -A5 '<job_name>'
```

---

## Workflow

1. Run JSONL token burn query → get per-job totals from `usage.total_tokens`
2. Run ClawSetup diagnostic → classification + error rates
3. Deep-dive top candidates: response_len + delivery rate
4. Verify model for EXEC_SCRIPT jobs
5. Generate fix recommendation for each top candidate (see Fix Suggestion Rules below)
6. Present top 3 + cost breakdown + fix commands

---

## Fix Suggestion Rules

For each candidate, suggest the most impactful fix based on the rule. Be specific — not generic:

| Rule | Primary Fix |
|---|---|
| D1 (failure loop) | `openclaw-env cron disable <id>` — 80%+ error rate; disable until root cause is fixed |
| D3 (premium model) | `openclaw-env cron edit <id> --model MiniMax-M2.5` — switch to cheaper model |
| D4 (agent cron) | `openclaw-env cron edit <id> --cron "0 3 * * *"` — reduce to daily |
| D6 (zero tokens) | Investigate — not a direct waste issue; may be counting bug or job is broken |
| D8 (silent loop) | If job has value: reduce frequency. If redundant: `openclaw-env cron disable <id>` |
| D9 (over-scheduled) | `openclaw-env cron edit <id> --cron "*/30 * * * *"` — halve frequency |

Be specific in the recommended fix — e.g., "reduce from hourly to every 6 hours" not just "reduce frequency." Include actual cron expression in the fix command.

Only suggest commands that have been verified to exist for this OpenClaw version. If `edit` is unavailable, say "contact admin to manually adjust schedule in jobs.json."

**ALWAYS wrap fix commands in a "⚠️ read-only until approved" block. Never auto-execute.**

---

## Related Skills

- `openclaw` — OpenClaw cron/job management reference
- `hermes-infrastructure` — Hermes system operations