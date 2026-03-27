#!/usr/bin/env bash
# preflight.sh — validate environment before any Codex invocation
# Exit 0 = all checks pass, exit 1 = critical failure (abort run)
set -euo pipefail

FAIL=0
WORKSPACE="/home/node/.openclaw/workspace-engineering"

echo "[preflight] Starting checks..."

# 1. Codex OAuth auth
AUTH_FILE="${HOME}/.codex/auth.json"
if [[ ! -f "$AUTH_FILE" ]]; then
  echo "[preflight] ERROR: ~/.codex/auth.json not found" >&2
  FAIL=1
else
  TOKEN=$(python3 -c "
import json, sys
try:
    d = json.load(open('${AUTH_FILE}'))
    print(d.get('tokens', {}).get('access_token', ''))
except Exception as e:
    print('', file=sys.stderr)
" 2>/dev/null || echo "")
  if [[ -z "$TOKEN" ]]; then
    echo "[preflight] ERROR: No access_token in ~/.codex/auth.json — run 'codex login' on host to refresh" >&2
    FAIL=1
  else
    echo "[preflight] OK: codex OAuth token present"
  fi
fi

# 2. Required binaries
for bin in codex git python3 bash; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "[preflight] OK: $bin found at $(command -v $bin)"
  else
    echo "[preflight] ERROR: $bin not found in PATH" >&2
    FAIL=1
  fi
done

# 3. Disk space (> 1 GB free in /tmp for worktrees)
FREE_KB=$(df /tmp --output=avail 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
if [[ "$FREE_KB" -lt 1048576 ]]; then
  echo "[preflight] ERROR: Less than 1 GB free in /tmp (${FREE_KB} KB available)" >&2
  FAIL=1
else
  echo "[preflight] OK: ${FREE_KB} KB free in /tmp"
fi

# 4. Create .eng directories in workspace if missing
mkdir -p "${WORKSPACE}/.eng/logs" \
         "${WORKSPACE}/.eng/memory" \
         "${WORKSPACE}/.eng/reviews"
echo "[preflight] OK: .eng directories ready"

if [[ "$FAIL" -eq 0 ]]; then
  echo "[preflight] All checks passed."
else
  echo "[preflight] One or more critical checks failed — aborting." >&2
fi

exit $FAIL
