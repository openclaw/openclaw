---
name: system-brain
description: Use shared agent, brand, project, and skill-learning context for high-context workflows with human review checkpoints.
---

# System Brain

Use this skill when a task should inherit durable local context, brand voice, project memory, or prior workflow learnings without copying everything into the main prompt.

## Context Layers

Read only the layers needed for the task:

1. Agent instructions: workspace `AGENTS.md` and `~/.openclaw/brain/agent/context.md`.
2. Brand/business context: `~/.openclaw/brain/brand/`.
3. Project memory: `~/.openclaw/brain/projects/`.
4. Skill learnings: `~/.openclaw/brain/skills/learnings.md`.

If a file is missing, continue with available context and note the gap.

## Rules

- Keep private context private; do not paste sensitive files into public outputs.
- Prefer references and short summaries over loading every memory file.
- Scheduled runs may draft changes under `~/.openclaw/review/`.
- Require human approval before publishing, sending, merging, deleting, changing credentials, or modifying active skill files.
- Treat sandbox, network, model, and credential changes as human-checkpoint work. Scheduled runs may report or draft them, but must not apply them.
- For code changes, generate a JiT diff-test plan and prefer catching tests that target the changed behavior over broad, brittle coverage.
- For browser workflows, keep runnable flow specs and artifacts; inspect screenshots/traces before changing selectors or app code.
- Do not route production or cron work to gated preview models unless access is explicitly approved and a local smoke test passed.
- When a reusable lesson appears, append a short candidate entry to `~/.openclaw/brain/skills/learnings.md` or draft it under review if the run is scheduled.

## Command Center

Use `~/.openclaw/command-center/goals.json` as the goal source of truth.
Write derived status to `~/.openclaw/command-center/status.md`.
Do not rewrite goal definitions unless requested.

## Output Shape

For reviews, include:

- context used
- findings or proposed changes
- files to update
- human checkpoint required

For implementation, keep edits scoped and cite exact files changed.
