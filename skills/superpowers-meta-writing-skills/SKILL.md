---
name: superpowers-meta-writing-skills
description: Codex skeleton migrated from obra/superpowers-skills for Writing Skills. Use when creating new skills, editing existing skills, or verifying skills work before deployment.
---

# Writing Skills

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `meta`
- Skill: `writing-skills`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Writing Skills`
- Description: TDD for process documentation - test with subagents before writing, iterate until bulletproof
- When to use: when creating new skills, editing existing skills, or verifying skills work before deployment

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
