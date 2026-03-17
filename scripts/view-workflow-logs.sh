#!/bin/bash
# Script để xem log workflow chi tiết
# Usage: ./scripts/view-workflow-logs.sh [workflow-id]

WORKFLOW_ID=${1:-"030f9921-7834-47d0-a9c1-8c16a0d08594"}
LOG_FILE="$HOME/.openclaw/logs/gateway.log"

echo "📖 Workflow Logs Viewer"
echo "======================"
echo "Workflow ID: $WORKFLOW_ID"
echo "Log File: $LOG_FILE"
echo

if [ ! -f "$LOG_FILE" ]; then
  echo "❌ Log file not found: $LOG_FILE"
  exit 1
fi

echo "🔍 Searching for workflow logs..."
echo

# Find all log entries for this workflow
echo "=== All Workflow Log Entries ==="
grep "workflow:$WORKFLOW_ID" "$LOG_FILE" | tail -50
echo

echo "=== Agent Bootstrap Events ==="
grep "agent:bootstrap.*workflow:$WORKFLOW_ID" "$LOG_FILE" | tail -20
echo

echo "=== Session Keys Used ==="
grep -oE "agent:main:workflow:[^ |]+" "$LOG_FILE" | grep "$WORKFLOW_ID" | sort -u
echo

echo "=== Token Usage ==="
grep "Total tokens.*workflow:$WORKFLOW_ID" "$LOG_FILE" | tail -10
echo

echo "=== Delivery Status ==="
grep "delivered.*workflow:$WORKFLOW_ID" "$LOG_FILE" | tail -10
echo

echo "=== Errors (if any) ==="
grep -E "(error|failed|ERROR).*workflow:$WORKFLOW_ID" "$LOG_FILE" | tail -10
echo

echo "=== Cron Run Log ==="
CRON_RUN_FILE="$HOME/.openclaw/cron/runs/${WORKFLOW_ID}.jsonl"
if [ -f "$CRON_RUN_FILE" ]; then
  echo "Latest run:"
  tail -n 1 "$CRON_RUN_FILE" | jq '.'
else
  echo "❌ Cron run log not found: $CRUN_FILE"
fi
echo

echo "💡 Note: Workflow sessions are cleaned up after execution to save memory."
echo "   To keep sessions, you need to modify the cleanup behavior in workflow-executor.ts"
