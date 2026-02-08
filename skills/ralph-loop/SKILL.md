---
name: ralph-loop
description: Generate copy-paste bash scripts for Ralph Wiggum/AI agent loops (Codex, Claude Code, OpenCode, Goose). Use when asked for a “Ralph loop”, “Ralph Wiggum loop”, or an AI loop to plan/build code via PROMPT.md + AGENTS.md, SPECS, and IMPLEMENTATION_PLAN.md, including PLANNING vs BUILDING modes, backpressure, sandboxing, and completion conditions.
---

# Ralph Loop

## Overview
Generate a ready-to-run bash script that runs an AI coding CLI in a loop. Align with the Ralph playbook flow:

1) **Define requirements** → JTBD → topics of concern → `specs/*.md`
2) **PLANNING loop** → create/update `IMPLEMENTATION_PLAN.md` (no implementation)
3) **BUILDING loop** → implement tasks, run tests (backpressure), update plan, commit

The loop persists context via `PROMPT.md` + `AGENTS.md` (loaded every iteration) plus the on-disk plan/specs.

## Workflow

### 1) Collect inputs (ask if missing)
- **Goal / JTBD** (what outcome is needed)
- CLI (`codex`, `claude-code`, `opencode`, `goose`, other)
- **Mode**: `PLANNING`, `BUILDING`, or `BOTH`
- **Completion condition**
  - Promise phrase (string to detect), **or**
  - Test/command to run each iteration, **or**
  - Plan sentinel (e.g., a line `STATUS: COMPLETE` in `IMPLEMENTATION_PLAN.md`)
- Max iterations
- Sandbox choice (`none` | `docker` | other) + **security posture**
- **Backpressure commands** (tests/lints/build) to embed in `AGENTS.md`
- **Auto‑approve flags** (ask explicitly)
  - Codex: `--full-auto`
  - Claude Code: `--dangerously-skip-permissions`

### 2) Phase 1 — Requirements → specs
If the user wants “full Ralph” (or unclear requirements), do this before the loop:
- Break the JTBD into **topics of concern** (1 topic = 1 spec file).
- For each topic, draft `specs/<topic>.md`.
- Use subagents to load URLs or existing docs into context for spec quality.
- Keep specs short and testable.

### 3) Phase 2/3 — PROMPT.md + AGENTS.md
- **Context loaded each iteration:** `PROMPT.md` + `AGENTS.md`.
- `AGENTS.md` should include:
  - project test commands (backpressure)
  - build/run instructions
  - any operational learnings
- `PROMPT.md` should reference:
  - `specs/*.md`
  - `IMPLEMENTATION_PLAN.md`
  - any relevant project files/dirs

### 4) Two prompt templates (PLANNING vs BUILDING)
Create **two prompts** and swap `PROMPT.md` based on mode.

**PLANNING prompt (no implementation):**
```
You are running a Ralph PLANNING loop for: <JTBD/GOAL>.

Read specs/* and the current codebase. Do a gap analysis and update IMPLEMENTATION_PLAN.md only.
Rules:
- Do NOT implement.
- Do NOT commit.
- Prioritize tasks and keep plan concise.
- If requirements are unclear, write clarifying questions into the plan.

Completion:
If the plan is complete, add line: STATUS: COMPLETE
```

**BUILDING prompt:**
```
You are running a Ralph BUILDING loop for: <JTBD/GOAL>.

Context:
- specs/*
- IMPLEMENTATION_PLAN.md
- AGENTS.md (tests/backpressure)

Tasks:
1) Pick the most important task from IMPLEMENTATION_PLAN.md.
2) Investigate relevant code (don’t assume missing).
3) Implement.
4) Run the backpressure commands from AGENTS.md.
5) Update IMPLEMENTATION_PLAN.md (mark done + notes).
6) Update AGENTS.md if you learned new operational details.
7) Commit with a clear message.

Completion:
If all tasks are done, add line: STATUS: COMPLETE
```

### 5) Build the per‑iteration command
- Codex: `codex exec <FLAGS> "$(cat PROMPT.md)"`
  - Requires git repo.
- Claude Code: `claude <FLAGS> "$(cat PROMPT.md)"`
- OpenCode: `opencode run "$(cat PROMPT.md)"`
- Goose: `goose run "$(cat PROMPT.md)"` (ask if they want the Goose recipe)

If the CLI is unknown, ask for the exact command to run each iteration.

### 6) Output a copy‑paste script
Provide **either** a minimal loop or a controlled loop with max iters + stop conditions.

**Minimal loop (Geoff style):**
```bash
while :; do cat PROMPT.md | claude ; done
```

**Controlled loop (recommended):**
```bash
#!/usr/bin/env bash
set -euo pipefail

PROMISE='...'
MAX_ITERS=...
CLI_FLAGS="..."  # optional
PLAN_SENTINEL='STATUS: COMPLETE'
TEST_CMD='...'   # optional

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "❌ Run this inside a git repo."
  exit 1
fi

touch PROMPT.md AGENTS.md IMPLEMENTATION_PLAN.md
LOG_FILE=".ralph/ralph.log"
mkdir -p .ralph

CLI_CMD="..." # e.g. "codex exec" or "claude"

for i in $(seq 1 "$MAX_ITERS"); do
  echo -e "\n=== Ralph iteration $i/$MAX_ITERS ===" | tee -a "$LOG_FILE"

  $CLI_CMD $CLI_FLAGS "$(cat PROMPT.md)" | tee -a "$LOG_FILE"

  if [[ -n "${TEST_CMD}" ]]; then
    echo "Running tests: $TEST_CMD" | tee -a "$LOG_FILE"
    bash -lc "$TEST_CMD" | tee -a "$LOG_FILE"
  fi

  if grep -Fq "$PROMISE" "$LOG_FILE" || grep -Fq "$PLAN_SENTINEL" IMPLEMENTATION_PLAN.md; then
    echo "✅ Completion detected. Stopping." | tee -a "$LOG_FILE"
    exit 0
  fi

done

echo "❌ Max iterations reached without completion." | tee -a "$LOG_FILE"
exit 1
```

## Safety/Sandbox Guidance (must mention)
- Running with `--dangerously-skip-permissions` or `--full-auto` implies **trust + risk**.
- Recommend a **sandbox** (docker/e2b/fly) with minimal credentials and restricted network.
- Escape hatches: `Ctrl+C` to stop; `git reset --hard` to revert.

## Guardrails
- If requirements are unclear, insist on specs before BUILDING.
- If the plan looks stale/wrong, regenerate it (PLANNING loop).
- If backpressure commands are missing, ask for them and add to `AGENTS.md`.
