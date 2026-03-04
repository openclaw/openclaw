#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_ROOT="$SCRIPT_DIR/orchestrator"
exec "$ORCH_ROOT/bin/check-agents.sh" "$@"
