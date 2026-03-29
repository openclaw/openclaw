#!/bin/bash
# gh-issues cron wrapper - bypasses CLI skill system due to matrix-js-sdk bundling conflict
# Usage: ./gh-issues-cron.sh [owner/repo] [label] [limit]

set -e

REPO="${1:-openclaw/openclaw}"
LABEL="${2:-bug}"
LIMIT="${3:-5}"
GH_TOKEN="${GH_TOKEN:-$(cat /data/.clawdbot/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty')}"
CLAIMS_FILE="/data/.clawdbot/gh-issues-claims.json"
CURSOR_FILE="/data/.clawdbot/gh-issues-cursor-${REPO//\//-}.json"
LOG_FILE="/home/w/.openclaw/workspace/memory/gh-issues-cron.log"

mkdir -p /home/w/.openclaw/workspace/memory
mkdir -p /data/.clawdbot

echo "=== gh-issues cron run: $(date) ===" >> "$LOG_FILE"

# Initialize claims file
if [ ! -f "$CLAIMS_FILE" ]; then
  echo '{}' > "$CLAIMS_FILE"
fi

# Initialize cursor file
if [ ! -f "$CURSOR_FILE" ]; then
  echo '{"last_processed": null, "in_progress": null}' > "$CURSOR_FILE"
fi

# Fetch issues
echo "Fetching issues from $REPO with label=$LABEL, limit=$LIMIT" >> "$LOG_FILE"
ISSUES=$(curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/issues?per_page=$LIMIT&state=open&labels=$LABEL" | \
  jq -c '[.[] | select(.pull_request == null)]')

ISSUE_COUNT=$(echo "$ISSUES" | jq 'length')
echo "Found $ISSUE_COUNT issues" >> "$LOG_FILE"

if [ "$ISSUE_COUNT" -eq 0 ]; then
  echo "No issues found" >> "$LOG_FILE"
  exit 0
fi

# Get cursor state
LAST_PROCESSED=$(cat "$CURSOR_FILE" | jq -r '.last_processed // null')
IN_PROGRESS=$(cat "$CURSOR_FILE" | jq -r '.in_progress // null')

# Find next eligible issue
NEXT_ISSUE="null"
REPO_KEY="$REPO#"
if [ "$LAST_PROCESSED" != "null" ]; then
  # Find first issue with number > last_processed and not in claims
  NEXT_ISSUE=$(echo "$ISSUES" | jq -r --arg last "$LAST_PROCESSED" --argjson claims "$(cat $CLAIMS_FILE)" --arg repo_key "$REPO_KEY" \
    '[.[] | select(.number > ($last | tonumber)) | select($claims[($repo_key + (.number | tostring))] // null | not)] | .[0] // null')
fi

# If no issue found after cursor, wrap around to beginning
if [ "$NEXT_ISSUE" = "null" ]; then
  NEXT_ISSUE=$(echo "$ISSUES" | jq -r --argjson claims "$(cat $CLAIMS_FILE)" --arg repo_key "$REPO_KEY" \
    '[.[] | select($claims[($repo_key + (.number | tostring))] // null | not)] | .[0] // null')
fi

if [ "$NEXT_ISSUE" = "null" ]; then
  echo "No eligible issues (all processed or in progress)" >> "$LOG_FILE"
  exit 0
fi

ISSUE_NUM=$(echo "$NEXT_ISSUE" | jq -r '.number')
ISSUE_TITLE=$(echo "$NEXT_ISSUE" | jq -r '.title')
ISSUE_URL=$(echo "$NEXT_ISSUE" | jq -r '.html_url')
ISSUE_BODY=$(echo "$NEXT_ISSUE" | jq -r '.body // ""')

echo "Processing issue #$ISSUE_NUM: $ISSUE_TITLE" >> "$LOG_FILE"

# Update cursor - mark as in_progress
cat "$CURSOR_FILE" | jq --argjson num "$ISSUE_NUM" '.in_progress = $num' > /tmp/cursor_tmp.json
mv /tmp/cursor_tmp.json "$CURSOR_FILE"

# Add claim
CLAIMS=$(cat "$CLAIMS_FILE")
CLAIM_KEY="${REPO_KEY}${ISSUE_NUM}"
CLAIMS=$(echo "$CLAIMS" | jq --arg key "$CLAIM_KEY" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {($key): $ts}')
echo "$CLAIMS" > "$CLAIMS_FILE"

# Spawn sub-agent via openclaw message (send to self to trigger agent)
# Note: This may fail if CLI has extension loading issues - agents can also be spawned manually
MSG_RESULT=$(/home/w/.npm-global/bin/openclaw message send \
  --channel openclaw-weixin \
  --account 0ce74580e8da \
  --target 0ce74580e8da-im-bot \
  -m "修复 GitHub issue #$ISSUE_NUM: $ISSUE_TITLE

仓库：$REPO
Issue: $ISSUE_URL

任务：
1. 读取 issue 内容，理解问题
2. 查找相关代码并分析根本原因
3. 实现修复
4. 运行测试
5. 提交并创建 PR

使用 curl + GitHub API，GH_TOKEN 已在环境中。" 2>&1) || true

if echo "$MSG_RESULT" | grep -q "Failed\|error\|Error"; then
  echo "Message send failed (CLI extension conflict): $MSG_RESULT" >> "$LOG_FILE"
  echo "Note: Agents may need to be spawned manually for this run" >> "$LOG_FILE"
else
  echo "Spawned agent for #$ISSUE_NUM" >> "$LOG_FILE"
fi
echo "=== Completed: $(date) ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
