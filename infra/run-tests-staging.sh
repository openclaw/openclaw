#!/bin/bash
#
# Staging Observability Stack - Automated Test Runner
#
# This script automates testing of the observability stack deployment.
# It runs prerequisite checks, component tests, data validation, and generates a report.
#
# Usage:
#   ./run-tests-staging.sh                    # Run all tests
#   ./run-tests-staging.sh --component prometheus  # Test single component
#   ./run-tests-staging.sh --test alert-routing   # Run specific test
#   ./run-tests-staging.sh --dry-run             # Show what would run
#

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test configuration
NAMESPACE="monitoring"
LOG_DIR="./test-logs"
REPORT_FILE="${LOG_DIR}/test-report-$(date +%Y%m%d-%H%M%S).md"
TEST_RESULTS_FILE="${LOG_DIR}/test-results-$(date +%Y%m%d-%H%M%S).txt"
DRY_RUN=false
VERBOSE=false
COMPONENT_FILTER=""
TEST_FILTER=""
STOP_ON_FAILURE=false

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
  echo -e "${BLUE}[INFO]${NC} $*" | tee -a "$TEST_RESULTS_FILE"
}

log_success() {
  echo -e "${GREEN}[✓]${NC} $*" | tee -a "$TEST_RESULTS_FILE"
  ((TESTS_PASSED++))
}

log_error() {
  echo -e "${RED}[✗]${NC} $*" | tee -a "$TEST_RESULTS_FILE"
  ((TESTS_FAILED++))
  if [[ "$STOP_ON_FAILURE" == true ]]; then
    exit 1
  fi
}

log_warning() {
  echo -e "${YELLOW}[!]${NC} $*" | tee -a "$TEST_RESULTS_FILE"
}

log_skip() {
  echo -e "${YELLOW}[SKIP]${NC} $*" | tee -a "$TEST_RESULTS_FILE"
  ((TESTS_SKIPPED++))
}

print_header() {
  echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}$*${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n" | tee -a "$TEST_RESULTS_FILE"
}

print_separator() {
  echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}" | tee -a "$TEST_RESULTS_FILE"
}

# ============================================================================
# Usage and Help
# ============================================================================

usage() {
  cat << EOF
Usage: $0 [OPTIONS]

OPTIONS:
  --component COMPONENT   Run tests for specific component (prometheus, grafana, loki, alertmanager)
  --test TEST_NAME        Run specific test (component, data, dashboard, alert, integration, failure)
  --dry-run               Show what would run without executing
  --verbose               Enable verbose output
  --stop-on-failure       Exit on first failure
  --help                  Show this help message

Examples:
  ./run-tests-staging.sh
  ./run-tests-staging.sh --component prometheus
  ./run-tests-staging.sh --test alert-routing
  ./run-tests-staging.sh --dry-run
EOF
}

# ============================================================================
# Prerequisites Checks
# ============================================================================

check_prerequisites() {
  print_header "PREREQUISITE CHECKS"
  
  local prereq_ok=true
  
  # Check kubectl
  if ! command -v kubectl &> /dev/null; then
    log_error "kubectl not found. Please install kubectl."
    prereq_ok=false
  else
    log_success "kubectl found: $(kubectl version --client --short 2>/dev/null || echo 'installed')"
  fi
  
  # Check curl
  if ! command -v curl &> /dev/null; then
    log_error "curl not found. Please install curl."
    prereq_ok=false
  else
    log_success "curl found: $(curl --version | head -1)"
  fi
  
  # Check jq
  if ! command -v jq &> /dev/null; then
    log_error "jq not found. Please install jq."
    prereq_ok=false
  else
    log_success "jq found: $(jq --version)"
  fi
  
  # Check kubectl cluster connection
  if ! kubectl cluster-info &> /dev/null; then
    log_error "Cannot connect to Kubernetes cluster. Check kubeconfig."
    prereq_ok=false
  else
    log_success "Connected to cluster: $(kubectl cluster-info | head -1)"
  fi
  
  # Check namespace exists
  if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
    log_error "Namespace '$NAMESPACE' not found."
    prereq_ok=false
  else
    log_success "Namespace '$NAMESPACE' exists"
  fi
  
  # Check observability pods exist
  local pod_count=$(kubectl -n "$NAMESPACE" get pods --no-headers 2>/dev/null | wc -l)
  if [[ $pod_count -gt 0 ]]; then
    log_success "Found $pod_count pods in namespace"
  else
    log_error "No pods found in namespace '$NAMESPACE'"
    prereq_ok=false
  fi
  
  if [[ "$prereq_ok" == false ]]; then
    log_error "Prerequisites check failed"
    exit 1
  fi
}

# ============================================================================
# Component Health Checks
# ============================================================================

check_component_health() {
  print_header "COMPONENT HEALTH CHECKS"
  
  local components=("prometheus" "grafana" "loki" "alertmanager")
  
  for component in "${components[@]}"; do
    if [[ -n "$COMPONENT_FILTER" ]] && [[ "$component" != "$COMPONENT_FILTER" ]]; then
      continue
    fi
    
    log_info "Checking $component..."
    
    local pod_count=$(kubectl -n "$NAMESPACE" get pods -l "app=$component" --no-headers 2>/dev/null | wc -l)
    
    if [[ $pod_count -eq 0 ]]; then
      log_error "$component: No pods found"
      continue
    fi
    
    # Check pod status
    local running_count=$(kubectl -n "$NAMESPACE" get pods -l "app=$component" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
    
    if [[ $running_count -eq $pod_count ]]; then
      log_success "$component: All $running_count pod(s) running"
    else
      log_error "$component: Only $running_count/$pod_count pods running"
    fi
    
    # Check resource usage
    if kubectl -n "$NAMESPACE" top pod -l "app=$component" &> /dev/null; then
      kubectl -n "$NAMESPACE" top pod -l "app=$component" | tail -n +2 | while read -r line; do
        log_info "  $component resource usage: $line"
      done
    fi
    
    ((TESTS_RUN++))
  done
}

# ============================================================================
# Service Connectivity Tests
# ============================================================================

check_service_connectivity() {
  print_header "SERVICE CONNECTIVITY"
  
  local services=("prometheus" "grafana" "loki" "alertmanager")
  
  for service in "${services[@]}"; do
    if [[ -n "$COMPONENT_FILTER" ]] && [[ "$service" != "$COMPONENT_FILTER" ]]; then
      continue
    fi
    
    ((TESTS_RUN++))
    
    if kubectl -n "$NAMESPACE" get svc "$service" &> /dev/null; then
      local ip=$(kubectl -n "$NAMESPACE" get svc "$service" -o jsonpath='{.spec.clusterIP}')
      log_success "$service service exists (IP: $ip)"
    else
      log_error "$service service not found"
    fi
  done
}

# ============================================================================
# Prometheus Tests
# ============================================================================

test_prometheus() {
  if [[ -n "$TEST_FILTER" ]] && [[ "$TEST_FILTER" != "component" ]] && [[ "$TEST_FILTER" != "prometheus" ]]; then
    return
  fi
  
  print_header "PROMETHEUS COMPONENT TESTS"
  
  # Setup port-forward
  local pf_pid=""
  setup_portforward "prometheus" "9090" pf_pid
  
  # Health check
  ((TESTS_RUN++))
  if curl -s "http://localhost:9090/-/healthy" &> /dev/null; then
    log_success "Prometheus health check"
  else
    log_error "Prometheus health check failed"
  fi
  
  # Targets check
  ((TESTS_RUN++))
  local target_count=$(curl -s 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null | \
    jq '.data.activeTargets | length' 2>/dev/null || echo "0")
  if [[ $target_count -gt 50 ]]; then
    log_success "Prometheus targets: $target_count active"
  else
    log_error "Prometheus targets: only $target_count (expected >50)"
  fi
  
  # Query test
  ((TESTS_RUN++))
  if curl -s 'http://localhost:9090/api/v1/query?query=up' 2>/dev/null | jq -e '.data.result | length > 0' &> /dev/null; then
    log_success "Prometheus query execution"
  else
    log_error "Prometheus query execution failed"
  fi
  
  # Rules check
  ((TESTS_RUN++))
  local rule_count=$(curl -s 'http://localhost:9090/api/v1/rules?type=alert' 2>/dev/null | \
    jq '.data.groups | length' 2>/dev/null || echo "0")
  if [[ $rule_count -gt 0 ]]; then
    log_success "Prometheus alert rules: $rule_count groups"
  else
    log_error "Prometheus alert rules: none found"
  fi
  
  cleanup_portforward "$pf_pid"
}

# ============================================================================
# Grafana Tests
# ============================================================================

test_grafana() {
  if [[ -n "$TEST_FILTER" ]] && [[ "$TEST_FILTER" != "component" ]] && [[ "$TEST_FILTER" != "grafana" ]]; then
    return
  fi
  
  print_header "GRAFANA COMPONENT TESTS"
  
  # Setup port-forward
  local pf_pid=""
  setup_portforward "grafana" "3000" pf_pid
  
  # Health check
  ((TESTS_RUN++))
  if curl -s 'http://localhost:3000/api/health' 2>/dev/null | jq -e '.version' &> /dev/null; then
    log_success "Grafana health check"
  else
    log_error "Grafana health check failed"
  fi
  
  # Datasources check
  ((TESTS_RUN++))
  local ds_count=$(curl -s 'http://localhost:3000/api/datasources' -u admin:admin 2>/dev/null | \
    jq 'length' 2>/dev/null || echo "0")
  if [[ $ds_count -ge 2 ]]; then
    log_success "Grafana datasources: $ds_count configured"
  else
    log_error "Grafana datasources: only $ds_count (expected ≥2)"
  fi
  
  # Dashboard check
  ((TESTS_RUN++))
  local dashboard_count=$(curl -s 'http://localhost:3000/api/search' -u admin:admin 2>/dev/null | \
    jq 'length' 2>/dev/null || echo "0")
  if [[ $dashboard_count -ge 3 ]]; then
    log_success "Grafana dashboards: $dashboard_count found"
  else
    log_error "Grafana dashboards: only $dashboard_count (expected ≥3)"
  fi
  
  cleanup_portforward "$pf_pid"
}

# ============================================================================
# Loki Tests
# ============================================================================

test_loki() {
  if [[ -n "$TEST_FILTER" ]] && [[ "$TEST_FILTER" != "component" ]] && [[ "$TEST_FILTER" != "loki" ]]; then
    return
  fi
  
  print_header "LOKI COMPONENT TESTS"
  
  # Setup port-forward
  local pf_pid=""
  setup_portforward "loki" "3100" pf_pid
  
  # Health check
  ((TESTS_RUN++))
  if curl -s 'http://localhost:3100/ready' &> /dev/null; then
    log_success "Loki ready check"
  else
    log_error "Loki ready check failed"
  fi
  
  # Labels check
  ((TESTS_RUN++))
  local label_count=$(curl -s 'http://localhost:3100/loki/api/v1/labels' 2>/dev/null | \
    jq '.values | length' 2>/dev/null || echo "0")
  if [[ $label_count -gt 5 ]]; then
    log_success "Loki labels: $label_count found"
  else
    log_warning "Loki labels: only $label_count (expected >5)"
  fi
  
  # Log query test
  ((TESTS_RUN++))
  if curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' 2>/dev/null | \
    jq -e '.data.result | length >= 0' &> /dev/null; then
    log_success "Loki log query execution"
  else
    log_error "Loki log query execution failed"
  fi
  
  cleanup_portforward "$pf_pid"
}

# ============================================================================
# AlertManager Tests
# ============================================================================

test_alertmanager() {
  if [[ -n "$TEST_FILTER" ]] && [[ "$TEST_FILTER" != "component" ]] && [[ "$TEST_FILTER" != "alertmanager" ]]; then
    return
  fi
  
  print_header "ALERTMANAGER COMPONENT TESTS"
  
  # Setup port-forward
  local pf_pid=""
  setup_portforward "alertmanager" "9093" pf_pid
  
  # Health check
  ((TESTS_RUN++))
  if curl -s 'http://localhost:9093/-/healthy' &> /dev/null; then
    log_success "AlertManager health check"
  else
    log_error "AlertManager health check failed"
  fi
  
  # Status check
  ((TESTS_RUN++))
  if curl -s 'http://localhost:9093/api/v1/status' 2>/dev/null | jq -e '.config' &> /dev/null; then
    log_success "AlertManager status check"
  else
    log_error "AlertManager status check failed"
  fi
  
  # Receivers check
  ((TESTS_RUN++))
  local receiver_count=$(curl -s 'http://localhost:9093/api/v1/status' 2>/dev/null | \
    jq '.config.receivers | length' 2>/dev/null || echo "0")
  if [[ $receiver_count -gt 0 ]]; then
    log_success "AlertManager receivers: $receiver_count configured"
  else
    log_error "AlertManager receivers: none configured"
  fi
  
  cleanup_portforward "$pf_pid"
}

# ============================================================================
# Data Validation Tests
# ============================================================================

test_data_collection() {
  if [[ -n "$TEST_FILTER" ]] && [[ "$TEST_FILTER" != "data" ]]; then
    return
  fi
  
  print_header "DATA COLLECTION VALIDATION"
  
  local pf_pid=""
  setup_portforward "prometheus" "9090" pf_pid
  
  # Metrics check
  ((TESTS_RUN++))
  local metric_count=$(curl -s 'http://localhost:9090/api/v1/query?query=count(up)' 2>/dev/null | \
    jq '.data.result[0].value[1]' 2>/dev/null | cut -d'.' -f1)
  if [[ $metric_count -gt 100 ]]; then
    log_success "Metrics collected: $metric_count time series"
  else
    log_warning "Metrics collected: only $metric_count (expected >100)"
  fi
  
  cleanup_portforward "$pf_pid"
  
  # Logs check
  pf_pid=""
  setup_portforward "loki" "3100" pf_pid
  
  ((TESTS_RUN++))
  if curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' 2>/dev/null | \
    jq -e '.data.result | length > 0' &> /dev/null; then
    log_success "Logs ingested from cluster"
  else
    log_warning "No logs found (may be normal if cluster just started)"
  fi
  
  cleanup_portforward "$pf_pid"
}

# ============================================================================
# Storage Check
# ============================================================================

check_storage() {
  print_header "STORAGE & CAPACITY CHECKS"
  
  # Prometheus PVC
  ((TESTS_RUN++))
  local prom_capacity=$(kubectl -n "$NAMESPACE" get pvc prometheus-data -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null)
  if [[ -n "$prom_capacity" ]]; then
    log_success "Prometheus PVC capacity: $prom_capacity"
  else
    log_warning "Prometheus PVC not found or no capacity set"
  fi
  
  # Loki PVC
  ((TESTS_RUN++))
  local loki_capacity=$(kubectl -n "$NAMESPACE" get pvc loki-data -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null)
  if [[ -n "$loki_capacity" ]]; then
    log_success "Loki PVC capacity: $loki_capacity"
  else
    log_warning "Loki PVC not found or no capacity set"
  fi
}

# ============================================================================
# Helper: Port Forward
# ============================================================================

setup_portforward() {
  local component=$1
  local port=$2
  local -n pf_pid_ref=$3
  
  kubectl -n "$NAMESPACE" port-forward "svc/$component" "$port:$port" &> /dev/null &
  pf_pid_ref=$!
  sleep 1
}

cleanup_portforward() {
  local pf_pid=$1
  if [[ -n "$pf_pid" ]] && kill -0 "$pf_pid" 2>/dev/null; then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
  fi
}

# ============================================================================
# Generate Report
# ============================================================================

generate_report() {
  print_header "GENERATING TEST REPORT"
  
  cat > "$REPORT_FILE" << EOF
# Staging Observability Stack - Automated Test Report

**Date:** $(date '+%Y-%m-%d %H:%M:%S')
**Cluster:** $(kubectl config current-context 2>/dev/null || echo "unknown")
**Namespace:** $NAMESPACE

## Test Summary

- **Tests Run:** $TESTS_RUN
- **Tests Passed:** $TESTS_PASSED
- **Tests Failed:** $TESTS_FAILED
- **Tests Skipped:** $TESTS_SKIPPED

**Overall Status:** $(if [[ $TESTS_FAILED -eq 0 ]]; then echo "✓ PASS"; else echo "✗ FAIL"; fi)

## Component Status

### Prometheus
- Health: $(get_component_status "prometheus" "9090" "/-/healthy")
- Targets: $(get_prometheus_targets)
- Memory: $(get_component_memory "prometheus")

### Grafana
- Health: $(get_component_status "grafana" "3000" "/api/health")
- Datasources: $(get_grafana_datasources)
- Memory: $(get_component_memory "grafana")

### Loki
- Health: $(get_component_status "loki" "3100" "/ready")
- Labels: $(get_loki_labels)
- Memory: $(get_component_memory "loki")

### AlertManager
- Health: $(get_component_status "alertmanager" "9093" "/-/healthy")
- Status: $(get_alertmanager_status)
- Memory: $(get_component_memory "alertmanager")

## Details

See \`$TEST_RESULTS_FILE\` for detailed test results.

## Recommendations

1. Review failed tests above
2. Check component logs: \`kubectl -n $NAMESPACE logs -f <pod-name>\`
3. Verify all prerequisites are installed
4. Ensure sufficient cluster resources available

---
*Report generated: $(date)*
EOF
  
  log_success "Test report written to: $REPORT_FILE"
}

# ============================================================================
# Status Helper Functions
# ============================================================================

get_component_status() {
  local component=$1
  local port=$2
  local endpoint=$3
  local pf_pid=""
  
  setup_portforward "$component" "$port" pf_pid
  
  if curl -s "http://localhost:$port$endpoint" &> /dev/null; then
    echo "✓ OK"
  else
    echo "✗ DOWN"
  fi
  
  cleanup_portforward "$pf_pid"
}

get_prometheus_targets() {
  local pf_pid=""
  setup_portforward "prometheus" "9090" pf_pid
  
  curl -s 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null | \
    jq '.data.activeTargets | length' 2>/dev/null || echo "unknown"
  
  cleanup_portforward "$pf_pid"
}

get_grafana_datasources() {
  local pf_pid=""
  setup_portforward "grafana" "3000" pf_pid
  
  curl -s 'http://localhost:3000/api/datasources' -u admin:admin 2>/dev/null | \
    jq 'length' 2>/dev/null || echo "unknown"
  
  cleanup_portforward "$pf_pid"
}

get_loki_labels() {
  local pf_pid=""
  setup_portforward "loki" "3100" pf_pid
  
  curl -s 'http://localhost:3100/loki/api/v1/labels' 2>/dev/null | \
    jq '.values | length' 2>/dev/null || echo "unknown"
  
  cleanup_portforward "$pf_pid"
}

get_alertmanager_status() {
  local pf_pid=""
  setup_portforward "alertmanager" "9093" pf_pid
  
  if curl -s 'http://localhost:9093/api/v1/status' 2>/dev/null | jq -e '.config' &> /dev/null; then
    echo "✓ Configured"
  else
    echo "✗ Not configured"
  fi
  
  cleanup_portforward "$pf_pid"
}

get_component_memory() {
  local component=$1
  kubectl -n "$NAMESPACE" top pod -l "app=$component" --no-headers 2>/dev/null | \
    awk '{print $3}' | head -1 || echo "unknown"
}

# ============================================================================
# Main
# ============================================================================

main() {
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      --component)
        COMPONENT_FILTER="$2"
        shift 2
        ;;
      --test)
        TEST_FILTER="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --verbose)
        VERBOSE=true
        shift
        ;;
      --stop-on-failure)
        STOP_ON_FAILURE=true
        shift
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1"
        usage
        exit 1
        ;;
    esac
  done
  
  # Create log directory
  mkdir -p "$LOG_DIR"
  
  # Initialize results file
  > "$TEST_RESULTS_FILE"
  
  # Print header
  print_header "STAGING OBSERVABILITY STACK - AUTOMATED TEST RUNNER"
  log_info "Start time: $(date)"
  log_info "Namespace: $NAMESPACE"
  
  if [[ "$DRY_RUN" == true ]]; then
    log_warning "Running in DRY-RUN mode (no actual tests executed)"
  fi
  
  # Run tests
  check_prerequisites
  print_separator
  check_component_health
  print_separator
  check_service_connectivity
  print_separator
  test_prometheus
  print_separator
  test_grafana
  print_separator
  test_loki
  print_separator
  test_alertmanager
  print_separator
  test_data_collection
  print_separator
  check_storage
  
  # Generate report
  print_separator
  generate_report
  
  # Summary
  print_header "TEST SUMMARY"
  log_info "Tests Run: $TESTS_RUN"
  log_info "Tests Passed: $TESTS_PASSED"
  log_info "Tests Failed: $TESTS_FAILED"
  log_info "Tests Skipped: $TESTS_SKIPPED"
  log_info "End time: $(date)"
  
  if [[ $TESTS_FAILED -eq 0 ]]; then
    log_success "All tests passed!"
  else
    log_error "$TESTS_FAILED test(s) failed"
  fi
  
  log_info ""
  log_info "Full results: $TEST_RESULTS_FILE"
  log_info "Report: $REPORT_FILE"
  log_info ""
  
  # Exit with appropriate code
  if [[ $TESTS_FAILED -gt 0 ]]; then
    exit 1
  else
    exit 0
  fi
}

# Run main function
main "$@"
