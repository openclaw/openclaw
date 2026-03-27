---
name: github-pr-ready-check
description: Run a quick GitHub PR readiness checklist via gh CLI. Use when users ask if a PR is ready to merge, want a pre-review sanity pass, or need CI/review blockers summarized.
---

# GitHub PR Ready Check

Run a lightweight readiness pass before merge/review.

## Core checks

Given `<repo>` and `<pr-number>`:

```bash
gh pr view <pr-number> --repo <owner/repo>
gh pr checks <pr-number> --repo <owner/repo>
```

Optional structured output:

```bash
gh pr view <pr-number> --repo <owner/repo> --json title,body,author,mergeStateStatus,reviewDecision,isDraft
```

## Readiness checklist

1. PR is not draft.
2. CI checks are passing.
3. No unresolved blocking review comments.
4. Merge state is clean.
5. Title/body are clear enough for maintainers.

## Output format

Return:

- merge readiness verdict (ready / needs fixes)
- blockers (if any)
- exact next step command(s)

## Guardrails

- Do not merge automatically unless explicitly asked.
- Keep feedback concise and objective.
