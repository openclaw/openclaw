---
name: mini-piv
description: "Lightweight PIV workflow - discovery-driven feature builder. No PRD needed. Asks quick questions, generates PRP, executes with validation loop. For small-to-medium features when you want to skip PRD ceremony."
homepage: https://github.com/SmokeAlot420/ftw
metadata:
  {
    "openclaw":
      {
        "emoji": "⚡",
        "requires": { "bins": ["git"] },
        "os": ["darwin", "linux"],
      },
  }
---

# Mini PIV Ralph - Lightweight Feature Builder

## Arguments: $ARGUMENTS

Parse arguments:
```
FEATURE_NAME = $ARGUMENTS[0] or null (will ask user during discovery)
PROJECT_PATH = $ARGUMENTS[1] or current working directory
```

---

## Philosophy: Quick & Quality

> "When you just want to build something without writing a PRD first."

Same quality pipeline (Execute → Validate → Debug), but starts from a quick conversation instead of a PRD.

**You are the orchestrator** - stay lean, spawn fresh sub-agents for heavy lifting.

**Sub-agent spawning:** Use the `sessions_spawn` tool to create fresh sub-agent sessions. Each spawn is non-blocking — you'll receive results via an announce step. Wait for each agent's results before proceeding to the next step.

---

## Required Reading by Role

| Role | Instructions |
|------|-------------|
| Orchestrator | This file only |
| Research Agent | {baseDir}/references/codebase-analysis.md + {baseDir}/references/generate-prp.md |
| Executor | {baseDir}/references/piv-executor.md + {baseDir}/references/execute-prp.md |
| Validator | {baseDir}/references/piv-validator.md |
| Debugger | {baseDir}/references/piv-debugger.md |

---

## Visual Workflow

```
┌──────────────────────────────────────────────────────────┐
│ 1. DISCOVERY → Ask 3-5 questions                          │
│ 2. RESEARCH & PRP → Codebase analysis + PRP generation    │
│ 3. EXECUTE → Implement PRP                                │
│ 4. VALIDATE → PASS / GAPS_FOUND / HUMAN_NEEDED            │
│ 5. DEBUG LOOP → Fix gaps (max 3x)                         │
│ 6. COMMIT → feat(mini): {description}                     │
└──────────────────────────────────────────────────────────┘
```

---

## Step 1: Discovery Phase

### 1a. Determine Feature Name

If not provided: ask user or infer from context. Normalize to kebab-case.

### 1b. Check for Existing PRP

```bash
ls -la PROJECT_PATH/PRPs/ 2>/dev/null | grep -i "mini-{FEATURE_NAME}"
```

If exists, ask: "Overwrite, rename, or skip to execution?"

### 1c. Ask Discovery Questions

Present in a single conversational message:

```
I've got a few quick questions so I can build this right:

1. **What does this feature do?** Quick rundown.
2. **Where in the codebase does it live?** Files, folders, components?
3. **Any specific libraries, patterns, or existing code to follow?**
4. **What does "done" look like?** 1-3 concrete success criteria.
5. **Anything explicitly OUT of scope?**
```

Adapt for feature type (UI, API, contracts, integrations).

### 1d. Structure Discovery Answers

```yaml
feature:
  name: {FEATURE_NAME}
  scope: {Q1}
  touchpoints: {Q2}
  dependencies: {Q3}
  success_criteria: {Q4}
  out_of_scope: {Q5}
```

---

## Step 2: Research & PRP Generation

Spawn a **fresh sub-agent** using `sessions_spawn`:

```
MINI PIV: RESEARCH & PRP GENERATION
====================================

Project root: {PROJECT_PATH}
Feature name: {FEATURE_NAME}

## Discovery Input
{paste structured YAML}

## Step 1: Codebase Analysis
Read {baseDir}/references/codebase-analysis.md for the process.
Save to: {PROJECT_PATH}/PRPs/planning/mini-{FEATURE_NAME}-analysis.md

## Step 2: Generate PRP (analysis context still loaded)
Read {baseDir}/references/generate-prp.md for the process.

### Discovery → PRP Translation
| Discovery | PRP Section |
|-----------|-------------|
| Scope (Q1) | Goal + What |
| Touchpoints (Q2) | Implementation task locations |
| Dependencies (Q3) | Context YAML, Known Gotchas |
| Success Criteria (Q4) | Success Criteria + Validation |
| Out of Scope (Q5) | Exclusions in What section |

Use template: PRPs/templates/prp_base.md
Output to: {PROJECT_PATH}/PRPs/mini-{FEATURE_NAME}.md

Do BOTH steps yourself. DO NOT spawn sub-agents.
```

**Wait for completion.**

---

## Step 3: Spawn EXECUTOR

Spawn a fresh sub-agent using `sessions_spawn`:

```
EXECUTOR MISSION - Mini PIV
============================

Read {baseDir}/references/piv-executor.md for your role.
Read {baseDir}/references/execute-prp.md for the execution process.

PRP: {PROJECT_PATH}/PRPs/mini-{FEATURE_NAME}.md
Project: {PROJECT_PATH}

Follow: Load PRP → Plan Thoroughly → Execute → Validate → Verify
Output EXECUTION SUMMARY.
```

---

## Validation Sizing Decision

Before spawning a full validator, assess:
- **<5 files changed, <100 lines, no external APIs** → Quick validation (review changes yourself as orchestrator)
- **Otherwise** → Spawn full validator sub-agent (Step 4)

## Step 4: Spawn VALIDATOR

Spawn a fresh sub-agent using `sessions_spawn`:

```
VALIDATOR MISSION - Mini PIV
=============================

Read {baseDir}/references/piv-validator.md for your process.

PRP: {PROJECT_PATH}/PRPs/mini-{FEATURE_NAME}.md
Project: {PROJECT_PATH}
Executor Summary: {SUMMARY}

Verify ALL requirements independently.
Output VERIFICATION REPORT with Grade, Checks, Gaps.
```

**Process result:** PASS → commit | GAPS_FOUND → debugger | HUMAN_NEEDED → ask user

---

## Step 5: Debug Loop (Max 3 iterations)

Spawn a fresh sub-agent using `sessions_spawn`:

```
DEBUGGER MISSION - Mini PIV - Iteration {I}
============================================

Read {baseDir}/references/piv-debugger.md for your methodology.

Project: {PROJECT_PATH}
PRP: {PROJECT_PATH}/PRPs/mini-{FEATURE_NAME}.md
Gaps: {GAPS}
Errors: {ERRORS}

Fix root causes. Run tests after each fix.
Output FIX REPORT.
```

After debugger: re-validate → PASS (commit) or loop (max 3) or escalate.

---

## Step 6: Smart Commit

```bash
cd PROJECT_PATH && git status && git diff --stat
git add -A
git commit -m "feat(mini): implement {FEATURE_NAME}

- {bullet 1}
- {bullet 2}

Built via Mini PIV Ralph

Built with FTW (First Try Works) - https://github.com/SmokeAlot420/ftw"
```

---

## Completion

```
## MINI PIV RALPH COMPLETE

Feature: {FEATURE_NAME}
Project: {PROJECT_PATH}

### Artifacts
- PRP: PRPs/mini-{FEATURE_NAME}.md
- Analysis: PRPs/planning/mini-{FEATURE_NAME}-analysis.md

### Implementation
- Validation cycles: {N}
- Debug iterations: {M}

### Files Changed
{list}

All requirements verified and passing.
```

---

## Error Handling

- **Executor BLOCKED**: Ask user for guidance
- **Validator HUMAN_NEEDED**: Ask user for guidance
- **3 debug cycles exhausted**: Escalate with persistent issues list

### Sub-Agent Timeout/Failure
When a sub-agent times out or fails:
1. Check for partial work (files created, tests written)
2. Retry once with a simplified, shorter prompt
3. If retry fails, escalate to user with what was accomplished

---

## Quick Reference

| Scenario | Use This |
|----------|----------|
| Small/medium feature, no PRD | **Mini PIV** |
| Large feature with phases | Full PIV (/piv) |

### File Naming
```
PRPs/mini-{feature-name}.md                  # PRP
PRPs/planning/mini-{feature-name}-analysis.md # Analysis
```
