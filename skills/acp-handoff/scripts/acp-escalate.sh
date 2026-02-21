#!/usr/bin/env bash
# acp-escalate.sh — Check and escalate overdue reviews
#
# Called by cron every 15 minutes. Checks all pending-review handoffs
# against their SLA deadlines and outputs escalation actions needed.
#
# Usage:
#   acp-escalate.sh          # check and output needed actions
#   acp-escalate.sh --dry-run  # show what would be escalated without acting
#
# Requires: sqlite3, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="${ACP_DB_PATH:-$HOME/.openclaw/acp-handoff.db}"
TIER_CONFIG="$SCRIPT_DIR/tier-config.json"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ ! -f "$DB_PATH" ]]; then
  echo '{"actions": [], "summary": "No handoff database found"}'
  exit 0
fi

# --- Find overdue reviews ---
OVERDUE=$(sqlite3 -json "$DB_PATH" "
  SELECT 
    id, author, branch, repo, pr_number, pr_url, reviewer, reviewer_tier,
    priority, summary, handoff_at, sla_deadline, escalated_at, reminder_sent_at,
    CAST((julianday('now') - julianday(sla_deadline)) * 24 * 60 AS INTEGER) as minutes_overdue
  FROM handoffs
  WHERE status = 'pending-review'
    AND sla_deadline < datetime('now')
  ORDER BY 
    CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
    minutes_overdue DESC
" 2>/dev/null || echo '[]')

OVERDUE_COUNT=$(echo "$OVERDUE" | jq 'length')

if [[ "$OVERDUE_COUNT" == "0" ]]; then
  echo '{"actions": [], "summary": "All reviews within SLA"}'
  exit 0
fi

# --- Find reviews approaching SLA (within 5 min) ---
APPROACHING=$(sqlite3 -json "$DB_PATH" "
  SELECT 
    id, reviewer, priority, pr_url,
    CAST((julianday(sla_deadline) - julianday('now')) * 24 * 60 AS INTEGER) as minutes_remaining
  FROM handoffs
  WHERE status = 'pending-review'
    AND sla_deadline > datetime('now')
    AND sla_deadline < datetime('now', '+5 minutes')
    AND reminder_sent_at IS NULL
" 2>/dev/null || echo '[]')

# --- Build escalation actions ---
ACTIONS=$(echo "$OVERDUE" | jq --argjson config "$(cat "$TIER_CONFIG")" '
  [.[] | {
    handoffId: .id,
    type: (
      if .priority == "P0" then "escalate-inbox"
      elif .priority == "P1" then "notify-squad-lead"
      elif .priority == "P2" then "remind-reviewer"
      else "log-only"
      end
    ),
    priority: .priority,
    reviewer: .reviewer,
    prUrl: .pr_url,
    minutesOverdue: .minutes_overdue,
    alreadyEscalated: (.escalated_at != null),
    message: (
      if .priority == "P0" then
        "🚨 P0 review overdue by \(.minutes_overdue)min: \(.pr_url) — assigned to `\(.reviewer)`. Needs immediate attention."
      elif .priority == "P1" then
        "⚠️ P1 review overdue by \(.minutes_overdue)min: \(.pr_url) — assigned to `\(.reviewer)`."
      elif .priority == "P2" then
        "📋 Review reminder: \(.pr_url) is \(.minutes_overdue)min past SLA. `\(.reviewer)`, please take a look."
      else
        "Review for \(.pr_url) is past SLA (\(.minutes_overdue)min overdue). No escalation configured for \(.priority)."
      end
    )
  }]
')

# --- Mark reminders for approaching reviews ---
REMINDER_ACTIONS=$(echo "$APPROACHING" | jq '
  [.[] | {
    handoffId: .id,
    type: "sla-warning",
    reviewer: .reviewer,
    prUrl: .pr_url,
    minutesRemaining: .minutes_remaining,
    message: "⏰ SLA warning: review for \(.pr_url) due in \(.minutes_remaining)min. `\(.reviewer)`, please prioritize."
  }]
')

# --- Update escalation timestamps (unless dry run) ---
if [[ "$DRY_RUN" != "true" ]]; then
  echo "$OVERDUE" | jq -r '.[].id' | while read -r hid; do
    sqlite3 "$DB_PATH" "
      UPDATE handoffs 
      SET escalated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = '$hid' AND escalated_at IS NULL;
    "
  done

  echo "$APPROACHING" | jq -r '.[].handoffId' | while read -r hid; do
    sqlite3 "$DB_PATH" "
      UPDATE handoffs 
      SET reminder_sent_at = datetime('now'), updated_at = datetime('now')
      WHERE id = '$hid';
    "
  done
fi

# --- Output ---
ALL_ACTIONS=$(jq -n \
  --argjson escalations "$ACTIONS" \
  --argjson warnings "$REMINDER_ACTIONS" \
  --argjson overdue_count "$OVERDUE_COUNT" \
  --arg dry_run "$DRY_RUN" \
  '{
    actions: ($escalations + $warnings),
    summary: {
      overdue: $overdue_count,
      warnings: ($warnings | length),
      dryRun: ($dry_run == "true")
    }
  }')

echo "$ALL_ACTIONS"
