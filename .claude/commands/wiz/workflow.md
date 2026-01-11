---
description: Summon workflow wizard - prime agent with dev workflow and project management
allowed-tools: [Bash, Glob, Grep, Read, Task, Write]
argument-hint: "[path]"
---

# Wizard: Development Workflow

You are summoning a workflow wizard. Prime yourself with understanding of the development workflow, project management, and processes we use together.

**Output path:** `$PATH` (default: `/dev/null`)

**Path conventions:**
- `/dev/null` - Suppress output (silent mode, default)
- `/dev/stdout` - Display report to screen
- Any other path - Write report to that file

## CRITICAL: Always Explore

You MUST explore the workflow docs and project state regardless of output destination.
The exploration phases happen always - `$PATH` only controls where the final report is written.

Generate your internal summary to ensure context is loaded. Then write it to the specified destination.

---

## Phase 1: Explore Workflow Documentation

Use the Read tool to read the main workflow guide and understand the development model.

**Note:** Some files may not exist in fork/upstream repos (dev-only files). If a file doesn't exist, note it and continue.

| Priority | File | Purpose |
|----------|------|---------|
| 1 | `.workflow/AGENTS.md` | Complete workflow guide - the source of truth |
| 2 | `.workflow/automation/agent-automation.md` | Multi-agent coordination (dev-only, may not exist) |
| 3 | `.workflow/automation/infrastructure.md` | Infrastructure setup (dev-only, may not exist) |

---

## Phase 2: Understand Build & Release System

Use the Read tool to read the release build scripts and understand the hotfix workflow.

**Note:** These scripts may not exist in fork/upstream repos (dev-only). If files don't exist, skip this phase and note in your summary.

| File | Purpose |
|------|---------|
| `scripts/build-release.sh` | Main build script - creates worktrees, applies hotfixes (dev-only) |
| `scripts/apply-release-fixes.sh` | Auto-applies `hotfix/*` branches (dev-only) |
| `scripts/release-fixes-status.sh` | Shows hotfix status vs any target (dev-only) |
| `scripts/deploy-release.sh` | Deploys build to /Applications (admin, dev-only) |

**Key Concepts:**
- **Hotfix Convention:** Branches named `hotfix/*` auto-apply during builds
- **Worktrees:** Isolated build directories in `.worktrees/<version>/`
- **Latest Symlink:** `.local/latest` points to most recent build

---

## Phase 3: List Available Commands

Use Bash to list the slash command structure. Just list files to know what exists - don't read them all unless needed later.

```bash
# List available dev commands
ls .claude/commands/dev/

# List available build commands
ls .claude/commands/build/

# List available wiz commands
ls .claude/commands/wiz/
```

**Command Namespaces:**
- `/dev:*` - Development workflow (gate, test, commit, tdd, etc.)
- `/build:*` - Release builds (release, help)
- `/wiz:*` - Wizard priming (core, workflow, help)

---

## Phase 4: Understand Git Model

From `.workflow/AGENTS.md`, understand the three-remote model:

| Remote | Repository | Purpose |
|--------|------------|---------|
| `dev` | petter-b/clawdbot-dev (private) | Daily development |
| `fork` | petter-b/clawdbot (public) | PR staging |
| `upstream` | clawdbot/clawdbot | PR target only |

**PR Flow:** dev → fork → upstream

**Dev-Only Files (never push):**
- `.workflow/` - Workflow documentation
- `.claude/` - Claude Code config
- `scripts/setup-*.sh` - Local setup scripts
- `scripts/daily-*.sh` - Daily build automation

---

## Phase 5: Generate Report

Create a concise internal summary covering:
- Hotfix system and build workflow
- Available slash commands
- Git remote model

**Report content:**

```
Dev Workflow Primed
===================

Hotfix System:
  Convention:  hotfix/* branches auto-apply during builds
  Status:      ./scripts/release-fixes-status.sh [target]
  Apply:       ./scripts/apply-release-fixes.sh [--dry-run]

Release Builds:
  Build:       /build:release [version]
  Artifacts:   .worktrees/<version>/dist/Clawdbot.app
  Latest:      .local/latest symlink

Git Model:
  dev      → Daily development (private)
  fork     → PR staging (public)
  upstream → PR target only

Commands:
  /dev:help    Development workflow commands
  /build:help  Release build commands
  /wiz:help    Wizard priming commands

Ready for questions about workflow or releases.
```

**Output handling:**

Follow this conditional pattern based on `$PATH`:

1. **Normalize path:** If `$PATH` is empty, treat as `/dev/null`

2. **Route output based on path:**
   - **If `$PATH` is `/dev/null`:**
     - Write nothing
     - Respond with: "Primed for workflow and project management questions."

   - **If `$PATH` is `/dev/stdout`:**
     - Display the full report above directly in your response
     - End with: "Primed for workflow and project management questions."

   - **Otherwise (any other path):**
     - Use Write tool to save the report to `$PATH`
     - Respond with: "Report written to `$PATH`. Primed for workflow and project management questions."

---

## Ready

You are now a workflow expert. Answer questions with confidence about:
- Development workflow and conventions
- Build and release process
- Project priorities and tracking
- Git model and PR flow
- Available slash commands

If asked about something you didn't explore, read the relevant files first.
