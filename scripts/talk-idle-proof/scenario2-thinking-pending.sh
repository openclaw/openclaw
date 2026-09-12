#!/usr/bin/env bash
# Scenario 2: Pending-reply expiry (thinking phase)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SCENARIO="scenario2"
TITLE="Pending-reply expiry (thinking phase)"
SETUP="Native path (webrtc); relay opt-in OFF; gateway paused after thinking starts"
STEPS="Speak once, enter Thinking, gateway STOP ${IDLE_WAIT_SEC}s, Talk should auto-disable"

log "=== $TITLE ==="
record_scenario_meta "$SCENARIO" "$TITLE" "$SETUP" "$STEPS"

ensure_gateway
set_realtime_transport webrtc

GW_PID="$(gateway_pid)"
[[ -n "$GW_PID" ]] || die "No gateway PID on port $GATEWAY_PORT"

prompt "$(cat <<EOF
MANUAL STEPS (Mac app):
1. Confirm "Use realtime Gateway relay" is OFF
2. Toggle Talk OFF, then ON
3. Say clearly: "What time is it?"
4. Wait until overlay shows THINKING (send chime)
5. Come back here immediately — do not wait for a reply
EOF
)"

log "Pausing gateway (PID $GW_PID) to block assistant reply..."
kill -STOP "$GW_PID" || die "kill -STOP failed for PID $GW_PID"

log "Gateway paused. Waiting ${IDLE_WAIT_SEC}s for idle timeout during thinking..."
sleep "$IDLE_WAIT_SEC"

kill -CONT "$GW_PID" 2>/dev/null || true
log "Gateway resumed."

capture_runtime_logs "$SCENARIO" >/dev/null

UI_OUTCOME=""
if prompt_yn "Did Talk turn off automatically while waiting (no assistant reply)?" y; then
  UI_OUTCOME="Entered Thinking after speech; gateway paused; Talk auto-off ~${IDLE_WAIT_SEC}s without reply."
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
