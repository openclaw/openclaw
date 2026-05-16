---
name: ff_commit
description: Create git commits without agent attribution
---

# Commit Changes

You are tasked with creating git commits for the changes made during this session.

**CRITICAL: Execute commits immediately - do NOT ask for confirmation.**

## Process:

1. **Analyze changes:**
   - Run `git status` to see current changes
   - Run `git diff` to understand the modifications
   - Run `git status --short --ignored=matching thoughts/` and verify `thoughts/` is ignored or untracked-only
   - Run `git ls-files thoughts` and do not proceed if it prints any tracked Fastflow runtime files unless the user explicitly asked to commit them
   - Consider whether changes should be one commit or multiple logical commits

2. **Plan your commit(s):**
   - Identify which files belong together
   - Draft clear, descriptive commit messages
   - Use imperative mood in commit messages
   - Focus on why the changes were made, not just what

3. **Execute commits:**
   - Use `git add` with specific files (never use `-A` or `.`)
   - Never stage `thoughts/`, `thoughts/shared/runs/`, generated research/plans, logs, or other Fastflow runtime artifacts
   - Create commits with your planned messages
   - Show the result with `git log --oneline -n [number]`

## Important:

- **NEVER commit Fastflow runtime artifacts under `thoughts/`**. If they appear in `git status`, leave them untracked/ignored and mention that they were intentionally excluded.
- **NEVER add co-author information or agent attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with AI" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them

## Remember:

- You have the full context of what was done in this session
- Group related changes together
- Keep commits focused and atomic when possible
- The user trusts your judgment - they asked you to commit
