#!/bin/bash
# Mythos Health Check Automation Script
# Performs comprehensive system health checks and reporting

set -euo pipefail

# Configuration
MYTHOS_URL="${MYTHOS_URL:-http://localhost:18789}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
REPORT_FILE="/tmp/mythos_health_$(date +%Y%m%d_%H%M%S).json"
ALERT_THRESHOLD_CPU="${ALERT_THRESHOLD_CPU:-80}"
ALERT_THRESHOLD_MEMORY="${ALERT_THRESHOLD_MEMORY:-85}"
ALERT_THRESHOLD_DISK="${ALERT_THRESHOLD_DISK:-90}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

show_usage() {
    cat <<EOF
Mythos Health Check Automation Script

Usage: $0 [OPTIONS]

Options:
    --url <url>           Mythos Gateway URL (default: http://localhost:18789)
    --output <file>       Save report to JSON file (default: auto-generated)
    --alert               Send alerts if health issues detected
    --quiet               Only output failures
    --help, -h            Show this help message

Checks Performed:
    1. Gateway connectivity and response time
    2. Configuration validation
    3. Memory engine status (Rust-native vs JavaScript fallback)
    4. Disk space and resource usage
    5. Service status (systemd/Docker)
    6. Network connectivity
    7. Certificate validity (if HTTPS)
    8. Performance metrics

Examples:
    $0
    $0 --url http://mythos.example.com:18789
    $0 --output /var/log/mythos_health.json --alert
    $0 --quiet

Environment Variables:
    MYTHOS_URL              Gateway URL (default: http://localhost:18789)
    OPENCLAW_HOME           OpenClaw home directory (default: ~/.openclaw)
    ALERT_THRESHOLD_CPU     CPU alert threshold % (default: 80)
    ALERT_THRESHOLD_MEMORY  Memory alert threshold % (default: 85)
    ALERT_THRESHOLD_DISK    Disk alert threshold % (default: 90)

EOF
}

# Parse arguments
SEND_ALERTS=false
QUIET_MODE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --url)
            MYTHOS_URL="$2"
            shift 2
            ;;
        --output)
            REPORT_FILE="$2"
            shift 2
            ;;
        --alert)
            SEND_ALERTS=true
            shift
            ;;
        --quiet)
            QUIET_MODE=true
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Initialize report
REPORT='{
  "timestamp": "'$(date -Iseconds)'",
  "mythos_url": "'$MYTHOS_URL'",
  "checks": {},
  "summary": {
    "status": "unknown",
    "checks_passed": 0,
    "checks_failed": 0,
    "checks_warning": 0
  }
}'

# Helper functions
update_report() {
    local check_name="$1"
    local status="$2"
    local message="$3"
    local details="${4:-{}}"
    
    REPORT=$(echo "$REPORT" | jq \
        --arg name "$check_name" \
        --arg status "$status" \
        --arg message "$message" \
        --argjson details "$details" \
        '.checks[$name] = {
            "status": $status,
            "message": $message,
            "details": $details,
            "timestamp": "'$(date -Iseconds)'"
        }')
    
    # Update summary
    if [ "$status" = "healthy" ]; then
        REPORT=$(echo "$REPORT" | jq '.summary.checks_passed += 1')
        [ "$QUIET_MODE" = false ] && log_info "✓ $check_name: $message"
    elif [ "$status" = "warning" ]; then
        REPORT=$(echo "$REPORT" | jq '.summary.checks_warning += 1')
        log_warn "⚠ $check_name: $message"
    elif [ "$status" = "critical" ]; then
        REPORT=$(echo "$REPORT" | jq '.summary.checks_failed += 1')
        log_error "✗ $check_name: $message"
    fi
}

finalize_report() {
    local passed=$(echo "$REPORT" | jq '.summary.checks_passed')
    local failed=$(echo "$REPORT" | jq '.summary.checks_failed')
    local warnings=$(echo "$REPORT" | jq '.summary.checks_warning')
    
    if [ "$failed" -gt 0 ]; then
        REPORT=$(echo "$REPORT" | jq '.summary.status = "critical"')
    elif [ "$warnings" -gt 0 ]; then
        REPORT=$(echo "$REPORT" | jq '.summary.status = "warning"')
    else
        REPORT=$(echo "$REPORT" | jq '.summary.status = "healthy"')
    fi
    
    echo "$REPORT" > "$REPORT_FILE"
}

# Check 1: Gateway connectivity
check_gateway_connectivity() {
    log_step "Checking gateway connectivity..."
    
    local start_time=$(date +%s%N)
    local response=$(curl -s -w "%{http_code}" -o /tmp/mythos_health_check "$MYTHOS_URL/health" 2>&1 || echo "000")
    local end_time=$(date +%s%N)
    local duration=$(( (end_time - start_time) / 1000000 ))
    
    local http_code="${response: -3}"
    
    if [ "$http_code" = "200" ]; then
        local health_data=$(cat /tmp/mythos_health_check 2>/dev/null || echo "{}")
        local version=$(echo "$health_data" | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown")
        local uptime=$(echo "$health_data" | jq -r '.uptime // "unknown"' 2>/dev/null || echo "unknown")
        
        update_report "gateway_connectivity" "healthy" "Gateway responding (HTTP 200, ${duration}ms)" \
            "{\"http_code\": $http_code, \"response_time_ms\": $duration, \"version\": \"$version\", \"uptime\": \"$uptime\"}"
        
        # Check response time
        if [ "$duration" -gt 5000 ]; then
            update_report "gateway_response_time" "warning" "Slow response time (${duration}ms > 5000ms)" \
                "{\"response_time_ms\": $duration, \"threshold_ms\": 5000}"
        else
            update_report "gateway_response_time" "healthy" "Response time acceptable (${duration}ms)" \
                "{\"response_time_ms\": $duration, \"threshold_ms\": 5000}"
        fi
    elif [ "$http_code" = "000" ]; then
        update_report "gateway_connectivity" "critical" "Cannot connect to gateway" \
            "{\"error\": \"Connection failed\", \"url\": \"$MYTHOS_URL\"}"
        return 1
    else
        update_report "gateway_connectivity" "critical" "Gateway returned HTTP $http_code" \
            "{\"http_code\": $http_code, \"url\": \"$MYTHOS_URL\"}"
        return 1
    fi
    
    rm -f /tmp/mythos_health_check
}

# Check 2: Configuration validation
check_configuration() {
    log_step "Checking configuration..."
    
    local config_file="$OPENCLAW_HOME/config.json"
    
    if [ ! -f "$config_file" ]; then
        update_report "configuration" "critical" "Configuration file not found" \
            "{\"path\": \"$config_file\"}"
        return 1
    fi
    
    # Validate JSON syntax
    if ! jq empty "$config_file" 2>/dev/null; then
        update_report "configuration" "critical" "Invalid JSON syntax" \
            "{\"path\": \"$config_file\"}"
        return 1
    fi
    
    # Check critical fields
    local issues=0
    
    if ! jq -e '.gateway.token' "$config_file" &> /dev/null; then
        log_warn "Gateway token not configured"
        ((issues++))
    fi
    
    if ! jq -e '.models.providers | length > 0' "$config_file" &> /dev/null; then
        log_warn "No model providers configured"
        ((issues++))
    fi
    
    if [ $issues -eq 0 ]; then
        update_report "configuration" "healthy" "Configuration valid" \
            "{\"path\": \"$config_file\", \"issues\": 0}"
    else
        update_report "configuration" "warning" "Configuration has $issues issues" \
            "{\"path\": \"$config_file\", \"issues\": $issues}"
    fi
}

# Check 3: Memory engine status
check_memory_engines() {
    log_step "Checking memory engines..."
    
    if ! command -v openclaw &> /dev/null; then
        update_report "memory_engines" "warning" "openclaw command not found" \
            "{\"error\": \"Command not available\"}"
        return
    fi
    
    local status=$(openclaw status 2>&1 || echo "")
    
    # Check for Rust engines
    local using_rust=false
    local rust_engines=()
    
    if echo "$status" | grep -q "vector_engine.*rust"; then
        using_rust=true
        rust_engines+=("vector")
    fi
    
    if echo "$status" | grep -q "text_engine.*rust"; then
        using_rust=true
        rust_engines+=("text")
    fi
    
    if [ "$using_rust" = true ]; then
        update_report "memory_engines" "healthy" "Using Rust-native engines" \
            "{\"rust_engines\": $(printf '%s\n' "${rust_engines[@]}" | jq -R . | jq -s .)}"
    else
        update_report "memory_engines" "warning" "Using JavaScript fallback engines" \
            "{\"message\": \"Rust engines not active, performance degraded\"}"
    fi
}

# Check 4: Disk space
check_disk_space() {
    log_step "Checking disk space..."
    
    local disk_usage=$(df -h "$OPENCLAW_HOME" | tail -1 | awk '{print $5}' | sed 's/%//')
    local available=$(df -h "$OPENCLAW_HOME" | tail -1 | awk '{print $4}')
    local total=$(df -h "$OPENCLAW_HOME" | tail -1 | awk '{print $2}')
    
    if [ "$disk_usage" -ge "$ALERT_THRESHOLD_DISK" ]; then
        update_report "disk_space" "critical" "Disk usage critical ($disk_usage%)" \
            "{\"usage_percent\": $disk_usage, \"available\": \"$available\", \"total\": \"$total\", \"threshold\": $ALERT_THRESHOLD_DISK}"
    elif [ "$disk_usage" -ge $((ALERT_THRESHOLD_DISK - 10)) ]; then
        update_report "disk_space" "warning" "Disk usage high ($disk_usage%)" \
            "{\"usage_percent\": $disk_usage, \"available\": \"$available\", \"total\": \"$total\", \"threshold\": $ALERT_THRESHOLD_DISK}"
    else
        update_report "disk_space" "healthy" "Disk space sufficient ($disk_usage% used)" \
            "{\"usage_percent\": $disk_usage, \"available\": \"$available\", \"total\": \"$total\", \"threshold\": $ALERT_THRESHOLD_DISK}"
    fi
}

# Check 5: Service status
check_service_status() {
    log_step "Checking service status..."
    
    local service_running=false
    local service_type="unknown"
    
    # Check systemd
    if command -v systemctl &> /dev/null; then
        if systemctl is-active --quiet mythos-gateway 2>/dev/null; then
            service_running=true
            service_type="systemd"
        fi
    fi
    
    # Check Docker
    if [ "$service_running" = false ] && command -v docker &> /dev/null; then
        if docker ps --filter "name=mythos-gateway" --format "{{.Names}}" | grep -q "mythos-gateway"; then
            service_running=true
            service_type="docker"
        fi
    fi
    
    # Check process
    if [ "$service_running" = false ]; then
        if pgrep -f "mythos-gateway" > /dev/null 2>&1; then
            service_running=true
            service_type="process"
        fi
    fi
    
    if [ "$service_running" = true ]; then
        update_report "service_status" "healthy" "Service running ($service_type)" \
            "{\"running\": true, \"type\": \"$service_type\"}"
    else
        update_report "service_status" "critical" "Service not running" \
            "{\"running\": false}"
    fi
}

# Check 6: Network connectivity
check_network() {
    log_step "Checking network connectivity..."
    
    local checks_passed=0
    local checks_total=0
    
    # Check DNS resolution
    ((checks_total++))
    if host "$(echo "$MYTHOS_URL" | sed 's|https\?://||' | cut -d: -f1)" &> /dev/null; then
        ((checks_passed++))
    fi
    
    # Check gateway port
    ((checks_total++))
    local port=$(echo "$MYTHOS_URL" | sed 's|.*:||' | cut -d/ -f1)
    if nc -z localhost "$port" 2>/dev/null; then
        ((checks_passed++))
    fi
    
    # Check external connectivity
    ((checks_total++))
    if curl -s --max-time 5 https://www.google.com &> /dev/null; then
        ((checks_passed++))
    fi
    
    if [ "$checks_passed" -eq "$checks_total" ]; then
        update_report "network" "healthy" "All network checks passed" \
            "{\"checks_passed\": $checks_passed, \"checks_total\": $checks_total}"
    elif [ "$checks_passed" -ge 2 ]; then
        update_report "network" "warning" "Some network checks failed" \
            "{\"checks_passed\": $checks_passed, \"checks_total\": $checks_total}"
    else
        update_report "network" "critical" "Network connectivity issues" \
            "{\"checks_passed\": $checks_passed, \"checks_total\": $checks_total}"
    fi
}

# Check 7: Certificate validity
check_certificates() {
    log_step "Checking certificates..."
    
    if [[ "$MYTHOS_URL" != https://* ]]; then
        update_report "certificates" "healthy" "HTTPS not configured, skipping" \
            "{\"https_enabled\": false}"
        return
    fi
    
    local host=$(echo "$MYTHOS_URL" | sed 's|https://||' | cut -d: -f1 | cut -d/ -f1)
    local port=$(echo "$MYTHOS_URL" | sed 's|.*:||' | cut -d/ -f1)
    [ "$port" = "$host" ] && port=443
    
    # Get certificate expiry
    local expiry=$(echo | openssl s_client -connect "$host:$port" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    
    if [ -z "$expiry" ]; then
        update_report "certificates" "critical" "Cannot retrieve certificate" \
            "{\"host\": \"$host\", \"port\": $port}"
        return
    fi
    
    # Calculate days until expiry
    local expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry" +%s 2>/dev/null)
    local now_epoch=$(date +%s)
    local days_remaining=$(( (expiry_epoch - now_epoch) / 86400 ))
    
    if [ "$days_remaining" -lt 7 ]; then
        update_report "certificates" "critical" "Certificate expires in $days_remaining days" \
            "{\"expiry\": \"$expiry\", \"days_remaining\": $days_remaining}"
    elif [ "$days_remaining" -lt 30 ]; then
        update_report "certificates" "warning" "Certificate expires in $days_remaining days" \
            "{\"expiry\": \"$expiry\", \"days_remaining\": $days_remaining}"
    else
        update_report "certificates" "healthy" "Certificate valid ($days_remaining days remaining)" \
            "{\"expiry\": \"$expiry\", \"days_remaining\": $days_remaining}"
    fi
}

# Check 8: Performance metrics
check_performance() {
    log_step "Checking performance metrics..."
    
    local metrics_available=false
    local cpu_usage=0
    local memory_usage=0
    
    # Try to get metrics from Prometheus endpoint
    local metrics_response=$(curl -s "$MYTHOS_URL/metrics" 2>/dev/null || echo "")
    
    if [ -n "$metrics_response" ]; then
        metrics_available=true
        
        # Parse CPU usage (simplified)
        cpu_usage=$(echo "$metrics_response" | grep "process_cpu_seconds_total" | tail -1 | awk '{print $2}' 2>/dev/null || echo "0")
        
        # Parse memory usage
        memory_usage=$(echo "$metrics_response" | grep "process_resident_memory_bytes" | tail -1 | awk '{print $2}' 2>/dev/null || echo "0")
    fi
    
    if [ "$metrics_available" = true ]; then
        update_report "performance" "healthy" "Metrics available" \
            "{\"metrics_available\": true, \"cpu_usage\": \"$cpu_usage\", \"memory_usage\": \"$memory_usage\"}"
    else
        update_report "performance" "warning" "Metrics not available" \
            "{\"metrics_available\": false, \"message\": \"Prometheus endpoint not accessible\"}"
    fi
}

# Send alerts
send_alerts() {
    local status=$(echo "$REPORT" | jq -r '.summary.status')
    
    if [ "$status" = "healthy" ]; then
        return
    fi
    
    log_step "Sending alerts..."
    
    local failed=$(echo "$REPORT" | jq '.summary.checks_failed')
    local warnings=$(echo "$REPORT" | jq '.summary.checks_warning')
    
    # Prepare alert message
    local message="Mythos Health Check Alert\n"
    message+="Status: $status\n"
    message+="Failed: $failed\n"
    message+="Warnings: $warnings\n"
    message+="Timestamp: $(date -Iseconds)\n"
    message+="\nFailed Checks:\n"
    
    echo "$REPORT" | jq -r '.checks | to_entries[] | select(.value.status == "critical" or .value.status == "warning") | "  - \(.key): \(.value.message)"' | while read -r line; do
        message+="$line\n"
    done
    
    # Send via configured alert channels
    # Slack
    if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
        curl -s -X POST -H 'Content-type: application/json' \
            --data "{\"text\": \"$message\"}" \
            "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 || true
        log_info "Alert sent to Slack"
    fi
    
    # Email (if mail command available)
    if command -v mail &> /dev/null && [ -n "${ALERT_EMAIL:-}" ]; then
        echo -e "$message" | mail -s "Mythos Health Alert: $status" "$ALERT_EMAIL" 2>/dev/null || true
        log_info "Alert sent to email"
    fi
    
    # PagerDuty (if curl available)
    if [ -n "${PAGERDUTY_KEY:-}" ]; then
        curl -s -X POST https://events.pagerduty.com/v2/enqueue \
            -H 'Content-Type: application/json' \
            -d "{
                \"routing_key\": \"$PAGERDUTY_KEY\",
                \"event_action\": \"trigger\",
                \"payload\": {
                    \"summary\": \"Mythos Health Check: $status\",
                    \"severity\": \"$status\",
                    \"source\": \"mythos-health-check\"
                }
            }" > /dev/null 2>&1 || true
        log_info "Alert sent to PagerDuty"
    fi
}

# Main execution
main() {
    if [ "$QUIET_MODE" = false ]; then
        echo "================================"
        echo "Mythos Health Check"
        echo "================================"
        echo "URL: $MYTHOS_URL"
        echo "Time: $(date)"
        echo "================================"
        echo ""
    fi
    
    local exit_code=0
    
    # Run all checks
    check_gateway_connectivity || exit_code=1
    check_configuration || exit_code=1
    check_memory_engines || true
    check_disk_space || exit_code=1
    check_service_status || exit_code=1
    check_network || exit_code=1
    check_certificates || true
    check_performance || true
    
    # Finalize report
    finalize_report
    
    local status=$(echo "$REPORT" | jq -r '.summary.status')
    
    echo "" | tee -a "$REPORT_FILE"
    echo "================================"
    echo "Health Check Summary"
    echo "================================"
    echo "Status: $status"
    echo "Checks Passed: $(echo "$REPORT" | jq '.summary.checks_passed')"
    echo "Checks Failed: $(echo "$REPORT" | jq '.summary.checks_failed')"
    echo "Checks Warning: $(echo "$REPORT" | jq '.summary.checks_warning')"
    echo "Report: $REPORT_FILE"
    echo "================================"
    
    # Send alerts if requested
    if [ "$SEND_ALERTS" = true ] && [ "$status" != "healthy" ]; then
        send_alerts
    fi
    
    exit $exit_code
}

# Run main
main "$@"
