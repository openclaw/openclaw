#!/usr/bin/env bash
# Run all three Talk idle-timeout proof scenarios and emit one PR evidence report.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

export RUN_ID EVIDENCE_DIR LOG_ROOT IDLE_WAIT_SEC REPO TEST_CONFIG GATEWAY_PORT

log "Evidence directory: $EVIDENCE_DIR"
log "Ensure dist/OpenClaw.app is built and gateway credentials are configured."

prompt "$(cat <<EOF
Before starting:
1. Mac app: open -n "$REPO/dist/OpenClaw.app" --args --attach-only
2. Microphone + Speech Recognition allowed for OpenClaw
3. This run will take ~$(( IDLE_WAIT_SEC * 3 + 120 ))s plus manual Talk toggles

Press Enter to run Scenario 1 → 2 → 3 in order.
EOF
)"

bash "$SCRIPT_DIR/scenario1-native-silent.sh"
bash "$SCRIPT_DIR/scenario2-thinking-pending.sh"
bash "$SCRIPT_DIR/scenario3-gateway-relay.sh"

REPORT="$(write_evidence_report)"
printf '\nDone. Add to your PR:\n  %s\n\nArtifacts:\n  %s\n' "$REPORT" "$EVIDENCE_DIR"
