#!/bin/bash
# PR CI 状态监控脚本 - 每 30 分钟执行一次
# 用途：检查负责 PR 的 CI 状态变化

set -e

LOG_FILE="/home/w/.openclaw/workspace/memory/pr-ci-monitor.log"
MEMORY_DIR="/home/w/.openclaw/workspace/memory"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# 确保日志目录存在
mkdir -p "$MEMORY_DIR"

# 记录开始
echo "[$TIMESTAMP] === PR CI 监控开始 ===" >> "$LOG_FILE"

# 需要监控的 PR 列表
# 这些是正在修复中的 PR
MONITORED_PRS=(
  "#54569"  # fix(matrix): lazy import music-metadata
  "#54611"  # fix(telegram): always return currentChannelId
)

# 检查 PR CI 状态的函数
check_pr_ci_status() {
  local pr=$1
  
  # 使用 gh CLI 获取 PR 的 CI 状态
  if command -v gh &> /dev/null; then
    # 获取 mergeStateStatus
    local status=$(HTTPS_PROXY=http://127.0.0.1:7890 gh pr view "$pr" --repo openclaw/openclaw --json mergeStateStatus,title 2>/dev/null || echo "FAILED")
    
    if [ "$status" != "FAILED" ]; then
      echo "[$TIMESTAMP] $pr: $status" >> "$LOG_FILE"
      
      # 如果状态是 CLEAN，说明 CI 全绿，可以通知用户
      if echo "$status" | grep -q '"mergeStateStatus":"CLEAN"'; then
        echo "[$TIMESTAMP] ⚠️  $pr CI 全绿，可以合并！" >> "$LOG_FILE"
        # 这里可以添加通知逻辑（钉钉、Telegram 等）
      fi
    else
      echo "[$TIMESTAMP] $pr: 无法获取状态" >> "$LOG_FILE"
    fi
  else
    echo "[$TIMESTAMP] $pr: gh CLI 未安装" >> "$LOG_FILE"
  fi
}

# 检查所有监控的 PR
echo "[$TIMESTAMP] --- 监控中的 PR ---" >> "$LOG_FILE"
for pr in "${MONITORED_PRS[@]}"; do
  check_pr_ci_status "$pr"
done

# 检查是否有新评论
echo "[$TIMESTAMP] --- 检查新评论 ---" >> "$LOG_FILE"
if command -v gh &> /dev/null; then
  for pr in "${MONITORED_PRS[@]}"; do
    # 获取最近的评论
    comments=$(HTTPS_PROXY=http://127.0.0.1:7890 gh pr view "$pr" --repo openclaw/openclaw --json comments 2>/dev/null || echo "")
    if [ -n "$comments" ]; then
      echo "[$TIMESTAMP] $pr: 可能有新评论" >> "$LOG_FILE"
    fi
  done
fi

# 记录结束
echo "[$TIMESTAMP] === PR CI 监控完成 ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

echo "PR CI 监控完成，日志：$LOG_FILE"
