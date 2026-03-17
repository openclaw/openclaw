#!/bin/bash
# Script để test workflow cronjob và xem session
# Usage: ./scripts/test-workflow-cron.sh

set -e

echo "🔍 OpenClaw Workflow Cronjob Test"
echo "=================================="
echo

# 1. Check if workflows.json exists
WORKFLOW_FILE="$HOME/.openclaw/workflows/workflows.json"
if [ ! -f "$WORKFLOW_FILE" ]; then
  echo "❌ Workflows file not found: $WORKFLOW_FILE"
  exit 1
fi

echo "✅ Found workflows file: $WORKFLOW_FILE"
echo

# 2. Parse workflow info
echo "📋 Workflow Configuration:"
echo "--------------------------"
if command -v jq &> /dev/null; then
  jq -r '.[] | "Name: \(.name)\nID: \(.id)\nNodes: \(.nodes | length)\nEdges: \(.edges | length)\nCron Jobs: \(.cronJobIds | length)\n"' "$WORKFLOW_FILE"
else
  echo "⚠️  jq not installed, showing raw JSON:"
  head -50 "$WORKFLOW_FILE"
fi
echo

# 3. List cron jobs
echo "⏰ Cron Jobs:"
echo "------------"
openclaw cron list --include-disabled 2>/dev/null || echo "❌ Failed to list cron jobs"
echo

# 4. Find recent cron runs
echo "📝 Recent Cron Runs:"
echo "--------------------"
CRON_RUNS_DIR="$HOME/.openclaw/cron/runs"
if [ -d "$CRON_RUNS_DIR" ]; then
  find "$CRON_RUNS_DIR" -name "*.jsonl" -mmin -60 -exec echo "📄 {}" \; 2>/dev/null | head -10
  echo
  
  # Show latest run for each job
  for file in "$CRON_RUNS_DIR"/*.jsonl; do
    if [ -f "$file" ]; then
      echo "Latest run in $(basename "$file"):"
      tail -n 1 "$file" | jq '.' 2>/dev/null || tail -n 1 "$file"
      echo
    fi
  done
else
  echo "❌ Cron runs directory not found: $CRON_RUNS_DIR"
fi
echo

# 5. Find session files
echo "💾 Session Files:"
echo "-----------------"
SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  echo "Recent session files (last 60 min):"
  find "$SESSIONS_DIR" -name "*.json" -mmin -60 -exec ls -lh {} \; 2>/dev/null | head -10
  echo
  
  # Check for cron sessions
  echo "Cron sessions in sessions.json:"
  if [ -f "$SESSIONS_DIR/sessions.json" ]; then
    if command -v jq &> /dev/null; then
      jq -r 'to_entries[] | select(.key | contains("cron")) | "\(.key): \(.value.label // "N/A")"' "$SESSIONS_DIR/sessions.json" 2>/dev/null || echo "No cron sessions found"
    fi
  fi
else
  echo "❌ Sessions directory not found: $SESSIONS_DIR"
fi
echo

# 6. Check logs
echo "📖 Recent Logs:"
echo "---------------"
LOG_DIR="$HOME/.openclaw/logs"
if [ -d "$LOG_DIR" ]; then
  echo "Looking for workflow/cron logs in last 60 min..."
  find "$LOG_DIR" -name "*.log" -mmin -60 -exec grep -l "workflow\|cron:" {} \; 2>/dev/null | head -5
  echo
  
  # Show recent cron logs
  echo "Recent cron log entries:"
  find "$LOG_DIR" -name "*.log" -mmin -60 -exec grep -h "cron:\|workflow:" {} \; 2>/dev/null | tail -20 || echo "No recent cron logs found"
else
  echo "❌ Logs directory not found: $LOG_DIR"
fi
echo

# 7. Debug script
echo "🔧 Running debug script:"
echo "------------------------"
if [ -f "scripts/debug-workflow-sessions.ts" ]; then
  pnpm tsx scripts/debug-workflow-sessions.ts --agent main
else
  echo "⚠️  Debug script not found"
fi
echo

echo "✅ Test complete!"
echo
echo "💡 Next steps:"
echo "   1. Run cron job manually: openclaw cron run <job-id>"
echo "   2. Watch logs: tail -f ~/.openclaw/logs/*.log | grep -E 'workflow|cron:'"
echo "   3. Check sessions: pnpm tsx scripts/debug-workflow-sessions.ts"
echo "   4. View cron runs: openclaw cron runs --job-id <job-id>"
