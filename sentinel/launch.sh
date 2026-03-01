#!/bin/bash
# Sentinel — 無極自主運作 daemon
# 用法：
#   bash ~/clawd/sentinel/launch.sh           # 前景啟動
#   bash ~/clawd/sentinel/launch.sh install    # 安裝 launchd 服務
#   bash ~/clawd/sentinel/launch.sh uninstall  # 移除 launchd 服務
#   bash ~/clawd/sentinel/launch.sh status     # 查看狀態
#   bash ~/clawd/sentinel/launch.sh run-now <task>  # 立即執行某 task

cd "$(dirname "$0")"
PLIST_SRC="$(pwd)/sentinel.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.clawd.sentinel.plist"

case "${1:-run}" in
  install)
    echo "Installing Sentinel launchd service..."
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
    echo "Sentinel installed and started."
    launchctl list | grep sentinel
    ;;

  uninstall)
    echo "Uninstalling Sentinel launchd service..."
    launchctl unload "$PLIST_DST" 2>/dev/null
    rm -f "$PLIST_DST"
    echo "Sentinel uninstalled."
    ;;

  status)
    echo "=== Sentinel Status ==="
    if launchctl list | grep -q com.clawd.sentinel; then
      echo "launchd: RUNNING"
      launchctl list | grep sentinel
    else
      echo "launchd: NOT RUNNING"
    fi
    echo ""
    echo "State:"
    python3 -c "
import json
with open('state.json') as f:
    s = json.load(f)
sentinel = s.get('sentinel', {})
print(f'  Started:    {sentinel.get(\"started_at\", \"never\")}')
print(f'  Last task:  {sentinel.get(\"last_task\", \"none\")}')
print(f'  Task runs:  {sentinel.get(\"task_runs\", {})}')
print(f'  API calls:  {sentinel.get(\"daily_api_calls\", 0)}')
"
    echo ""
    echo "Recent logs:"
    tail -10 logs/sentinel-*.log 2>/dev/null || echo "  No logs yet"
    ;;

  run-now)
    if [ -z "$2" ]; then
      echo "Usage: launch.sh run-now <task_name>"
      echo "Available: nightly_ops, morning_brief, anomaly_scan, weekly_review"
      exit 1
    fi
    echo "Running task: $2"
    python3 sentinel.py --run-now "$2"
    ;;

  dry-run)
    python3 sentinel.py --dry-run
    ;;

  run|"")
    echo "=== Sentinel 啟動 ==="
    echo "時間: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "目錄: $(pwd)"
    echo ""
    if ! curl -s -m 3 http://localhost:18790/health > /dev/null 2>&1; then
      echo "WARNING: Telegram bridge (18790) 不可用"
    fi
    exec python3 sentinel.py
    ;;

  *)
    echo "Usage: launch.sh [run|install|uninstall|status|run-now <task>|dry-run]"
    exit 1
    ;;
esac
