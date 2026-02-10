---（轉為繁體中文）
description: Land a PR (merge with proper workflow)（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
Input（轉為繁體中文）
（轉為繁體中文）
- PR: $1 <number|url>（轉為繁體中文）
  - If missing: use the most recent PR mentioned in the conversation.（轉為繁體中文）
  - If ambiguous: ask.（轉為繁體中文）
（轉為繁體中文）
Do (end-to-end)（轉為繁體中文）
Goal: PR must end in GitHub state = MERGED (never CLOSED). Use `gh pr merge` with `--rebase` or `--squash`.（轉為繁體中文）
（轉為繁體中文）
1. Repo clean: `git status`.（轉為繁體中文）
2. Identify PR meta (author + head branch):（轉為繁體中文）
（轉為繁體中文）
   ```sh（轉為繁體中文）
   gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner}'（轉為繁體中文）
   contrib=$(gh pr view <PR> --json author --jq .author.login)（轉為繁體中文）
   head=$(gh pr view <PR> --json headRefName --jq .headRefName)（轉為繁體中文）
   head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
3. Fast-forward base:（轉為繁體中文）
   - `git checkout main`（轉為繁體中文）
   - `git pull --ff-only`（轉為繁體中文）
4. Create temp base branch from main:（轉為繁體中文）
   - `git checkout -b temp/landpr-<ts-or-pr>`（轉為繁體中文）
5. Check out PR branch locally:（轉為繁體中文）
   - `gh pr checkout <PR>`（轉為繁體中文）
6. Rebase PR branch onto temp base:（轉為繁體中文）
   - `git rebase temp/landpr-<ts-or-pr>`（轉為繁體中文）
   - Fix conflicts; keep history tidy.（轉為繁體中文）
7. Fix + tests + changelog:（轉為繁體中文）
   - Implement fixes + add/adjust tests（轉為繁體中文）
   - Update `CHANGELOG.md` and mention `#<PR>` + `@$contrib`（轉為繁體中文）
8. Decide merge strategy:（轉為繁體中文）
   - Rebase if we want to preserve commit history（轉為繁體中文）
   - Squash if we want a single clean commit（轉為繁體中文）
   - If unclear, ask（轉為繁體中文）
9. Full gate (BEFORE commit):（轉為繁體中文）
   - `pnpm lint && pnpm build && pnpm test`（轉為繁體中文）
10. Commit via committer (include # + contributor in commit message):（轉為繁體中文）
    - `committer "fix: <summary> (#<PR>) (thanks @$contrib)" CHANGELOG.md <changed files>`（轉為繁體中文）
    - `land_sha=$(git rev-parse HEAD)`（轉為繁體中文）
11. Push updated PR branch (rebase => usually needs force):（轉為繁體中文）
（轉為繁體中文）
    ```sh（轉為繁體中文）
    git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"（轉為繁體中文）
    git push --force-with-lease prhead HEAD:$head（轉為繁體中文）
    ```（轉為繁體中文）
（轉為繁體中文）
12. Merge PR (must show MERGED on GitHub):（轉為繁體中文）
    - Rebase: `gh pr merge <PR> --rebase`（轉為繁體中文）
    - Squash: `gh pr merge <PR> --squash`（轉為繁體中文）
    - Never `gh pr close` (closing is wrong)（轉為繁體中文）
13. Sync main:（轉為繁體中文）
    - `git checkout main`（轉為繁體中文）
    - `git pull --ff-only`（轉為繁體中文）
14. Comment on PR with what we did + SHAs + thanks:（轉為繁體中文）
（轉為繁體中文）
    ```sh（轉為繁體中文）
    merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')（轉為繁體中文）
    gh pr comment <PR> --body "Landed via temp rebase onto main.\n\n- Gate: pnpm lint && pnpm build && pnpm test\n- Land commit: $land_sha\n- Merge commit: $merge_sha\n\nThanks @$contrib!"（轉為繁體中文）
    ```（轉為繁體中文）
（轉為繁體中文）
15. Verify PR state == MERGED:（轉為繁體中文）
    - `gh pr view <PR> --json state --jq .state`（轉為繁體中文）
16. Delete temp branch:（轉為繁體中文）
    - `git branch -D temp/landpr-<ts-or-pr>`（轉為繁體中文）
