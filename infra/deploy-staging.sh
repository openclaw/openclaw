#!/bin/bash

################################################################################
# Observability Stack Deployment Script for Staging Cluster
# 
# Purpose: Automate deployment of Prometheus, Grafana, Loki, AlertManager
#          to clarity-router-staging cluster (us-west-2)
#
# Usage: bash deploy-staging.sh [--slack-webhook <url>] [--dry-run]
#
# Prerequisites:
#   - kubectl configured for clarity-router-staging context
#   - Helm 3.12+ installed
#   - Slack webhook URL for AlertManager notifications
#   - EFS FileSystem created and mounted in cluster
#
# Environment:
#   SLACK_WEBHOOK_URL - Slack webhook for AlertManager (prompt if not set)
#   DRY_RUN           - If "true", run in dry-run mode (no actual deployment)
#
################################################################################

set -e

# Color output for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CLUSTER_NAME="clarity-router-staging"
CLUSTER_REGION="us-west-2"
NAMESPACE="monitoring"
DEPLOYMENT_TIMEOUT="10m"
DRY_RUN="${DRY_RUN:-false}"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check kubectl
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl not found. Please install kubectl."
        exit 1
    fi
    log_success "kubectl found: $(kubectl version --short 2>/dev/null | head -1)"
    
    # Check helm
    if ! command -v helm &> /dev/null; then
        log_error "helm not found. Please install Helm 3.12+."
        exit 1
    fi
    log_success "helm found: $(helm version --short)"
    
    # Check cluster context
    CURRENT_CONTEXT=$(kubectl config current-context)
    if [[ ! "$CURRENT_CONTEXT" =~ "$CLUSTER_NAME" ]]; then
        log_error "kubectl context is not set to staging cluster. Current: $CURRENT_CONTEXT"
        log_info "Run: aws eks update-kubeconfig --region $CLUSTER_REGION --name $CLUSTER_NAME"
        exit 1
    fi
    log_success "kubectl context: $CURRENT_CONTEXT"
    
    # Check cluster connectivity
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to cluster. Check kubeconfig and cluster status."
        exit 1
    fi
    log_success "Cluster connectivity verified"
    
    # Check nodes
    NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
    if [ "$NODE_COUNT" -lt 2 ]; then
        log_warning "Only $NODE_COUNT node(s) found. Recommended: 2-3"
    else
        log_success "Nodes ready: $NODE_COUNT"
    fi
    
    # Check EFS CSI driver
    EFS_CSI_PODS=$(kubectl get pods -n kube-system -l app=efs-csi-controller --no-headers 2>/dev/null | wc -l)
    if [ "$EFS_CSI_PODS" -eq 0 ]; then
        log_error "EFS CSI driver not found. Install with: helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver -n kube-system"
        exit 1
    fi
    log_success "EFS CSI driver found"
    
    # Check StorageClass
    if ! kubectl get storageclass efs-sc &> /dev/null; then
        log_error "StorageClass 'efs-sc' not found. Check cluster storage configuration."
        exit 1
    fi
    log_success "StorageClass 'efs-sc' found"
    
    log_success "All prerequisites verified"
    echo ""
}

# Parse command-line arguments
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --slack-webhook)
                SLACK_WEBHOOK_URL="$2"
                shift 2
                ;;
            --dry-run)
                DRY_RUN="true"
                shift
                ;;
            *)
                log_error "Unknown argument: $1"
                echo "Usage: $0 [--slack-webhook <url>] [--dry-run]"
                exit 1
                ;;
        esac
    done
}

# Prompt for Slack webhook if not provided
prompt_slack_webhook() {
    if [ -z "$SLACK_WEBHOOK_URL" ]; then
        log_warning "Slack webhook URL not provided"
        echo -n "Enter Slack webhook URL (or press Enter to use placeholder): "
        read -r SLACK_WEBHOOK_URL
        
        if [ -z "$SLACK_WEBHOOK_URL" ]; then
            SLACK_WEBHOOK_URL="https://hooks.slack.com/services/PLACEHOLDER/PLACEHOLDER/PLACEHOLDER"
            log_warning "Using placeholder Slack webhook URL"
        fi
    fi
    
    # Validate webhook URL format
    if [[ ! "$SLACK_WEBHOOK_URL" =~ ^https://hooks.slack.com/services/ ]]; then
        log_warning "Slack webhook URL may be invalid: $SLACK_WEBHOOK_URL"
    fi
}

# Create or verify monitoring namespace
setup_namespace() {
    log_info "Setting up monitoring namespace..."
    
    if kubectl get namespace $NAMESPACE &> /dev/null; then
        log_success "Namespace '$NAMESPACE' already exists"
    else
        log_info "Creating namespace '$NAMESPACE'..."
        if [ "$DRY_RUN" = "true" ]; then
            log_info "[DRY-RUN] kubectl create namespace $NAMESPACE"
        else
            kubectl create namespace $NAMESPACE
        fi
        log_success "Namespace created"
    fi
    
    # Label namespace
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] kubectl label namespace $NAMESPACE app=monitoring --overwrite"
    else
        kubectl label namespace $NAMESPACE app=monitoring --overwrite
    fi
    
    echo ""
}

# Create Kubernetes secrets for AlertManager webhooks
setup_secrets() {
    log_info "Creating Kubernetes secrets for AlertManager..."
    
    SECRET_NAME="alertmanager-webhooks"
    
    # Check if secret already exists
    if kubectl get secret $SECRET_NAME -n $NAMESPACE &> /dev/null; then
        log_warning "Secret '$SECRET_NAME' already exists. Skipping..."
        return
    fi
    
    # Create secret
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] kubectl create secret generic $SECRET_NAME \\"
        log_info "  --from-literal=slack-webhook-url='$SLACK_WEBHOOK_URL' \\"
        log_info "  --from-literal=pagerduty-service-key='PLACEHOLDER_PAGERDUTY_KEY' \\"
        log_info "  -n $NAMESPACE"
    else
        kubectl create secret generic $SECRET_NAME \
            --from-literal=slack-webhook-url="$SLACK_WEBHOOK_URL" \
            --from-literal=pagerduty-service-key="PLACEHOLDER_PAGERDUTY_SERVICE_KEY" \
            -n $NAMESPACE
        log_success "Secret created"
    fi
    
    echo ""
}

# Add Helm repositories
setup_helm_repos() {
    log_info "Adding Helm repositories..."
    
    REPOS=(
        "prometheus-community https://prometheus-community.github.io/helm-charts"
        "grafana https://grafana.github.io/helm-charts"
        "jetstack https://charts.jetstack.io"
    )
    
    for repo in "${REPOS[@]}"; do
        NAME=$(echo $repo | cut -d' ' -f1)
        URL=$(echo $repo | cut -d' ' -f2)
        
        if helm repo list 2>/dev/null | grep -q "^$NAME"; then
            log_success "Helm repo '$NAME' already added"
        else
            log_info "Adding Helm repo '$NAME'..."
            if [ "$DRY_RUN" = "true" ]; then
                log_info "[DRY-RUN] helm repo add $NAME $URL"
            else
                helm repo add $NAME $URL
            fi
        fi
    done
    
    # Update repos
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] helm repo update"
    else
        helm repo update
    fi
    log_success "Helm repositories ready"
    
    echo ""
}

# Install cert-manager (dependency for TLS)
install_cert_manager() {
    log_info "Installing cert-manager (TLS certificate management)..."
    
    # Check if cert-manager is already installed
    if helm list -n cert-manager 2>/dev/null | grep -q cert-manager; then
        log_success "cert-manager already installed"
        return
    fi
    
    # Create cert-manager namespace
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] kubectl create namespace cert-manager"
        log_info "[DRY-RUN] helm install cert-manager jetstack/cert-manager -n cert-manager --wait"
    else
        kubectl create namespace cert-manager --dry-run=client -o yaml | kubectl apply -f -
        helm install cert-manager jetstack/cert-manager \
            -n cert-manager \
            --set installCRDs=true \
            --wait \
            --timeout $DEPLOYMENT_TIMEOUT
        log_success "cert-manager installed"
    fi
    
    echo ""
}

# Install Prometheus stack (includes Prometheus, AlertManager, kube-state-metrics)
install_prometheus_stack() {
    log_info "Installing Prometheus stack (Prometheus + AlertManager + kube-state-metrics)..."
    
    RELEASE_NAME="prometheus-stack"
    
    # Check if already installed
    if helm list -n $NAMESPACE 2>/dev/null | grep -q $RELEASE_NAME; then
        log_warning "Prometheus stack already installed. Upgrade instead..."
        INSTALL_CMD="upgrade"
    else
        INSTALL_CMD="install"
    fi
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] helm $INSTALL_CMD $RELEASE_NAME prometheus-community/kube-prometheus-stack \\"
        log_info "  -n $NAMESPACE \\"
        log_info "  --values infra/prometheus/values-common.yaml \\"
        log_info "  --values infra/prometheus/values-staging.yaml \\"
        log_info "  --wait --timeout $DEPLOYMENT_TIMEOUT"
    else
        helm $INSTALL_CMD $RELEASE_NAME prometheus-community/kube-prometheus-stack \
            -n $NAMESPACE \
            --values infra/prometheus/values-common.yaml \
            --values infra/prometheus/values-staging.yaml \
            --wait \
            --timeout $DEPLOYMENT_TIMEOUT
        log_success "Prometheus stack installed/updated"
    fi
    
    echo ""
}

# Install Loki stack (includes Loki + Promtail)
install_loki_stack() {
    log_info "Installing Loki stack (Loki + Promtail)..."
    
    RELEASE_NAME="loki"
    
    # Check if already installed
    if helm list -n $NAMESPACE 2>/dev/null | grep -q $RELEASE_NAME; then
        log_warning "Loki already installed. Upgrade instead..."
        INSTALL_CMD="upgrade"
    else
        INSTALL_CMD="install"
    fi
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] helm $INSTALL_CMD $RELEASE_NAME grafana/loki-stack \\"
        log_info "  -n $NAMESPACE \\"
        log_info "  --values infra/loki/values-common.yaml \\"
        log_info "  --values infra/loki/values-staging.yaml \\"
        log_info "  --wait --timeout $DEPLOYMENT_TIMEOUT"
    else
        helm $INSTALL_CMD $RELEASE_NAME grafana/loki-stack \
            -n $NAMESPACE \
            --values infra/loki/values-common.yaml \
            --values infra/loki/values-staging.yaml \
            --wait \
            --timeout $DEPLOYMENT_TIMEOUT
        log_success "Loki stack installed/updated"
    fi
    
    echo ""
}

# Install Grafana
install_grafana() {
    log_info "Installing Grafana..."
    
    RELEASE_NAME="grafana"
    
    # Generate admin password if not already created
    ADMIN_PASSWORD=$(kubectl get secret grafana-admin-secret -n $NAMESPACE -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo "")
    if [ -z "$ADMIN_PASSWORD" ]; then
        ADMIN_PASSWORD=$(openssl rand -base64 22)
        
        if [ "$DRY_RUN" = "false" ]; then
            kubectl create secret generic grafana-admin-secret \
                --from-literal=password="$ADMIN_PASSWORD" \
                -n $NAMESPACE \
                --dry-run=client -o yaml | kubectl apply -f -
            log_success "Grafana admin password: $ADMIN_PASSWORD"
        fi
    fi
    
    # Check if already installed
    if helm list -n $NAMESPACE 2>/dev/null | grep -q $RELEASE_NAME; then
        log_warning "Grafana already installed. Upgrade instead..."
        INSTALL_CMD="upgrade"
    else
        INSTALL_CMD="install"
    fi
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] helm $INSTALL_CMD $RELEASE_NAME grafana/grafana \\"
        log_info "  -n $NAMESPACE \\"
        log_info "  --values infra/grafana/values-common.yaml \\"
        log_info "  --values infra/grafana/values-staging.yaml \\"
        log_info "  --wait --timeout $DEPLOYMENT_TIMEOUT"
    else
        helm $INSTALL_CMD $RELEASE_NAME grafana/grafana \
            -n $NAMESPACE \
            --values infra/grafana/values-common.yaml \
            --values infra/grafana/values-staging.yaml \
            --wait \
            --timeout $DEPLOYMENT_TIMEOUT
        log_success "Grafana installed/updated"
    fi
    
    echo ""
}

# Apply Kubernetes manifests (datasources, dashboards, ServiceMonitors, PrometheusRules)
apply_manifests() {
    log_info "Applying Kubernetes manifests (datasources, dashboards, rules)..."
    
    MANIFESTS=(
        "infra/grafana/datasources-configmap.yaml"
        "infra/grafana/dashboards-configmap.yaml"
        "infra/prometheus/servicemonitor-router.yaml"
        "infra/prometheus/prometheusrule-alerts.yaml"
        "infra/alertmanager/slack-integration.yaml"
    )
    
    for manifest in "${MANIFESTS[@]}"; do
        if [ -f "$manifest" ]; then
            log_info "Applying $manifest..."
            if [ "$DRY_RUN" = "true" ]; then
                log_info "[DRY-RUN] kubectl apply -f $manifest -n $NAMESPACE"
            else
                kubectl apply -f "$manifest" -n $NAMESPACE
            fi
        else
            log_warning "Manifest not found: $manifest (skipping)"
        fi
    done
    
    log_success "Manifests applied"
    echo ""
}

# Wait for deployments to be ready
wait_for_deployments() {
    log_info "Waiting for all deployments to be ready (timeout: $DEPLOYMENT_TIMEOUT)..."
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] Skipping deployment wait checks"
        return
    fi
    
    DEPLOYMENTS=(
        "prometheus-stack-kube-prom-prometheus"
        "grafana"
        "loki"
        "prometheus-stack-kube-prom-alertmanager"
    )
    
    for deployment in "${DEPLOYMENTS[@]}"; do
        log_info "Waiting for $deployment..."
        
        if kubectl get statefulset -n $NAMESPACE -l app.kubernetes.io/name=$deployment &> /dev/null; then
            kubectl rollout status statefulset -l app.kubernetes.io/name=$deployment -n $NAMESPACE --timeout=$DEPLOYMENT_TIMEOUT || true
        elif kubectl get deployment -n $NAMESPACE -l app.kubernetes.io/name=$deployment &> /dev/null; then
            kubectl rollout status deployment -l app.kubernetes.io/name=$deployment -n $NAMESPACE --timeout=$DEPLOYMENT_TIMEOUT || true
        fi
    done
    
    log_success "Deployments ready (or timeout reached)"
    echo ""
}

# Verify deployment
verify_deployment() {
    log_info "Verifying deployment..."
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] Skipping verification checks"
        return
    fi
    
    log_info "Checking pods in namespace '$NAMESPACE'..."
    POD_COUNT=$(kubectl get pods -n $NAMESPACE --no-headers 2>/dev/null | wc -l)
    RUNNING_PODS=$(kubectl get pods -n $NAMESPACE --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
    
    log_info "Pods: $RUNNING_PODS running out of $POD_COUNT total"
    
    log_info "Checking services in namespace '$NAMESPACE'..."
    kubectl get svc -n $NAMESPACE --no-headers 2>/dev/null || true
    
    log_success "Deployment verification complete"
    echo ""
}

# Print post-deployment instructions
print_completion_info() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Observability Stack Deployment Complete!"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    
    if [ "$DRY_RUN" = "true" ]; then
        log_warning "This was a DRY-RUN. No resources were actually deployed."
        echo "To perform actual deployment, run: bash infra/deploy-staging.sh"
        echo ""
    fi
    
    echo "Next Steps:"
    echo ""
    echo "1. Verify all components are running:"
    echo "   bash infra/status-staging.sh"
    echo ""
    echo "2. Access Prometheus:"
    echo "   kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090"
    echo "   Visit: http://localhost:9090"
    echo ""
    echo "3. Access Grafana:"
    echo "   kubectl port-forward -n monitoring svc/grafana 3000:3000"
    echo "   Visit: http://localhost:3000"
    echo "   Username: admin"
    echo "   Password: $(kubectl get secret grafana-admin-secret -n $NAMESPACE -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo '<check secret>')"
    echo ""
    echo "4. Review complete verification checklist:"
    echo "   See: infra/VERIFY_STAGING.md"
    echo ""
    echo "5. Access instructions for all components:"
    echo "   See: infra/ACCESS_STAGING.md"
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
}

# Main execution flow
main() {
    log_info "Starting Observability Stack Deployment to Staging Cluster"
    log_info "Cluster: $CLUSTER_NAME | Region: $CLUSTER_REGION | Namespace: $NAMESPACE"
    
    if [ "$DRY_RUN" = "true" ]; then
        log_warning "DRY-RUN MODE ENABLED - No resources will be modified"
    fi
    
    echo ""
    
    # Parse arguments
    parse_arguments "$@"
    
    # Prompt for Slack webhook
    prompt_slack_webhook
    
    # Execute deployment steps
    check_prerequisites
    setup_namespace
    setup_secrets
    setup_helm_repos
    install_cert_manager
    install_prometheus_stack
    install_loki_stack
    install_grafana
    apply_manifests
    wait_for_deployments
    verify_deployment
    print_completion_info
    
    log_success "Deployment script completed successfully"
}

# Run main function
main "$@"
