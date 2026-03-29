---
name: superpowers-collaboration-subagent-driven-development
description: Codex skeleton migrated from obra/superpowers-skills for Subagent-Driven Development. Use when executing implementation plans with independent tasks in the current session, using fresh subagents with review gates.
---

# Subagent-Driven Development

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `collaboration`
- Skill: `subagent-driven-development`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Subagent-Driven Development`
- Description: Execute implementation plan by dispatching fresh subagent for each task, with code review between tasks
- When to use: when executing implementation plans with independent tasks in the current session, using fresh subagents with review gates

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
