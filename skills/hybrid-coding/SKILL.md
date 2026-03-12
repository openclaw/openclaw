---
name: hybrid-coding
description: "Delegate coding tasks via 3-Layer multi-agent (MAIBOT → Sub-agent → Claude Code CLI). Use when: (1) feature implementation/build, (2) PR review, (3) refactoring/architecture, (4) parallel multi-agent coding, (5) new project multi-agent init. NOT for: simple file edits (Edit tool), reading code (Read tool), or MAIBOT workspace (C:\\MAIBOT) work."
metadata:
  openclaw:
    emoji: "🏗️"
    requires:
      anyBins: ["claude"]
---

# Hybrid Coding Agent (3-Layer Multi-Agent)

MAIBOT(orchestrator) → Sub-agent(parallelization) → Claude Code CLI(execution).

## Architecture

```
Layer 1: MAIBOT (OpenClaw, Opus 4.6) ← Orchestrator
    │   • Task analysis / routing / verification / fixing
    │   • Handle simple tasks directly
    │
    ├── Layer 2: sessions_spawn or exec → Sub-agent
    │     └── Layer 3: claude -p --agent {specialist} 'task'
    │           └── Claude Code CLI (Max OAuth, 69 agents)
    │
    └── (parallel: Slot 2, 3...)
```

## ⚠️ PTY Required!

Claude Code CLI is a terminal app — **always use `pty:true`**.

```bash
# ✅ Correct
exec pty:true workdir:"C:\TEST\<project>" command:"claude -p 'task'"

# ❌ Wrong — output breaks or hangs
exec workdir:"C:\TEST\<project>" command:"claude -p 'task'"
```

## Quick Command

```bash
claude -p --model sonnet --dangerously-skip-permissions --agent <agent> "task"
```

| Flag                             | Purpose                                             |
| -------------------------------- | --------------------------------------------------- |
| `-p`                             | Non-interactive, exit after response — **required** |
| `--model sonnet/opus`            | Model selection                                     |
| `--agent {name}`                 | Specialist agent                                    |
| `--dangerously-skip-permissions` | Auto-approve all                                    |
| `--fallback-model sonnet`        | Auto-switch on rate limit                           |

> **Max/Pro OAuth:** Never use `--max-budget-usd` (monthly subscription, no per-token billing).
> **MCP hang:** Never use `--strict-mcp-config --mcp-config '{}'` on Windows — hangs.

## Task Routing

| Task Type                               | Where                      | Model          | Concurrency |
| --------------------------------------- | -------------------------- | -------------- | ----------- |
| **Simple** (file edits, config, docs)   | MAIBOT direct (Edit/Write) | —              | unlimited   |
| **Medium** (features, bug fixes, tests) | Claude Code CLI            | **Sonnet 4.6** | 2 slots     |
| **Complex** (design, refactoring, arch) | Claude Code CLI            | **Opus 4.6**   | 1 slot      |

Model mix target: 60% MAIBOT direct + 30% Sonnet + 10% Opus.

## Verification (required after every Claude Code run)

```
Claude Code done
    ↓
MAIBOT verify: tsc --noEmit + vitest run + code review (Read)
    ↓
Pass → git commit
Fail → simple type error: MAIBOT fixes directly (Edit)
      logic error: re-run Claude Code with error message
      design issue: escalate to Opus agent
```

> Claude Code ~90% accurate. TypeScript exports and ESM paths are common failure spots.
> MAIBOT verification + fix = 100% coverage.

## Progress Reporting (required for background runs)

1. **Start** — Discord DM: what + where (1 line)
2. **Milestone/error/input needed/done** — update only on change
3. **End** — summary of changes + verification result
4. **On kill** — explain reason immediately

## Rules

1. **Always `pty:true`** — Claude Code needs a terminal
2. **Never run inside `C:\MAIBOT`** — live OpenClaw instance
3. **Be patient** — don't kill slow sessions
4. **Verify before commit** — tsc + vitest pass required
5. **On agent failure** — retry or ask 지니, don't silently substitute
6. **Max subscription: never use `--max-budget-usd`**

## References

- [Agent Catalog (69 agents)](references/agents-catalog.md)
- [Execution Recipes](references/recipes.md)
- [Rate Limit & MCP Guide](references/rate-limit-mcp.md)
- [Project Init Checklist](references/project-init.md)

## Changelog

| Date       | Change                                             |
| ---------- | -------------------------------------------------- |
| 2026-02-06 | Hybrid v1 introduced                               |
| 2026-02-07 | v1 deprecated (MCP conflict)                       |
| 2026-02-24 | v2 — 3-Layer multi-agent + coding-agent merged     |
| 2026-03-13 | **v3** — Skills 2.0 restructure (references split) |
