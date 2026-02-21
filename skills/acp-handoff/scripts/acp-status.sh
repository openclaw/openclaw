#!/usr/bin/env bash
# acp-status.sh — Check pending ACP handoffs
#
# Usage:
#   acp-status.sh                          # all pending
#   acp-status.sh --author xavier          # by author
#   acp-status.sh --reviewer tim           # by reviewer
#   acp-status.sh --overdue                # only overdue
#   acp-status.sh --all                    # include completed
#
# Requires: sqlite3, jq

set -euo pipefail

DB_PATH="${ACP_DB_PATH:-$HOME/.openclaw/acp-handoff.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo '{"handoffs": [], "summary": {"total": 0, "pending": 0, "overdue": 0}}' 
  exit 0
fi

# --- Parse args ---
AUTHOR=""
REVIEWER=""
OVERDUE_ONLY=false
SHOW_ALL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --author)   AUTHOR="$2"; shift 2 ;;
    --reviewer) REVIEWER="$2"; shift 2 ;;
    --overdue)  OVERDUE_ONLY=true; shift ;;
    --all)      SHOW_ALL=true; shift ;;
    *)          echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --- Build query ---
WHERE_CLAUSES=()

if [[ "$SHOW_ALL" != "true" ]]; then
  WHERE_CLAUSES+=("status = 'pending-review'")
fi

if [[ -n "$AUTHOR" ]]; then
  WHERE_CLAUSES+=("author = '$AUTHOR'")
fi

if [[ -n "$REVIEWER" ]]; then
  WHERE_CLAUSES+=("reviewer = '$REVIEWER'")
fi

if [[ "$OVERDUE_ONLY" == "true" ]]; then
  WHERE_CLAUSES+=("sla_deadline < datetime('now') AND status = 'pending-review'")
fi

WHERE=""
if [[ ${#WHERE_CLAUSES[@]} -gt 0 ]]; then
  WHERE="WHERE $(IFS=" AND "; echo "${WHERE_CLAUSES[*]}")"
fi

# --- Query ---
RESULTS=$(sqlite3 -json "$DB_PATH" "
  SELECT 
    id, author, branch, repo, pr_number, pr_url, reviewer, reviewer_tier,
    priority, status, summary, handoff_at, sla_deadline, escalated_at,
    reminder_sent_at, reviewed_at, review_status, workq_item_id,
    CASE 
      WHEN status = 'pending-review' AND sla_deadline < datetime('now') THEN 1
      ELSE 0
    END as is_overdue,
    CASE
      WHEN status = 'pending-review' THEN
        CAST((julianday(sla_deadline) - julianday('now')) * 24 * 60 AS INTEGER)
      ELSE NULL
    END as minutes_remaining
  FROM handoffs
  $WHERE
  ORDER BY 
    CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
    handoff_at ASC
" 2>/dev/null || echo '[]')

# --- Summary stats ---
TOTAL=$(echo "$RESULTS" | jq 'length')
PENDING=$(echo "$RESULTS" | jq '[.[] | select(.status == "pending-review")] | length')
OVERDUE=$(echo "$RESULTS" | jq '[.[] | select(.is_overdue == 1)] | length')

jq -n \
  --argjson handoffs "$RESULTS" \
  --argjson total "$TOTAL" \
  --argjson pending "$PENDING" \
  --argjson overdue "$OVERDUE" \
  '{
    handoffs: $handoffs,
    summary: {
      total: $total,
      pending: $pending,
      overdue: $overdue
    }
  }'
