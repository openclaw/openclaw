#!/bin/bash
# Claude Code runner for incidents captured by scripts/rescue-watchdog.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="${OPENCLAW_RESCUE_WORKSPACE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
INCIDENT_DIR="${OPENCLAW_RESCUE_INCIDENT_DIR:-}"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_RESCUE_MODEL="${CLAUDE_RESCUE_MODEL:-sonnet}"
CLAUDE_RESCUE_PERMISSION_MODE="${CLAUDE_RESCUE_PERMISSION_MODE:-acceptEdits}"
CLAUDE_RESCUE_APPEND_SYSTEM_PROMPT="${CLAUDE_RESCUE_APPEND_SYSTEM_PROMPT:-}"

if [ -z "$INCIDENT_DIR" ]; then
  echo "OPENCLAW_RESCUE_INCIDENT_DIR is required" >&2
  exit 1
fi

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "claude CLI not found: $CLAUDE_BIN" >&2
  exit 1
fi

SUMMARY_FILE="${OPENCLAW_RESCUE_SUMMARY_FILE:-$INCIDENT_DIR/summary.txt}"
HEALTH_FILE="${OPENCLAW_RESCUE_HEALTH_FILE:-$INCIDENT_DIR/health.json}"
STATUS_FILE="${OPENCLAW_RESCUE_STATUS_FILE:-$INCIDENT_DIR/status.txt}"
LOG_FILE="${OPENCLAW_RESCUE_GATEWAY_LOG_FILE:-$INCIDENT_DIR/gateway-log.tail.txt}"
PROMPT_FILE="$INCIDENT_DIR/claude-prompt.txt"
OUTPUT_FILE="$INCIDENT_DIR/claude-output.txt"

summary_text="$(cat "$SUMMARY_FILE" 2>/dev/null || echo "unknown openclaw runtime failure")"

cat >"$PROMPT_FILE" <<RESCUE_WATCHDOG_PROMPT_END
An OpenClaw rescue watchdog detected a runtime failure.

Goals:
- Restore reply capability with the smallest safe fix.
- Prefer narrow changes over refactors.
- Do not commit, push, or modify files outside this workspace.
- Use the captured incident artifacts before exploring broadly.

Workspace:
- Repo: $WORKSPACE_DIR
- Incident dir: $INCIDENT_DIR

Artifacts:
- Summary: $SUMMARY_FILE
- Health snapshot: $HEALTH_FILE
- CLI status: $STATUS_FILE
- Gateway log tail: $LOG_FILE

Required steps:
1. Read the incident artifacts first.
2. Inspect only the code paths suggested by the incident.
3. If you find a safe fix, apply it in this workspace.
4. Run focused verification. Prefer pnpm build; if that is too expensive, explain why and run a narrower check.
5. If possible, run openclaw health --json --timeout 10000 after the fix.
6. Print a concise operator summary with:
   - root cause
   - files changed
   - verification run
   - remaining risk

Incident summary:
$summary_text
RESCUE_WATCHDOG_PROMPT_END

cmd=(
  "$CLAUDE_BIN"
  -p
  --model "$CLAUDE_RESCUE_MODEL"
  --permission-mode "$CLAUDE_RESCUE_PERMISSION_MODE"
  --output-format text
  --add-dir "$INCIDENT_DIR"
)

if [ -n "$CLAUDE_RESCUE_APPEND_SYSTEM_PROMPT" ]; then
  cmd+=(--append-system-prompt "$CLAUDE_RESCUE_APPEND_SYSTEM_PROMPT")
fi

cd "$WORKSPACE_DIR"
"${cmd[@]}" "$(cat "$PROMPT_FILE")" | tee "$OUTPUT_FILE"
