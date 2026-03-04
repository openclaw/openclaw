#!/bin/bash
# Fix x-i18n frontmatter in all ja-JP translation PRs
set -e
cd /home/ubuntu/openclaw

BRANCHES=(
  "docs/ja-cli-dns"
  "docs/ja-start-quickstart"
  "docs/ja-help-index"
  "docs/ja-cli-health"
  "docs/ja-cli-clawbot"
  "docs/ja-cli-skills"
  "docs/ja-cli-webhooks"
  "docs/ja-gateway-network-model"
  "docs/ja-cli-agent"
  "docs/ja-cli-uninstall"
  "docs/ja-tools-reactions"
  "docs/ja-cli-reset"
  "docs/ja-cli-tui"
  "docs/ja-cli-dashboard"
  "docs/ja-cli-setup"
  "docs/ja-reference-credits"
  "docs/ja-help-scripts"
  "docs/ja-cli-logs"
  "docs/ja-cli-status"
  "docs/ja-cli-docs"
  "docs/ja-troubleshooting-translation"
  "docs/ja-vps-translation"
)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for BRANCH in "${BRANCHES[@]}"; do
  echo "=== Fixing $BRANCH ==="
  
  git checkout "$BRANCH" 2>/dev/null || { echo "Skip: can't checkout $BRANCH"; continue; }
  
  # Find the ja-JP file
  JA_FILE=$(git diff --name-only upstream/main | grep "ja-JP" | head -1)
  if [ -z "$JA_FILE" ]; then
    echo "No ja-JP file found, skipping"
    continue
  fi
  
  echo "File: $JA_FILE"
  
  # Derive source_path: remove "docs/ja-JP/" prefix
  SOURCE_PATH=$(echo "$JA_FILE" | sed 's|^docs/ja-JP/||')
  
  # Get source file hash
  SOURCE_FILE="docs/$SOURCE_PATH"
  if [ -f "$SOURCE_FILE" ]; then
    SOURCE_HASH=$(sha256sum "$SOURCE_FILE" | cut -d' ' -f1)
  else
    SOURCE_HASH="unknown"
  fi
  
  # Fix the frontmatter using python for reliability
  python3 << PYEOF
import re

with open("$JA_FILE", "r") as f:
    content = f.read()

# Replace the x-i18n block
new_i18n = """x-i18n:
  generated_at: "$TIMESTAMP"
  model: claude-opus-4-6
  provider: anthropic
  source_hash: $SOURCE_HASH
  source_path: $SOURCE_PATH
  workflow: 15"""

# Match existing x-i18n block
content = re.sub(
    r'x-i18n:\n(?:  \S.*\n)*',
    new_i18n + '\n',
    content
)

with open("$JA_FILE", "w") as f:
    f.write(content)
PYEOF

  # Check if anything changed
  if git diff --quiet "$JA_FILE"; then
    echo "No changes needed"
    continue
  fi
  
  git add "$JA_FILE"
  git commit -m "fix: correct x-i18n frontmatter format (add missing fields, fix source_path)"
  git push fork "$BRANCH"
  
  echo "=== Done: $BRANCH ==="
  sleep 1
done

echo "All done!"
