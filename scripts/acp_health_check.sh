#!/usr/bin/env bash
set -euo pipefail

printf '== gateway status ==\n'
openclaw gateway status

printf '\n== openclaw status --deep ==\n'
openclaw status --deep || true

printf '\n== last heartbeat ==\n'
openclaw system heartbeat last || true

printf '\n== safe event smoke test ==\n'
openclaw system event --text "gateway stability check" --mode next-heartbeat

printf '\n== log signals ==\n'
grep -RIn "queue owner unavailable\|ensureSession replacing dead named session\|abnormal closure\|1006\|acpx exited with code 1\|stale-socket" /tmp/openclaw /home/mertb/.openclaw 2>/dev/null | tail -n 80 || true
