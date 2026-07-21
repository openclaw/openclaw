#!/bin/bash
# Mythos Scaling Automation Script
# Handles horizontal and vertical scaling operations

set -euo pipefail

# Configuration
DEPLOYMENT="mythos-gateway"
NAMESPACE="${NAMESPACE:-mythos}"
MAX_REPLICAS="${MAX_REPLICAS:-10}"
MIN_REPLICAS="${MIN_REPLICAS:-2}"
SCALE_LOG="/var/log/mythos_scaling_$(date +%Y%m%d_%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1" | tee -a "$SCALE_LOG"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$SCALE_LOG"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$SCALE_LOG"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1" | tee -a "$SCALE_LOG"
}

show_usage() {
    cat <<EOF
Mythos Scaling Automation Script

Usage: $0 <command> [options]

Commands:
    status              Show current scaling status
    up <replicas>       Scale up to specified number of replicas
    down <replicas>     Scale down to specified number of replicas
    auto                Enable/disable autoscaling
    monitor             Monitor resource usage and scaling metrics
    recommend           Get scaling recommendations based on metrics

Options:
    --namespace <ns>    Kubernetes namespace (default: mythos)
    --dry-run           Show what would be done without making changes
    --help, -h          Show this help message

Examples:
    $0 status
    $0 up 5
    $0 down 2
    $0 auto enable
    $0 monitor --duration 5m

Environment Variables:
    NAMESPACE          Kubernetes namespace (default: mythos)
    MAX_REPLICAS       Maximum replicas for autoscaling (default: 10)
    MIN_REPLICAS       Minimum replicas for autoscaling (default: 2)

EOF
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."
    
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl command not found"
        exit 1
    fi
    
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Show current status
show_status() {
    log_step "Getting current scaling status..."
    
    echo "" | tee -a "$SCALE_LOG"
    echo "Deployment: $DEPLOYMENT" | tee -a "$SCALE_LOG"
    echo "Namespace: $NAMESPACE" | tee -a "$SCALE_LOG"
    echo "" | tee -a "$SCALE_LOG"
    
    # Get current replicas
    local current_replicas=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "N/A")
    local ready_replicas=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "N/A")
    local available_replicas=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo "N/A")
    
    echo "Current Replicas: $current_replicas" | tee -a "$SCALE_LOG"
    echo "Ready Replicas: $ready_replicas" | tee -a "$SCALE_LOG"
    echo "Available Replicas: $available_replicas" | tee -a "$SCALE_LOG"
    echo "" | tee -a "$SCALE_LOG"
    
    # Get resource usage
    echo "Resource Usage:" | tee -a "$SCALE_LOG"
    kubectl top pods -n "$NAMESPACE" -l app=mythos-gateway 2>/dev/null | tee -a "$SCALE_LOG" || log_warn "Could not get pod metrics"
    echo "" | tee -a "$SCALE_LOG"
    
    # Get HPA status if exists
    if kubectl get hpa "$DEPLOYMENT" -n "$NAMESPACE" &> /dev/null; then
        echo "Horizontal Pod Autoscaler:" | tee -a "$SCALE_LOG"
        kubectl get hpa "$DEPLOYMENT" -n "$NAMESPACE" | tee -a "$SCALE_LOG"
    else
        log_info "No HPA configured for $DEPLOYMENT"
    fi
}

# Scale up
scale_up() {
    local target_replicas="$1"
    
    if [ -z "$target_replicas" ]; then
        log_error "Target replicas not specified"
        exit 1
    fi
    
    if [ "$target_replicas" -gt "$MAX_REPLICAS" ]; then
        log_warn "Target replicas ($target_replicas) exceeds MAX_REPLICAS ($MAX_REPLICAS)"
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Scale up cancelled"
            exit 0
        fi
    fi
    
    log_step "Scaling up to $target_replicas replicas..."
    
    if [ "${DRY_RUN:-false}" = true ]; then
        log_info "DRY RUN: Would scale to $target_replicas replicas"
        return
    fi
    
    kubectl scale deployment "$DEPLOYMENT" --replicas="$target_replicas" -n "$NAMESPACE"
    
    log_info "Waiting for rollout to complete..."
    kubectl rollout status deployment "$DEPLOYMENT" -n "$NAMESPACE" --timeout=300s
    
    log_info "Scale up completed successfully"
}

# Scale down
scale_down() {
    local target_replicas="$1"
    
    if [ -z "$target_replicas" ]; then
        log_error "Target replicas not specified"
        exit 1
    fi
    
    if [ "$target_replicas" -lt "$MIN_REPLICAS" ]; then
        log_warn "Target replicas ($target_replicas) is below MIN_REPLICAS ($MIN_REPLICAS)"
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Scale down cancelled"
            exit 0
        fi
    fi
    
    log_step "Scaling down to $target_replicas replicas..."
    
    if [ "${DRY_RUN:-false}" = true ]; then
        log_info "DRY RUN: Would scale to $target_replicas replicas"
        return
    fi
    
    # Get current replicas
    local current_replicas=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')
    
    if [ "$target_replicas" -ge "$current_replicas" ]; then
        log_warn "Target replicas ($target_replicas) is not less than current ($current_replicas)"
        exit 1
    fi
    
    kubectl scale deployment "$DEPLOYMENT" --replicas="$target_replicas" -n "$NAMESPACE"
    
    log_info "Waiting for rollout to complete..."
    kubectl rollout status deployment "$DEPLOYMENT" -n "$NAMESPACE" --timeout=300s
    
    log_info "Scale down completed successfully"
}

# Enable/disable autoscaling
manage_autoscaling() {
    local action="$1"
    
    case "$action" in
        enable)
            log_step "Enabling autoscaling..."
            
            if [ "${DRY_RUN:-false}" = true ]; then
                log_info "DRY RUN: Would create HPA"
                return
            fi
            
            # Create HPA
            kubectl autoscale deployment "$DEPLOYMENT" \
                -n "$NAMESPACE" \
                --cpu-percent=70 \
                --min="$MIN_REPLICAS" \
                --max="$MAX_REPLICAS"
            
            log_info "Autoscaling enabled (CPU target: 70%, min: $MIN_REPLICAS, max: $MAX_REPLICAS)"
            ;;
        
        disable)
            log_step "Disabling autoscaling..."
            
            if [ "${DRY_RUN:-false}" = true ]; then
                log_info "DRY RUN: Would delete HPA"
                return
            fi
            
            kubectl delete hpa "$DEPLOYMENT" -n "$NAMESPACE" 2>/dev/null || true
            
            log_info "Autoscaling disabled"
            ;;
        
        *)
            log_error "Invalid action: $action (use 'enable' or 'disable')"
            exit 1
            ;;
    esac
}

# Monitor resources
monitor_resources() {
    local duration="${1:-1m}"
    
    log_step "Monitoring resources for $duration..."
    
    # Parse duration
    local seconds=60
    if [[ "$duration" =~ ^([0-9]+)s$ ]]; then
        seconds="${BASH_REMATCH[1]}"
    elif [[ "$duration" =~ ^([0-9]+)m$ ]]; then
        seconds=$(( ${BASH_REMATCH[1]} * 60 ))
    elif [[ "$duration" =~ ^([0-9]+)h$ ]]; then
        seconds=$(( ${BASH_REMATCH[1]} * 3600 ))
    fi
    
    log_info "Monitoring for $seconds seconds (Ctrl+C to stop)"
    echo ""
    
    local start_time=$(date +%s)
    local end_time=$((start_time + seconds))
    
    while [ $(date +%s) -lt "$end_time" ]; do
        clear
        echo "Mythos Scaling Monitor - $(date)"
        echo "================================"
        echo ""
        
        # Pod status
        echo "Pod Status:"
        kubectl get pods -n "$NAMESPACE" -l app=mythos-gateway -o wide
        echo ""
        
        # Resource usage
        echo "Resource Usage:"
        kubectl top pods -n "$NAMESPACE" -l app=mythos-gateway 2>/dev/null || echo "Metrics not available"
        echo ""
        
        # HPA status
        echo "HPA Status:"
        kubectl get hpa "$DEPLOYMENT" -n "$NAMESPACE" 2>/dev/null || echo "No HPA configured"
        echo ""
        
        # Recent events
        echo "Recent Events:"
        kubectl get events -n "$NAMESPACE" --sort-by='.metadata.creationTimestamp' | tail -5
        echo ""
        
        sleep 10
    done
}

# Get recommendations
get_recommendations() {
    log_step "Analyzing metrics for scaling recommendations..."
    
    echo "" | tee -a "$SCALE_LOG"
    
    # Get current metrics
    local cpu_usage=$(kubectl top pods -n "$NAMESPACE" -l app=mythos-gateway --no-headers 2>/dev/null | awk '{sum+=$2} END {print sum/NR}' || echo "0")
    local memory_usage=$(kubectl top pods -n "$NAMESPACE" -l app=mythos-gateway --no-headers 2>/dev/null | awk '{sum+=$3} END {print sum/NR}' || echo "0")
    local current_replicas=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')
    
    echo "Current State:" | tee -a "$SCALE_LOG"
    echo "  Replicas: $current_replicas" | tee -a "$SCALE_LOG"
    echo "  Avg CPU Usage: ${cpu_usage:-N/A}" | tee -a "$SCALE_LOG"
    echo "  Avg Memory Usage: ${memory_usage:-N/A}" | tee -a "$SCALE_LOG"
    echo "" | tee -a "$SCALE_LOG"
    
    # Parse CPU usage
    local cpu_percent=0
    if [[ "$cpu_usage" =~ ^([0-9]+)m$ ]]; then
        cpu_percent=$(( ${BASH_REMATCH[1]} / 10 ))  # Convert millicores to percentage (assuming 1000m = 100%)
    fi
    
    # Generate recommendations
    echo "Recommendations:" | tee -a "$SCALE_LOG"
    
    if [ "$cpu_percent" -gt 80 ]; then
        log_warn "High CPU usage detected ($cpu_percent%)"
        echo "  → Consider scaling up" | tee -a "$SCALE_LOG"
        echo "  → Recommended replicas: $((current_replicas + 2))" | tee -a "$SCALE_LOG"
    elif [ "$cpu_percent" -lt 30 ] && [ "$current_replicas" -gt "$MIN_REPLICAS" ]; then
        log_info "Low CPU usage detected ($cpu_percent%)"
        echo "  → Consider scaling down to save resources" | tee -a "$SCALE_LOG"
        echo "  → Recommended replicas: $((current_replicas - 1))" | tee -a "$SCALE_LOG"
    else
        log_info "CPU usage is within optimal range ($cpu_percent%)"
        echo "  → No scaling action needed" | tee -a "$SCALE_LOG"
    fi
    
    echo "" | tee -a "$SCALE_LOG"
    
    # Check for HPA
    if ! kubectl get hpa "$DEPLOYMENT" -n "$NAMESPACE" &> /dev/null; then
        log_warn "No HPA configured"
        echo "  → Consider enabling autoscaling:" | tee -a "$SCALE_LOG"
        echo "    $0 auto enable" | tee -a "$SCALE_LOG"
    fi
}

# Parse arguments
if [ $# -eq 0 ]; then
    show_usage
    exit 1
fi

COMMAND="$1"
shift

# Initialize log
mkdir -p "$(dirname "$SCALE_LOG")"
echo "Mythos Scaling Log - $(date)" > "$SCALE_LOG"
echo "================================" >> "$SCALE_LOG"

# Handle dry-run
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            ARG="$1"
            shift
            ;;
    esac
done

# Check prerequisites
check_prerequisites

# Execute command
case "$COMMAND" in
    status)
        show_status
        ;;
    
    up)
        scale_up "${ARG:-}"
        ;;
    
    down)
        scale_down "${ARG:-}"
        ;;
    
    auto)
        manage_autoscaling "${ARG:-}"
        ;;
    
    monitor)
        monitor_resources "${ARG:-1m}"
        ;;
    
    recommend)
        get_recommendations
        ;;
    
    *)
        log_error "Unknown command: $COMMAND"
        show_usage
        exit 1
        ;;
esac

log_info "Operation completed"
log_info "Log file: $SCALE_LOG"
