# Claude (Mac) Git Workflow

This document defines Git conventions for Mac-side Claude agents working in this repository.
It complements `AGENTS.md` and `DEEPNOA_RULES.md` and is designed for use alongside Codex agents.

## Role Summary

| Agent        | Primary Responsibility                                  | Branch Prefix   |
| ------------ | ------------------------------------------------------- | --------------- |
| Mac Codex    | Feature development, CI, upstream sync                  | `codex/`        |
| Sense Codex  | NemoClaw runner, Ollama integration, Sense-side scripts | `codex/`        |
| Mac Claude   | Research, design, small patches, PR assistance          | `claude/mac-`   |
| Sense Claude | Sense-side config, SSH verification, systemd inspection | `claude/sense-` |

Mac Claude does not merge to `main`. PRs are created for human review.

## Branch Rules

- Always branch from the latest `origin/main`.
- Branch name format: `claude/mac-<task-name>`
- Examples:
  - `claude/mac-git-workflow`
  - `claude/mac-add-ssh-test`
  - `claude/mac-sense-docs`
- Never use `codex/` prefix. Never push to `main`.

```bash
git checkout -b claude/mac-<task-name> origin/main
```

## Commit Rules

- Always use `scripts/committer` — never `git commit` directly.
- Commit message must include `(claude)` in the scope.
- Format: `<type>(claude): <description>`
- Examples:
  - `feat(claude): add git workflow docs for mac claude`
  - `fix(claude): correct branch naming in agent rules`
  - `docs(claude): document sense-worker ops flow`

```bash
scripts/committer "feat(claude): <description>" <file1> [file2 ...]
```

Forbidden:

- `git add .` or `git add -A` (stages unintended files)
- `git commit -m ...` directly (bypasses committer safety guards)
- Staging `node_modules` paths
- Using `"."` as a file argument to committer

## Push Rules

```bash
git push -u origin claude/mac-<task-name>
```

Never:

- `git push origin main`
- `git push --force`
- `git rebase`
- `git stash`
- `git reset --hard` on any branch other than your own

## PR Rules

Every PR from a Claude branch must include:

1. **AI Agent** field — identify as `Mac Claude`
2. Purpose — what problem this solves
3. Codex integration note — how Codex should consume or build on this work
4. Test evidence — what was verified and how

PRs are not merged by Claude. Merge is a human decision.

## Interaction with Codex

- Do not modify branches prefixed with `codex/`.
- Do not modify files in worktrees that belong to a Codex session.
- If a file needs to be changed that Codex is also touching, flag it in the PR and wait for human resolution.
- Codex can identify Claude work by the `claude/mac-` branch prefix and `(claude)` commit scope.

## Worktree Notes

Mac Claude operates inside `.claude/worktrees/<name>` — a git worktree separate from the main checkout.
Do not add or remove worktrees without explicit instruction.
Do not switch the worktree's branch to a `codex/` branch.

## Quick Reference

```bash
# Start new task
git checkout -b claude/mac-<task> origin/main

# Commit
scripts/committer "feat(claude): <what changed>" <file>

# Push
git push -u origin claude/mac-<task>

# Never
git push origin main
git push --force
git stash / rebase / reset --hard (other branches)
```
