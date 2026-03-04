#!/bin/bash
# Rebase all ja-JP branches via Claude Code (single session, sequential)
cd /home/ubuntu/openclaw
CLAUDE="/home/ubuntu/.npm-global/bin/claude"

BRANCHES=(
  "docs/ja-cli-dns"
  "docs/ja-start-quickstart"
  "docs/ja-help-index"
  "docs/ja-cli-health"
  "docs/ja-cli-clawbot"
  "docs/ja-cli-skills"
  "docs/ja-cli-webhooks"
  "docs/ja-cli-agent"
  "docs/ja-cli-uninstall"
  "docs/ja-tools-reactions"
  "docs/ja-cli-reset"
  "docs/ja-cli-tui"
  "docs/ja-cli-dashboard"
  "docs/ja-cli-setup"
  "docs/ja-help-scripts"
  "docs/ja-cli-logs"
  "docs/ja-troubleshooting-translation"
  "docs/ja-vps-translation"
)

git fetch upstream main 2>/dev/null

for BRANCH in "${BRANCHES[@]}"; do
  echo "=== $BRANCH ==="
  
  timeout 180 $CLAUDE --dangerously-skip-permissions \
    "checkout $BRANCH, rebase upstream/main, git diff --name-only upstream/main to verify only correct ja-JP file. Remove wrong files with git rm. Force push to fork. Be quick, minimal output." \
    2>&1 | tail -20
  
  echo "=== Done: $BRANCH ==="
  echo ""
  sleep 2
done

echo "ALL DONE!"
