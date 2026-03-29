---
name: superpowers-collaboration-dispatching-parallel-agents
description: Codex skeleton migrated from obra/superpowers-skills for Dispatching Parallel Agents. Use when facing 3+ independent failures that can be investigated without shared state or dependencies.
---

# Dispatching Parallel Agents

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `collaboration`
- Skill: `dispatching-parallel-agents`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Dispatching Parallel Agents`
- Description: Use multiple Claude agents to investigate and fix independent problems concurrently
- When to use: when facing 3+ independent failures that can be investigated without shared state or dependencies

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
