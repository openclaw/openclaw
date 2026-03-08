#!/usr/bin/env bash
# Check PR 40031 for new comments and CI failures. Run periodically (e.g. cron) or manually.
# Usage: ./scripts/check-pr-40031.sh
# To fix issues automatically: run this script, then in Cursor say "帮我看下 PR 40031 的 CI，有红的就修掉" or paste the output.

set -e
PR=40031
REPO=openclaw/openclaw

echo "=== PR #$PR status ==="
gh pr view $PR --repo $REPO --json state,title,url,statusCheckRollup -q '"\(.state) - \(.title)\n\(.url)"'
echo ""

echo "=== Failed CI checks ==="
FAILED=$(gh pr view $PR --repo $REPO --json statusCheckRollup -q '.statusCheckRollup[] | select(.conclusion == "FAILURE") | .name' 2>/dev/null || true)
if [ -z "$FAILED" ]; then
  echo "None"
else
  echo "$FAILED"
fi
echo ""

echo "=== Recent review comments ==="
gh api "repos/$REPO/pulls/$PR/comments" --jq '.[] | "\(.user.login) (\(.path):\(.line)): \(.body[0:120])..."' 2>/dev/null | head -15 || echo "Could not fetch"
echo ""

echo "=== Latest run ==="
gh run list --repo $REPO --branch feature/cron-main-announce-and-feishu-fixes --limit 1 --json conclusion,status,databaseId,url -q '.[0] | "\(.conclusion) \(.status) \(.url)"' 2>/dev/null || true
