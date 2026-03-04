# Fix PR Review Issues

Remotes: fork=cl-victor1/openclaw, upstream=openclaw/openclaw

## PR #34022 (branch: docs/ja-cli-docs)
- Checkout branch, run `git diff --name-only upstream/main`
- REMOVE any files that are NOT `docs/ja-JP/cli/docs.md` (e.g. batch-ja-translate.sh, fix-frontmatter.sh)
- Use `git rm` to remove, commit "fix: remove automation scripts", push to fork

## PR #34035 (branch: docs/ja-gateway-network-model)
- Should ONLY have `docs/ja-JP/gateway/network-model.md`
- May incorrectly include `docs/ja-JP/cli/clawbot.md` - remove if present
- If `docs/ja-JP/gateway/network-model.md` is missing, create it by translating `docs/gateway/network-model.md`

## PR #34027 (branch: docs/ja-reference-credits)
- Should ONLY have `docs/ja-JP/reference/credits.md`
- May include wrong file `docs/ja-JP/cli/tui.md` - remove if present

## PR #34023 (branch: docs/ja-cli-status)
- Should ONLY have `docs/ja-JP/cli/status.md`  
- May include extra `docs/ja-JP/cli/dashboard.md` - remove if present

## For each fix: checkout branch, fix, commit, `git push fork BRANCH`
