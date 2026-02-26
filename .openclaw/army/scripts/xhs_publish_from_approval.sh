#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/jack/github/openclaw/.openclaw/army"
RUNTIME="$ROOT/runtime"
PUBLISHED="$ROOT/published"
CHAT_ID="14886"
CHAT_TARGET="chat_id:14886"

mkdir -p "$RUNTIME" "$PUBLISHED"
queue="$RUNTIME/xhs_queue.jsonl"
[ -f "$queue" ] || touch "$queue"

last_approvals="$RUNTIME/approvals_seen.txt"
[ -f "$last_approvals" ] || touch "$last_approvals"

# Parse latest approval replies from the dedicated chat.
mapfile -t approvals < <(imsg history --chat-id "$CHAT_ID" --limit 80 --json 2>/dev/null \
  | jq -Rr 'fromjson? | select(.is_from_me==false) | .text // empty' \
  | rg -o '同意发布\s+xhs-[0-9]{8}-[0-9]{6}' \
  | awk '{print $2}' \
  | sort -u)

for id in "${approvals[@]:-}"; do
  grep -qx "$id" "$last_approvals" && continue

  line="$(jq -Rr --arg id "$id" 'fromjson? | select(.id==$id and .status=="pending_review") | @json' < "$queue" | tail -n 1)"
  if [[ -z "$line" ]]; then
    echo "$id" >> "$last_approvals"
    continue
  fi

  json_path="$(printf '%s' "$line" | jq -r '.json')"
  if [[ ! -f "$json_path" ]]; then
    echo "$id" >> "$last_approvals"
    continue
  fi

  # Try publish; if login missing/editor changed, notify and keep pending.
  result="$(node "$ROOT/scripts/xhs_publish_playwright.mjs" --input "$json_path" 2>&1 || true)"
  ok="$(printf '%s' "$result" | jq -Rr 'fromjson? | .ok // empty' | tail -n 1)"

  if [[ "$ok" == "true" ]]; then
    cp "$json_path" "$PUBLISHED/${id}.json"
    jq -Rr --arg id "$id" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
      fromjson? | if .id==$id and .status=="pending_review" then .status="published" | .published_at=$ts else . end | @json
    ' < "$queue" > "$queue.tmp" && mv "$queue.tmp" "$queue"

    openclaw message send --channel imessage --target "$CHAT_TARGET" --message "已自动发布：$id" --json >/dev/null || true
  else
    openclaw message send --channel imessage --target "$CHAT_TARGET" --message "自动发布失败：$id。请先执行登录初始化：node $ROOT/scripts/xhs_publish_playwright.mjs --setup-login" --json >/dev/null || true
  fi

  echo "$id" >> "$last_approvals"
done

echo "approval-check-done"
