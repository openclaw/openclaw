#!/bin/bash
# Issue 监控脚本 - 每天上午 10:00 执行
# 用途：检查高优先级 Issue 的状态和进展

set -e

LOG_FILE="/home/w/.openclaw/workspace/memory/issue-monitor.log"
MEMORY_DIR="/home/w/.openclaw/workspace/memory"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# 确保日志目录存在
mkdir -p "$MEMORY_DIR"

# 记录开始
echo "[$TIMESTAMP] === Issue 监控开始 ===" >> "$LOG_FILE"

# 高优先级 Issue 列表（根据 HEARTBEAT.md 配置）
# 这些是需要重点关注的 Issue
HIGH_PRIORITY_ISSUES=(
  "#53335"  # /new 命令错误 spawn subagent
  "#53247"  # WhatsApp 插件崩溃
  "#53365"  # 微信登录不出二维码
)

MEDIUM_PRIORITY_ISSUES=(
  "#53322"  # Browser tool 执行回归
  "#53317"  # Gateway 覆盖 OAuth token
  "#53284"  # Cron 消息未持久化
)

# 检查 Issue 状态的函数
check_issue_status() {
  local issue=$1
  local priority=$2
  
  # 使用 gh CLI 获取 Issue 状态
  if command -v gh &> /dev/null; then
    local status=$(HTTPS_PROXY=http://127.0.0.1:7890 gh issue view "$issue" --repo openclaw/openclaw --json state,title,updatedAt 2>/dev/null || echo "FAILED")
    
    if [ "$status" != "FAILED" ]; then
      echo "[$TIMESTAMP] [$priority] $issue: $status" >> "$LOG_FILE"
    else
      echo "[$TIMESTAMP] [$priority] $issue: 无法获取状态（可能已关闭或删除）" >> "$LOG_FILE"
    fi
  else
    echo "[$TIMESTAMP] [$priority] $issue: gh CLI 未安装" >> "$LOG_FILE"
  fi
}

# 检查高优先级 Issue
echo "[$TIMESTAMP] --- 高优先级 Issue ---" >> "$LOG_FILE"
for issue in "${HIGH_PRIORITY_ISSUES[@]}"; do
  check_issue_status "$issue" "HIGH"
done

# 检查中优先级 Issue
echo "[$TIMESTAMP] --- 中优先级 Issue ---" >> "$LOG_FILE"
for issue in "${MEDIUM_PRIORITY_ISSUES[@]}"; do
  check_issue_status "$issue" "MEDIUM"
done

# 检查是否有新评论
echo "[$TIMESTAMP] --- 检查新评论 ---" >> "$LOG_FILE"
if command -v gh &> /dev/null; then
  # 获取最近 24 小时的评论
  for issue in "${HIGH_PRIORITY_ISSUES[@]}"; do
    comments=$(HTTPS_PROXY=http://127.0.0.1:7890 gh issue view "$issue" --repo openclaw/openclaw --json comments 2>/dev/null || echo "")
    if [ -n "$comments" ]; then
      echo "[$TIMESTAMP] $issue: 有评论更新" >> "$LOG_FILE"
    fi
  done
fi

# 记录结束
echo "[$TIMESTAMP] === Issue 监控完成 ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# 如果有重要更新，可以通知用户（通过钉钉或其他渠道）
# 这里只是记录日志，实际通知可以在 HEARTBEAT.md 中配置

echo "Issue 监控完成，日志：$LOG_FILE"
