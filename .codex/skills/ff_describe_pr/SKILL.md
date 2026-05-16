---
name: ff_describe_pr
description: Create or update a pull request description from local diff and GitHub metadata
---

# Describe Pull Request

Generate a useful PR description from the current branch, local diff, commits, tests, and any repository template. Use gh when available and authenticated. Do not assume a thoughts-specific template exists.

## Process

1. Identify the PR:
   - Try `gh pr view --json url,number,title,state,baseRefName,headRefName`.
   - If there is no PR yet, use the current branch and commit range against the default branch.
2. Find a template, in this order:
   - `.github/pull_request_template.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `thoughts/shared/pr_description.md`
   - Otherwise use the default format below.
3. Gather evidence:
   - `git status`
   - `git log --oneline origin/main..HEAD` or the appropriate base branch
   - `git diff --stat` and relevant diffs
   - verification commands already run in this session, or run obvious safe checks if needed
4. Write a concise PR body to `thoughts/shared/prs/{number-or-branch}_description.md` when that directory exists, otherwise write `pr_description.md` in the repository root.
5. If a PR exists, update it with `gh pr edit --body-file <file>`.

## Default PR Format

```markdown
## Summary

- {change 1}
- {change 2}

## Why

{problem or goal}

## Verification

- [x] `command` - {result}
- [ ] Manual: {manual check still needed}

## Risks / Notes

- {risk, migration note, or follow-up}
```

## Completion

Print the PR URL if available, the body file path, and any verification that still needs human attention.
