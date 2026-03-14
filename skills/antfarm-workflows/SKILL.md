---
name: antfarm-workflows
description: "Multi-agent workflow orchestration for OpenClaw. Use when user mentions antfarm, asks to run a multi-step workflow (feature dev, bug fix, security audit), or wants to install/uninstall/check status of antfarm workflows."
user-invocable: false
---

# Antfarm

Multi-agent workflow pipelines on OpenClaw. Each workflow is a sequence of specialized agents (planner, developer, verifier, tester, reviewer) that execute autonomously via cron jobs polling a shared SQLite database.

All CLI commands use the full path to avoid PATH issues:

```bash
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js <command>
```

Shorthand used below: `antfarm-cli` means `node ~/.openclaw/workspace/antfarm/dist/cli/cli.js`.

## Workflows

| Workflow | Pipeline | Use for |
|----------|----------|---------|
| `feature-dev` | plan -> setup -> develop (stories) -> verify -> test -> PR -> review | New features, refactors |
| `bug-fix` | triage -> investigate -> setup -> fix -> verify -> PR | Bug reports with reproduction steps |
| `security-audit` | scan -> prioritize -> setup -> fix -> verify -> test -> PR | Codebase security review |

## Core Commands

```bash
# Install all workflows (creates agents + starts dashboard)
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js install

# Full uninstall (workflows, agents, crons, DB, dashboard)
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js uninstall [--force]

# Start a run
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow run <workflow-id> "<detailed task with acceptance criteria>"

# Check a run
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow status "<task or run-id prefix>"

# List all runs
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow runs

# Resume a failed run from the failed step
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow resume <run-id>

# View logs
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js logs [lines]

# Dashboard
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js dashboard [start] [--port N]
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js dashboard stop
```

## Before Starting a Run

The task string is the contract between you and the agents. A vague task produces bad results.

**Always include in the task string:**
1. What to build/fix (specific, not vague)
2. Key technical details and constraints
3. Acceptance criteria (checkboxes)

Get the user to confirm the plan and acceptance criteria before running.

## How It Works

- Agents have cron jobs (every 15 min, staggered) that poll for pending steps
- Each agent claims its step, does the work, marks it done, advancing the next step
- Context passes between steps via KEY: value pairs in agent output
- No central orchestrator — agents are autonomous

## Force-Triggering Agents

To skip the 15-min cron wait, use the `cron` tool with `action: "run"` and the agent's job ID. List crons to find them — they're named `antfarm/<workflow-id>/<agent-id>`.

## Workflow Management

```bash
# List available workflows
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow list

# Install/uninstall individual workflows
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow install <name>
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow uninstall <name>
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js workflow uninstall --all [--force]
```

## Creating Custom Workflows

See `{baseDir}/../../docs/creating-workflows.md` for the full guide on writing workflow YAML, agent workspaces, step templates, and verification loops.

## Agent Step Operations (used by agent cron jobs, not typically manual)

```bash
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step claim <agent-id>        # Claim pending step
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step complete <step-id>      # Complete step (output from stdin)
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step fail <step-id> <error>  # Fail step with retry
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step stories <run-id>        # List stories for a run
```
