---
name: ftw
description: "FTW (First Try Works) - structured development with Plan-Implement-Validate loop. Full multi-phase orchestration (/ftw) or lightweight discovery-driven builder (/ftw mini). Uses independent sub-agents for execution, validation, and debugging."
homepage: https://github.com/SmokeAlot420/ftw
metadata:
  {
    "openclaw":
      {
        "emoji": "⚙️",
        "requires": { "bins": ["git"] },
        "os": ["darwin", "linux"],
      },
  }
---

# FTW (First Try Works)

## Arguments: $ARGUMENTS

Parse arguments to determine mode:

### Mode Detection

```
If $ARGUMENTS[0] == "mini":
  MODE = "mini"
  FEATURE_NAME = $ARGUMENTS[1] or null (will ask during discovery)
  PROJECT_PATH = $ARGUMENTS[2] or current working directory

Else if $ARGUMENTS[0] == "init":
  MODE = "init"
  PROJECT_PATH = $ARGUMENTS[1] or current working directory

Else:
  MODE = "full"
  If $ARGUMENTS[0] ends with ".md":
    PRD_PATH = $ARGUMENTS[0]
    PROJECT_PATH = dirname(dirname(PRD_PATH))
    START_PHASE = $ARGUMENTS[1] or 1
    END_PHASE = $ARGUMENTS[2] or auto-detect from PRD
    PRD_NAME = basename without extension
  Else:
    PROJECT_PATH = $ARGUMENTS[0] or current working directory
    START_PHASE = $ARGUMENTS[1] or 1
    END_PHASE = $ARGUMENTS[2] or 4
    PRD_PATH = auto-discover from PROJECT_PATH/PRDs/
    PRD_NAME = discovered PRD basename
```

### Usage

```
/ftw [prd-path.md] [start] [end]     Full PIV mode with PRD
/ftw [project-path] [start] [end]    Full PIV mode, auto-discover PRD
/ftw                                  Full PIV mode, cwd
/ftw mini [feature-name] [path]       Mini mode (discovery-driven)
/ftw init [project-path]              Project setup
```

---

## Required Reading by Role

**CRITICAL: Each role MUST read their instruction files before acting.**

| Role | Instructions |
|------|-------------|
| PRD Creation | Read {baseDir}/references/create-prd.md |
| PRP Generation | Read {baseDir}/references/generate-prp.md |
| Codebase Analysis | Read {baseDir}/references/codebase-analysis.md |
| Executor | Read {baseDir}/references/piv-executor.md + {baseDir}/references/execute-prp.md |
| Validator | Read {baseDir}/references/piv-validator.md |
| Debugger | Read {baseDir}/references/piv-debugger.md |

---

## Orchestrator Philosophy

> "Context budget: ~15% orchestrator, 100% fresh per subagent"

You are the **orchestrator**. You stay lean and manage workflow. You DO NOT execute PRPs yourself - you spawn specialized sub-agents with fresh context for each task.

**Sub-agent spawning:** Use the `sessions_spawn` tool to create fresh sub-agent sessions. Each spawn is non-blocking - you'll receive results via an announce step. Wait for each agent's results before proceeding to the next step.

---

## Mode: Init

If MODE is "init", set up the project:

```bash
mkdir -p PROJECT_PATH/PRDs PROJECT_PATH/PRPs/templates PROJECT_PATH/PRPs/planning
```

Copy `{baseDir}/assets/prp_base.md` to `PROJECT_PATH/PRPs/templates/prp_base.md` if it doesn't exist.
Create `PROJECT_PATH/WORKFLOW.md` from `{baseDir}/assets/workflow-template.md` if it doesn't exist.

Output: "Project initialized at PROJECT_PATH". Done.

---

## Mode: Full PIV

**Prerequisite:** A PRD must exist. If none found, tell user to create one first.

For each phase from START_PHASE to END_PHASE, you will execute this pipeline:

1. **Check/Generate PRP** — Look for existing PRP; if none, spawn a research sub-agent (`sessions_spawn`) to do codebase analysis + PRP generation
2. **Spawn EXECUTOR** — Fresh sub-agent (`sessions_spawn`) implements the PRP requirements
3. **Spawn VALIDATOR** — Fresh sub-agent (`sessions_spawn`) independently verifies ALL requirements against the PRP
4. **Debug Loop** (max 3x) — If GAPS_FOUND: spawn DEBUGGER sub-agent, then re-validate. If HUMAN_NEEDED: ask user
5. **Smart Commit** — Semantic commit with `Built with FTW (First Try Works)`
6. **Update WORKFLOW.md** — Mark phase complete with validation results
7. **Next Phase** — Loop back to step 1

Read {baseDir}/references/workflow-full.md for the detailed step-by-step instructions including sub-agent prompt templates.

---

## Mode: Mini

No PRD required — starts from a quick conversation with the user.

1. **Discovery** — Ask 3-5 targeted questions (what it does, where it lives, success criteria, out of scope). Structure answers into YAML
2. **Research & PRP Generation** — Spawn sub-agent (`sessions_spawn`) for codebase analysis + PRP generation from discovery answers
3. **Spawn EXECUTOR** — Fresh sub-agent implements the PRP
4. **Spawn VALIDATOR** — Fresh sub-agent verifies requirements (or self-validate if <5 files/<100 lines changed)
5. **Debug Loop** (max 3x) — If GAPS_FOUND: spawn DEBUGGER, re-validate. If HUMAN_NEEDED: ask user
6. **Smart Commit** — `feat(mini): implement {FEATURE_NAME}` with `Built with FTW (First Try Works)`

Read {baseDir}/references/workflow-mini.md for the detailed step-by-step instructions including discovery questions, sub-agent prompt templates, and validation sizing logic.

---

## Error Handling

- **No PRD** (full mode): Tell user to create one first
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

| Scenario | Command |
|----------|---------|
| Large feature with PRD + phases | `/ftw [prd.md] [start] [end]` |
| Large feature, auto-discover PRD | `/ftw [project-path]` |
| Small/medium feature, no PRD | `/ftw mini [feature-name]` |
| Set up PIV directories | `/ftw init [project-path]` |

### File Naming

```
PRDs/{name}.md                                # PRD (full mode)
PRPs/PRP-{prd-name}-phase-{N}.md              # PRP (full mode)
PRPs/planning/{prd-name}-phase-{N}-analysis.md # Analysis (full mode)
PRPs/mini-{feature-name}.md                   # PRP (mini mode)
PRPs/planning/mini-{feature-name}-analysis.md  # Analysis (mini mode)
```

---

## Completion

### Full Mode

```
## FTW COMPLETE

Phases Completed: START to END
Total Commits: N
Validation Cycles: M

### Phase Summary:
- Phase 1: [feature] - validated in N cycles
...

All phases successfully implemented and validated.
```

### Mini Mode

```
## FTW MINI COMPLETE

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
