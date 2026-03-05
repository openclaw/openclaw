#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
REG="$ROOT/.clawdbot/active-tasks.json"
NOTIFY="$ROOT/scripts/swarm/notify.sh"

if [[ ! -f "$REG" ]]; then
  echo "No registry file found: $REG"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found; skip"
  exit 0
fi

task_ids=$(jq -r '.tasks[].id' "$REG")
for id in $task_ids; do
  task=$(jq -c --arg id "$id" '.tasks[] | select(.id==$id)' "$REG")
  [[ -z "$task" ]] && continue

  status=$(echo "$task" | jq -r '.status')
  [[ "$status" == "merged" || "$status" == "failed_permanent" ]] && continue

  branch=$(echo "$task" | jq -r '.branch')
  session=$(echo "$task" | jq -r '.session')
  attempt=$(echo "$task" | jq -r '.attempt')
  max_retries=$(echo "$task" | jq -r '.max_retries')
  notified=$(echo "$task" | jq -r '.notified_ready')

  pr_json=$(gh pr list --state open --head "$branch" --json number,url,isDraft 2>/dev/null | jq '.[0] // null')
  pr_number=$(echo "$pr_json" | jq -r '.number // empty')

  tmp=$(mktemp)
  if [[ -n "$pr_number" ]]; then
    pr_url=$(echo "$pr_json" | jq -r '.url')
    jq --arg id "$id" --argjson pr "$pr_number" --arg url "$pr_url" --arg now "$(date -Iseconds)" \
      '.tasks |= map(if .id==$id then .pr_number=$pr | .pr_url=$url | .status="pr_open" | .updated_at=$now else . end)' \
      "$REG" > "$tmp" && mv "$tmp" "$REG"

    check_json=$(gh pr view "$pr_number" --json statusCheckRollup,reviewDecision,mergeStateStatus 2>/dev/null)
    pending=$(echo "$check_json" | jq '[.statusCheckRollup[]? | select((.conclusion==null) and (.status!="COMPLETED"))] | length')
    failed=$(echo "$check_json" | jq '[.statusCheckRollup[]? | select(.conclusion=="FAILURE" or .conclusion=="CANCELLED" or .conclusion=="TIMED_OUT")] | length')

    if (( failed > 0 )); then
      if (( attempt < max_retries )); then
        bash "$ROOT/scripts/swarm/retry-agent.sh" "$id" || true
        bash "$NOTIFY" "⚠️ [$id] CI failed; auto-retry ${attempt}/${max_retries}"
      else
        tmp=$(mktemp)
        jq --arg id "$id" --arg now "$(date -Iseconds)" '.tasks |= map(if .id==$id then .status="failed_permanent" | .updated_at=$now | .last_error="ci_failed" else . end)' "$REG" > "$tmp" && mv "$tmp" "$REG"
        bash "$NOTIFY" "❌ [$id] retry budget exhausted (CI failures)."
      fi
      continue
    fi

    if (( pending > 0 )); then
      continue
    fi

    is_draft=$(echo "$pr_json" | jq -r '.isDraft // false')
    if [[ "$is_draft" == "true" ]]; then
      continue
    fi

    if bash "$ROOT/scripts/swarm/pr-ready.sh" "$pr_number" >/dev/null 2>&1; then
      if [[ "$notified" != "true" ]]; then
        tmp=$(mktemp)
        jq --arg id "$id" --arg now "$(date -Iseconds)" '.tasks |= map(if .id==$id then .status="ready_for_review" | .notified_ready=true | .updated_at=$now else . end)' "$REG" > "$tmp" && mv "$tmp" "$REG"
        bash "$NOTIFY" "✅ PR #$pr_number ready for review: $(gh pr view "$pr_number" --json url --jq .url)"
      fi
    fi
    continue
  fi

  if tmux has-session -t "$session" 2>/dev/null; then
    tmp=$(mktemp)
    jq --arg id "$id" --arg now "$(date -Iseconds)" '.tasks |= map(if .id==$id then .status="in_progress" | .updated_at=$now else . end)' "$REG" > "$tmp" && mv "$tmp" "$REG"
  else
    if (( attempt < max_retries )); then
      bash "$ROOT/scripts/swarm/retry-agent.sh" "$id" || true
      bash "$NOTIFY" "🔁 [$id] session stopped; auto-retry ${attempt}/${max_retries}"
    else
      tmp=$(mktemp)
      jq --arg id "$id" --arg now "$(date -Iseconds)" '.tasks |= map(if .id==$id then .status="failed_permanent" | .updated_at=$now | .last_error="session_dead" else . end)' "$REG" > "$tmp" && mv "$tmp" "$REG"
      bash "$NOTIFY" "❌ [$id] failed: session stopped and retry budget exhausted."
    fi
  fi
done

echo "[swarm-monitor] done $(date -Iseconds)"
