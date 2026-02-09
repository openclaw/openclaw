---
name: prepare-pr
description: Prepare a GitHub PR for merge by rebasing onto main, fixing review findings, running gates, committing fixes, and pushing to the PR head branch. Use after /reviewpr. Never merge or push to main.
---

# Prepare PR

## Overview

Prepare a PR branch for merge with review fixes, green gates, and an updated head branch.

## Inputs

- Ask for PR number or URL.
- If missing, auto-detect from conversation.
- If ambiguous, ask.

## Safety

- Never push to `main` or `origin/main`. Push only to the PR head branch.
- Never run `git push` without specifying remote and branch explicitly. Do not run bare `git push`.
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.
- Do not run `git clean -fdx`.
- Do not run `git add -A` or `git add .`. Stage only specific files changed.

## Execution Rule

- Execute the workflow. Do not stop after printing the TODO checklist.
- If delegating, require the delegate to run commands and capture outputs.

## Known Footguns

- If you see "fatal: not a git repository", you are in the wrong directory. Use `~/dev/openclaw` if available; otherwise ask user.
- Do not run `git clean -fdx`.
- Do not run `git add -A` or `git add .`.

## Completion Criteria

- Rebase PR commits onto `origin/main`.
- Fix all BLOCKER and IMPORTANT items from `.local/review.md`.
- Run required gates and pass (docs-only PRs may skip `pnpm test` when high-confidence docs-only criteria are met and documented).
- Commit prep changes.
- Push the updated HEAD back to the PR head branch.
- Write `.local/prep.md` with a prep summary.
- Output exactly: `PR is ready for /mergepr`.

## First: Create a TODO Checklist

Create a checklist of all prep steps, print it, then continue and execute the commands.

## Setup: Use a Worktree

Use an isolated worktree for all prep work.

```sh
cd ~/openclaw
# Sanity: confirm you are in the repo
git rev-parse --show-toplevel

WORKTREE_DIR=".worktrees/pr-<PR>"
```

Run all commands inside the worktree directory.

## Load Review Findings (Mandatory)

```sh
if [ -f .local/review.md ]; then
  echo "Found review findings from /reviewpr"
else
  echo "Missing .local/review.md. Run /reviewpr first and save findings."
  exit 1
fi

# Read it
sed -n '1,200p' .local/review.md
```

## Steps

1. Identify PR meta (author, head branch, head repo URL)

```sh
gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository,body --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,body}'
contrib=$(gh pr view <PR> --json author --jq .author.login)
head=$(gh pr view <PR> --json headRefName --jq .headRefName)
head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)
```

2. Fetch the PR branch tip into a local ref

```sh
git fetch origin pull/<PR>/head:pr-<PR>
```

3. Rebase PR commits onto latest main

```sh
# Move worktree to the PR tip first
git reset --hard pr-<PR>

# Rebase onto current main
git fetch origin main
git rebase origin/main
```

If conflicts happen:

- Resolve each conflicted file.
- Run `git add <resolved_file>` for each file.
- Run `git rebase --continue`.

If the rebase gets confusing or you resolve conflicts 3 or more times, stop and report.

4. Fix issues from `.local/review.md`

- Fix all BLOCKER and IMPORTANT items.
- NITs are optional.
- Keep scope tight.

Keep a running log in `.local/prep.md`:

- List which review items you fixed.
- List which files you touched.
- Note behavior changes.

5. Update `CHANGELOG.md` if flagged in review

Check `.local/review.md` section H for guidance.
If flagged and user-facing:

- Check if `CHANGELOG.md` exists.

```sh
ls CHANGELOG.md 2>/dev/null
```

- Follow existing format.
- Add a concise entry with PR number and contributor.

6. Update docs if flagged in review

Check `.local/review.md` section G for guidance.
If flagged, update only docs related to the PR changes.

7. Commit prep fixes

Stage only specific files:

```sh
git add <file1> <file2> ...
```

Preferred commit tool:

```sh
committer "fix: <summary> (#<PR>) (thanks @$contrib)" <changed files>
```

If `committer` is not found:

```sh
git commit -m "fix: <summary> (#<PR>) (thanks @$contrib)"
```

8. Decide verification mode and run required gates before pushing

If you are highly confident the change is docs-only, you may skip `pnpm test`.

High-confidence docs-only criteria (all must be true):

- Every changed file is documentation-only (`docs/**`, `README*.md`, `CHANGELOG.md`, `*.md`, `*.mdx`, `mintlify.json`, `docs.json`).
- No code, runtime, test, dependency, or build config files changed (`src/**`, `extensions/**`, `apps/**`, `package.json`, lockfiles, TS/JS config, test files, scripts).
- `.local/review.md` does not call for non-doc behavior fixes.

Suggested check:

```sh
changed_files=$(git diff --name-only origin/main...HEAD)
non_docs=$(printf "%s\n" "$changed_files" | grep -Ev '^(docs/|README.*\.md$|CHANGELOG\.md$|.*\.md$|.*\.mdx$|mintlify\.json$|docs\.json$)' || true)

docs_only=false
if [ -n "$changed_files" ] && [ -z "$non_docs" ]; then
  docs_only=true
fi

echo "docs_only=$docs_only"
```

Run required gates:

```sh
pnpm install
pnpm build
pnpm ui:build
pnpm check

if [ "$docs_only" = "true" ]; then
  echo "Docs-only change detected with high confidence; skipping pnpm test." | tee -a .local/prep.md
else
  pnpm test
fi
```

Require all required gates to pass. If something fails, fix, commit, and rerun. Allow at most 3 fix and rerun cycles. If gates still fail after 3 attempts, stop and report the failures. Do not loop indefinitely.

9. Push updates back to the PR head branch

```sh
# Ensure remote for PR head exists
git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"

# Use force with lease after rebase
# Double check: $head must NOT be "main" or "master"
echo "Pushing to branch: $head"
if [ "$head" = "main" ] || [ "$head" = "master" ]; then
  echo "ERROR: head branch is main/master. This is wrong. Stopping."
  exit 1
fi
git push --force-with-lease prhead HEAD:$head
```

10. Verify PR is not behind main (Mandatory)

```sh
git fetch origin main
git fetch origin pull/<PR>/head:pr-<PR>-verify --force
git merge-base --is-ancestor origin/main pr-<PR>-verify && echo "PR is up to date with main" || echo "ERROR: PR is still behind main, rebase again"
git branch -D pr-<PR>-verify 2>/dev/null || true
```

If still behind main, repeat steps 2 through 9.

11. Write prep summary artifacts (Mandatory)

Update `.local/prep.md` with:

- Current HEAD sha from `git rev-parse HEAD`.
- Short bullet list of changes.
- Gate results.
- Push confirmation.
- Rebase verification result.

Create or overwrite `.local/prep.md` and verify it exists and is non-empty:

```sh
git rev-parse HEAD
ls -la .local/prep.md
wc -l .local/prep.md
```

12. Output

Include a diff stat summary:

```sh
git diff --stat origin/main..HEAD
git diff --shortstat origin/main..HEAD
```

Report totals: X files changed, Y insertions(+), Z deletions(-).

If gates passed and push succeeded, print exactly:

```
PR is ready for /mergepr
```

Otherwise, list remaining failures and stop.

## Guardrails

- Worktree only.
- Do not delete the worktree on success. `/mergepr` may reuse it.
- Do not run `gh pr merge`.
- Never push to main. Only push to the PR head branch.
- Run and pass all required gates before pushing. `pnpm test` may be skipped only for high-confidence docs-only changes, and the skip must be explicitly recorded in `.local/prep.md`.
