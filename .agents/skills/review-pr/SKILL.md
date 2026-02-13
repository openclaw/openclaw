---
name: review-pr
description: Script-first review-only GitHub pull request analysis. Use for deterministic PR review with structured findings handoff to /prepare-pr.
---

# Review PR

## Overview

Perform a read-only review and produce both human and machine-readable outputs.

## Inputs

- Ask for PR number or URL.
- If missing, always ask.

## Safety

- Never push, merge, or modify code intended to keep.
- Work only in `.worktrees/pr-<PR>`.

## Execution Contract

1. Run wrapper setup:

```sh
scripts/pr-review <PR>
```

2. Use explicit branch mode switches:

- Main baseline mode: `scripts/pr review-checkout-main <PR>`
- PR-head mode: `scripts/pr review-checkout-pr <PR>`

3. Before writing review outputs, run branch guard:

```sh
scripts/pr review-guard <PR>
```

4. Write both outputs:

- `.local/review.md` with sections A through J.
- `.local/review.json` with structured findings.

5. Validate artifacts semantically:

```sh
scripts/pr review-validate-artifacts <PR>
```

## Steps

1. Setup and metadata

```sh
scripts/pr-review <PR>
ls -la .local/pr-meta.json .local/pr-meta.env .local/review-context.env .local/review-mode.env
```

2. Existing implementation check on main

```sh
scripts/pr review-checkout-main <PR>
rg -n "<keyword>" -S src extensions apps || true
git log --oneline --all --grep "<keyword>" | head -20
```

3. Claim PR

```sh
gh_user=$(gh api user --jq .login)
gh pr edit <PR> --add-assignee "$gh_user" || echo "Could not assign reviewer, continuing"
```

4. Read PR description and diff

```sh
scripts/pr review-checkout-pr <PR>
gh pr diff <PR>

source .local/review-context.env
git diff --stat "$MERGE_BASE"..pr-<PR>
git diff "$MERGE_BASE"..pr-<PR>
```

5. Optional local tests

Use the wrapper for target validation and executed-test verification:

```sh
scripts/pr review-tests <PR> <test-file> [<test-file> ...]
```

6. Initialize review artifact templates

```sh
scripts/pr review-artifacts-init <PR>
```

7. Produce review outputs

- Fill `.local/review.md` sections A through J.
- Fill `.local/review.json`.

Minimum JSON shape:

```json
{
  "recommendation": "READY FOR /prepare-pr",
  "findings": [
    {
      "id": "F1",
      "severity": "IMPORTANT",
      "title": "...",
      "area": "path/or/component",
      "fix": "Actionable fix"
    }
  ],
  "tests": {
    "ran": [],
    "gaps": [],
    "result": "pass"
  },
  "docs": "up_to_date|missing|not_applicable",
  "changelog": "required"
}
```

8. Guard + validate before final output

```sh
scripts/pr review-guard <PR>
scripts/pr review-validate-artifacts <PR>
```

## Guardrails

- Keep review read-only.
- Do not delete worktree.
- Use merge-base scoped diff for local context to avoid stale branch drift.
