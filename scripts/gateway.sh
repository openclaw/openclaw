#!/bin/bash
# OpenClaw Gateway Start/Stop Script
# Usage: ./scripts/gateway.sh start|stop|restart|status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/tmp/openclaw-gateway.log"
PORT=18789

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Kill all OpenClaw gateway processes
kill_gateway() {
    log_info "Stopping OpenClaw gateway..."
    
    # Try graceful stop first
    if command -v pnpm >/dev/null 2>&1; then
        cd "$PROJECT_ROOT"
        pnpm openclaw gateway stop 2>/dev/null || true
        sleep 2
    fi
    
    # Force kill any remaining processes
    pkill -9 -f 'openclaw gateway' 2>/dev/null || true
    pkill -9 -f 'node.*gateway' 2>/dev/null || true
    
    # Kill any process using the port
    if lsof -ti :$PORT >/dev/null 2>&1; then
        log_warn "Killing process on port $PORT..."
        lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
    
    # Verify nothing is running
    if pgrep -f 'openclaw gateway' >/dev/null 2>&1; then
        log_warn "Some processes still running, force killing..."
        pkill -9 -f 'openclaw gateway' 2>/dev/null || true
        sleep 1
    fi
    
    log_info "Gateway stopped"
}

# Start the gateway
start_gateway() {
    log_info "Starting OpenClaw gateway..."
    
    # Check if already running
    if pgrep -f 'openclaw gateway' >/dev/null 2>&1; then
        log_warn "Gateway appears to be running. Use 'restart' to restart it."
        return 1
    fi
    
    if lsof -ti :$PORT >/dev/null 2>&1; then
        log_warn "Port $PORT is in use. Killing existing process..."
        lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
        sleep 2
    fi
    
    # Start the gateway
    cd "$PROJECT_ROOT"
    nohup pnpm openclaw gateway run --bind loopback --port $PORT --force > "$LOG_FILE" 2>&1 &
    GATEWAY_PID=$!
    
    # Wait a moment and check if it's still running
    sleep 3
    if ps -p $GATEWAY_PID >/dev/null 2>&1; then
        log_info "Gateway started with PID: $GATEWAY_PID"
        log_info "Logs: tail -f $LOG_FILE"
        log_info "Status: pnpm openclaw status"
        return 0
    else
        log_error "Gateway failed to start. Check logs: $LOG_FILE"
        tail -20 "$LOG_FILE" 2>/dev/null || true
        return 1
    fi
}

# Check gateway status
status_gateway() {
    if pgrep -f 'openclaw gateway' >/dev/null 2>&1; then
        log_info "Gateway is running"
        echo ""
        echo "Processes:"
        ps aux | grep -E 'openclaw gateway|node.*gateway' | grep -v grep || true
        echo ""
        if lsof -ti :$PORT >/dev/null 2>&1; then
            log_info "Port $PORT is in use"
        else
            log_warn "Port $PORT is not in use"
        fi
        return 0
    else
        log_warn "Gateway is not running"
        return 1
    fi
}

# Main command handler
case "${1:-}" in
    start)
        kill_gateway
        start_gateway
        ;;
    stop)
        kill_gateway
        ;;
    restart)
        kill_gateway
        sleep 2
        start_gateway
        ;;
    status)
        status_gateway
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        echo ""
        echo "Commands:"
        echo "  start   - Kill any running gateway and start fresh"
        echo "  stop    - Stop the gateway (kills all processes)"
        echo "  restart - Stop and start the gateway"
        echo "  status  - Check if gateway is running"
        exit 1
        ;;
esac
