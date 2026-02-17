#!/bin/bash
# permctl.sh — macOS TCC permission checker for AI agents
# Usage: bash permctl.sh [status|request|guide] [permission]
# Output: JSON (machine-readable)
set -euo pipefail

NODE_BIN=$(cd "$(dirname "$(which node)")" && pwd -P)/$(basename "$(which node)")
# Follow symlinks manually (macOS BSD readlink lacks -f)
while [ -L "$NODE_BIN" ]; do
  LINK_TARGET=$(readlink "$NODE_BIN")
  case "$LINK_TARGET" in
    /*) NODE_BIN="$LINK_TARGET" ;;
    *)  NODE_BIN="$(dirname "$NODE_BIN")/$LINK_TARGET" ;;
  esac
done

check_screen_recording() {
  # Prefer peekaboo if available (most reliable)
  if command -v peekaboo &>/dev/null; then
    local out
    out=$(peekaboo permissions status 2>&1) || true
    if echo "$out" | grep -q "Screen Recording.*Granted"; then
      echo "granted"; return
    elif echo "$out" | grep -q "Screen Recording.*Not Granted"; then
      echo "denied"; return
    fi
  fi
  # Fallback: screencapture (may fail in non-TTY)
  /usr/sbin/screencapture -x /tmp/.permctl_sr_test.png 2>/dev/null || true
  if [ -f /tmp/.permctl_sr_test.png ]; then
    rm -f /tmp/.permctl_sr_test.png
    echo "granted"
  else
    # screencapture can fail in non-TTY without meaning denied
    # Check via TCC database as last resort
    local count
    count=$(sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
      "SELECT allowed FROM access WHERE service='kTCCServiceScreenCapture' AND indirect_object_identifier='com.apple.screencaptureui' LIMIT 1" 2>/dev/null) || true
    if [ "$count" = "1" ]; then
      echo "granted"
    elif [ "$count" = "0" ]; then
      echo "denied"
    else
      echo "unknown"
    fi
  fi
}

check_accessibility() {
  local out
  out=$(osascript \
    -e 'with timeout of 5 seconds' \
    -e 'tell application "System Events" to get name of first process' \
    -e 'end timeout' 2>&1) || true
  if echo "$out" | grep -qi "not allowed"; then
    echo "denied"
  elif [ -n "$out" ] && ! echo "$out" | grep -qi "error"; then
    echo "granted"
  else
    echo "unknown"
  fi
}

check_automation() {
  local out
  out=$(osascript \
    -e 'with timeout of 5 seconds' \
    -e 'tell application "Finder" to get name' \
    -e 'end timeout' 2>&1) || true
  if echo "$out" | grep -qi "not allowed\|not authorized"; then
    echo "denied"
  elif [ "$out" = "Finder" ]; then
    echo "granted"
  else
    echo "unknown"
  fi
}

check_full_disk_access() {
  if [ ! -e "$HOME/Library/Mail" ]; then
    # Directory doesn't exist — can't determine FDA status
    echo "unknown"
  elif ls "$HOME/Library/Mail" >/dev/null 2>&1; then
    echo "granted"
  else
    echo "denied"
  fi
}

check_calendar() {
  local out
  out=$(osascript \
    -e 'with timeout of 5 seconds' \
    -e 'tell application "Calendar" to get name of first calendar' \
    -e 'end timeout' 2>&1) || true
  if echo "$out" | grep -qi "not allowed"; then
    echo "denied"
  elif [ -n "$out" ] && ! echo "$out" | grep -qi "error"; then
    echo "granted"
  else
    echo "unknown"
  fi
}

check_reminders() {
  local out
  out=$(osascript \
    -e 'with timeout of 5 seconds' \
    -e 'tell application "Reminders" to get name of first list' \
    -e 'end timeout' 2>&1) || true
  if echo "$out" | grep -qi "not allowed\|denied"; then
    echo "denied"
  elif [ -n "$out" ] && ! echo "$out" | grep -qi "error"; then
    echo "granted"
  else
    echo "unknown"
  fi
}

# ── Settings URLs ────────────────────────────────────────────────────
settings_url() {
  case "$1" in
    screen-recording) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" ;;
    accessibility) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" ;;
    automation) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" ;;
    full-disk-access) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" ;;
    camera) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera" ;;
    microphone) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" ;;
    calendar) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars" ;;
    reminders) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders" ;;
    contacts) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts" ;;
    input-monitoring) echo "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent" ;;
    *) echo "" ;;
  esac
}

# ── Trigger permission popup ────────────────────────────────────────
trigger_permission() {
  case "$1" in
    screen-recording)
      /usr/sbin/screencapture -x /tmp/.permctl_trigger.png 2>/dev/null || true
      rm -f /tmp/.permctl_trigger.png
      echo '{"kind":"screen-recording","triggered":true}'
      ;;
    accessibility)
      osascript -e 'tell application "System Events" to get name of first process' 2>/dev/null || true
      echo '{"kind":"accessibility","triggered":true}'
      ;;
    automation)
      osascript -e 'tell application "Finder" to get name' 2>/dev/null || true
      echo '{"kind":"automation","triggered":true}'
      ;;
    calendar)
      osascript -e 'tell application "Calendar" to get name of first calendar' 2>/dev/null || true
      echo '{"kind":"calendar","triggered":true}'
      ;;
    contacts)
      osascript -e 'tell application "Contacts" to get name of first person' 2>/dev/null || true
      echo '{"kind":"contacts","triggered":true}'
      ;;
    reminders)
      osascript -e 'tell application "Reminders" to get name of first list' 2>/dev/null || true
      echo '{"kind":"reminders","triggered":true}'
      ;;
    full-disk-access|camera|microphone|input-monitoring)
      local url
      url=$(settings_url "$1")
      open "$url" 2>/dev/null || true
      echo "{\"kind\":\"$1\",\"triggered\":false,\"opened_settings\":true}"
      ;;
    *)
      echo "{\"error\":\"unknown permission: $1\"}"
      ;;
  esac
}

# ── Commands ─────────────────────────────────────────────────────────
cmd_status() {
  local perms=("screen-recording" "accessibility" "automation" "full-disk-access")
  if [ "${1:-}" = "--all" ]; then
    perms+=("calendar" "reminders")
  fi

  local items=()
  for p in "${perms[@]}"; do
    local fn="check_${p//-/_}"
    local st
    st=$($fn 2>/dev/null || echo "unknown")
    items+=("{\"kind\":\"$p\",\"status\":\"$st\"}")
  done

  local json
  json=$(printf '%s,' "${items[@]}")
  json="[${json%,}]"
  echo "{\"binary\":\"$NODE_BIN\",\"permissions\":$json}"
}

cmd_request() {
  if [ -n "${1:-}" ]; then
    trigger_permission "$1"
    return
  fi
  # Batch: trigger all denied
  local status_json
  status_json=$(cmd_status)
  local results=()
  for p in screen-recording accessibility automation full-disk-access; do
    local st
    st=$(echo "$status_json" | grep -o "\"kind\":\"$p\",\"status\":\"[^\"]*\"" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    if [ "$st" != "granted" ]; then
      local r
      r=$(trigger_permission "$p")
      results+=("$r")
    fi
  done
  if [ ${#results[@]} -eq 0 ]; then
    echo '{"message":"all permissions granted","results":[]}'
  else
    local json
    json=$(printf '%s,' "${results[@]}")
    echo "{\"results\":[${json%,}]}"
  fi
}

cmd_guide() {
  local perm="${1:-}"
  if [ -z "$perm" ]; then
    echo '{"error":"usage: permctl.sh guide <permission>"}'
    return 1
  fi
  local url
  url=$(settings_url "$perm")
  if [ -z "$url" ]; then
    echo "{\"error\":\"unknown permission: $perm\"}"
    return 1
  fi
  open "$url" 2>/dev/null || true
  echo "{\"kind\":\"$perm\",\"opened\":true,\"url\":\"$url\",\"binary\":\"$NODE_BIN\"}"
}

# ── Main ─────────────────────────────────────────────────────────────
case "${1:-status}" in
  status) cmd_status "${2:-}" ;;
  request|req) cmd_request "${2:-}" ;;
  guide) cmd_guide "${2:-}" ;;
  *)
    echo '{"error":"unknown command","usage":"permctl.sh [status|request|guide] [permission]"}'
    exit 1
    ;;
esac
