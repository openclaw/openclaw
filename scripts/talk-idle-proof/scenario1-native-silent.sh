#!/usr/bin/env bash
# Scenario 1: Native silent listening expiry
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO="scenario1"
TITLE="Native silent listening expiry"
SETUP="talk.realtime.transport=webrtc; Mac app relay opt-in OFF"
STEPS="Enable Talk, stay silent ${IDLE_WAIT_SEC}s, Talk should auto-disable"

log "=== $TITLE ==="
record_scenario_meta "$SCENARIO" "$TITLE" "$SETUP" "$STEPS"

ensure_gateway
set_realtime_transport webrtc
log "Config set to native path (webrtc). Restart Mac app if it was already running."

prompt "$(cat <<EOF
MANUAL STEPS (Mac app):
1. Open Settings → Voice Wake
2. Turn OFF "Use realtime Gateway relay"
3. Toggle Talk Mode OFF, then ON
4. Confirm overlay shows Listening
5. Do NOT speak — the script will wait ${IDLE_WAIT_SEC}s for you
EOF
)"

log "Waiting ${IDLE_WAIT_SEC}s for idle timeout..."
sleep "$IDLE_WAIT_SEC"

capture_runtime_logs "$SCENARIO" >/dev/null

UI_OUTCOME=""
if prompt_yn "Did Talk turn off automatically (overlay gone, menu unchecked)?" y; then
  UI_OUTCOME="Talk overlay dismissed and menu Talk off after ~${IDLE_WAIT_SEC}s silence without speech."
  PASS="PASS"
else
  read -r -p "Describe what you saw: " UI_OUTCOME
  PASS="FAIL"
fi

idle_log="$EVIDENCE_DIR/$SCENARIO/talk.runtime.idle-timeout.log"
filtered="$EVIDENCE_DIR/$SCENARIO/talk.runtime.filtered.txt"
if rg -q "idle timeout expired" "$filtered" "$idle_log" 2>/dev/null; then
  log "Log contains idle timeout expiry line."
  rg "idle timeout expired" "$filtered" "$idle_log" 2>/dev/null | head -3
else
  log "WARNING: idle timeout line not found (try: ./scripts/clawlog.sh -c talk.runtime --all -l 10m -s \"idle timeout\")"
  if [[ "$PASS" == "PASS" ]]; then
    PASS="PASS (UI only; missing log line)"
  else
    PASS="FAIL (missing log line)"
  fi
fi

finish_scenario "$SCENARIO" "$UI_OUTCOME" "$PASS"
log "Report: $(write_evidence_report)"
