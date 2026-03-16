#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_JS="$ROOT/src/config.mjs"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NOW="$(id -u)"

CFG="$(CONFIG_JS="$CONFIG_JS" /opt/homebrew/bin/node --input-type=module <<'NODE'
const mod = await import(process.env.CONFIG_JS);
console.log(mod.APP_LOG_DIR);
console.log(mod.LAUNCHD_LABEL);
console.log(mod.LAUNCHD_PLIST_NAME);
console.log(mod.DASHBOARD_LAUNCHD_ROOT);
NODE
)"
LOG_DIR="$(printf '%s\n' "$CFG" | sed -n '1p')"
LAUNCHD_LABEL="$(printf '%s\n' "$CFG" | sed -n '2p')"
LAUNCHD_PLIST_NAME="$(printf '%s\n' "$CFG" | sed -n '3p')"
LAUNCHD_ROOT="$(printf '%s\n' "$CFG" | sed -n '4p')"
RUN_SCRIPT="$LAUNCHD_ROOT/run-dashboard.sh"
TEMPLATE_PLIST="$LAUNCHD_ROOT/com.vio.dashboard.plist"
TARGET_PLIST="$AGENTS_DIR/$LAUNCHD_PLIST_NAME"

MODE="${1:-source}"
case "$MODE" in
  source|runtime) ;;
  *)
    echo "Usage: $0 [source|runtime]" >&2
    exit 1
    ;;
esac

mkdir -p "$AGENTS_DIR" "$LOG_DIR"

python3 - <<PY
from pathlib import Path

template = Path(r'''$TEMPLATE_PLIST''').read_text()
content = template.replace('__LAUNCHD_LABEL__', r'''$LAUNCHD_LABEL''').replace('__RUN_SCRIPT__', r'''$RUN_SCRIPT''')
Path(r'''$TARGET_PLIST''').write_text(content)
PY

printf '%s\n' "$MODE" > "$ROOT/launchd/.run-mode"
if [[ "$MODE" == "runtime" ]]; then
  bash "$ROOT/launchd/sync-runtime.sh"
fi
launchctl bootout "gui/$UID_NOW" "$TARGET_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_NOW" "$TARGET_PLIST"
launchctl kickstart -k "gui/$UID_NOW/$LAUNCHD_LABEL"

echo "Installed and loaded: $LAUNCHD_LABEL"
echo "Mode: $MODE"
echo "Open: http://127.0.0.1:8791"
