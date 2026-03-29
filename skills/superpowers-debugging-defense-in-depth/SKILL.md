---
name: superpowers-debugging-defense-in-depth
description: Codex skeleton migrated from obra/superpowers-skills for Defense-in-Depth Validation. Use when invalid data causes failures deep in execution, requiring validation at multiple system layers.
---

# Defense-in-Depth Validation

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `debugging`
- Skill: `defense-in-depth`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Defense-in-Depth Validation`
- Description: Validate at every layer data passes through to make bugs impossible
- When to use: when invalid data causes failures deep in execution, requiring validation at multiple system layers

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
