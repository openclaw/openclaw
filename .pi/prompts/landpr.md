---
description: Land a PR (merge with proper workflow)
---

Input

- PR: $1 <number|url>
  - If missing: use the most recent PR mentioned in the conversation.
  - If ambiguous: ask.

Do (end-to-end)
Goal: PR must end in GitHub state = MERGED (never CLOSED). Use `gh pr merge` with `--rebase` or `--squash`.

1. Assign PR to self:
   - `gh pr edit <PR> --add-assignee @me`
2. Repo clean: `git status`.
3. Identify PR meta (author + head branch):

   ```sh
   gh pr view <PR> --json number,title,author,headRefName,baseRefName,headRepository --jq '{number,title,author:.author.login,head:.headRefName,base:.baseRefName,headRepo:.headRepository.nameWithOwner}'
   contrib=$(gh pr view <PR> --json author --jq .author.login)
   head=$(gh pr view <PR> --json headRefName --jq .headRefName)
   head_repo_url=$(gh pr view <PR> --json headRepository --jq .headRepository.url)
   ```

4. Fast-forward base:
   - `git checkout main`
   - `git pull --ff-only`
5. Create temp base branch from main:
   - `git checkout -b temp/landpr-<ts-or-pr>`
6. Check out PR branch locally:
   - `gh pr checkout <PR>`
7. Rebase PR branch onto temp base:
   - `git rebase temp/landpr-<ts-or-pr>`
   - Fix conflicts; keep history tidy.
8. Fix + tests + changelog:
   - Implement fixes + add/adjust tests
   - Update `CHANGELOG.md` and mention `#<PR>` + `@$contrib`
9. Decide merge strategy:
   - Rebase if we want to preserve commit history
   - Squash if we want a single clean commit
   - If unclear, ask
10. Full gate (BEFORE commit):
    - `pnpm lint && pnpm build && pnpm test`
11. Commit via committer (final merge commit only includes PR # + thanks):
    - For the final merge-ready commit: `committer "fix: <summary> (#<PR>) (thanks @$contrib)" CHANGELOG.md <changed files>`
    - If you need intermediate fix commits before the final merge commit, keep those messages concise and **omit** PR number/thanks.
    - `land_sha=$(git rev-parse HEAD)`
12. Push updated PR branch (rebase => usually needs force):

    ```sh
    git remote add prhead "$head_repo_url.git" 2>/dev/null || git remote set-url prhead "$head_repo_url.git"
    git push --force-with-lease prhead HEAD:$head
    ```

13. Merge PR (must show MERGED on GitHub):
    - Rebase: `gh pr merge <PR> --rebase`
    - Squash: `gh pr merge <PR> --squash`
    - Never `gh pr close` (closing is wrong)
14. Sync main:
    - `git checkout main`
    - `git pull --ff-only`
15. Comment on PR with what we did + SHAs + thanks:

    ```sh
    merge_sha=$(gh pr view <PR> --json mergeCommit --jq '.mergeCommit.oid')
    gh pr comment <PR> --body "Landed via temp rebase onto main.\n\n- Gate: pnpm lint && pnpm build && pnpm test\n- Land commit: $land_sha\n- Merge commit: $merge_sha\n\nThanks @$contrib!"
    ```

16. Verify PR state == MERGED:
    - `gh pr view <PR> --json state --jq .state`
17. Delete temp branch:
    - `git branch -D temp/landpr-<ts-or-pr>`
