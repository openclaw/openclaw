#!/bin/bash
# PR Review Monitor - 监控 GitHub PR 审查通知
# 用法：./scripts/monitor-pr-reviews.sh <PR_NUMBER>

set -e

PR_NUMBER=$1
if [ -z "$PR_NUMBER" ]; then
  echo "用法：$0 <PR_NUMBER>"
  echo "示例：$0 45813"
  exit 1
fi

REPO="openclaw/openclaw"
CHECK_INTERVAL=300  # 5 分钟检查一次
LAST_REVIEW_COUNT=0

echo "🔍 开始监控 PR #$PR_NUMBER 的审查通知..."
echo "仓库：$REPO"
echo "检查间隔：${CHECK_INTERVAL}秒"
echo ""

# 获取当前审查数量
get_review_count() {
  gh pr view "$PR_NUMBER" --json reviews --jq '.reviews | length' 2>/dev/null || echo "0"
}

# 获取最新审查详情
get_latest_review() {
  gh pr view "$PR_NUMBER" --json reviews --jq '.reviews[-1] | "\(.author.login) - \(.state) - \(.submittedAt)"' 2>/dev/null
}

# 发送通知（替换为你的通知方式）
send_notification() {
  local message="$1"
  echo "📬 $message"
  
  # 可选：发送到 Telegram/Slack 等
  # curl -X POST "YOUR_WEBHOOK_URL" -d "text=$message"
}

# 初始检查
LAST_REVIEW_COUNT=$(get_review_count)
echo "初始审查数量：$LAST_REVIEW_COUNT"
echo ""

# 主循环
while true; do
  sleep $CHECK_INTERVAL
  
  CURRENT_COUNT=$(get_review_count)
  
  if [ "$CURRENT_COUNT" -gt "$LAST_REVIEW_COUNT" ]; then
    LATEST=$(get_latest_review)
    send_notification "⚠️ 收到新的 PR 审查！PR #$PR_NUMBER"
    send_notification "审查详情：$LATEST"
    send_notification ""
    send_notification "请立即响应审查意见并修复指出的问题。"
    
    LAST_REVIEW_COUNT=$CURRENT_COUNT
  fi
  
  # 检查 PR 状态
  PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
  
  if [ "$PR_STATE" = "MERGED" ]; then
    send_notification "✅ PR #$PR_NUMBER 已合并！"
    exit 0
  elif [ "$PR_STATE" = "CLOSED" ]; then
    send_notification "❌ PR #$PR_NUMBER 已关闭（未合并）"
    exit 0
  fi
done
