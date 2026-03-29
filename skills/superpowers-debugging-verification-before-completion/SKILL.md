---
name: superpowers-debugging-verification-before-completion
description: Codex skeleton migrated from obra/superpowers-skills for Verification Before Completion. Use when about to claim work is complete, fixed, or passing, before committing or creating PRs.
---

# Verification Before Completion

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `debugging`
- Skill: `verification-before-completion`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Verification Before Completion`
- Description: Run verification commands and confirm output before claiming success
- When to use: when about to claim work is complete, fixed, or passing, before committing or creating PRs

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
