---
name: the-loop
description: "Autonomous development protocol: from idea to working code. Use when Vlad gives a coding task, feature request, or project to build. Implements THE LOOP — Molt as architect/supervisor, Anthropic harness as conveyor, Claude Code as executor. Covers: task intake, feature planning, incremental development, 3-checkpoint doubt protocol, independent verification, learnings, and progress streaming."
---

# THE LOOP — Autonomous Development Protocol

## Architecture

```
Vlad (brain) → Molt (architect/supervisor) → Harness (conveyor) → Claude Code (hands)
```

Molt handles planning, doubt, and oversight. The harness runs Claude Code in a loop — one feature at a time. Claude Code writes code.

## When to Use

Trigger: any coding task, feature request, bug fix, or project build from Vlad.

## Protocol

### Phase 0: Task Intake

1. Vlad describes task (text/voice)
2. Ask clarifying questions (batch, not one-by-one):
   - Stack? (language, frameworks)
   - How should it look? (UI, behavior)
   - What exactly should work? (features)
   - Priorities? Dependencies?
   - What NOT to do?
3. Vlad answers
4. Confirm understanding

### Phase 1: Planning

1. `memory_search` for project learnings
2. Read current code and architecture
3. Create `feature-list.json`:
   ```json
   [
     {
       "id": 1,
       "description": "What to build",
       "steps": ["step 1", "step 2"],
       "passes": false
     }
   ]
   ```
4. Order: simple → complex, respect dependencies
5. **🔴 CHECKPOINT 1 — Pre-start doubt:**
   - "Is this what Vlad asked, or did I add something?"
   - "Learnings warn about any risks?"
   - "Plan complete? Nothing missing?"
6. Show plan to Vlad → wait for approval

### Phase 2: Iterative Development

For each feature in feature-list.json:

**A. Compose prompt for Claude Code**
Use template from `references/prompt-template.md`. Always include:
- Project context
- Single feature task
- Files to read / edit / NOT touch
- Constraints and style
- Learnings from past mistakes
- "Do ONLY what is described. Do not add features not in the plan."

**B. Launch Claude Code**

First run (initializer):
- Fill `references/initializer-prompt.md` placeholders
- `exec: claude -p "<filled prompt>" --dangerously-skip-permissions` (pty, background, workdir)

Subsequent runs (coding):
- Fill `references/coding-prompt.md` placeholders
- Same exec pattern
- Repeat until all features `passes: true`

**C. Supervise**
- `process:log` every 30s
- Stream progress to Vlad
- Correct if going wrong
- Respond to agent requests (`process submit`)
- When session ends, check feature_list.json progress
- If features remain → launch next coding session automatically

**D. Browser verification (web apps)**
- Claude Code has Playwright MCP — can navigate, click, type, screenshot
- Verify features end-to-end through actual UI
- Take screenshots as proof

**E. 🔴 CHECKPOINT 2 — Post-action doubt:**
- `git diff` — matches plan?
- Grep stubs: `TODO`, `pass`, `NotImplemented`, `placeholder`, `...`
- No changes outside scope?
- "Was this asked, or did Claude Code improvise?"
- Run project tests

**F. 🔴 CHECKPOINT 3 — Independent verification:**
- Spawn subagent via `sessions_spawn`:
  ```
  task: "You are a code reviewer. Check this code.
    Feature: [description from feature-list]
    Diff: [git diff output]
    Does it work? Bugs? Stubs? Matches requirements?"
  ```
- Subagent has fresh context — no bias
- If problem found → fix → repeat checkpoint 2-3

**G. Commit & Document**
- `git commit` with descriptive message
- Set `feature.passes = true` in feature-list.json
- Update progress.md
- Stream result to Vlad

**H. Reflect**
- If error occurred → write to `memory/learnings/{project}.md`:
  ```
  ### What: description
  ### Why: root cause
  ### Fix: what to do instead
  ### Date: YYYY-MM-DD
  ```
- Next feature

### Phase 3: Finalization

1. All features `passes: true`?
2. Full end-to-end run
3. Final code review (grep for junk, stubs)
4. Project learnings update
5. Report to Vlad: what was done, what we learned, what to improve

## Key Rules

1. **One feature at a time** — never one-shot
2. **Doubt at every step** — 3 checkpoints, never 100% sure
3. **Scope discipline** — do ONLY what was asked
4. **JSON feature list** — not Markdown (AI breaks Markdown more)
5. **Git = safety net** — commit every change, revert if needed
6. **Stream everything** — Vlad sees every step
7. **Learnings injection** — always include past mistakes in prompts

## References

- `references/initializer-prompt.md` — prompt for first session (setup + feature list)
- `references/coding-prompt.md` — prompt for each coding session (one feature at a time)
- `references/prompt-template.md` — general structured prompt template
- `references/feature-list-example.json` — example feature list
- See also: `notes/resources/AUTONOMOUS-AGENT-RESEARCH.md` for full industry research
- Based on: [Anthropic's autonomous-coding harness](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding)
