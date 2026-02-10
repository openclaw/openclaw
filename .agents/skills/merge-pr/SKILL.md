---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: merge-pr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Merge a GitHub PR via squash after /preparepr. Use when asked to merge a ready PR. Do not push to main or modify code. Ensure the PR ends in MERGED state and clean up worktrees after success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Merge PR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Merge a prepared PR via `gh pr merge --squash` and clean up the worktree after success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask for PR number or URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, auto-detect from conversation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If ambiguous, ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `gh pr merge --squash` as the only path to `main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git push` at all during merge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Rule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Execute the workflow. Do not stop after printing the TODO checklist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If delegating, require the delegate to run commands and capture outputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known Footguns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see "fatal: not a git repository", you are in the wrong directory. Use `~/dev/openclaw` if available; otherwise ask user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read `.local/review.md` and `.local/prep.md` in the worktree. Do not skip.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clean up the real worktree directory `.worktrees/pr-<PR>` only after a successful merge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expect cleanup to remove `.local/` artifacts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Completion Criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure `gh pr merge` succeeds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure PR state is `MERGED`, never `CLOSED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Record the merge SHA.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run cleanup only after merge success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First: Create a TODO Checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a checklist of all merge steps, print it, then continue and execute the commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup: Use a Worktree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use an isolated worktree for all merge work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/dev/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sanity: confirm you are in the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rev-parse --show-toplevel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKTREE_DIR=".worktrees/pr-<PR>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run all commands inside the worktree directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Load Local Artifacts (Mandatory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expect these files from earlier steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.local/review.md` from `/reviewpr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.local/prep.md` from `/preparepr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ls -la .local || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ -f .local/review.md ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Found .local/review.md"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sed -n '1,120p' .local/review.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Missing .local/review.md. Stop and run /reviewpr, then /preparepr."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  exit 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ -f .local/prep.md ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Found .local/prep.md"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sed -n '1,120p' .local/prep.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Missing .local/prep.md. Stop and run /preparepr first."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  exit 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Identify PR meta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr view <PR> --json number,title,state,isDraft,author,headRefName,baseRefName,headRepository,body --jq '{number,title,state,isDraft,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,body}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
contrib=$(gh pr view <PR> --json author --jq .author.login)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
head=$(gh pr view <PR> --json headRefName --jq .headRefName)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run sanity checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stop if any are true:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PR is a draft.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Required checks are failing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Branch is behind main.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `.local/prep.md` contains `Docs-only change detected with high confidence; skipping pnpm test.`, that local test skip is allowed. CI checks still must be green.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr checks <PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check behind main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin pull/<PR>/head:pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git merge-base --is-ancestor origin/main pr-<PR> || echo "PR branch is behind main, run /preparepr"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If anything is failing or behind, stop and say to run `/preparepr`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Merge PR and delete branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If checks are still running, use `--auto` to queue the merge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check status first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
check_status=$(gh pr checks <PR> 2>&1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if echo "$check_status" | grep -q "pending\|queued"; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Checks still running, using --auto to queue merge"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gh pr merge <PR> --squash --delete-branch --auto（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Merge queued. Monitor with: gh pr checks <PR> --watch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gh pr merge <PR> --squash --delete-branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If merge fails, report the error and stop. Do not retry in a loop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the PR needs changes beyond what `/preparepr` already did, stop and say to run `/preparepr` again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Get merge SHA（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "merge_sha=$merge_sha"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Optional comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a literal multiline string or heredoc for newlines.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr comment <PR> -F - <<'EOF'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Merged via squash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Merge commit: $merge_sha（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thanks @$contrib!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Verify PR state is MERGED（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr view <PR> --json state --jq .state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Clean up worktree only on success（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run cleanup only if step 6 returned `MERGED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/dev/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git worktree remove ".worktrees/pr-<PR>" --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git branch -D temp/pr-<PR> 2>/dev/null || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git branch -D pr-<PR> 2>/dev/null || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Guardrails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Worktree only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not close PRs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- End in MERGED state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clean up only after merge success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never push to main. Use `gh pr merge --squash` only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git push` at all in this command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
