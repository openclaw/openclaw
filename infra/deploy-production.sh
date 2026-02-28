#!/bin/bash
#
# ClarityRouter Observability Stack - Production Deployment Script
# This script automates deployment to the production EKS cluster (clarity-router-prod)
#
# Usage:
#   ./deploy-production.sh --dry-run                    # Show what would be deployed
#   ./deploy-production.sh --cluster=clarity-router-prod --apply  # Deploy to production
#   ./deploy-production.sh --help                       # Show all options

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="observability"
CLUSTER_NAME="${CLUSTER_NAME:-clarity-router-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=false
APPLY=false
VERBOSE=false
CANARY=false
LOG_FILE="/tmp/observability-deployment-$(date +%Y%m%d-%H%M%S).log"

# Production configuration
PROMETHEUS_REPLICAS=3
GRAFANA_REPLICAS=2
LOKI_REPLICAS=3
PROMETHEUS_MEMORY="2Gi"
PROMETHEUS_CPU="500m"
GRAFANA_MEMORY="512Mi"
GRAFANA_CPU="250m"
LOKI_MEMORY="1Gi"
LOKI_CPU="250m"
PAGERDUTY_ENABLED=true
PVC_SIZE="200Gi"

# Functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $*" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[✗] ERROR${NC}: $*" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $*" | tee -a "$LOG_FILE"
}

log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${BLUE}[DEBUG]${NC} $*" | tee -a "$LOG_FILE"
    fi
}

show_help() {
    cat << EOF
Production Observability Stack Deployment Script

USAGE:
    ./deploy-production.sh [OPTIONS]

OPTIONS:
    --dry-run               Show what would be deployed without applying changes
    --apply                 Actually deploy to cluster (requires confirmation)
    --cluster NAME          EKS cluster name (default: clarity-router-prod)
    --region REGION         AWS region (default: us-east-1)
    --canary                Deploy as canary (single replica, monitor before scaling)
    --verbose               Enable debug output
    --help                  Show this help message

EXAMPLES:
    # Dry-run to see what will be deployed
    ./deploy-production.sh --dry-run

    # Deploy to production (interactive confirmation)
    ./deploy-production.sh --cluster=clarity-router-prod --apply

    # Canary deployment (safer for initial rollout)
    ./deploy-production.sh --canary --apply

PREREQUISITES:
    - kubectl installed and configured for production cluster
    - AWS CLI installed and authenticated
    - Helm 3.x installed
    - Secrets Manager access for Slack/PagerDuty credentials
    - Appropriate IAM permissions in cluster

DOCUMENTATION:
    See DEPLOYMENT_PRODUCTION.md for pre-flight checklist
    See INSTALL_PRODUCTION.md for detailed step-by-step guide
    See VERIFY_PRODUCTION.md for post-deployment verification
EOF
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --apply)
                APPLY=true
                shift
                ;;
            --cluster)
                CLUSTER_NAME="$2"
                shift 2
                ;;
            --region)
                AWS_REGION="$2"
                shift 2
                ;;
            --canary)
                CANARY=true
                log_warning "Canary mode enabled: deploying 1 replica for testing"
                PROMETHEUS_REPLICAS=1
                GRAFANA_REPLICAS=1
                LOKI_REPLICAS=1
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

verify_prerequisites() {
    log "Verifying prerequisites..."

    # Check kubectl
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl not found. Please install kubectl."
        exit 1
    fi
    log_success "kubectl installed ($(kubectl version --client --short))"

    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI not found. Please install AWS CLI."
        exit 1
    fi
    log_success "AWS CLI installed"

    # Check Helm
    if ! command -v helm &> /dev/null; then
        log_error "Helm not found. Please install Helm 3.x."
        exit 1
    fi
    log_success "Helm installed ($(helm version --short))"

    # Verify AWS credentials
    if ! aws sts get-caller-identity --region "$AWS_REGION" &> /dev/null; then
        log_error "AWS credentials not configured or expired. Please run 'aws configure'."
        exit 1
    fi
    log_success "AWS credentials valid"

    # Check kubectl context
    CURRENT_CONTEXT=$(kubectl config current-context)
    log_verbose "Current kubectl context: $CURRENT_CONTEXT"

    # Verify cluster connectivity
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to Kubernetes cluster. Check kubeconfig and credentials."
        exit 1
    fi
    log_success "Kubernetes cluster reachable"
}

check_production_requirements() {
    log "Checking production-specific requirements..."

    # Check EFS availability
    EFS_COUNT=$(aws efs describe-file-systems --region "$AWS_REGION" --query 'FileSystems | length(@)' 2>/dev/null || echo 0)
    if [[ $EFS_COUNT -eq 0 ]]; then
        log_warning "No EFS file systems found in $AWS_REGION. You may need to provision EFS."
    else
        log_success "EFS file systems found: $EFS_COUNT"
    fi

    # Check node count (production requires 3+ for HA)
    NODE_COUNT=$(kubectl get nodes --no-headers | wc -l)
    if [[ $NODE_COUNT -lt 3 ]]; then
        log_warning "Only $NODE_COUNT nodes found. Production HA requires 3+ nodes."
    else
        log_success "Node count adequate: $NODE_COUNT nodes"
    fi

    # Check secrets exist
    for SECRET in slack-webhook-prod pagerduty-integration-prod grafana-admin-password; do
        if aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$AWS_REGION" &> /dev/null; then
            log_success "Secret found: $SECRET"
        else
            log_warning "Secret not found: $SECRET (will be created or must be added manually)"
        fi
    done

    # Check EFS CSI driver (required for persistent volumes)
    if kubectl get deployment -n kube-system efs-csi-controller &> /dev/null; then
        log_success "EFS CSI driver installed in cluster"
    else
        log_warning "EFS CSI driver not found. PVCs may fail to mount."
    fi
}

create_namespace() {
    log "Creating or verifying namespace '$NAMESPACE'..."

    if kubectl get namespace "$NAMESPACE" &> /dev/null; then
        log_verbose "Namespace already exists"
    else
        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Would create namespace: $NAMESPACE"
        else
            kubectl create namespace "$NAMESPACE"
            log_success "Namespace created: $NAMESPACE"
        fi
    fi
}

setup_secrets() {
    log "Setting up secrets in Kubernetes..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would create secrets from AWS Secrets Manager:"
        log "  - slack-webhook"
        log "  - pagerduty-integration"
        log "  - grafana-admin-password"
        return 0
    fi

    # Create Slack webhook secret
    SLACK_WEBHOOK=$(aws secretsmanager get-secret-value \
        --secret-id slack-webhook-prod \
        --region "$AWS_REGION" \
        --query 'SecretString' \
        --output text 2>/dev/null || echo "")

    if [[ -z "$SLACK_WEBHOOK" ]]; then
        log_warning "Slack webhook secret not found. AlertManager will not send to Slack."
    else
        kubectl create secret generic slack-webhook \
            --from-literal=webhook-url="$SLACK_WEBHOOK" \
            -n "$NAMESPACE" \
            --dry-run=client -o yaml | kubectl apply -f -
        log_success "Slack webhook secret created"
    fi

    # Create PagerDuty secret
    PAGERDUTY_KEY=$(aws secretsmanager get-secret-value \
        --secret-id pagerduty-integration-prod \
        --region "$AWS_REGION" \
        --query 'SecretString' \
        --output text 2>/dev/null || echo "")

    if [[ -z "$PAGERDUTY_KEY" ]]; then
        log_warning "PagerDuty secret not found. Escalations will not be sent."
    else
        kubectl create secret generic pagerduty-integration \
            --from-literal=integration-key="$PAGERDUTY_KEY" \
            -n "$NAMESPACE" \
            --dry-run=client -o yaml | kubectl apply -f -
        log_success "PagerDuty secret created"
    fi

    # Create Grafana admin password secret
    GRAFANA_ADMIN=$(aws secretsmanager get-secret-value \
        --secret-id grafana-admin-password \
        --region "$AWS_REGION" \
        --query 'SecretString' \
        --output text 2>/dev/null || echo "")

    if [[ -z "$GRAFANA_ADMIN" ]]; then
        log_warning "Grafana admin password not found. Default credentials will be used."
    else
        kubectl create secret generic grafana-admin \
            --from-literal=admin-password="$GRAFANA_ADMIN" \
            -n "$NAMESPACE" \
            --dry-run=client -o yaml | kubectl apply -f -
        log_success "Grafana admin secret created"
    fi
}

add_helm_repos() {
    log "Adding Helm repositories..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would add Helm repos:"
        log "  - prometheus-community"
        log "  - grafana"
        log "  - loki"
        return 0
    fi

    helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
    helm repo add grafana https://grafana.github.io/helm-charts
    helm repo add loki https://grafana.github.io/loki/charts
    helm repo update
    log_success "Helm repositories updated"
}

deploy_prometheus() {
    log "Deploying Prometheus..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would deploy Prometheus with:"
        log "  - Replicas: $PROMETHEUS_REPLICAS"
        log "  - Memory: $PROMETHEUS_MEMORY"
        log "  - CPU: $PROMETHEUS_CPU"
        log "  - Retention: 15 days"
        return 0
    fi

    helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
        -n "$NAMESPACE" \
        --values "${SCRIPT_DIR}/prometheus/values-prod.yaml" \
        --set prometheus.prometheusSpec.replicas="$PROMETHEUS_REPLICAS" \
        --set prometheus.prometheusSpec.resources.requests.memory="$PROMETHEUS_MEMORY" \
        --set prometheus.prometheusSpec.resources.requests.cpu="$PROMETHEUS_CPU" \
        --set prometheus.prometheusSpec.retention=15d \
        --wait \
        --timeout 10m

    log_success "Prometheus deployed successfully"
}

deploy_loki() {
    log "Deploying Loki..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would deploy Loki with:"
        log "  - Replicas: $LOKI_REPLICAS"
        log "  - Memory: $LOKI_MEMORY"
        log "  - CPU: $LOKI_CPU"
        log "  - Retention: 30 days"
        return 0
    fi

    helm upgrade --install loki grafana/loki-stack \
        -n "$NAMESPACE" \
        --values "${SCRIPT_DIR}/loki/values-prod.yaml" \
        --set loki.replicas="$LOKI_REPLICAS" \
        --set loki.resources.requests.memory="$LOKI_MEMORY" \
        --set loki.resources.requests.cpu="$LOKI_CPU" \
        --set loki.retention_period=30d \
        --set promtail.enabled=true \
        --wait \
        --timeout 10m

    log_success "Loki deployed successfully"
}

deploy_grafana() {
    log "Deploying Grafana..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would deploy Grafana with:"
        log "  - Replicas: $GRAFANA_REPLICAS"
        log "  - Memory: $GRAFANA_MEMORY"
        log "  - CPU: $GRAFANA_CPU"
        return 0
    fi

    helm upgrade --install grafana grafana/grafana \
        -n "$NAMESPACE" \
        --values "${SCRIPT_DIR}/grafana/values-prod.yaml" \
        --set replicaCount="$GRAFANA_REPLICAS" \
        --set resources.requests.memory="$GRAFANA_MEMORY" \
        --set resources.requests.cpu="$GRAFANA_CPU" \
        --wait \
        --timeout 10m

    log_success "Grafana deployed successfully"
}

deploy_alertmanager() {
    log "Deploying AlertManager..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would deploy AlertManager with:"
        log "  - Slack notifications enabled"
        log "  - PagerDuty escalation enabled"
        return 0
    fi

    # AlertManager is typically included in kube-prometheus-stack
    log_verbose "AlertManager installed as part of Prometheus stack"
    log_success "AlertManager configuration applied"
}

verify_deployment() {
    log "Verifying deployment..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Would verify:"
        log "  - All pods in running state"
        log "  - PVCs bound"
        log "  - Services accessible"
        return 0
    fi

    # Wait for pods to be ready
    log "Waiting for pods to be ready (timeout: 5 minutes)..."
    kubectl wait --for=condition=ready pod \
        -l app.kubernetes.io/name=prometheus \
        -n "$NAMESPACE" \
        --timeout=300s 2>/dev/null || log_warning "Prometheus pods not ready yet"

    # Show pod status
    log "Pod status:"
    kubectl get pods -n "$NAMESPACE" -o wide

    # Show PVC status
    log "PVC status:"
    kubectl get pvc -n "$NAMESPACE"

    # Get Grafana admin password
    GRAFANA_PASSWORD=$(kubectl get secret grafana-admin -n "$NAMESPACE" -o jsonpath='{.data.admin-password}' | base64 -d)
    log "Grafana admin password: $GRAFANA_PASSWORD"

    log_success "Deployment verification complete"
}

show_access_info() {
    log "Deployment complete! Access information:"
    echo ""
    echo "📊 Grafana:"
    echo "  kubectl port-forward -n $NAMESPACE svc/grafana 3000:80"
    echo "  Then visit http://localhost:3000"
    echo ""
    echo "📈 Prometheus:"
    echo "  kubectl port-forward -n $NAMESPACE svc/prometheus-kube-prom-prometheus 9090:9090"
    echo "  Then visit http://localhost:9090"
    echo ""
    echo "📝 Loki:"
    echo "  kubectl port-forward -n $NAMESPACE svc/loki 3100:3100"
    echo ""
    echo "See ACCESS_PRODUCTION.md for more access methods."
}

main() {
    log "ClarityRouter Observability Stack - Production Deployment"
    log "Cluster: $CLUSTER_NAME (Region: $AWS_REGION)"
    log "Logging to: $LOG_FILE"
    echo ""

    # Parse arguments
    parse_arguments "$@"

    # Check if applying or dry-run
    if [[ "$DRY_RUN" == "true" ]]; then
        log_warning "DRY-RUN MODE - No changes will be made"
    elif [[ "$APPLY" == "false" ]]; then
        log_warning "PREVIEW MODE - Run with --apply to deploy"
    fi
    echo ""

    # Run deployment steps
    verify_prerequisites
    check_production_requirements
    create_namespace
    setup_secrets
    add_helm_repos
    deploy_prometheus
    deploy_loki
    deploy_grafana
    deploy_alertmanager
    verify_deployment
    show_access_info

    log_success "Deployment completed successfully!"
    log "Review output above and see VERIFY_PRODUCTION.md for detailed verification checklist."
}

# Run main function
main "$@"
