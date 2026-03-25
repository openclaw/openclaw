#!/usr/bin/env bash
# EVOX Container Health Monitor
# Checks Docker containers and auto-restarts unhealthy ones
# Run via cron or HEARTBEAT.md

set -euo pipefail

LOG_FILE="/tmp/evox-container-monitor.log"
MAX_RESTART_ATTEMPTS=3
RESTART_COOLDOWN_SECONDS=300  # 5 minutes between restarts

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

get_restart_count() {
  local container="$1"
  local count_file="/tmp/evox-restart-count-${container}"
  if [[ -f "$count_file" ]]; then
    cat "$count_file"
  else
    echo "0"
  fi
}

increment_restart_count() {
  local container="$1"
  local count_file="/tmp/evox-restart-count-${container}"
  local current=$(get_restart_count "$container")
  echo $((current + 1)) > "$count_file"
}

reset_restart_count() {
  local container="$1"
  local count_file="/tmp/evox-restart-count-${container}"
  rm -f "$count_file"
}

should_restart() {
  local container="$1"
  local cooldown_file="/tmp/evox-restart-cooldown-${container}"
  
  # Check cooldown
  if [[ -f "$cooldown_file" ]]; then
    local last_restart=$(cat "$cooldown_file")
    local now=$(date +%s)
    local elapsed=$((now - last_restart))
    if [[ $elapsed -lt $RESTART_COOLDOWN_SECONDS ]]; then
      log "SKIP: $container in cooldown (${elapsed}s / ${RESTART_COOLDOWN_SECONDS}s)"
      return 1
    fi
  fi
  
  # Check restart count
  local count=$(get_restart_count "$container")
  if [[ $count -ge $MAX_RESTART_ATTEMPTS ]]; then
    log "ALERT: $container exceeded max restart attempts ($count >= $MAX_RESTART_ATTEMPTS)"
    return 1
  fi
  
  return 0
}

restart_container() {
  local container="$1"
  local cooldown_file="/tmp/evox-restart-cooldown-${container}"
  
  log "RESTARTING: $container"
  if docker restart "$container" &>/dev/null; then
    log "SUCCESS: $container restarted"
    date +%s > "$cooldown_file"
    increment_restart_count "$container"
    return 0
  else
    log "FAILED: Could not restart $container"
    return 1
  fi
}

check_containers() {
  log "=== Container Health Check ==="
  
  local unhealthy_count=0
  local restarted_count=0
  local failed_count=0
  
  # Get all evox containers
  while IFS= read -r line; do
    local container=$(echo "$line" | awk '{print $1}')
    local health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    
    if [[ -z "$container" ]]; then
      continue
    fi
    
    case "$health" in
      healthy|starting)
        # Reset restart count for healthy containers
        reset_restart_count "$container"
        log "OK: $container is $health"
        ;;
      unhealthy)
        log "UNHEALTHY: $container"
        ((unhealthy_count++))
        if should_restart "$container"; then
          if restart_container "$container"; then
            ((restarted_count++))
          else
            ((failed_count++))
          fi
        fi
        ;;
      *)
        log "UNKNOWN: $container has health '$health'"
        ;;
    esac
  done < <(docker ps --filter "name=evox" --format "{{.Names}}")
  
  log "Summary: unhealthy=$unhealthy_count restarted=$restarted_count failed=$failed_count"
  
  # Return non-zero if any containers need attention
  if [[ $failed_count -gt 0 ]]; then
    return 2
  elif [[ $unhealthy_count -gt 0 ]]; then
    return 1
  fi
  return 0
}

# Main
check_containers
exit_code=$?

if [[ $exit_code -eq 2 ]]; then
  log "CRITICAL: Some containers could not be restarted"
elif [[ $exit_code -eq 1 ]]; then
  log "WARNING: Some containers still unhealthy"
else
  log "OK: All containers healthy"
fi

exit $exit_code
