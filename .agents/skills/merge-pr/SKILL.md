---
name: merge-pr
description: Merge a GitHub PR via squash after /preparepr. Use when asked to merge a ready PR. Do not push to main or modify code. Ensure the PR ends in MERGED state and clean up worktrees after success.
---

# Merge PR

## Overview

Merge a prepared PR via `gh pr merge --squash` and clean up the worktree after success.

## Inputs

- Ask for PR number or URL.
- If missing, auto-detect from conversation.
- If ambiguous, ask.

## Safety

- Use `gh pr merge --squash` as the only path to `main`.
- Do not run `git push` at all during merge.
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.

## Execution Rule

- Execute the workflow. Do not stop after printing the TODO checklist.
- If delegating, require the delegate to run commands and capture outputs.

## Known Footguns

- If you see "fatal: not a git repository", you are in the wrong directory. Use `~/dev/openclaw` if available; otherwise ask user.
- Read `.local/review.md` and `.local/prep.md` in the worktree. Do not skip.
- Clean up the real worktree directory `.worktrees/pr-<PR>` only after a successful merge.
- Expect cleanup to remove `.local/` artifacts.

## Completion Criteria

- Ensure `gh pr merge` succeeds.
- Ensure PR state is `MERGED`, never `CLOSED`.
- Record the merge SHA.
- Run cleanup only after merge success.

## First: Create a TODO Checklist

Create a checklist of all merge steps, print it, then continue and execute the commands.

## Setup: Use a Worktree

Use an isolated worktree for all merge work.

```sh
cd ~/dev/openclaw
# Sanity: confirm you are in the repo
git rev-parse --show-toplevel

WORKTREE_DIR=".worktrees/pr-<PR>"
```

Run all commands inside the worktree directory.

## Load Local Artifacts (Mandatory)

Expect these files from earlier steps:

- `.local/review.md` from `/reviewpr`
- `.local/prep.md` from `/preparepr`

```sh
ls -la .local || true

if [ -f .local/review.md ]; then
  echo "Found .local/review.md"
  sed -n '1,120p' .local/review.md
else
  echo "Missing .local/review.md. Stop and run /reviewpr, then /preparepr."
  exit 1
fi

if [ -f .local/prep.md ]; then
  echo "Found .local/prep.md"
  sed -n '1,120p' .local/prep.md
else
  echo "Missing .local/prep.md. Stop and run /preparepr first."
  exit 1
fi
```

## Steps

1. Identify PR meta

```sh
gh pr view <PR> --json number,title,state,isDraft,author,headRefName,baseRefName,headRepository,body --jq '{number,title,state,isDraft,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,body}'
contrib=$(gh pr view <PR> --json author --jq .author.login)
head=$(gh pr view <PR> --json headRefName --jq .headRefName)
head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)
```

2. Run sanity checks

Stop if any are true:

- PR is a draft.
- Required checks are failing.
- Branch is behind main.

```sh
# Checks
gh pr checks <PR>

# Check behind main
git fetch origin main
git fetch origin pull/<PR>/head:pr-<PR>
git merge-base --is-ancestor origin/main pr-<PR> || echo "PR branch is behind main, run /preparepr"
```

If anything is failing or behind, stop and say to run `/preparepr`.

3. Merge PR and delete branch

If checks are still running, use `--auto` to queue the merge.

```sh
# Check status first
check_status=$(gh pr checks <PR> 2>&1)
if echo "$check_status" | grep -q "pending\|queued"; then
  echo "Checks still running, using --auto to queue merge"
  gh pr merge <PR> --squash --delete-branch --auto
  echo "Merge queued. Monitor with: gh pr checks <PR> --watch"
else
  gh pr merge <PR> --squash --delete-branch
fi
```

If merge fails, report the error and stop. Do not retry in a loop.
If the PR needs changes beyond what `/preparepr` already did, stop and say to run `/preparepr` again.

4. Get merge SHA

```sh
merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')
echo "merge_sha=$merge_sha"
```

5. Optional comment

Use a literal multiline string or heredoc for newlines.

```sh
gh pr comment <PR> -F - <<'EOF'
Merged via squash.

- Merge commit: $merge_sha

Thanks @$contrib!
EOF
```

6. Verify PR state is MERGED

```sh
gh pr view <PR> --json state --jq .state
```

7. Clean up worktree only on success

Run cleanup only if step 6 returned `MERGED`.

```sh
cd ~/dev/openclaw

git worktree remove ".worktrees/pr-<PR>" --force

git branch -D temp/pr-<PR> 2>/dev/null || true
git branch -D pr-<PR> 2>/dev/null || true
```

## Guardrails

- Worktree only.
- Do not close PRs.
- End in MERGED state.
- Clean up only after merge success.
- Never push to main. Use `gh pr merge --squash` only.
- Do not run `git push` at all in this command.
