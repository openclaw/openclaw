---
name: review-pr
description: Review-only GitHub pull request analysis with the gh CLI. Use when asked to review a PR, provide structured feedback, or assess readiness to land. Do not merge, push, or make code changes you intend to keep.
---

# Review PR

## Overview

Perform a thorough review-only PR assessment and return a structured recommendation on readiness for /prepare-pr.

## Inputs

- Ask for PR number or URL.
- If missing, always ask. Never auto-detect from conversation.
- If ambiguous, ask.

## Safety

- Never push to `main` or `origin/main`, not during review, not ever.
- Do not run `git push` at all during review. Treat review as read only.
- Do not stop or kill the gateway. Do not run gateway stop commands. Do not kill processes on port 18792.

## Execution Rule

- Execute the workflow. Do not stop after printing the TODO checklist.
- If delegating, require the delegate to run commands and capture outputs, not a plan.

## Known Failure Modes

- If you see "fatal: not a git repository", you are in the wrong directory. Move to the repository root and retry.
- Do not stop after printing the checklist. That is not completion.

## Writing Style for Output

- Write casual and direct.
- Avoid em dashes and en dashes. Use commas or separate sentences.

## Completion Criteria

- Run the commands in the worktree and inspect the PR directly.
- Produce the structured review sections A through J.
- Save the full review to `.local/review.md` inside the worktree.
- Save PR metadata handoff to `.local/pr-meta.env` inside the worktree.

## First: Create a TODO Checklist

Create a checklist of all review steps, print it, then continue and execute the commands.

## Setup: Use a Worktree

Use an isolated worktree for all review work.

```sh
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
gh auth status

WORKTREE_DIR=".worktrees/pr-<PR>"
git fetch origin main

# Reuse existing worktree if it exists, otherwise create new
if [ -d "$WORKTREE_DIR" ]; then
  git worktree list
  cd "$WORKTREE_DIR"
  git fetch origin main
  git checkout -B temp/pr-<PR> origin/main
else
  git worktree add "$WORKTREE_DIR" -b temp/pr-<PR> origin/main
  cd "$WORKTREE_DIR"
fi

# Create local scratch space that persists across /review-pr to /prepare-pr to /merge-pr
mkdir -p .local
```

Run all commands inside the worktree directory.
Start on `origin/main` so you can check for existing implementations before looking at PR code.

## Steps

1. Identify PR meta and context

```sh
pr_meta_json=$(gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,url,body,labels,assignees,reviewRequests,files,additions,deletions,statusCheckRollup)
printf '%s\n' "$pr_meta_json" | jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,headSha:.headRefOid,headRepo:.headRepository.nameWithOwner,additions,deletions,files:(.files|length),body}'

cat > .local/pr-meta.env <<EOF
PR_NUMBER=$(printf '%s\n' "$pr_meta_json" | jq -r .number)
PR_URL=$(printf '%s\n' "$pr_meta_json" | jq -r .url)
PR_AUTHOR=$(printf '%s\n' "$pr_meta_json" | jq -r .author.login)
PR_BASE=$(printf '%s\n' "$pr_meta_json" | jq -r .baseRefName)
PR_HEAD=$(printf '%s\n' "$pr_meta_json" | jq -r .headRefName)
PR_HEAD_SHA=$(printf '%s\n' "$pr_meta_json" | jq -r .headRefOid)
PR_HEAD_REPO=$(printf '%s\n' "$pr_meta_json" | jq -r .headRepository.nameWithOwner)
EOF

ls -la .local/pr-meta.env
```

2. Check if this already exists in main before looking at the PR branch

- Identify the core feature or fix from the PR title and description.
- Search for existing implementations using keywords from the PR title, changed file paths, and function or component names from the diff.

```sh
# Use keywords from the PR title and changed files
rg -n "<keyword_from_pr_title>" -S src packages apps ui || true
rg -n "<function_or_component_name>" -S src packages apps ui || true

git log --oneline --all --grep="<keyword_from_pr_title>" | head -20
```

If it already exists, call it out as a BLOCKER or at least IMPORTANT.

3. Claim the PR

Assign yourself so others know someone is reviewing. Skip if the PR looks like spam or is a draft you plan to recommend closing.

```sh
gh_user=$(gh api user --jq .login)
gh pr edit <PR> --add-assignee "$gh_user" || echo "Could not assign reviewer, continuing"
```

4. Read the PR description carefully

Use the body from step 1. Summarize goal, scope, and missing context.

5. Read the diff thoroughly

Minimum:

```sh
gh pr diff <PR>
```

If you need full code context locally, fetch the PR head to a local ref and diff it. Do not create a merge commit.

```sh
git fetch origin pull/<PR>/head:pr-<PR> --force
mb=$(git merge-base origin/main pr-<PR>)

# Show only this PR patch relative to merge-base, not total branch drift
git diff --stat "$mb"..pr-<PR>
git diff "$mb"..pr-<PR>
```

If you want to browse the PR version of files directly, temporarily check out `pr-<PR>` in the worktree. Do not commit or push. Return to `temp/pr-<PR>` and reset to `origin/main` afterward.

```sh
# Use only if needed
# git checkout pr-<PR>
# git branch --show-current
# ...inspect files...

git checkout temp/pr-<PR>
git checkout -B temp/pr-<PR> origin/main
git branch --show-current
```

6. Validate the change is needed and valuable

Be honest. Call out low value AI slop.

7. Evaluate implementation quality

Review correctness, design, performance, and ergonomics.

8. Perform a security review

Assume OpenClaw subagents run with full disk access, including git, gh, and shell. Check auth, input validation, secrets, dependencies, tool safety, and privacy.

9. Review tests and verification

Identify what exists, what is missing, and what would be a minimal regression test.

If you run local tests in the worktree, bootstrap dependencies first:

```sh
if [ ! -x node_modules/.bin/vitest ]; then
  pnpm install --frozen-lockfile
fi
```

10. Check docs

Check if the PR touches code with related documentation such as README, docs, inline API docs, or config examples.

- If docs exist for the changed area and the PR does not update them, flag as IMPORTANT.
- If the PR adds a new feature or config option with no docs, flag as IMPORTANT.
- If the change is purely internal with no user-facing impact, skip this.

11. Check changelog

Check if `CHANGELOG.md` exists and whether the PR warrants an entry.

- If the project has a changelog and the PR is user-facing, flag missing entry as IMPORTANT.
- Leave the change for /prepare-pr, only flag it here.

12. Answer the key question

Decide if /prepare-pr can fix issues or the contributor must update the PR.

13. Save findings to the worktree

Write the full structured review sections A through J to `.local/review.md`.
Create or overwrite the file and verify it exists and is non-empty.

```sh
ls -la .local/review.md
wc -l .local/review.md
```

14. Output the structured review

Produce a review that matches what you saved to `.local/review.md`.

A) TL;DR recommendation

- One of: READY FOR /prepare-pr | NEEDS WORK | NEEDS DISCUSSION | NOT USEFUL (CLOSE)
- 1 to 3 sentences.

B) What changed

C) What is good

D) Security findings

E) Concerns or questions (actionable)

- Numbered list.
- Mark each item as BLOCKER, IMPORTANT, or NIT.
- For each, point to file or area and propose a concrete fix.

F) Tests

G) Docs status

- State if related docs are up to date, missing, or not applicable.

H) Changelog

- State if `CHANGELOG.md` needs an entry and which category.

I) Follow ups (optional)

J) Suggested PR comment (optional)

## Guardrails

- Worktree only.
- Do not delete the worktree after review.
- Review only, do not merge, do not push.
