#!/bin/bash
# Clawdis Gateway Health Check Script
# Usage: ./health-check.sh [--verbose] [--json]
# Returns: 0 = healthy, 1 = unhealthy

set -uo pipefail

VERBOSE=false
JSON_OUTPUT=false
GATEWAY_PORT=18789
BRIDGE_PORT=18790
BROWSER_PORT=18791
CANVAS_PORT=18793

get_telegram_proxy() {
    local proxy=""
    if command -v python3 >/dev/null 2>&1; then
        proxy=$(python3 - <<'PY' 2>/dev/null
import json, os, sys
path = os.path.expanduser("~/.clawdis/clawdis.json")
try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    proxy = cfg.get("telegram", {}).get("proxy") or ""
    if isinstance(proxy, str):
        sys.stdout.write(proxy)
except Exception:
    pass
PY
)
    elif command -v node >/dev/null 2>&1; then
        proxy=$(node - <<'NODE' 2>/dev/null
const fs = require("fs");
const path = require("path");
try {
  const cfgPath = path.join(process.env.HOME || "", ".clawdis", "clawdis.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const proxy = (cfg.telegram && cfg.telegram.proxy) || "";
  if (typeof proxy === "string") process.stdout.write(proxy);
} catch {}
NODE
)
    fi
    echo "$proxy"
}

find_gateway_pid() {
    local pid=""
    pid=$(pgrep -f "clawdis gateway" | head -1 || true)
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
    pid=$(pgrep -f "src/index.ts gateway" | head -1 || true)
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
    pid=$(pgrep -f "gateway --port 18789" | head -1 || true)
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
}

# Parse arguments
for arg in "$@"; do
    case $arg in
        --verbose|-v) VERBOSE=true ;;
        --json|-j) JSON_OUTPUT=true ;;
    esac
done

# Health check results
declare -A CHECKS
OVERALL_HEALTHY=true

check_port() {
    local name=$1
    local port=$2
    if ss -tuln | grep -q ":${port} "; then
        CHECKS["${name}_port"]="ok"
        return 0
    else
        CHECKS["${name}_port"]="fail"
        OVERALL_HEALTHY=false
        return 1
    fi
}

check_process() {
    local pid
    pid=$(find_gateway_pid)
    if [ -n "$pid" ]; then
        CHECKS["process"]="ok"
        # Get memory usage
        local mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{print int($1/1024)"MB"}')
        CHECKS["memory"]="${mem:-unknown}"
        return 0
    else
        CHECKS["process"]="fail"
        OVERALL_HEALTHY=false
        return 1
    fi
}

check_telegram_api() {
    local token="${TELEGRAM_BOT_TOKEN:-}"
    if [ -z "$token" ]; then
        # Try to read from .env
        if [ -f "/home/almaz/zoo_flow/clawdis/.env" ]; then
            token=$(grep TELEGRAM_BOT_TOKEN /home/almaz/zoo_flow/clawdis/.env | cut -d= -f2- || true)
        fi
    fi
    if [ -z "$token" ]; then
        # Try to read from secrets.env
        if [ -f "/home/almaz/.clawdis/secrets.env" ]; then
            token=$(grep TELEGRAM_BOT_TOKEN /home/almaz/.clawdis/secrets.env | cut -d= -f2- || true)
        fi
    fi

    if [ -n "$token" ]; then
        local proxy
        local -a proxy_args=()
        proxy=$(get_telegram_proxy)
        if [ -n "$proxy" ]; then
            proxy_args=(--proxy "$proxy")
        fi
        local response=$(curl -s --max-time 5 "${proxy_args[@]}" "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || echo "error")
        if echo "$response" | grep -q '"ok":true'; then
            CHECKS["telegram_api"]="ok"
            return 0
        else
            CHECKS["telegram_api"]="fail"
            OVERALL_HEALTHY=false
            return 1
        fi
    else
        CHECKS["telegram_api"]="skip"
        return 0
    fi
}

check_disk_space() {
    local usage=$(df /home/almaz/.clawdis 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
    if [ -n "$usage" ] && [ "$usage" -lt 90 ]; then
        CHECKS["disk_space"]="ok (${usage}%)"
        return 0
    else
        CHECKS["disk_space"]="warn (${usage:-unknown}%)"
        return 0
    fi
}

check_log_size() {
    local log_size=$(du -sm /home/almaz/.clawdis/*.log 2>/dev/null | awk '{sum+=$1} END {print sum}')
    if [ -n "$log_size" ] && [ "$log_size" -lt 500 ]; then
        CHECKS["log_size"]="ok (${log_size}MB)"
        return 0
    else
        CHECKS["log_size"]="warn (${log_size:-0}MB)"
        return 0
    fi
}

get_uptime() {
    local pid
    pid=$(find_gateway_pid)
    if [ -n "$pid" ]; then
        local start_time=$(ps -o lstart= -p "$pid" 2>/dev/null)
        if [ -n "$start_time" ]; then
            local start_epoch=$(date -d "$start_time" +%s 2>/dev/null)
            local now_epoch=$(date +%s)
            local uptime_secs=$((now_epoch - start_epoch))
            local days=$((uptime_secs / 86400))
            local hours=$(((uptime_secs % 86400) / 3600))
            local mins=$(((uptime_secs % 3600) / 60))
            CHECKS["uptime"]="${days}d ${hours}h ${mins}m"
        fi
    fi
}

# Run all checks
check_process
check_port "gateway" $GATEWAY_PORT
check_port "bridge" $BRIDGE_PORT
check_port "browser" $BROWSER_PORT
check_port "canvas" $CANVAS_PORT
check_telegram_api
check_disk_space
check_log_size
get_uptime

# Output results
if $JSON_OUTPUT; then
    echo "{"
    echo "  \"healthy\": $OVERALL_HEALTHY,"
    echo "  \"timestamp\": \"$(date -Iseconds)\","
    echo "  \"checks\": {"
    first=true
    for key in "${!CHECKS[@]}"; do
        if $first; then first=false; else echo ","; fi
        echo -n "    \"$key\": \"${CHECKS[$key]}\""
    done
    echo ""
    echo "  }"
    echo "}"
else
    if $VERBOSE; then
        echo "=== Clawdis Gateway Health Check ==="
        echo "Timestamp: $(date)"
        echo ""
        for key in "${!CHECKS[@]}"; do
            printf "%-20s %s\n" "$key:" "${CHECKS[$key]}"
        done
        echo ""
    fi

    if $OVERALL_HEALTHY; then
        echo "Status: HEALTHY"
        exit 0
    else
        echo "Status: UNHEALTHY"
        exit 1
    fi
fi
