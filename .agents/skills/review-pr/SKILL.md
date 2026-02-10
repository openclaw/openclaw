---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: review-pr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Review-only GitHub pull request analysis with the gh CLI. Use when asked to review a PR, provide structured feedback, or assess readiness to land. Do not merge, push, or make code changes you intend to keep.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Review PR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Perform a thorough review-only PR assessment and return a structured recommendation on readiness for /preparepr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask for PR number or URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, always ask. Never auto-detect from conversation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If ambiguous, ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never push to `main` or `origin/main`, not during review, not ever.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git push` at all during review. Treat review as read only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not stop or kill the gateway. Do not run gateway stop commands. Do not kill processes on port 18792.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Rule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Execute the workflow. Do not stop after printing the TODO checklist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If delegating, require the delegate to run commands and capture outputs, not a plan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known Failure Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see "fatal: not a git repository", you are in the wrong directory. Use `~/dev/openclaw` if available; otherwise ask user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not stop after printing the checklist. That is not completion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Writing Style for Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write casual and direct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid em dashes and en dashes. Use commas or separate sentences.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Completion Criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run the commands in the worktree and inspect the PR directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Produce the structured review sections A through J.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Save the full review to `.local/review.md` inside the worktree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First: Create a TODO Checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a checklist of all review steps, print it, then continue and execute the commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup: Use a Worktree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use an isolated worktree for all review work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/dev/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sanity: confirm you are in the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rev-parse --show-toplevel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKTREE_DIR=".worktrees/pr-<PR>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Reuse existing worktree if it exists, otherwise create new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ -d "$WORKTREE_DIR" ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cd "$WORKTREE_DIR"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  git checkout temp/pr-<PR> 2>/dev/null || git checkout -b temp/pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  git fetch origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  git reset --hard origin/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  git worktree add "$WORKTREE_DIR" -b temp/pr-<PR> origin/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cd "$WORKTREE_DIR"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create local scratch space that persists across /reviewpr to /preparepr to /mergepr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p .local（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run all commands inside the worktree directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start on `origin/main` so you can check for existing implementations before looking at PR code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Identify PR meta and context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,headRepository,url,body,labels,assignees,reviewRequests,files,additions,deletions --jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,headRepo:.headRepository.nameWithOwner,additions,deletions,files:.files|length,body}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Check if this already exists in main before looking at the PR branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Identify the core feature or fix from the PR title and description.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search for existing implementations using keywords from the PR title, changed file paths, and function or component names from the diff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use keywords from the PR title and changed files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rg -n "<keyword_from_pr_title>" -S src packages apps ui || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rg -n "<function_or_component_name>" -S src packages apps ui || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git log --oneline --all --grep="<keyword_from_pr_title>" | head -20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If it already exists, call it out as a BLOCKER or at least IMPORTANT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Claim the PR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Assign yourself so others know someone is reviewing. Skip if the PR looks like spam or is a draft you plan to recommend closing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh_user=$(gh api user --jq .login)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr edit <PR> --add-assignee "$gh_user"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Read the PR description carefully（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the body from step 1. Summarize goal, scope, and missing context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Read the diff thoroughly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimum:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr diff <PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need full code context locally, fetch the PR head to a local ref and diff it. Do not create a merge commit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin pull/<PR>/head:pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Show changes without modifying the working tree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git diff --stat origin/main..pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git diff origin/main..pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to browse the PR version of files directly, temporarily check out `pr-<PR>` in the worktree. Do not commit or push. Return to `temp/pr-<PR>` and reset to `origin/main` afterward.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use only if needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# git checkout pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ...inspect files...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git checkout temp/pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git reset --hard origin/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Validate the change is needed and valuable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Be honest. Call out low value AI slop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Evaluate implementation quality（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Review correctness, design, performance, and ergonomics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Perform a security review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Assume OpenClaw subagents run with full disk access, including git, gh, and shell. Check auth, input validation, secrets, dependencies, tool safety, and privacy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. Review tests and verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Identify what exists, what is missing, and what would be a minimal regression test.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. Check docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check if the PR touches code with related documentation such as README, docs, inline API docs, or config examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If docs exist for the changed area and the PR does not update them, flag as IMPORTANT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the PR adds a new feature or config option with no docs, flag as IMPORTANT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the change is purely internal with no user-facing impact, skip this.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
11. Check changelog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check if `CHANGELOG.md` exists and whether the PR warrants an entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the project has a changelog and the PR is user-facing, flag missing entry as IMPORTANT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Leave the change for /preparepr, only flag it here.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12. Answer the key question（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Decide if /preparepr can fix issues or the contributor must update the PR.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
13. Save findings to the worktree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write the full structured review sections A through J to `.local/review.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create or overwrite the file and verify it exists and is non-empty.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ls -la .local/review.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wc -l .local/review.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
14. Output the structured review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Produce a review that matches what you saved to `.local/review.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A) TL;DR recommendation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One of: READY FOR /preparepr | NEEDS WORK | NEEDS DISCUSSION | NOT USEFUL (CLOSE)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 1 to 3 sentences.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
B) What changed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
C) What is good（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
D) Security findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
E) Concerns or questions (actionable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Numbered list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mark each item as BLOCKER, IMPORTANT, or NIT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For each, point to file or area and propose a concrete fix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
F) Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
G) Docs status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State if related docs are up to date, missing, or not applicable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
H) Changelog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State if `CHANGELOG.md` needs an entry and which category.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
I) Follow ups (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
J) Suggested PR comment (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Guardrails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Worktree only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not delete the worktree after review.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Review only, do not merge, do not push.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
