#!/usr/bin/env bash
# Start worker processes on current node
# Usage: ./scripts/start-workers.sh [--foreground]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TMUX_SESSION="${TMUX_SESSION:-openclaw-workers}"
LOG_DIR="${OPENCLAW_CLUSTER_DIR:-$HOME/cluster}/logs"
HOSTNAME="$(hostname -s)"

cd "$PROJECT_DIR"

mkdir -p "$LOG_DIR"

# Activate venv if present
if [[ -d "$PROJECT_DIR/.venv" ]]; then
    source "$PROJECT_DIR/.venv/bin/activate"
fi

if [[ "${1:-}" == "--foreground" ]]; then
    echo "Starting workers (foreground) on $HOSTNAME..."
    OPENCLAW_DB="${OPENCLAW_DB:-$PROJECT_DIR/data/openclaw.db}" \
        python -m packages.jobs.worker 2>&1 | tee -a "$LOG_DIR/$HOSTNAME-worker.log"
else
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "Workers already running in tmux session: $TMUX_SESSION"
        exit 0
    fi

    echo "Starting workers on $HOSTNAME in tmux session: $TMUX_SESSION"

    # Window 0: App server
    tmux new-session -d -s "$TMUX_SESSION" \
        "cd $PROJECT_DIR && source .venv/bin/activate 2>/dev/null; \
        OPENCLAW_DB=${OPENCLAW_DB:-$PROJECT_DIR/data/openclaw.db} \
        OPENCLAW_AUTO_MIGRATE=true \
        python -m packages.app --host 0.0.0.0 --port 8080 \
        2>&1 | tee -a $LOG_DIR/$HOSTNAME-app.log"

    # Window 1: Job worker
    tmux new-window -t "$TMUX_SESSION" \
        "cd $PROJECT_DIR && source .venv/bin/activate 2>/dev/null; \
        OPENCLAW_DB=${OPENCLAW_DB:-$PROJECT_DIR/data/openclaw.db} \
        python -m packages.jobs.worker \
        2>&1 | tee -a $LOG_DIR/$HOSTNAME-worker.log"

    echo "Workers started (app + job worker)."
    echo "  Attach: tmux attach -t $TMUX_SESSION"
fi
