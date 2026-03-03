#!/usr/bin/env bash
# =============================================================================
# scripts/mb-security-watch-install.sh
#
# One-time setup: installs the MaxBot security watcher as a macOS LaunchAgent.
# Runs every 5 minutes automatically, even when MB UI is closed.
#
# Usage:
#   bash scripts/mb-security-watch-install.sh             # install / reinstall
#   bash scripts/mb-security-watch-install.sh --uninstall # remove
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH_SCRIPT="$SCRIPT_DIR/mb-security-watch.py"
PLIST_LABEL="com.maxbot.security-watch"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs"
PYTHON="$(command -v python3 2>/dev/null || echo "/usr/bin/python3")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}${BOLD}✓${RESET} $*"; }
info() { echo -e "  ${BOLD}$*${RESET}"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null && ok "Unloaded LaunchAgent" || true
  rm -f "$PLIST_PATH"          && ok "Removed plist" || true
  echo "Uninstalled. Audit log, cursor, and lockdown files are untouched."
  exit 0
fi

# ── Sanity checks ─────────────────────────────────────────────────────────────
[[ -f "$WATCH_SCRIPT" ]] || { echo "Watch script not found: $WATCH_SCRIPT"; exit 1; }
[[ -x "$PYTHON" ]]       || { echo "python3 not found at $PYTHON"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# ── Passphrase setup ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━  MaxBot Security Watcher — Setup  ━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo "  Choose an unlock passphrase. MB will go into LOCKDOWN when a serious"
echo "  security event is detected. You'll send this passphrase via Signal to"
echo "  lift the lockdown."
echo ""
echo "  The passphrase is stored as a SHA-256 hash only — never in plain text."
echo ""

PASSPHRASE_HASH=""
if [[ -f "$PLIST_PATH" ]]; then
  # Re-use existing hash if reinstalling
  existing=$(grep -A1 "MB_LOCKDOWN_PASSPHRASE_HASH" "$PLIST_PATH" 2>/dev/null \
    | grep "<string>" | sed 's/.*<string>\(.*\)<\/string>.*/\1/' || true)
  if [[ -n "$existing" ]]; then
    warn "Existing passphrase hash found. Press Enter to keep it, or type a new passphrase:"
    read -r -s new_pp
    if [[ -z "$new_pp" ]]; then
      PASSPHRASE_HASH="$existing"
      ok "Keeping existing passphrase hash."
    else
      PASSPHRASE_HASH=$(echo -n "$new_pp" | python3 -c "import sys,hashlib; print(hashlib.sha256(sys.stdin.read().strip().encode()).hexdigest())")
      ok "New passphrase hash set."
    fi
  fi
fi

if [[ -z "$PASSPHRASE_HASH" ]]; then
  while true; do
    echo -n "  Enter passphrase: "
    read -r -s pp1; echo ""
    echo -n "  Confirm passphrase: "
    read -r -s pp2; echo ""
    if [[ -z "$pp1" ]]; then
      warn "Passphrase cannot be empty. Try again."
      continue
    fi
    if [[ "$pp1" != "$pp2" ]]; then
      warn "Passphrases do not match. Try again."
      continue
    fi
    PASSPHRASE_HASH=$(echo -n "$pp1" | python3 -c "import sys,hashlib; print(hashlib.sha256(sys.stdin.read().strip().encode()).hexdigest())")
    ok "Passphrase hash stored."
    break
  done
fi

# ── Write plist ───────────────────────────────────────────────────────────────
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON}</string>
    <string>${WATCH_SCRIPT}</string>
  </array>

  <!-- Check every 5 minutes -->
  <key>StartInterval</key>
  <integer>300</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/security-watch.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/security-watch.log</string>

  <key>KeepAlive</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>MB_LOCKDOWN_PASSPHRASE_HASH</key>
    <string>${PASSPHRASE_HASH}</string>
  </dict>
</dict>
</plist>
PLIST

# ── Load ──────────────────────────────────────────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo ""
echo -e "${GREEN}${BOLD}  MaxBot security watcher installed  ${RESET}"
echo ""
ok "Runs every 5 minutes (even with MB UI closed)"
ok "Sends Signal alert to +447366270212 on blocked events"
ok "Full lockdown auto-triggers on serious threats"
ok "Send 'UNLOCK: <passphrase>' via Signal to lift lockdown"
echo ""
info "Plist:    $PLIST_PATH"
info "Log:      $LOG_DIR/security-watch.log"
info "Audit:    $LOG_DIR/security-sentinel.jsonl"
echo ""
echo "  Useful commands:"
echo "    tail -f $LOG_DIR/security-watch.log           # live log"
echo "    python3 $WATCH_SCRIPT --status                # current state"
echo "    python3 $WATCH_SCRIPT --reset                 # terminal unlock"
echo "    bash $0 --uninstall                           # remove"
echo ""
