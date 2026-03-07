#!/usr/bin/env bash
set -euo pipefail

# Platinum Fang guided demo runner.
# This script is visual (step banners + pauses) and operator-driven.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

MODE_SCRIPT="$SCRIPT_DIR/platinumfang-mode.sh"
TOUR_SCRIPT="$SCRIPT_DIR/platinumfang-tour.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose v2 is required." >&2
  exit 1
fi

if [[ ! -x "$MODE_SCRIPT" ]]; then
  echo "Missing mode script: $MODE_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$TOUR_SCRIPT" ]]; then
  echo "Missing tour script: $TOUR_SCRIPT" >&2
  exit 1
fi

pause() {
  read -r -p "Press Enter to continue..."
}

banner() {
  local msg="$1"
  printf '\n============================================================\n'
  printf '%s\n' "$msg"
  printf '============================================================\n'
}

run_cli() {
  docker compose run --rm openclaw-cli "$@"
}

banner "Platinum Fang Demo: 1) Baseline Status"
"$MODE_SCRIPT" status || true
pause

banner "Platinum Fang Demo: 2) Architecture + Capability Tour"
"$TOUR_SCRIPT" || true
pause

banner "Platinum Fang Demo: 3) Enforce Safe Mode"
"$MODE_SCRIPT" safe
pause

banner "Platinum Fang Demo: 4) Show Pairing Queue (Discord DM test now)"
cat <<'EOF'
On Discord:
  1) DM your bot: hi
  2) Wait for pairing code
Then return here.
EOF
pause
run_cli pairing list discord || true
cat <<'EOF'
If you see a code, approve it with:
  docker compose run --rm openclaw-cli pairing approve discord <CODE>
EOF
pause

banner "Platinum Fang Demo: 5) Toggle Individual Controls"
"$MODE_SCRIPT" discord-toggle
"$MODE_SCRIPT" mention-toggle
"$MODE_SCRIPT" model-toggle
"$MODE_SCRIPT" profile-toggle
"$MODE_SCRIPT" status || true
pause

banner "Platinum Fang Demo: 6) Toggle-All (Global Invert)"
"$MODE_SCRIPT" toggle-all
pause

banner "Platinum Fang Demo: 7) Return to Safe End State"
"$MODE_SCRIPT" safe
"$MODE_SCRIPT" status || true

banner "Demo Complete"
cat <<'EOF'
You have now seen:
  - baseline status
  - architecture/capability map
  - secure mode enforcement
  - pairing flow checkpoint
  - individual toggles
  - toggle-all behavior
  - return-to-safe workflow
EOF
