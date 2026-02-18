---
name: prepare-pr
description: Prepare a GitHub PR for merge by rebasing onto main, fixing review findings, running gates, committing fixes, and pushing to the PR head branch. Use after /review-pr. Never merge or push to main.
---

# Prepare PR

## Overview

Prepare a PR head branch for merge with review fixes, green gates, and deterministic merge handoff artifacts.

## Inputs

- Ask for PR number or URL.
- If missing, use `.local/pr-meta.env` from the PR worktree if present.
- If ambiguous, ask.

## Safety

- Never push to `main` or `origin/main`. Push only to the PR head branch.
- Never run `git push` without explicit remote and branch. Do not run bare `git push`.
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.
- Do not run `git clean -fdx`.
- Do not run `git add -A` or `git add .`.

## Execution Rule

- Execute the workflow. Do not stop after printing the TODO checklist.
- If delegating, require the delegate to run commands and capture outputs.

## Completion Criteria

- Rebase PR commits onto `origin/main`.
- Fix all BLOCKER and IMPORTANT items from `.local/review.md`.
- Commit prep changes with required subject format.
- Run required gates and pass (`pnpm test` may be skipped only for high-confidence docs-only changes).
- Push the updated HEAD back to the PR head branch.
- Write `.local/prep.md` and `.local/prep.env`.
- Output exactly: `PR is ready for /mergepr`.

## First: Create a TODO Checklist

Create a checklist of all prep steps, print it, then continue and execute the commands.

## Setup: Use a Worktree

Use an isolated worktree for all prep work.

```sh
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
gh auth status

WORKTREE_DIR=".worktrees/pr-<PR>"
if [ ! -d "$WORKTREE_DIR" ]; then
  git fetch origin main
  git worktree add "$WORKTREE_DIR" -b temp/pr-<PR> origin/main
fi
cd "$WORKTREE_DIR"
mkdir -p .local
```

Run all commands inside the worktree directory.

## Load Review Artifacts (Mandatory)

```sh
if [ ! -f .local/review.md ]; then
  echo "Missing .local/review.md. Run /review-pr first and save findings."
  exit 1
fi

if [ ! -f .local/pr-meta.env ]; then
  echo "Missing .local/pr-meta.env. Run /review-pr first and save metadata."
  exit 1
fi

sed -n '1,220p' .local/review.md
source .local/pr-meta.env
```

## Steps

1. Identify PR meta with one API call

```sh
pr_meta_json=$(gh pr view <PR> --json number,title,author,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,body)
printf '%s\n' "$pr_meta_json" | jq '{number,title,author:.author.login,head:.headRefName,headSha:.headRefOid,base:.baseRefName,headRepo:.headRepository.nameWithOwner,headRepoOwner:.headRepositoryOwner.login,headRepoName:.headRepository.name,body}'

pr_number=$(printf '%s\n' "$pr_meta_json" | jq -r .number)
contrib=$(printf '%s\n' "$pr_meta_json" | jq -r .author.login)
head=$(printf '%s\n' "$pr_meta_json" | jq -r .headRefName)
pr_head_sha_before=$(printf '%s\n' "$pr_meta_json" | jq -r .headRefOid)
head_owner=$(printf '%s\n' "$pr_meta_json" | jq -r '.headRepositoryOwner.login // empty')
head_repo_name=$(printf '%s\n' "$pr_meta_json" | jq -r '.headRepository.name // empty')
head_repo_url=$(printf '%s\n' "$pr_meta_json" | jq -r '.headRepository.url // empty')

if [ -n "${PR_HEAD:-}" ] && [ "$head" != "$PR_HEAD" ]; then
  echo "ERROR: PR head branch changed from $PR_HEAD to $head. Re-run /review-pr."
  exit 1
fi
```

2. Fetch PR head and rebase on latest `origin/main`

```sh
git fetch origin pull/<PR>/head:pr-<PR> --force
git checkout -B pr-<PR>-prep pr-<PR>
git fetch origin main
git rebase origin/main
```

If conflicts happen:

- Resolve each conflicted file.
- Run `git add <resolved_file>` for each file.
- Run `git rebase --continue`.

If the rebase gets confusing or you resolve conflicts 3 or more times, stop and report.

3. Fix issues from `.local/review.md`

- Fix all BLOCKER and IMPORTANT items.
- NITs are optional.
- Keep scope tight.

Keep a running log in `.local/prep.md`:

- List which review items you fixed.
- List which files you touched.
- Note behavior changes.

4. Optional quick feedback tests before full gates

Targeted tests are optional quick feedback, not a substitute for full gates.

If running targeted tests in a fresh worktree:

```sh
if [ ! -x node_modules/.bin/vitest ]; then
  pnpm install --frozen-lockfile
fi
```

5. Commit prep fixes with required subject format

Use `scripts/committer` with explicit file paths.

Required subject format:

- `fix: <summary> (openclaw#<PR>) thanks @<author>`

```sh
commit_msg="fix: <summary> (openclaw#$pr_number) thanks @$contrib"
scripts/committer "$commit_msg" <changed file 1> <changed file 2> ...
```

If there are no local changes, do not create a no-op commit.

Post-commit validation (mandatory):

```sh
subject=$(git log -1 --pretty=%s)
echo "$subject" | rg -q "openclaw#$pr_number" || { echo "ERROR: commit subject missing openclaw#$pr_number"; exit 1; }
echo "$subject" | rg -q "thanks @$contrib" || { echo "ERROR: commit subject missing thanks @$contrib"; exit 1; }
```

6. Decide verification mode and run required gates before pushing

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

Bootstrap dependencies in a fresh worktree before gates:

```sh
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
```

Run required gates:

```sh
pnpm build
pnpm check

if [ "$docs_only" = "true" ]; then
  echo "Docs-only change detected with high confidence; skipping pnpm test." | tee -a .local/prep.md
else
  pnpm test
fi
```

Require all required gates to pass. If something fails, fix, commit, and rerun. Allow at most 3 fix-and-rerun cycles.

7. Push safely to the PR head branch

Build `prhead` from owner/name first, then validate remote branch SHA before push.

```sh
if [ -n "$head_owner" ] && [ -n "$head_repo_name" ]; then
  head_repo_push_url="https://github.com/$head_owner/$head_repo_name.git"
elif [ -n "$head_repo_url" ] && [ "$head_repo_url" != "null" ]; then
  case "$head_repo_url" in
    *.git) head_repo_push_url="$head_repo_url" ;;
    *) head_repo_push_url="$head_repo_url.git" ;;
  esac
else
  echo "ERROR: unable to determine PR head repo push URL"
  exit 1
fi

git remote add prhead "$head_repo_push_url" 2>/dev/null || git remote set-url prhead "$head_repo_push_url"

echo "Pushing to branch: $head"
if [ "$head" = "main" ] || [ "$head" = "master" ]; then
  echo "ERROR: head branch is main/master. This is wrong. Stopping."
  exit 1
fi

remote_sha=$(git ls-remote prhead "refs/heads/$head" | awk '{print $1}')
if [ -z "$remote_sha" ]; then
  echo "ERROR: remote branch refs/heads/$head not found on prhead"
  exit 1
fi
if [ "$remote_sha" != "$pr_head_sha_before" ]; then
  echo "ERROR: expected remote SHA $pr_head_sha_before, got $remote_sha. Re-fetch metadata and rebase first."
  exit 1
fi

git push --force-with-lease=refs/heads/$head:$pr_head_sha_before prhead HEAD:$head || push_failed=1
```

If lease push fails because head moved, perform one automatic retry:

```sh
if [ "${push_failed:-0}" = "1" ]; then
  echo "Lease push failed, retrying once with fresh PR head..."

  pr_head_sha_before=$(gh pr view <PR> --json headRefOid --jq .headRefOid)
  git fetch origin pull/<PR>/head:pr-<PR>-latest --force
  git rebase pr-<PR>-latest

  pnpm build
  pnpm check
  if [ "$docs_only" != "true" ]; then
    pnpm test
  fi

  git push --force-with-lease=refs/heads/$head:$pr_head_sha_before prhead HEAD:$head
fi
```

8. Verify PR head and base relation (Mandatory)

```sh
prep_head_sha=$(git rev-parse HEAD)
pr_head_sha_after=$(gh pr view <PR> --json headRefOid --jq .headRefOid)

if [ "$prep_head_sha" != "$pr_head_sha_after" ]; then
  echo "ERROR: pushed head SHA does not match PR head SHA."
  exit 1
fi

git fetch origin main
git fetch origin pull/<PR>/head:pr-<PR>-verify --force
git merge-base --is-ancestor origin/main pr-<PR>-verify && echo "PR is up to date with main" || (echo "ERROR: PR is still behind main, rebase again" && exit 1)
git branch -D pr-<PR>-verify 2>/dev/null || true
```

9. Write prep summary artifacts (Mandatory)

Write `.local/prep.md` and `.local/prep.env` for merge handoff.

```sh
contrib_id=$(gh api users/$contrib --jq .id)
coauthor_email="${contrib_id}+${contrib}@users.noreply.github.com"

cat > .local/prep.env <<EOF_ENV
PR_NUMBER=$pr_number
PR_AUTHOR=$contrib
PR_HEAD=$head
PR_HEAD_SHA_BEFORE=$pr_head_sha_before
PREP_HEAD_SHA=$prep_head_sha
COAUTHOR_EMAIL=$coauthor_email
EOF_ENV

ls -la .local/prep.md .local/prep.env
wc -l .local/prep.md .local/prep.env
```

10. Output

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
