---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: prepare-pr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Prepare a GitHub PR for merge by rebasing onto main, fixing review findings, running gates, committing fixes, and pushing to the PR head branch. Use after /reviewpr. Never merge or push to main.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Prepare PR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prepare a PR branch for merge with review fixes, green gates, and an updated head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask for PR number or URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, auto-detect from conversation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If ambiguous, ask.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never push to `main` or `origin/main`. Push only to the PR head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never run `git push` without specifying remote and branch explicitly. Do not run bare `git push`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run gateway stop commands. Do not kill processes. Do not touch port 18792.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git clean -fdx`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git add -A` or `git add .`. Stage only specific files changed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Rule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Execute the workflow. Do not stop after printing the TODO checklist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If delegating, require the delegate to run commands and capture outputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known Footguns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see "fatal: not a git repository", you are in the wrong directory. Use `~/dev/openclaw` if available; otherwise ask user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git clean -fdx`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `git add -A` or `git add .`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Completion Criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rebase PR commits onto `origin/main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix all BLOCKER and IMPORTANT items from `.local/review.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run required gates and pass (docs-only PRs may skip `pnpm test` when high-confidence docs-only criteria are met and documented).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commit prep changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Push the updated HEAD back to the PR head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write `.local/prep.md` with a prep summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output exactly: `PR is ready for /mergepr`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First: Create a TODO Checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a checklist of all prep steps, print it, then continue and execute the commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup: Use a Worktree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use an isolated worktree for all prep work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sanity: confirm you are in the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rev-parse --show-toplevel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKTREE_DIR=".worktrees/pr-<PR>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run all commands inside the worktree directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Load Review Findings (Mandatory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ -f .local/review.md ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Found review findings from /reviewpr"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Missing .local/review.md. Run /reviewpr first and save findings."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  exit 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Read it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sed -n '1,200p' .local/review.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Identify PR meta (author, head branch, head repo URL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository,body --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner,body}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
contrib=$(gh pr view <PR> --json author --jq .author.login)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
head=$(gh pr view <PR> --json headRefName --jq .headRefName)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fetch the PR branch tip into a local ref（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin pull/<PR>/head:pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Rebase PR commits onto latest main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Move worktree to the PR tip first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git reset --hard pr-<PR>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Rebase onto current main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rebase origin/main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If conflicts happen:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolve each conflicted file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `git add <resolved_file>` for each file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `git rebase --continue`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the rebase gets confusing or you resolve conflicts 3 or more times, stop and report.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Fix issues from `.local/review.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix all BLOCKER and IMPORTANT items.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- NITs are optional.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep scope tight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep a running log in `.local/prep.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List which review items you fixed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List which files you touched.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Note behavior changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Update `CHANGELOG.md` if flagged in review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check `.local/review.md` section H for guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If flagged and user-facing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check if `CHANGELOG.md` exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ls CHANGELOG.md 2>/dev/null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Follow existing format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a concise entry with PR number and contributor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Update docs if flagged in review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check `.local/review.md` section G for guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If flagged, update only docs related to the PR changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Commit prep fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stage only specific files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git add <file1> <file2> ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred commit tool:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
committer "fix: <summary> (#<PR>) (thanks @$contrib)" <changed files>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `committer` is not found:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git commit -m "fix: <summary> (#<PR>) (thanks @$contrib)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Decide verification mode and run required gates before pushing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are highly confident the change is docs-only, you may skip `pnpm test`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
High-confidence docs-only criteria (all must be true):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Every changed file is documentation-only (`docs/**`, `README*.md`, `CHANGELOG.md`, `*.md`, `*.mdx`, `mintlify.json`, `docs.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No code, runtime, test, dependency, or build config files changed (`src/**`, `extensions/**`, `apps/**`, `package.json`, lockfiles, TS/JS config, test files, scripts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.local/review.md` does not call for non-doc behavior fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Suggested check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
changed_files=$(git diff --name-only origin/main...HEAD)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
non_docs=$(printf "%s\n" "$changed_files" | grep -Ev '^(docs/|README.*\.md$|CHANGELOG\.md$|.*\.md$|.*\.mdx$|mintlify\.json$|docs\.json$)' || true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docs_only=false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ -n "$changed_files" ] && [ -z "$non_docs" ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  docs_only=true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "docs_only=$docs_only"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run required gates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ "$docs_only" = "true" ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "Docs-only change detected with high confidence; skipping pnpm test." | tee -a .local/prep.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  pnpm test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Require all required gates to pass. If something fails, fix, commit, and rerun. Allow at most 3 fix and rerun cycles. If gates still fail after 3 attempts, stop and report the failures. Do not loop indefinitely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. Push updates back to the PR head branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Ensure remote for PR head exists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use force with lease after rebase（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Double check: $head must NOT be "main" or "master"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "Pushing to branch: $head"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if [ "$head" = "main" ] || [ "$head" = "master" ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "ERROR: head branch is main/master. This is wrong. Stopping."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  exit 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git push --force-with-lease prhead HEAD:$head（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. Verify PR is not behind main (Mandatory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin pull/<PR>/head:pr-<PR>-verify --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git merge-base --is-ancestor origin/main pr-<PR>-verify && echo "PR is up to date with main" || echo "ERROR: PR is still behind main, rebase again"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git branch -D pr-<PR>-verify 2>/dev/null || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If still behind main, repeat steps 2 through 9.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
11. Write prep summary artifacts (Mandatory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update `.local/prep.md` with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Current HEAD sha from `git rev-parse HEAD`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Short bullet list of changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gate results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Push confirmation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rebase verification result.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create or overwrite `.local/prep.md` and verify it exists and is non-empty:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git rev-parse HEAD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ls -la .local/prep.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wc -l .local/prep.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12. Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Include a diff stat summary:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git diff --stat origin/main..HEAD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git diff --shortstat origin/main..HEAD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Report totals: X files changed, Y insertions(+), Z deletions(-).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If gates passed and push succeeded, print exactly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PR is ready for /mergepr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Otherwise, list remaining failures and stop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Guardrails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Worktree only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not delete the worktree on success. `/mergepr` may reuse it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not run `gh pr merge`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never push to main. Only push to the PR head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run and pass all required gates before pushing. `pnpm test` may be skipped only for high-confidence docs-only changes, and the skip must be explicitly recorded in `.local/prep.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
