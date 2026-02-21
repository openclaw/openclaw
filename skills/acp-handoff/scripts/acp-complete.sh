#!/usr/bin/env bash
# acp-complete.sh — Mark a handoff review as complete
#
# Usage:
#   acp-complete.sh --handoff-id <id> --status approved
#   acp-complete.sh --handoff-id <id> --status changes-requested
#   acp-complete.sh --pr <number> --status approved
#
# Requires: sqlite3, jq

set -euo pipefail

DB_PATH="${ACP_DB_PATH:-$HOME/.openclaw/acp-handoff.db}"

HANDOFF_ID=""
PR_NUMBER=""
STATUS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --handoff-id) HANDOFF_ID="$2"; shift 2 ;;
    --pr)         PR_NUMBER="$2"; shift 2 ;;
    --status)     STATUS="$2"; shift 2 ;;
    *)            echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$STATUS" ]]; then
  echo '{"error": "Missing required --status (approved|changes-requested)"}' >&2
  exit 1
fi

if [[ "$STATUS" != "approved" && "$STATUS" != "changes-requested" ]]; then
  echo '{"error": "Status must be approved or changes-requested"}' >&2
  exit 1
fi

if [[ -z "$HANDOFF_ID" && -z "$PR_NUMBER" ]]; then
  echo '{"error": "Must specify --handoff-id or --pr"}' >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo '{"error": "No handoff database found"}' >&2
  exit 1
fi

# --- Find the handoff ---
if [[ -n "$HANDOFF_ID" ]]; then
  WHERE="id = '$HANDOFF_ID'"
else
  WHERE="pr_number = $PR_NUMBER"
fi

EXISTING=$(sqlite3 -json "$DB_PATH" "SELECT id, status, author, reviewer, branch, pr_url FROM handoffs WHERE $WHERE LIMIT 1" 2>/dev/null || echo '[]')
COUNT=$(echo "$EXISTING" | jq 'length')

if [[ "$COUNT" == "0" ]]; then
  echo '{"error": "Handoff not found"}' >&2
  exit 1
fi

CURRENT_STATUS=$(echo "$EXISTING" | jq -r '.[0].status')
HID=$(echo "$EXISTING" | jq -r '.[0].id')

if [[ "$CURRENT_STATUS" != "pending-review" ]]; then
  echo "{\"error\": \"Handoff is not pending review (current status: $CURRENT_STATUS)\"}" >&2
  exit 1
fi

# --- Update status ---
NEW_STATUS="done"
if [[ "$STATUS" == "changes-requested" ]]; then
  NEW_STATUS="pending-review"  # stays in review but with feedback noted
fi

sqlite3 "$DB_PATH" "
  UPDATE handoffs 
  SET status = CASE WHEN '$STATUS' = 'approved' THEN 'done' ELSE status END,
      review_status = '$STATUS',
      reviewed_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = '$HID';
"

# --- Output ---
RESULT=$(sqlite3 -json "$DB_PATH" "
  SELECT id, author, branch, pr_number, pr_url, reviewer, status, review_status, reviewed_at
  FROM handoffs WHERE id = '$HID'
" 2>/dev/null)

echo "$RESULT" | jq '.[0] | {
  handoffId: .id,
  author: .author,
  branch: .branch,
  prNumber: .pr_number,
  prUrl: .pr_url,
  reviewer: .reviewer,
  status: .status,
  reviewStatus: .review_status,
  reviewedAt: .reviewed_at
}'
