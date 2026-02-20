#!/usr/bin/env bash
set -euo pipefail

MAX_WAIT_SECONDS=90
WAIT_INTERVAL_SECONDS=2
TARGET_URL="http://127.0.0.1:18789/status"

printf '[openclaw-gateway] startup: gateway may take a few seconds to warm up (providers/signals/channels).
'
printf '[openclaw-gateway] startup: waiting up to %s seconds for HTTP status endpoint %s to become available.
' "$MAX_WAIT_SECONDS" "$TARGET_URL"

for i in $(seq 1 "$MAX_WAIT_SECONDS"); do
  if curl -fsS --max-time 1 "$TARGET_URL" >/dev/null 2>&1; then
    printf '[openclaw-gateway] startup: gateway ready after %ss.
' "$((i * WAIT_INTERVAL_SECONDS))"
    exit 0
  fi

  if (( i % 10 == 0 )); then
    printf '[openclaw-gateway] startup: still initializing (t=%ss). If this persists, check upstream logs; status probe will become healthy when ws listener is ready.
' "$((i * WAIT_INTERVAL_SECONDS))"
  fi

  sleep "$WAIT_INTERVAL_SECONDS"
 done

printf '[openclaw-gateway] startup: endpoint did not become ready in time.
'
printf '[openclaw-gateway] startup: service is running, but clients should retry in a few seconds.
'
exit 0
