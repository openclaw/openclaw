---
name: superpowers-debugging-root-cause-tracing
description: Codex skeleton migrated from obra/superpowers-skills for Root Cause Tracing. Use when errors occur deep in execution and you need to trace back to find the original trigger.
---

# Root Cause Tracing

This is a Codex skeleton migrated from `obra/superpowers-skills`.

## Source

- Repository: `obra/superpowers-skills`
- Category: `debugging`
- Skill: `root-cause-tracing`

## Status

- This file is a migration skeleton, not a full semantic port.
- Keep the source intent, but rewrite any Claude Superpowers-specific commands, paths, or assumptions before relying on it in production work.
- Treat this skill as a starting point for a proper Codex-native rewrite.

## Original Intent

- Name: `Root Cause Tracing`
- Description: Systematically trace bugs backward through call stack to find original trigger
- When to use: when errors occur deep in execution and you need to trace back to find the original trigger

## Codex Adaptation Checklist

- Replace any Claude-only tool references with Codex tools available in this environment.
- Replace Superpowers-specific path conventions with repo-local paths or Codex skill-relative paths.
- Remove workflow steps that depend on unsupported features or external plugins.
- Tighten the trigger description once the skill is fully rewritten for Codex.

## Next Porting Step

- Read the original source `SKILL.md` from `obra/superpowers-skills` and translate only the durable workflow guidance into Codex-native instructions.
