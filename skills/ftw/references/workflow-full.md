# Full PIV Phase Workflow

For each phase from START_PHASE to END_PHASE:

## Step 1: Check/Generate PRP

Check for existing PRP:
```bash
ls -la PROJECT_PATH/PRPs/ 2>/dev/null | grep -i "phase.*N\|pN\|p-N"
```

If no PRP exists, spawn a **fresh sub-agent** using `sessions_spawn` to do both codebase analysis and PRP generation in sequence:

```
RESEARCH & PRP GENERATION MISSION - Phase {N}
==============================================

Project root: {PROJECT_PATH}
PRD Path: {PRD_PATH}

## Phase {N} Scope (from PRD)
{paste phase scope}

## Step 1: Codebase Analysis
Read {baseDir}/references/codebase-analysis.md for the process.
Save to: {PROJECT_PATH}/PRPs/planning/{PRD_NAME}-phase-{N}-analysis.md

## Step 2: Generate PRP (analysis context still loaded)
Read {baseDir}/references/generate-prp.md for the process.
Use template: PRPs/templates/prp_base.md
Output to: {PROJECT_PATH}/PRPs/PRP-{PRD_NAME}-phase-{N}.md

Do BOTH steps yourself. DO NOT spawn sub-agents.
```

## Step 2: Spawn EXECUTOR

Spawn a fresh sub-agent using `sessions_spawn`:

```
EXECUTOR MISSION - Phase {N}
============================

Read {baseDir}/references/piv-executor.md for your role definition.
Read {baseDir}/references/execute-prp.md for the execution process.

PRP Path: {PRP_PATH}
Project: {PROJECT_PATH}

Follow: Load PRP -> Plan Thoroughly -> Execute -> Validate -> Verify
Output EXECUTION SUMMARY with Status, Files, Tests, Issues.
```

## Step 3: Spawn VALIDATOR

Spawn a fresh sub-agent using `sessions_spawn`:

```
VALIDATOR MISSION - Phase {N}
=============================

Read {baseDir}/references/piv-validator.md for your validation process.

PRP Path: {PRP_PATH}
Project: {PROJECT_PATH}
Executor Summary: {SUMMARY}

Verify ALL requirements independently.
Output VERIFICATION REPORT with Grade, Checks, Gaps.
```

**Process result:** PASS -> commit | GAPS_FOUND -> debugger | HUMAN_NEEDED -> ask user

## Step 4: Debug Loop (Max 3 iterations)

Spawn a fresh sub-agent using `sessions_spawn`:

```
DEBUGGER MISSION - Phase {N} - Iteration {I}
============================================

Read {baseDir}/references/piv-debugger.md for your debugging methodology.

Project: {PROJECT_PATH}
PRP Path: {PRP_PATH}
Gaps: {GAPS}
Errors: {ERRORS}

Fix root causes, not symptoms. Run tests after each fix.
Output FIX REPORT with Status, Fixes Applied, Test Results.
```

After debugger: re-validate -> PASS (commit) or loop (max 3) or escalate.

## Step 5: Smart Commit

```bash
cd PROJECT_PATH && git status && git diff --stat
```

Create semantic commit with `Built with FTW (First Try Works) - https://github.com/SmokeAlot420/ftw`.

## Step 6: Update WORKFLOW.md

Mark phase complete, note validation results.

## Step 7: Next Phase

Loop back to Step 1 for next phase.
