#!/usr/bin/env bash
# Scenario 3: Gateway-relay expiry
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO="scenario3"
TITLE="Gateway-relay expiry"
SETUP="talk.realtime.transport=gateway-relay; Mac app relay opt-in ON"
STEPS="Enable relay Talk, stay silent ${IDLE_WAIT_SEC}s, Talk should auto-disable"

log "=== $TITLE ==="
record_scenario_meta "$SCENARIO" "$TITLE" "$SETUP" "$STEPS"

set_realtime_transport gateway-relay
restart_gateway

capture_talk_config "$EVIDENCE_DIR/$SCENARIO/talk.config.pre-test.json"

prompt "$(cat <<EOF
MANUAL STEPS (Mac app):
1. Open Settings → Voice Wake
2. Turn ON "Use realtime Gateway relay"
3. Toggle Talk OFF, then ON (relay path)
4. Confirm Talk is active on relay (not native STT-only)
5. Do NOT speak — the script will wait ${IDLE_WAIT_SEC}s
EOF
)"

log "Waiting ${IDLE_WAIT_SEC}s for idle timeout..."
sleep "$IDLE_WAIT_SEC"

capture_runtime_logs "$SCENARIO" >/dev/null

UI_OUTCOME=""
if prompt_yn "Did Talk turn off automatically on the relay path?" y; then
  UI_OUTCOME="Gateway-relay Talk on; silent ${IDLE_WAIT_SEC}s; overlay dismissed, Talk off."
  PASS="PASS"
else
  read -r -p "Describe what you saw: " UI_OUTCOME
  PASS="FAIL"
fi

filtered="$EVIDENCE_DIR/$SCENARIO/talk.runtime.filtered.txt"
if [[ -s "$filtered" ]] && rg -q "idle timeout expired" "$filtered"; then
  log "Log contains idle timeout expiry line."
else
  log "WARNING: idle timeout line not found in filtered logs."
  PASS="FAIL (missing log line)"
fi

# Restore native transport for convenience
set_realtime_transport webrtc
log "Restored config transport=webrtc (restart gateway manually if needed)."

finish_scenario "$SCENARIO" "$UI_OUTCOME" "$PASS"
log "Report: $(write_evidence_report)"
