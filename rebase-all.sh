#!/bin/bash
# Rebase all ja-JP branches on upstream/main via Claude Code
set -e
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

git fetch upstream main

for BRANCH in "${BRANCHES[@]}"; do
  echo "=== Processing $BRANCH ==="
  
  # Derive expected ja-JP file path from branch name
  SLUG="${BRANCH#docs/ja-}"
  
  tmux new-session -d -s rebase-work "cd /home/ubuntu/openclaw && $CLAUDE --dangerously-skip-permissions 'checkout $BRANCH, rebase upstream/main, run git diff --name-only upstream/main, check only correct ja-JP file exists. Remove wrong files with git rm if any. Force push to fork. Be quick.'"
  
  # Wait up to 3 minutes
  for i in $(seq 1 18); do
    sleep 10
    if ! tmux has-session -t rebase-work 2>/dev/null; then
      echo "Session ended"
      break
    fi
    OUTPUT=$(tmux capture-pane -t rebase-work -p -S -20 2>/dev/null)
    if echo "$OUTPUT" | grep -q "force.*push\|Done\|pushed\|already up to date" 2>/dev/null; then
      echo "Looks done!"
      sleep 5
      break
    fi
  done
  
  tmux kill-session -t rebase-work 2>/dev/null
  echo "=== Done: $BRANCH ==="
  sleep 2
done

echo "All branches processed!"
