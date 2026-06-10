#!/usr/bin/env bash
#
# gateway-watchdog.sh — hourly self-heal for agent gateway containers
# (channel-error-hardening Phase B2). Runs ON each prod host via cron:
#
#   17 * * * *  /bin/bash /opt/openclaw/scripts/ops/gateway-watchdog.sh >> /var/log/openclaw-watchdog.log 2>&1
#
# What it does:
# - Revives gateway containers that exited NON-ZERO (crashes, OOM-kills,
#   daemon-restart races), max 3 starts per run with a 20s stagger — the
#   2-vCPU US host cannot absorb simultaneous gateway boots (2026-06-10:
#   12 at once → load 117).
# - Leaves exit code 0/143 alone: that is a deliberate `docker stop` and the
#   unless-stopped restart policy's promise must be respected.
# - Skips containers whose recent logs match known TERMINAL signatures
#   (invalid bot token 401 loop, channel runner gave up, mcp-bridge EPIPE):
#   reviving those just resumes the loop. Skips are recorded to
#   /root/.openclaw/watchdog-state.json, which the daily
#   agents_server_diagnostic.sh folds into the bug_list AUTOSCAN block —
#   single writer for bug_list.md stays the daily cron.
set -uo pipefail

STATE=/root/.openclaw/watchdog-state.json
MAX_STARTS=3
started=0
ts="$(date -u +%FT%TZ)"
entries=""

record() { # action container exitCode reason
  entries="$entries{\"ts\":\"$ts\",\"action\":\"$1\",\"container\":\"$2\",\"exitCode\":$3,\"reason\":\"$4\"},"
}

terminal_reason() { # prints reason and returns 0 if last log lines look terminal
  local logs="$1"
  if printf '%s' "$logs" | grep -q "401: Unauthorized"; then echo "telegram-401"; return 0; fi
  if printf '%s' "$logs" | grep -qE "giving up after [0-9]+ restart attempts"; then echo "channel-gave-up"; return 0; fi
  if printf '%s' "$logs" | grep -q "EPIPE"; then echo "epipe-crash"; return 0; fi
  return 1
}

for c in $(docker ps -a --filter "status=exited" --format '{{.Names}}' | grep -- "-openclaw-gateway-1$"); do
  code="$(docker inspect -f '{{.State.ExitCode}}' "$c" 2>/dev/null || echo "?")"
  if [ "$code" = "0" ] || [ "$code" = "143" ] || [ "$code" = "?" ]; then
    continue
  fi
  logs="$(docker logs --tail 50 "$c" 2>&1)"
  if reason="$(terminal_reason "$logs")"; then
    echo "$ts SKIP   $c exit=$code reason=$reason (terminal — needs human action)"
    record skipped "$c" "$code" "$reason"
    continue
  fi
  if [ "$started" -ge "$MAX_STARTS" ]; then
    echo "$ts DEFER  $c exit=$code (max $MAX_STARTS starts/run — next run picks it up)"
    record deferred "$c" "$code" "max-starts-per-run"
    continue
  fi
  if docker start "$c" >/dev/null 2>&1; then
    started=$((started + 1))
    echo "$ts REVIVE $c (was exit=$code)"
    record revived "$c" "$code" "non-zero-exit"
    sleep 20
  else
    echo "$ts FAIL   $c — docker start failed"
    record start-failed "$c" "$code" "docker-start-error"
  fi
done

if [ -n "$entries" ]; then
  ENTRIES_JSON="[${entries%,}]" python3 - "$STATE" <<'PYEOF'
import json, os, sys
path = sys.argv[1]
new = json.loads(os.environ["ENTRIES_JSON"])
old = []
if os.path.exists(path):
    try:
        old = json.load(open(path))
    except Exception:
        old = []
json.dump((old + new)[-200:], open(path, "w"), indent=1)
PYEOF
fi
