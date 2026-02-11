---
name: prepare-pr
description: Script-first PR preparation with structured findings resolution, deterministic push safety, and explicit gate execution.
---

# Prepare PR

## Overview

Prepare the PR head branch for merge after `/review-pr`.

## Inputs

- Ask for PR number or URL.
- If missing, use `.local/pr-meta.env` if present in the PR worktree.

## Safety

- Never push to `main`.
- Only push to PR head with explicit `--force-with-lease` against known head SHA.
- Do not run `git clean -fdx`.
- Wrappers are cwd-agnostic; run from repo root or PR worktree.

## Execution Contract

1. Run setup:

```sh
scripts/pr-prepare init <PR>
```

2. Resolve findings from structured review:

- `.local/review.json` is mandatory.
- Resolve all `BLOCKER` and `IMPORTANT` items.

3. Commit with required subject format and validate it.

4. Run gates via wrapper.

5. Push via wrapper (includes pre-push remote verification, one automatic lease-retry path, and post-push API propagation retry).

Optional one-shot path:

```sh
scripts/pr-prepare run <PR>
```

## Steps

1. Setup and artifacts

```sh
scripts/pr-prepare init <PR>

ls -la .local/review.md .local/review.json .local/pr-meta.env .local/prep-context.env
jq . .local/review.json >/dev/null
```

2. Resolve required findings

List required items:

```sh
jq -r '.findings[] | select(.severity=="BLOCKER" or .severity=="IMPORTANT") | "- [\(.severity)] \(.id): \(.title) => \(.fix)"' .local/review.json
```

Fix all required findings. Keep scope tight.

3. Update changelog/docs when required

```sh
jq -r '.changelog' .local/review.json
jq -r '.docs' .local/review.json
```

4. Commit scoped changes

Required commit subject format:

- `fix: <summary> (openclaw#<PR>) thanks @<pr-author>`

Use explicit file list:

```sh
source .local/pr-meta.env
scripts/committer "fix: <summary> (openclaw#$PR_NUMBER) thanks @$PR_AUTHOR" <file1> <file2> ...
```

Validate commit subject:

```sh
scripts/pr-prepare validate-commit <PR>
```

5. Run gates

```sh
scripts/pr-prepare gates <PR>
```

6. Push safely to PR head

```sh
scripts/pr-prepare push <PR>
```

This push step includes:

- robust fork remote resolution from owner/name,
- pre-push remote SHA verification,
- one automatic rebase + gate rerun + retry if lease push fails,
- post-push PR-head propagation retry,
- idempotent behavior when local prep HEAD is already on the PR head,
- post-push SHA verification and `.local/prep.env` generation.

7. Verify handoff artifacts

```sh
ls -la .local/prep.md .local/prep.env
```

8. Output

- Summarize resolved findings and gate results.
- Print exactly: `PR is ready for /merge-pr`.

## Guardrails

- Do not run `gh pr merge` in this skill.
- Do not delete worktree.
