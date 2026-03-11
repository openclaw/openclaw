#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <artifact-dir> <session-name> [url]" >&2
  exit 1
fi

ARTIFACT_DIR=$1
SESSION_NAME=$2
PAGE_URL=${3:-http://127.0.0.1:43123/index.html}
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

mkdir -p "$ARTIFACT_DIR"
ARTIFACT_DIR=$(cd "$ARTIFACT_DIR" && pwd)
rm -f \
  "$ARTIFACT_DIR/before.png" \
  "$ARTIFACT_DIR/after.png" \
  "$ARTIFACT_DIR/annotated.png" \
  "$ARTIFACT_DIR/walkthrough.webm" \
  "$ARTIFACT_DIR/assertions.txt"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  agent-browser --session "$SESSION_NAME" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

browser() {
  agent-browser --session "$SESSION_NAME" "$@"
}

cd "$REPO_ROOT"
python3 -m http.server 43123 --directory operator-harness/demo-app >"$ARTIFACT_DIR/serve.log" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" >"$ARTIFACT_DIR/server.pid"

for _ in {1..40}; do
  if curl -fsS "$PAGE_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS "$PAGE_URL" >/dev/null

browser open "$PAGE_URL"
browser wait --load networkidle
browser screenshot --full "$ARTIFACT_DIR/before.png"

browser record restart "$ARTIFACT_DIR/walkthrough.webm" "$PAGE_URL"
browser wait --load networkidle

browser click "[data-testid='filter-review']"
browser wait 350
summary_review=$(browser get text "[data-testid='summary-title']")
empty_review=$(browser get text "[data-testid='empty-state']")
printf '%s\n' "$summary_review" | rg -q "Review tickets"
printf '%s\n' "$empty_review" | rg -q "No tickets in review"

browser click "[data-testid='filter-blocked']"
browser wait 350
summary_blocked=$(browser get text "[data-testid='summary-title']")
printf '%s\n' "$summary_blocked" | rg -q "Blocked tickets"

browser screenshot --full "$ARTIFACT_DIR/after.png"
browser screenshot --annotate "$ARTIFACT_DIR/annotated.png"

browser set viewport 390 844
browser wait 250
mobile_summary=$(browser get text "[data-testid='summary-title']")
printf '%s\n' "$mobile_summary" | rg -q "Blocked tickets"
browser set viewport 1280 720

browser record stop

cat >"$ARTIFACT_DIR/assertions.txt" <<EOF
review_summary=$summary_review
review_empty=$empty_review
blocked_summary=$summary_blocked
mobile_summary=$mobile_summary
EOF
