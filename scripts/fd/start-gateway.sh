#!/usr/bin/env bash
# Start OpenClaw Gateway on M4 Mac mini
# Usage: ./scripts/start-gateway.sh [--foreground]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TMUX_SESSION="${TMUX_SESSION:-openclaw-gateway}"
LOG_DIR="${OPENCLAW_CLUSTER_DIR:-$HOME/cluster}/logs"

cd "$PROJECT_DIR"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Check if OpenClaw (npm) is installed
if ! command -v openclaw &>/dev/null; then
    echo "ERROR: 'openclaw' CLI not found. Install with: npm install -g openclaw@latest"
    exit 1
fi

if [[ "${1:-}" == "--foreground" ]]; then
    echo "Starting OpenClaw Gateway (foreground)..."
    openclaw gateway \
        --config "$PROJECT_DIR/gateway/openclaw.json5" \
        2>&1 | tee -a "$LOG_DIR/gateway.log"
else
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "Gateway already running in tmux session: $TMUX_SESSION"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
        echo "  Stop:   tmux kill-session -t $TMUX_SESSION"
        exit 0
    fi

    echo "Starting OpenClaw Gateway in tmux session: $TMUX_SESSION"
    tmux new-session -d -s "$TMUX_SESSION" \
        "cd $PROJECT_DIR && openclaw gateway \
            --config $PROJECT_DIR/gateway/openclaw.json5 \
            2>&1 | tee -a $LOG_DIR/gateway.log"

    echo "Gateway started."
    echo "  Attach: tmux attach -t $TMUX_SESSION"
    echo "  Logs:   tail -f $LOG_DIR/gateway.log"
fi
