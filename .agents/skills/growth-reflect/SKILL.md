---
name: growth-reflect
description: Run a structured growth reflection for a workspace agent. Reads recent
  memory files, distills learnings into bank/, updates GROWTH_LOG.md and MEMORY.md,
  and optionally promotes lessons to SOUL.md. Use for weekly review or on-demand
  reflection.
license: MIT
metadata:
  author: openclaw
  version: "1.0"
---

# Growth Reflect

Perform a structured knowledge distillation for a workspace agent. Reads the last
N days of memory, identifies patterns, updates persistent knowledge stores, and
returns a concise summary.

## When to Use

- **Weekly heartbeat** — triggered by HEARTBEAT.md on Monday
- **Manual** — user says "run growth reflect" or "做週度反思"
- **On milestone** — after completing a large project or learning something significant

## Inputs

Ask if not obvious from context:
- **Period:** how many days to review? (default: 7)
- **Mode:** `weekly` (full review) or `quick` (GROWTH_LOG + bank only, skip MEMORY.md restructure)

## Execution

### Step 1 — Read

Load the following in order. Stop if a file doesn't exist (don't error).

```
1. GROWTH_LOG.md           — recent errors/learnings to continue tracking
2. bank/world.md           — current world model
3. bank/experience.md      — recent activity log
4. bank/opinions.md        — current opinions and confidence levels
5. MEMORY.md               — current long-term memory
6. memory/YYYY-MM-DD.md    — last N days (N = period, default 7)
```

### Step 2 — Identify Themes

Answer mentally before writing anything:

- What topics or tasks appeared repeatedly this period?
- Were there decisions made? What drove them?
- Were there mistakes, friction points, or surprises?
- Did any of the human's preferences or behaviors become clearer?
- Did any previously-held opinions weaken or strengthen?

### Step 3 — Update bank/

For each insight from Step 2, route it to the right file:

| Insight type | Target |
|---|---|
| Confirmed fact about tools, environment, preferences | `bank/world.md` |
| Activity worth remembering (project done, skill learned) | `bank/experience.md` |
| Opinion formed or confidence updated | `bank/opinions.md` |
| New person/project becoming recurring | `bank/entities/<slug>.md` |

**Write concisely.** bank/ is structured knowledge, not a dump. One good sentence > three mediocre ones.

### Step 4 — Update GROWTH_LOG.md

For each error or lesson from the period:

```markdown
## YYYY-MM-DD — [title]
- Mistake: [what happened]
- Root cause: [why]
- Correction: [what to do differently]
- Updated: [which file was changed, if any]
```

If an error has appeared before, note it as a pattern: `(recurring — 2nd time)`.

### Step 5 — Update MEMORY.md (weekly mode only)

Rules:
- **Add:** cross-day insights worth keeping for months
- **Skip:** single events, details findable in memory/ logs
- **Remove:** entries older than 90 days that haven't been referenced
- **Target length:** 300–800 words (enforce this — prune if over)

### Step 6 — Promote to SOUL.md (if warranted)

A lesson graduates to SOUL.md when:
- It corrects a repeated mistake (appeared 2+ times in GROWTH_LOG)
- It describes a permanent preference or constraint
- The human explicitly said "remember this always" or equivalent

When promoting, add to the relevant section of SOUL.md and note in GROWTH_LOG:
```
- Promoted to SOUL.md: "[rule]"
```

### Step 7 — Return Summary

Reply with a structured summary (≤ 120 words):

```
成長反思完成（YYYY-MM-DD，過去 N 天）

bank/ 更新：
- world.md: [N 條新增/更新]
- experience.md: [N 條]
- opinions.md: [N 條]
- entities/: [N 個頁面]

GROWTH_LOG.md: [N 條新記錄，M 個重複模式]
MEMORY.md: [新增 N / 刪除 M 條]（weekly mode 時才顯示）
SOUL.md: [若有升級，說明；否則省略此行]

下週關注：[一句話]
```

## Safety

- Only writes to workspace files (`bank/`, `GROWTH_LOG.md`, `MEMORY.md`, `SOUL.md`)
- Never sends messages externally
- Never modifies repo code or other agents' files
- If `SOUL.md` changes are significant, summarize them explicitly so the human can review

## Notes

- In quick mode, skip Step 5 (MEMORY.md restructure) — only update bank/ and GROWTH_LOG
- If the period is > 30 days, consider spawning a subagent for Step 1–2 to avoid token burn
- The summary should be delivered to the **main channel** (not just HEARTBEAT_OK)
