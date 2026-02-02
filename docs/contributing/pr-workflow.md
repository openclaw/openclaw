# Commit & PR Workflow

## Commits
```bash
scripts/committer "<msg>" <file...>  # Preferred
```
- Avoid manual `git add`/`git commit` so staging stays scoped
- Concise, action-oriented messages (e.g., `CLI: add verbose flag to send`)
- Group related changes; avoid bundling unrelated refactors

## Changelog
- Keep latest released version at top (no `Unreleased`)
- After publishing, bump version and start new top section
- When working on PR: add entry with PR # and thank contributor
- When working on issue: reference issue in entry

## PR Guidelines
- Summarize scope
- Note testing performed
- Mention user-facing changes or new flags

## PR Review Flow
- When given PR link: review via `gh pr view`/`gh pr diff`
- **Do NOT change branches** during review
- Prefer single `gh pr view --json ...` to batch metadata/comments
- Before starting review: run `git pull`; if local changes/unpushed commits, stop and alert

## PR Merge Flow
1. Create temp branch from `main`
2. Merge PR branch (prefer squash unless history matters; use rebase when it does)
3. If squash: add PR author as co-contributor
4. Apply fixes
5. Add changelog entry (PR # + thanks)
6. Run full gate: `pnpm lint && pnpm build && pnpm test`
7. Commit
8. Merge back to `main`
9. Delete temp branch
10. End on `main`

**Goal:** Merge PRs. Contributor must be in git graph after landing.

## After Merge
- Leave PR comment explaining what we did + SHA hashes
- New contributor: add avatar to README "clawtributors" list
- Run `bun scripts/update-clawtributors.ts` if missing

## Review vs Land Modes
| Mode | Actions |
|------|---------|
| **Review** (PR link only) | Read `gh pr view/diff`; NO branch switch; NO code changes |
| **Land** | Create integration branch, bring in commits, fix, changelog, gate, commit, merge to main |

## Shorthand: `sync`
If working tree is dirty, commit all (sensible message), then `git pull --rebase`; if conflicts can't resolve, stop; otherwise `git push`.

## Multi-Agent Safety
- Do NOT create/apply/drop `git stash` unless explicitly requested
- Do NOT create/remove/modify `git worktree` unless requested
- Do NOT switch branches unless requested
- When "push": may `git pull --rebase` (never discard others' work)
- When "commit": scope to your changes only
- When "commit all": commit everything in grouped chunks
- Focus reports on your edits; brief "other files present" note only if relevant
