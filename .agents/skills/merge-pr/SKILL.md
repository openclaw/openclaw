---
name: merge-pr
description: Script-first deterministic squash merge with strict required-check gating, head-SHA pinning, and reliable attribution/commenting.
---

# Merge PR

## Overview

Merge a prepared PR only after deterministic validation.

## Inputs

- Ask for PR number or URL.
- If missing, use `.local/prep.env` from the PR worktree.

## Safety

- Never use `gh pr merge --auto` in this flow.
- Never run `git push` directly.
- Require `--match-head-commit` during merge.

## Execution Contract

1. Validate merge readiness:

```sh
scripts/pr-merge verify <PR>
```

Backward-compatible verify form also works:

```sh
scripts/pr-merge <PR>
```

2. Run one-shot deterministic merge:

```sh
scripts/pr-merge run <PR>
```

3. Ensure output reports:

- `merge_sha=<sha>`
- `merge_author_email=<email>`
- `comment_url=<url>`

## Steps

1. Validate artifacts

```sh
require=(.local/review.md .local/review.json .local/prep.md .local/prep.env)
for f in "${require[@]}"; do
  [ -s "$f" ] || { echo "Missing artifact: $f"; exit 1; }
done
```

2. Validate checks and branch status

```sh
scripts/pr-merge verify <PR>
source .local/prep.env
```

`scripts/pr-merge` treats “no required checks configured” as acceptable (`[]`), but fails on any required `fail` or `pending`.

3. Merge deterministically (wrapper-managed)

```sh
scripts/pr-merge run <PR>
```

`scripts/pr-merge run` performs:

- deterministic squash merge pinned to `PREP_HEAD_SHA`
- reviewer merge author email selection with fallback candidates
- one retry only when merge fails due to author-email validation
- co-author trailers for PR author and reviewer
- post-merge verification of both co-author trailers on commit message
- PR comment retry (3 attempts), then comment URL extraction
- cleanup after confirmed `MERGED`

4. Manual fallback (only if wrapper is unavailable)

```sh
scripts/pr merge-run <PR>
```

5. Cleanup

Cleanup is handled by `run` after merge success.

## Guardrails

- End in `MERGED`, never `CLOSED`.
- Cleanup only after confirmed merge.
