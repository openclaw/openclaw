#!/bin/bash
# List cron jobs in readable format

echo "📋 当前 Cron 任务列表"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

openclaw cron list 2>/dev/null | tail -n +20 || echo "暂无任务"
