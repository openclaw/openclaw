# Workflow

## Branch and PR targets

- Default to this fork, not upstream.
- Consumer-product work targets `codex/consumer-openclaw-project`.
- General fork work that is not consumer-product work targets this repo's `main`.
- Use upstream `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream review, triage, or PR flow.
- `consumer` is legacy. Do not target new PRs there unless the user explicitly asks.
- Do not recreate `consumer` for new work. The active product branch is `codex/consumer-openclaw-project`.
- If the user says "consumer branch", interpret that as `codex/consumer-openclaw-project` unless they explicitly say they want the legacy `consumer` branch.
- Never run `git merge upstream/main` on this fork. Port upstream changes selectively via `main`.
- Validate new bot behavior in a feature worktree first when possible, ideally with a tester bot or other isolated runtime. Do not repoint the long-lived main bot or LaunchAgent at a feature worktree. For the production bot, merge to `main` first, then restart and exercise the gateway from the `main` checkout. See `docs/debug/worktree-branch-survival.md` for the runtime truth model.

## GitHub footguns

- For issue comments, PR comments, and review bodies, use literal multiline strings or a single-quoted heredoc. Do not embed `\n`.
- Do not use `gh issue/pr comment -b "..."` when the body contains shell characters or backticks. Use `-F - <<'EOF'`.
- Do not wrap issue or PR refs like `#24643` in backticks when you want auto-linking.
- When searching issues or PRs broadly, keep paginating until you reach the end. Do not assume the first page or first 500 results is enough.

## Commits and PRs

- Use `scripts/committer "<message>" <file...>` for commits so staging stays scoped.
- Use Conventional Commits and include a bullet body for what, why, and risk.
- Group related changes. Do not bundle unrelated refactors.
- If the task is a bug-fix PR, require proof:
  - Symptom evidence
  - Root cause in code with file and line
  - Fix touching that code path
  - Regression proof or explicit manual validation notes
- Before `/landpr`, run `/reviewpr`.

## Multi-agent safety

- Do not use `git stash` unless the user explicitly asks.
- Do not switch branches or modify worktrees unless the user explicitly asks.
- Leave unrelated edits alone. Focus on your own diff.
- If formatting-only churn appears around your changes, fold it in without turning it into a separate drama.
