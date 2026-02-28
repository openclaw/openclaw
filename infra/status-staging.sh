#!/bin/bash

################################################################################
# Observability Stack Status & Diagnostic Script for Staging Cluster
#
# Purpose: Provide real-time diagnostic information about observability stack
#          components, resource usage, and operational health
#
# Usage: bash status-staging.sh [--detailed] [--pods] [--services] [--all]
#
# Options:
#   --detailed     Show detailed pod/service information
#   --pods         Show only pod status
#   --services     Show only service status
#   --all          Show all diagnostic information (equivalent to --detailed)
#   --watch        Continuous monitoring mode (updates every 5 seconds)
#
################################################################################

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
NAMESPACE="monitoring"
CLUSTER_NAME="clarity-router-staging"
REFRESH_INTERVAL=5

# Flags
DETAILED="false"
SHOW_PODS="false"
SHOW_SERVICES="false"
SHOW_ALL="true"
WATCH_MODE="false"

# Helper functions
print_section() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
}

print_subsection() {
    echo ""
    echo -e "${CYAN}▶ $1${NC}"
}

status_icon() {
    if [ "$1" = "Running" ] || [ "$1" = "Active" ] || [ "$1" = "Bound" ]; then
        echo -e "${GREEN}✓${NC}"
    elif [ "$1" = "Ready" ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi
}

print_pod_status() {
    local pod_name=$1
    local ready=$2
    local status=$3
    local restarts=$4
    
    if [ "$status" = "Running" ] && [ "$ready" = "2/2" ] || [ "$ready" = "1/1" ]; then
        echo -e "  ${GREEN}✓${NC} $pod_name (Ready: $ready, Status: $status, Restarts: $restarts)"
    else
        echo -e "  ${RED}✗${NC} $pod_name (Ready: $ready, Status: $status, Restarts: $restarts)"
    fi
}

# Parse arguments
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --detailed)
                DETAILED="true"
                SHOW_ALL="false"
                shift
                ;;
            --pods)
                SHOW_PODS="true"
                SHOW_ALL="false"
                shift
                ;;
            --services)
                SHOW_SERVICES="true"
                SHOW_ALL="false"
                shift
                ;;
            --all)
                SHOW_ALL="true"
                DETAILED="true"
                shift
                ;;
            --watch)
                WATCH_MODE="true"
                shift
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

# Display cluster overview
show_cluster_overview() {
    print_section "Cluster Overview"
    
    # Cluster context
    CONTEXT=$(kubectl config current-context)
    echo -e "Cluster Context: ${CYAN}$CONTEXT${NC}"
    
    # Node count
    NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
    READY_NODES=$(kubectl get nodes --field-selector=status.phase=Ready --no-headers 2>/dev/null | wc -l)
    echo -e "Nodes: ${GREEN}$READY_NODES/$NODE_COUNT${NC} Ready"
    
    # Namespace status
    if kubectl get namespace $NAMESPACE &>/dev/null; then
        echo -e "Monitoring Namespace: ${GREEN}✓ Active${NC}"
    else
        echo -e "Monitoring Namespace: ${RED}✗ Missing${NC}"
        return 1
    fi
}

# Display pod status
show_pod_status() {
    print_section "Pod Status"
    
    # Prometheus pods
    print_subsection "Prometheus (StatefulSet: 2 replicas expected)"
    kubectl get pods -n $NAMESPACE \
        -l app.kubernetes.io/name=prometheus \
        -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount \
        --no-headers 2>/dev/null | while read name ready status restarts; do
        print_pod_status "$name" "$ready" "$status" "$restarts"
    done
    
    # AlertManager pods
    print_subsection "AlertManager (StatefulSet: 2 replicas expected)"
    kubectl get pods -n $NAMESPACE \
        -l app.kubernetes.io/name=alertmanager \
        -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount \
        --no-headers 2>/dev/null | while read name ready status restarts; do
        print_pod_status "$name" "$ready" "$status" "$restarts"
    done
    
    # Grafana pods
    print_subsection "Grafana (Deployment: 2 replicas expected)"
    kubectl get pods -n $NAMESPACE \
        -l app.kubernetes.io/name=grafana \
        -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount \
        --no-headers 2>/dev/null | while read name ready status restarts; do
        print_pod_status "$name" "$ready" "$status" "$restarts"
    done
    
    # Loki pods
    print_subsection "Loki (StatefulSet: 2 replicas expected)"
    kubectl get pods -n $NAMESPACE \
        -l app=loki \
        -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount \
        --no-headers 2>/dev/null | while read name ready status restarts; do
        print_pod_status "$name" "$ready" "$status" "$restarts"
    done
    
    # Promtail pods
    print_subsection "Promtail (DaemonSet: 1 per node expected)"
    PROMTAIL_COUNT=$(kubectl get pods -n $NAMESPACE -l app=promtail --no-headers 2>/dev/null | wc -l)
    echo -e "  Promtail pods running: ${CYAN}$PROMTAIL_COUNT${NC}"
    
    # kube-state-metrics
    print_subsection "kube-state-metrics (1 replica expected)"
    kubectl get pods -n $NAMESPACE \
        -l app.kubernetes.io/name=kube-state-metrics \
        -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount \
        --no-headers 2>/dev/null | while read name ready status restarts; do
        print_pod_status "$name" "$ready" "$status" "$restarts"
    done
}

# Display service status
show_service_status() {
    print_section "Service Status"
    
    echo -e "${CYAN}Service Endpoints:${NC}"
    kubectl get svc -n $NAMESPACE -o custom-columns=NAME:.metadata.name,CLUSTER-IP:.spec.clusterIP,PORT:.spec.ports[0].port,ENDPOINTS:.status.loadBalancer.ingress[0].ip --no-headers 2>/dev/null | while read name ip port endpoints; do
        [ -z "$ip" ] && ip="<pending>"
        echo -e "  • $name: $ip:$port"
    done
}

# Display storage status
show_storage_status() {
    print_section "Storage Status"
    
    print_subsection "PersistentVolumeClaims"
    kubectl get pvc -n $NAMESPACE -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,CAPACITY:.spec.resources.requests.storage,VOLUME:.spec.volumeName --no-headers 2>/dev/null | while read name status capacity volume; do
        if [ "$status" = "Bound" ]; then
            echo -e "  ${GREEN}✓${NC} $name ($capacity) - Bound to $volume"
        else
            echo -e "  ${RED}✗${NC} $name ($capacity) - $status"
        fi
    done
    
    print_subsection "Storage Usage (Approximate)"
    # Prometheus storage usage
    PROM_USAGE=$(kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n $NAMESPACE -- \
        df -h /prometheus 2>/dev/null | awk 'NR==2 {print $5}' || echo "N/A")
    echo -e "  Prometheus: ${CYAN}$PROM_USAGE${NC}"
    
    # Loki storage usage
    LOKI_USAGE=$(kubectl exec -it loki-0 -n $NAMESPACE -- \
        df -h /loki/storage 2>/dev/null | awk 'NR==2 {print $5}' || echo "N/A")
    echo -e "  Loki: ${CYAN}$LOKI_USAGE${NC}"
    
    # Grafana storage usage
    GRAFANA_USAGE=$(kubectl exec -it grafana-0 -n $NAMESPACE -- \
        df -h /var/lib/grafana 2>/dev/null | awk 'NR==2 {print $5}' || echo "N/A")
    echo -e "  Grafana: ${CYAN}$GRAFANA_USAGE${NC}"
}

# Display resource usage
show_resource_usage() {
    print_section "Resource Usage"
    
    print_subsection "Pod Resource Requests & Usage"
    kubectl top pods -n $NAMESPACE 2>/dev/null || echo -e "  ${YELLOW}Resource metrics not yet available${NC}"
    
    print_subsection "Node Resource Usage"
    kubectl top nodes 2>/dev/null || echo -e "  ${YELLOW}Node metrics not yet available${NC}"
}

# Display Prometheus metrics
show_prometheus_metrics() {
    print_section "Prometheus Metrics"
    
    # Check if Prometheus service is reachable
    PROM_CHECK=$(kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n $NAMESPACE -- \
        curl -s http://localhost:9090/-/healthy 2>/dev/null | head -c 10 || echo "unreachable")
    
    if [[ "$PROM_CHECK" == "Prometheus"* ]] || [[ "$PROM_CHECK" == "OK"* ]]; then
        echo -e "Prometheus Status: ${GREEN}✓ Healthy${NC}"
        
        # Get metric count
        METRIC_COUNT=$(kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n $NAMESPACE -- \
            curl -s 'http://localhost:9090/api/v1/label/__name__/values' 2>/dev/null | grep -o '"' | wc -l || echo "?")
        echo -e "Metrics Loaded: ${CYAN}~$(($METRIC_COUNT / 2))${NC} unique metrics"
        
        # Get target count
        TARGET_COUNT=$(kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n $NAMESPACE -- \
            curl -s 'http://localhost:9090/api/v1/targets' 2>/dev/null | grep -o '"labels"' | wc -l || echo "?")
        echo -e "Scrape Targets: ${CYAN}~$TARGET_COUNT${NC}"
    else
        echo -e "Prometheus Status: ${YELLOW}⚠ Cannot reach API (pod may still be starting)${NC}"
    fi
}

# Display Grafana status
show_grafana_status() {
    print_section "Grafana Status"
    
    # Check Grafana service
    GRAFANA_CHECK=$(kubectl exec -it grafana-0 -n $NAMESPACE -- \
        curl -s http://localhost:3000/api/health 2>/dev/null | grep -o 'ok' || echo "unreachable")
    
    if [ "$GRAFANA_CHECK" = "ok" ]; then
        echo -e "Grafana Status: ${GREEN}✓ Healthy${NC}"
        echo -e "Access: http://localhost:3000 (via port-forward)"
        
        # Get datasource count
        DS_COUNT=$(kubectl exec -it grafana-0 -n $NAMESPACE -- \
            curl -s -u admin:$(kubectl get secret grafana-admin-secret -n $NAMESPACE -o jsonpath='{.data.password}' 2>/dev/null | base64 -d) \
            http://localhost:3000/api/datasources 2>/dev/null | grep -o '"name"' | wc -l || echo "?")
        echo -e "Datasources: ${CYAN}$DS_COUNT${NC}"
        
        # Get dashboard count
        DASH_COUNT=$(kubectl exec -it grafana-0 -n $NAMESPACE -- \
            curl -s -u admin:$(kubectl get secret grafana-admin-secret -n $NAMESPACE -o jsonpath='{.data.password}' 2>/dev/null | base64 -d) \
            http://localhost:3000/api/search 2>/dev/null | grep -o '"type":"dash-db"' | wc -l || echo "?")
        echo -e "Dashboards: ${CYAN}$DASH_COUNT${NC}"
    else
        echo -e "Grafana Status: ${YELLOW}⚠ Cannot reach API (pod may still be starting)${NC}"
    fi
}

# Display Loki status
show_loki_status() {
    print_section "Loki Status"
    
    # Check Loki service
    LOKI_CHECK=$(kubectl exec -it loki-0 -n $NAMESPACE -- \
        curl -s http://localhost:3100/loki/api/v1/status/buildinfo 2>/dev/null | grep -o 'version' || echo "unreachable")
    
    if [ "$LOKI_CHECK" = "version" ]; then
        echo -e "Loki Status: ${GREEN}✓ Healthy${NC}"
        echo -e "Promtail DaemonSet: ${GREEN}✓ Running${NC}"
    else
        echo -e "Loki Status: ${YELLOW}⚠ Cannot reach API (pod may still be starting)${NC}"
    fi
}

# Display AlertManager status
show_alertmanager_status() {
    print_section "AlertManager Status"
    
    # Check AlertManager service
    ALERT_CHECK=$(kubectl exec -it prometheus-stack-kube-prom-alertmanager-0 -n $NAMESPACE -- \
        curl -s http://localhost:9093/-/healthy 2>/dev/null | head -c 10 || echo "unreachable")
    
    if [[ "$ALERT_CHECK" == "AlertManager"* ]] || [[ "$ALERT_CHECK" == "OK"* ]]; then
        echo -e "AlertManager Status: ${GREEN}✓ Healthy${NC}"
        
        # Get alert count
        ALERT_COUNT=$(kubectl exec -it prometheus-stack-kube-prom-alertmanager-0 -n $NAMESPACE -- \
            curl -s 'http://localhost:9093/api/v1/alerts' 2>/dev/null | grep -o '"status"' | wc -l || echo "?")
        echo -e "Active Alerts: ${CYAN}$ALERT_COUNT${NC}"
    else
        echo -e "AlertManager Status: ${YELLOW}⚠ Cannot reach API (pod may still be starting)${NC}"
    fi
}

# Display deployment summary
show_deployment_summary() {
    print_section "Deployment Summary"
    
    # Count pods
    TOTAL_PODS=$(kubectl get pods -n $NAMESPACE --no-headers 2>/dev/null | wc -l)
    RUNNING_PODS=$(kubectl get pods -n $NAMESPACE --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
    READY_PODS=$(kubectl get pods -n $NAMESPACE -o jsonpath='{.items[?(@.status.conditions[?(@.type=="Ready")].status=="True")].metadata.name}' 2>/dev/null | wc -w)
    
    echo -e "Total Pods: ${CYAN}$TOTAL_PODS${NC}"
    echo -e "Running Pods: ${GREEN}$RUNNING_PODS${NC}"
    echo -e "Ready Pods: ${GREEN}$READY_PODS${NC}"
    
    if [ "$RUNNING_PODS" -eq "$TOTAL_PODS" ] && [ "$READY_PODS" -eq "$TOTAL_PODS" ]; then
        echo -e "Overall Status: ${GREEN}✓ Healthy${NC}"
    elif [ "$RUNNING_PODS" -eq "$TOTAL_PODS" ]; then
        echo -e "Overall Status: ${YELLOW}⚠ Running but not all ready${NC}"
    else
        echo -e "Overall Status: ${RED}✗ Degraded${NC}"
    fi
}

# Display port-forward instructions
show_port_forward_instructions() {
    print_section "Port-Forward Commands"
    
    echo -e "${CYAN}To access components locally, use these commands:${NC}"
    echo ""
    echo "Prometheus:"
    echo -e "  ${YELLOW}kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090${NC}"
    echo "  Access: http://localhost:9090"
    echo ""
    echo "Grafana:"
    echo -e "  ${YELLOW}kubectl port-forward -n monitoring svc/grafana 3000:3000${NC}"
    echo "  Access: http://localhost:3000"
    echo "  Username: admin"
    echo "  Password: $(kubectl get secret grafana-admin-secret -n monitoring -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo '<run: kubectl get secret grafana-admin-secret -n monitoring -o jsonpath=\"{.data.password}\" | base64 -d>')"
    echo ""
    echo "Loki:"
    echo -e "  ${YELLOW}# Loki is accessed via Grafana Explore tab${NC}"
    echo ""
    echo "AlertManager:"
    echo -e "  ${YELLOW}kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093${NC}"
    echo "  Access: http://localhost:9093"
}

# Display help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --detailed    Show detailed pod/service information"
    echo "  --pods        Show only pod status"
    echo "  --services    Show only service status"
    echo "  --all         Show all diagnostic information"
    echo "  --watch       Continuous monitoring mode (5s refresh)"
    echo "  --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  bash $0                    # Show quick status"
    echo "  bash $0 --detailed         # Show detailed status"
    echo "  bash $0 --watch            # Continuous monitoring"
}

# Main status display
show_status() {
    # Always show cluster overview
    show_cluster_overview || return 1
    
    if [ "$SHOW_ALL" = "true" ]; then
        # Show everything
        show_pod_status
        show_service_status
        show_storage_status
        show_resource_usage
        show_prometheus_metrics
        show_grafana_status
        show_loki_status
        show_alertmanager_status
        show_deployment_summary
        show_port_forward_instructions
    else
        # Show selected sections
        [ "$SHOW_PODS" = "true" ] && show_pod_status
        [ "$SHOW_SERVICES" = "true" ] && show_service_status
    fi
    
    if [ "$DETAILED" = "true" ]; then
        show_storage_status
        show_resource_usage
    fi
}

# Main function
main() {
    parse_arguments "$@"
    
    if [ "$WATCH_MODE" = "true" ]; then
        echo -e "${CYAN}Monitoring mode enabled. Refreshing every ${REFRESH_INTERVAL}s. Press Ctrl+C to exit.${NC}"
        while true; do
            clear
            show_status
            sleep $REFRESH_INTERVAL
        done
    else
        show_status
    fi
}

# Show help if requested
if [[ " $@ " =~ " --help " ]]; then
    show_help
    exit 0
fi

# Run main function
main "$@"
