#!/bin/bash
# tmux Interactive Prompt Responder
# Monitors a tmux pane and automatically responds to interactive prompts
#
# Usage:
#   tmux-interactive-responder.sh -S socket -s session -p "pattern" -k "key1" -k "key2" -T timeout
#
# Example:
#   tmux-interactive-responder.sh \
#     -S /tmp/my-socket \
#     -s my-session \
#     -p "Yes, proceed" \
#     -k "2" \
#     -k "Enter" \
#     -T 30

set -euo pipefail

# Default values
SOCKET=""
SESSION=""
PATTERNS=()
KEYS=()
TIMEOUT=60
INTERVAL=0.5

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -S|--socket)
      SOCKET="$2"
      shift 2
      ;;
    -s|--session)
      SESSION="$2"
      shift 2
      ;;
    -p|--pattern)
      PATTERNS+=("$2")
      shift 2
      ;;
    -k|--key)
      KEYS+=("$2")
      shift 2
      ;;
    -T|--timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -i|--interval)
      INTERVAL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Validate required arguments
if [ -z "$SESSION" ]; then
  echo "Error: Session name (-s) is required" >&2
  exit 1
fi

if [ ${#PATTERNS[@]} -eq 0 ]; then
  echo "Error: At least one pattern (-p) is required" >&2
  exit 1
fi

if [ ${#KEYS[@]} -eq 0 ]; then
  echo "Error: At least one key (-k) is required" >&2
  exit 1
fi

# Build tmux command
TMUX_CMD="tmux"
if [ -n "$SOCKET" ]; then
  TMUX_CMD="$TMUX_CMD -S $SOCKET"
fi

# Log function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Check if session exists
if ! $TMUX_CMD has-session -t "$SESSION" 2>/dev/null; then
  log "Error: tmux session '$SESSION' not found"
  exit 1
fi

log "Monitoring tmux session: $SESSION"
log "Patterns: ${PATTERNS[*]}"
log "Keys to send: ${KEYS[*]}"
log "Timeout: ${TIMEOUT}s"

start_time=$(date +%s)
matched=0

while true; do
  # Check timeout
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  
  if [ $elapsed -ge $TIMEOUT ]; then
    log "Timeout reached (${TIMEOUT}s) without matching pattern"
    exit 1
  fi
  
  # Capture tmux pane content
  pane_content=$($TMUX_CMD capture-pane -t "$SESSION" -p 2>/dev/null || true)
  
  # Check each pattern
  for pattern in "${PATTERNS[@]}"; do
    if echo "$pane_content" | grep -q "$pattern"; then
      log "Pattern matched: '$pattern'"
      log "Sending keys: ${KEYS[*]}"
      
      # Send each key
      for key in "${KEYS[@]}"; do
        $TMUX_CMD send-keys -t "$SESSION" "$key"
        sleep 0.1
      done
      
      matched=1
      log "Keys sent successfully"
      exit 0
    fi
  done
  
  # Wait before next check
  sleep "$INTERVAL"
done
