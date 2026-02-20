#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[1/4] Lint critical ClarityOS + gateway files..."
pnpm -s lint \
  ui/src/ui/views/clarityos.ts \
  ui/src/ui/controllers/clarityos.ts \
  ui/src/ui/app-polling.ts \
  src/gateway/server-methods/clarityos.ts \
  src/gateway/server-methods.ts

echo "[2/4] Check for unresolved conflict markers..."
if grep -R -nE '^(<<<<<<<|=======|>>>>>>>)' src/gateway/server-methods.ts ui/src/ui/views/clarityos.ts >/dev/null; then
  echo "[error] Conflict markers found:" >&2
  grep -R -nE '^(<<<<<<<|=======|>>>>>>>)' src/gateway/server-methods.ts ui/src/ui/views/clarityos.ts || true
  exit 1
fi

echo "[3/4] Git status..."
git status -sb

echo "[4/4] Manual runtime checks (do these in UI/chat):"
echo "  - Open Control UI -> ClarityOS tab -> Refresh"
echo "  - Keep tab open >60s, confirm no aggressive polling"
echo "  - Verify .main hello and .submain hello"
echo "  - Verify one cron/heartbeat message path"
echo ""
echo "Smoke checks completed."
