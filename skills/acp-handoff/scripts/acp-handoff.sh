#!/usr/bin/env bash
# acp-handoff.sh — Automatic Completion Protocol: Handoff to Review
#
# Opens a PR, assigns a reviewer based on tier config, records in SQLite,
# and outputs JSON for the calling agent to use for notification.
#
# Usage:
#   acp-handoff.sh --branch <name> --author <agent-id> --summary "description"
#     [--repo owner/repo] [--worktree /path] [--priority P0|P1|P2|P3]
#     [--issue <num>] [--reviewer <agent-id>] [--workq-item <id>]
#
# Requires: gh (authenticated), git, sqlite3, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="${ACP_DB_PATH:-$HOME/.openclaw/acp-handoff.db}"
TIER_CONFIG="$SCRIPT_DIR/tier-config.json"

# --- Defaults ---
BRANCH=""
AUTHOR=""
SUMMARY=""
REPO=""
WORKTREE=""
PRIORITY="P2"
ISSUE=""
REVIEWER=""
WORKQ_ITEM=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --branch)     BRANCH="$2"; shift 2 ;;
    --author)     AUTHOR="$2"; shift 2 ;;
    --summary)    SUMMARY="$2"; shift 2 ;;
    --repo)       REPO="$2"; shift 2 ;;
    --worktree)   WORKTREE="$2"; shift 2 ;;
    --priority)   PRIORITY="$2"; shift 2 ;;
    --issue)      ISSUE="$2"; shift 2 ;;
    --reviewer)   REVIEWER="$2"; shift 2 ;;
    --workq-item) WORKQ_ITEM="$2"; shift 2 ;;
    *)            echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --- Validate required args ---
if [[ -z "$BRANCH" || -z "$AUTHOR" || -z "$SUMMARY" ]]; then
  echo '{"error": "Missing required args: --branch, --author, --summary"}' >&2
  exit 1
fi

# --- Detect repo from git remote if not specified ---
if [[ -z "$REPO" ]]; then
  if [[ -n "$WORKTREE" && -d "$WORKTREE" ]]; then
    cd "$WORKTREE"
  fi
  REMOTE_URL=$(git remote get-url upstream 2>/dev/null || git remote get-url origin 2>/dev/null || echo "")
  if [[ -n "$REMOTE_URL" ]]; then
    # Extract owner/repo from SSH or HTTPS URL
    REPO=$(echo "$REMOTE_URL" | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')
  fi
  if [[ -z "$REPO" ]]; then
    REPO=$(jq -r '.defaults.repo' "$TIER_CONFIG")
  fi
fi

# --- Ensure we're in the right directory ---
if [[ -n "$WORKTREE" && -d "$WORKTREE" ]]; then
  cd "$WORKTREE"
fi

# --- Validate branch state ---
# Check branch exists locally
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  # Maybe we're already on it
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    echo "{\"error\": \"Branch '$BRANCH' not found locally\"}" >&2
    exit 1
  fi
fi

# Check branch is pushed
if ! git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q "$BRANCH"; then
  echo '{"error": "Branch not pushed to origin. Run: git push -u origin '"$BRANCH"'"}' >&2
  exit 1
fi

# Check commits ahead of main
AHEAD=$(git rev-list --count origin/main.."$BRANCH" 2>/dev/null || echo "0")
if [[ "$AHEAD" == "0" ]]; then
  echo '{"error": "Branch has no commits ahead of main"}' >&2
  exit 1
fi

# --- Get files changed ---
FILES_CHANGED=$(git diff --name-only origin/main..."$BRANCH" 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0))' || echo '[]')

# --- Initialize database ---
mkdir -p "$(dirname "$DB_PATH")"
sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  branch TEXT NOT NULL,
  repo TEXT NOT NULL,
  worktree TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  reviewer TEXT,
  reviewer_tier TEXT,
  priority TEXT DEFAULT 'P2',
  status TEXT DEFAULT 'pending-review',
  summary TEXT,
  issue_ref TEXT,
  files_changed TEXT,
  handoff_at TEXT NOT NULL,
  sla_deadline TEXT NOT NULL,
  escalated_at TEXT,
  reminder_sent_at TEXT,
  reviewed_at TEXT,
  review_status TEXT,
  workq_item_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status);
CREATE INDEX IF NOT EXISTS idx_handoffs_reviewer ON handoffs(reviewer);
CREATE INDEX IF NOT EXISTS idx_handoffs_author ON handoffs(author);
SQL

# --- Auto-select reviewer if not specified ---
get_author_tier() {
  local agent="$1"
  for tier in T1 T2 T3 T4; do
    if jq -e --arg a "$agent" --arg t "$tier" '.tiers[$t].agents | index($a)' "$TIER_CONFIG" >/dev/null 2>&1; then
      echo "$tier"
      return
    fi
  done
  echo "T4"  # default
}

get_author_squad() {
  local agent="$1"
  jq -r --arg a "$agent" '
    .squads | to_entries[] |
    select(.value.members | index($a)) |
    .key
  ' "$TIER_CONFIG" 2>/dev/null | head -1
}

select_reviewer() {
  local author="$1"
  local author_tier
  author_tier=$(get_author_tier "$author")
  local author_squad
  author_squad=$(get_author_squad "$author")

  # Get review tiers for this author's tier
  local review_tiers
  review_tiers=$(jq -r --arg t "$author_tier" '.tiers[$t].reviewedBy[]' "$TIER_CONFIG" 2>/dev/null)

  # Try same-squad reviewers first, then any reviewer in the target tier
  for rt in $review_tiers; do
    # Same squad first
    if [[ -n "$author_squad" ]]; then
      local squad_reviewer
      squad_reviewer=$(jq -r --arg t "$rt" --arg s "$author_squad" --arg a "$author" '
        (.tiers[$t].agents // []) as $tier_agents |
        (.squads[$s].members // []) as $squad_members |
        [$tier_agents[] | select(. != $a) | select(. as $x | $squad_members | index($x))] |
        first // empty
      ' "$TIER_CONFIG" 2>/dev/null || echo "")
      if [[ -n "$squad_reviewer" ]]; then
        echo "$squad_reviewer"
        return
      fi
    fi
    # Any reviewer in that tier
    local any_reviewer
    any_reviewer=$(jq -r --arg t "$rt" --arg a "$author" '
      .tiers[$t].agents | map(select(. != $a)) | first // empty
    ' "$TIER_CONFIG" 2>/dev/null || echo "")
    if [[ -n "$any_reviewer" ]]; then
      echo "$any_reviewer"
      return
    fi
  done

  # Fallback
  local fallback
  fallback=$(jq -r --arg t "$author_tier" '.tiers[$t].fallbackReviewer // empty' "$TIER_CONFIG" 2>/dev/null || echo "")
  if [[ -n "$fallback" ]]; then
    echo "$fallback"
  else
    echo ""
  fi
}

if [[ -z "$REVIEWER" ]]; then
  REVIEWER=$(select_reviewer "$AUTHOR")
fi
REVIEWER_TIER=$(get_author_tier "$REVIEWER")

# --- Calculate SLA deadline ---
SLA_MINUTES=$(jq -r --arg p "$PRIORITY" '.sla[$p].minutes // 120' "$TIER_CONFIG")
HANDOFF_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [[ "$(uname)" == "Darwin" ]]; then
  SLA_DEADLINE=$(date -u -v+"${SLA_MINUTES}M" +"%Y-%m-%dT%H:%M:%SZ")
else
  SLA_DEADLINE=$(date -u -d "+${SLA_MINUTES} minutes" +"%Y-%m-%dT%H:%M:%SZ")
fi

# --- Open PR ---
PR_TITLE="$SUMMARY"
PR_BODY="## Summary

$SUMMARY

## Author
Agent: \`$AUTHOR\`

## Files Changed
$(echo "$FILES_CHANGED" | jq -r '.[] | "- `" + . + "`"')

## Review Info
- **Priority:** $PRIORITY
- **Reviewer:** \`$REVIEWER\` ($REVIEWER_TIER)
- **SLA Deadline:** $SLA_DEADLINE
"

if [[ -n "$ISSUE" ]]; then
  PR_BODY="$PR_BODY
## Related Issue
Closes #$ISSUE
"
  PR_TITLE="$PR_TITLE (#$ISSUE)"
fi

PR_BODY="$PR_BODY
---
*Opened automatically by ACP Handoff*"

# Create the PR
PR_JSON=$(gh pr create \
  --repo "$REPO" \
  --head "$BRANCH" \
  --base main \
  --title "$PR_TITLE" \
  --body "$PR_BODY" \
  --json number,url 2>&1) || {
  # If PR already exists, try to get it
  PR_JSON=$(gh pr view "$BRANCH" --repo "$REPO" --json number,url 2>/dev/null || echo '{"error": "Failed to create or find PR"}')
}

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number // empty' 2>/dev/null || echo "")
PR_URL=$(echo "$PR_JSON" | jq -r '.url // empty' 2>/dev/null || echo "")

if [[ -z "$PR_NUMBER" ]]; then
  echo "{\"error\": \"Failed to create PR\", \"details\": $(echo "$PR_JSON" | jq -Rs .)}" >&2
  exit 1
fi

# --- Request review on GitHub ---
if [[ -n "$REVIEWER" ]]; then
  # Note: gh pr edit --add-reviewer requires GitHub usernames, not agent IDs
  # For now, we skip GitHub reviewer assignment and handle it via sessions_send
  true
fi

# --- Generate handoff ID ---
HANDOFF_ID=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || echo "hoff-$(date +%s)")

# --- Record in database ---
sqlite3 "$DB_PATH" <<SQL
INSERT INTO handoffs (id, author, branch, repo, worktree, pr_number, pr_url, reviewer, reviewer_tier, priority, status, summary, issue_ref, files_changed, handoff_at, sla_deadline, workq_item_id)
VALUES (
  '${HANDOFF_ID}',
  '${AUTHOR}',
  '${BRANCH}',
  '${REPO}',
  '${WORKTREE}',
  ${PR_NUMBER:-NULL},
  '${PR_URL}',
  '${REVIEWER}',
  '${REVIEWER_TIER}',
  '${PRIORITY}',
  'pending-review',
  $(echo "$SUMMARY" | jq -Rs .),
  '${ISSUE}',
  $(echo "$FILES_CHANGED" | jq -c . | jq -Rs .),
  '${HANDOFF_AT}',
  '${SLA_DEADLINE}',
  '${WORKQ_ITEM}'
);
SQL

# --- Output result ---
jq -n \
  --arg id "$HANDOFF_ID" \
  --arg author "$AUTHOR" \
  --arg branch "$BRANCH" \
  --arg repo "$REPO" \
  --argjson pr_number "${PR_NUMBER:-0}" \
  --arg pr_url "$PR_URL" \
  --arg reviewer "$REVIEWER" \
  --arg reviewer_tier "$REVIEWER_TIER" \
  --arg priority "$PRIORITY" \
  --arg handoff_at "$HANDOFF_AT" \
  --arg sla_deadline "$SLA_DEADLINE" \
  --argjson files_changed "$FILES_CHANGED" \
  '{
    handoffId: $id,
    author: $author,
    branch: $branch,
    repo: $repo,
    prNumber: $pr_number,
    prUrl: $pr_url,
    reviewer: $reviewer,
    reviewerTier: $reviewer_tier,
    priority: $priority,
    status: "pending-review",
    handoffAt: $handoff_at,
    slaDeadline: $sla_deadline,
    filesChanged: $files_changed
  }'
