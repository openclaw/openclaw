# Observability Stack Installation Guide - Staging Cluster
## Step-by-Step Installation Procedure

**Document Version:** 1.0  
**Target Cluster:** `clarity-router-staging` (us-west-2)  
**Estimated Duration:** 30-45 minutes  

---

## Overview

This guide provides detailed step-by-step instructions for deploying the complete observability stack to the staging cluster. Follow each step sequentially to ensure proper configuration and dependencies.

**Prerequisites:** Complete [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md) pre-flight checklist before proceeding.

---

## Step 1: Verify Prerequisites

### Verify Cluster Access

```bash
# Check kubectl context
kubectl config current-context
# Expected: arn:aws:eks:us-west-2:ACCOUNT_ID:cluster/clarity-router-staging

# Verify cluster connectivity
kubectl cluster-info
# Expected: Kubernetes control plane and other core services running

# List cluster nodes
kubectl get nodes -o wide
# Expected: 2-3 nodes in Ready state
```

### Verify Kubernetes Version

```bash
kubectl version --short
# Expected: Server version 1.28+ (EKS on 1.28 or higher)
```

### Verify Helm Installation

```bash
helm version --short
# Expected: v3.12+ (note: must use v3, not v2)

# Verify Helm repos are available
helm repo list
# Expected: prometheus-community, grafana, jetstack repos listed
```

---

## Step 2: Create Kubernetes Namespace and Labels

### Create the `monitoring` Namespace

```bash
# Create namespace (idempotent)
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

# Verify namespace created
kubectl get namespace monitoring
# Expected: STATUS = Active
```

### Label the Namespace

```bash
# Add labels for identification
kubectl label namespace monitoring app=monitoring --overwrite
kubectl label namespace monitoring environment=staging --overwrite

# Verify labels
kubectl get namespace monitoring -o jsonpath='{.metadata.labels}' | jq .
# Expected: {"app":"monitoring","environment":"staging"}
```

---

## Step 3: Create Kubernetes Secrets for AlertManager Webhooks

### Create Slack Webhook Secret

Before proceeding, obtain your Slack webhook URL:
- Go to Slack workspace → Settings → Apps & Integrations
- Create or find an Incoming Webhook
- Format: `https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX`

```bash
# Set Slack webhook URL (replace with your actual URL)
export SLACK_WEBHOOK="https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"

# Create secret
kubectl create secret generic alertmanager-webhooks \
  --from-literal=slack-webhook-url="$SLACK_WEBHOOK" \
  --from-literal=pagerduty-service-key="PLACEHOLDER_PAGERDUTY_SERVICE_KEY" \
  -n monitoring \
  --dry-run=client -o yaml | kubectl apply -f -

# Verify secret created
kubectl get secret alertmanager-webhooks -n monitoring
# Expected: TYPE = Opaque, DATA = 2
```

### Verify Secret Contents (Optional)

```bash
# View secret keys (not values)
kubectl get secret alertmanager-webhooks -n monitoring -o jsonpath='{.data}' | jq 'keys'
# Expected: ["pagerduty-service-key", "slack-webhook-url"]
```

---

## Step 4: Add Helm Repositories and Update

### Add Prometheus Community Repository

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts

# Verify added
helm repo list | grep prometheus-community
# Expected: prometheus-community https://prometheus-community.github.io/helm-charts
```

### Add Grafana Repository

```bash
helm repo add grafana https://grafana.github.io/helm-charts

# Verify added
helm repo list | grep grafana
# Expected: grafana https://grafana.github.io/helm-charts
```

### Add Jetstack Repository (cert-manager)

```bash
helm repo add jetstack https://charts.jetstack.io

# Verify added
helm repo list | grep jetstack
# Expected: jetstack https://charts.jetstack.io
```

### Update All Repositories

```bash
helm repo update
# Expected: Successfully got an update from the following repositories:
#   - prometheus-community
#   - grafana
#   - jetstack
```

---

## Step 5: Install cert-manager (TLS Certificate Management)

cert-manager is required for automatic TLS certificate provisioning.

### Create cert-manager Namespace

```bash
kubectl create namespace cert-manager --dry-run=client -o yaml | kubectl apply -f -
```

### Install cert-manager Helm Chart

```bash
helm install cert-manager jetstack/cert-manager \
  -n cert-manager \
  --set installCRDs=true \
  --wait \
  --timeout 5m

# Verify installation
kubectl get pods -n cert-manager
# Expected: cert-manager, cert-manager-cainjector, cert-manager-webhook pods running
```

---

## Step 6: Deploy Prometheus Stack

The kube-prometheus-stack includes:
- Prometheus (metrics collection)
- AlertManager (alert routing)
- kube-state-metrics (Kubernetes metrics)
- Prometheus Operator (custom resource management)

### Install Prometheus Stack

```bash
# Install with layered values (common + staging-specific)
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values infra/prometheus/values-common.yaml \
  --values infra/prometheus/values-staging.yaml \
  --wait \
  --timeout 10m

# Expected: release "prometheus-stack" installed
```

### Verify Prometheus Installation

```bash
# Check pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus
# Expected: prometheus-stack-kube-prom-prometheus-0 and -1 (2 replicas, Running)

# Check statefulset
kubectl get statefulset -n monitoring prometheus-stack-kube-prom-prometheus
# Expected: READY 2/2

# Wait for rollout (if needed)
kubectl rollout status statefulset/prometheus-stack-kube-prom-prometheus -n monitoring
```

### Verify AlertManager Installation

```bash
# Check AlertManager pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=alertmanager
# Expected: prometheus-stack-kube-prom-alertmanager-0 and -1 (2 replicas)

# Check AlertManager statefulset
kubectl get statefulset -n monitoring prometheus-stack-kube-prom-alertmanager
# Expected: READY 2/2
```

### Verify kube-state-metrics Installation

```bash
# Check kube-state-metrics pod
kubectl get pods -n monitoring -l app.kubernetes.io/name=kube-state-metrics
# Expected: prometheus-stack-kube-prom-kube-state-metrics pod (1 replica)
```

---

## Step 7: Deploy Loki Stack

Loki stack includes:
- Loki (log aggregation)
- Promtail (log shipper DaemonSet)

### Install Loki Stack

```bash
# Install Loki with layered values
helm install loki grafana/loki-stack \
  --namespace monitoring \
  --values infra/loki/values-common.yaml \
  --values infra/loki/values-staging.yaml \
  --wait \
  --timeout 10m

# Expected: release "loki" installed
```

### Verify Loki Installation

```bash
# Check Loki pods
kubectl get pods -n monitoring -l app=loki
# Expected: loki-0 and loki-1 (2 replicas, Running)

# Check statefulset
kubectl get statefulset -n monitoring loki
# Expected: READY 2/2
```

### Verify Promtail Installation

```bash
# Check Promtail DaemonSet (should run on all nodes)
kubectl get daemonset -n monitoring -l app=promtail
# Expected: promtail daemonset with READY = number of nodes

# Check Promtail pods
kubectl get pods -n monitoring -l app=promtail
# Expected: promtail-xxxxx pods (one per node, all Running)
```

---

## Step 8: Deploy Grafana

Grafana provides visualization and alerting dashboards.

### Generate Grafana Admin Password

```bash
# Generate random 22-character password
ADMIN_PASSWORD=$(openssl rand -base64 22)
echo "Grafana Admin Password: $ADMIN_PASSWORD"

# Store securely (save to safe location, not in code/logs)
# Create Kubernetes secret
kubectl create secret generic grafana-admin-secret \
  --from-literal=password="$ADMIN_PASSWORD" \
  -n monitoring \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Install Grafana Helm Chart

```bash
# Install Grafana with layered values
helm install grafana grafana/grafana \
  --namespace monitoring \
  --values infra/grafana/values-common.yaml \
  --values infra/grafana/values-staging.yaml \
  --wait \
  --timeout 10m

# Expected: release "grafana" installed
```

### Verify Grafana Installation

```bash
# Check Grafana pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
# Expected: grafana-0 and grafana-1 (2 replicas, Running)

# Wait for rollout
kubectl rollout status deployment/grafana -n monitoring

# Verify service
kubectl get svc -n monitoring grafana
# Expected: Service with CLUSTER-IP assigned, port 3000
```

---

## Step 9: Apply Datasource Configurations

### Apply Prometheus & Loki Datasources ConfigMap

```bash
# Apply datasources for Grafana
kubectl apply -f infra/grafana/datasources-configmap.yaml -n monitoring

# Verify ConfigMap created
kubectl get configmap -n monitoring | grep grafana-datasources
# Expected: grafana-datasources ConfigMap listed

# View datasources content (optional)
kubectl get configmap grafana-datasources -n monitoring -o yaml | head -30
```

### Verify Datasources in Grafana

After port-forwarding Grafana (Step 10), verify datasources:
1. Navigate to Configuration → Data Sources
2. Verify both datasources listed:
   - prometheus-staging (Prometheus)
   - loki-staging (Loki)
3. Check "Test" button shows successful connection

---

## Step 10: Import Grafana Dashboards

### Apply Dashboard ConfigMaps

```bash
# Apply dashboard definitions
kubectl apply -f infra/grafana/dashboards-configmap.yaml -n monitoring

# Verify ConfigMap created
kubectl get configmap -n monitoring | grep grafana-dashboards
# Expected: grafana-dashboards ConfigMap listed
```

### Verify Dashboards Import

Dashboards are auto-discovered via ConfigMap label. To verify:

```bash
# Port-forward to Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000 &

# Open browser: http://localhost:3000
# Login: admin / $ADMIN_PASSWORD

# Navigate to Dashboards → Home
# Expected: 3 dashboards listed:
#   1. Router Health Overview
#   2. Performance Details
#   3. Infrastructure Health
```

---

## Step 11: Apply ServiceMonitors and PrometheusRules

### Apply ServiceMonitor for Router Metrics

```bash
# Apply ServiceMonitor (enables Prometheus to scrape router metrics)
kubectl apply -f infra/prometheus/servicemonitor-router.yaml -n monitoring

# Verify ServiceMonitor created
kubectl get servicemonitor -n monitoring
# Expected: servicemonitor.monitoring.coreos.com/clarityrouter-metrics listed

# Describe ServiceMonitor for debugging
kubectl describe servicemonitor clarityrouter-metrics -n monitoring
```

### Apply PrometheusRules for Alerts

```bash
# Apply alert and recording rules
kubectl apply -f infra/prometheus/prometheusrule-alerts.yaml -n monitoring

# Verify PrometheusRule created
kubectl get prometheusrule -n monitoring
# Expected: prometheusrule.monitoring.coreos.com/clarityrouter-rules listed

# Describe PrometheusRule
kubectl describe prometheusrule clarityrouter-rules -n monitoring
```

### Verify Prometheus Discovers ServiceMonitors

```bash
# Port-forward to Prometheus
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090 &

# Open browser: http://localhost:9090
# Navigate to Status → Service Discovery
# Expected: ServiceMonitors discovered and endpoints listed

# Check Targets tab
# Navigate to Status → Targets
# Expected: Targets showing up (may take 1-2 minutes for scrape to start)
```

---

## Step 12: Apply AlertManager Configuration

### Apply AlertManager Slack Integration

```bash
# Apply AlertManager configuration
kubectl apply -f infra/alertmanager/slack-integration.yaml -n monitoring

# Verify configuration applied
kubectl get configmap -n monitoring | grep alertmanager
# Expected: alertmanager ConfigMap listed
```

---

## Step 13: Verify All Components Running

### Check All Pods in Monitoring Namespace

```bash
# List all pods
kubectl get pods -n monitoring
# Expected output showing all these pods Running:
#   - prometheus-stack-kube-prom-prometheus-0, -1
#   - prometheus-stack-kube-prom-alertmanager-0, -1
#   - grafana-0, -1
#   - loki-0, -1
#   - promtail-xxxxx (multiple, one per node)
#   - prometheus-stack-kube-prom-kube-state-metrics-xxx
```

### Check All Services

```bash
# List all services in monitoring namespace
kubectl get svc -n monitoring
# Expected services:
#   - prometheus-stack-kube-prom-prometheus
#   - prometheus-stack-kube-prom-alertmanager
#   - grafana
#   - loki
#   - prometheus-stack-kube-prom-kube-state-metrics
```

### Check All PersistentVolumeClaims

```bash
# List PVCs
kubectl get pvc -n monitoring
# Expected: PVCs for Prometheus, Loki, Grafana all in Bound state

# Check PVC storage usage
kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  df -h /prometheus
# Expected: Shows mounted EFS with available capacity
```

---

## Step 14: Perform Basic Validation

### Test Prometheus Connectivity

```bash
# Port-forward to Prometheus
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090 &

# Query Prometheus API
curl http://localhost:9090/api/v1/query?query=up
# Expected: JSON response with metric results
```

### Test Loki Connectivity

```bash
# Test Loki from within cluster
kubectl run -it --rm --restart=Never --image=alpine:latest loki-test -- \
  wget -O - http://loki.monitoring:3100/loki/api/v1/status/buildinfo

# Expected: HTTP 200 with Loki build info
```

### Test AlertManager Connectivity

```bash
# Port-forward to AlertManager
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093 &

# Query AlertManager API
curl http://localhost:9093/api/v1/status
# Expected: JSON response with AlertManager status
```

---

## Step 15: Next Steps & Verification

### Review Verification Checklist

After installation, proceed to [`VERIFY_STAGING.md`](VERIFY_STAGING.md) for comprehensive verification of:
- All pods running and ready
- Prometheus scraping metrics
- Grafana dashboards displaying data
- Loki receiving logs
- AlertManager routing configured
- Test alert firing

### Access Components

See [`ACCESS_STAGING.md`](ACCESS_STAGING.md) for detailed instructions on:
- Port-forwarding to each component
- Accessing Grafana dashboards
- Querying Prometheus metrics
- Viewing logs in Loki
- Checking AlertManager status

### Monitor Deployment Status

```bash
# Real-time monitoring of deployment
bash infra/status-staging.sh
```

---

## Troubleshooting During Installation

### Pod Not Starting / CrashLoopBackOff

```bash
# Check pod logs
kubectl logs -n monitoring <pod-name> --tail=50

# Describe pod for events
kubectl describe pod -n monitoring <pod-name>

# Check resource limits/requests
kubectl describe pod -n monitoring <pod-name> | grep -A 5 "Limits\|Requests"
```

### PVC Stuck in Pending

```bash
# Check PVC status
kubectl describe pvc -n monitoring <pvc-name>

# Verify EFS CSI driver
kubectl get pods -n kube-system -l app=efs-csi-controller

# Check CSI driver logs
kubectl logs -n kube-system -l app=efs-csi-controller | grep error
```

### Helm Install Timeout

```bash
# Increase timeout and re-run
helm install <release> <chart> \
  -n monitoring \
  --wait \
  --timeout 15m

# Or check pod events
kubectl describe pod -n monitoring <pod-name>
```

### Cannot Connect to Services

```bash
# Verify services exist
kubectl get svc -n monitoring

# Test DNS resolution from pod
kubectl run -it --rm --restart=Never --image=alpine:latest dns-test -- \
  nslookup prometheus-stack-kube-prom-prometheus.monitoring

# Check network policies (if any)
kubectl get networkpolicy -n monitoring
```

---

## Rollback if Needed

If installation fails or needs to be reverted:

```bash
# See detailed rollback instructions: infra/ROLLBACK_STAGING.md

# Quick uninstall:
helm uninstall prometheus-stack -n monitoring
helm uninstall loki -n monitoring
helm uninstall grafana -n monitoring
helm uninstall cert-manager -n cert-manager

# Remove secrets
kubectl delete secret alertmanager-webhooks -n monitoring
kubectl delete secret grafana-admin-secret -n monitoring

# Remove namespace (WARNING: Deletes all resources)
# kubectl delete namespace monitoring
```

---

## Monitoring Installation Progress

### Watch Pods Coming Up

```bash
# Terminal 1: Watch pods
kubectl get pods -n monitoring -w

# Terminal 2: Watch events
kubectl get events -n monitoring -w

# Terminal 3: Check logs for specific pod
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus -f
```

### Check Resource Usage During Installation

```bash
# Monitor node resources
kubectl top nodes

# Monitor pod resources (after kubelet metrics available)
kubectl top pods -n monitoring
```

---

## Performance Notes

- **First data collection:** Prometheus will start scraping after 1-2 minutes
- **Dashboard refresh:** Grafana dashboards may show "No data" for first 5-10 minutes while metrics are collected
- **Log ingestion:** Promtail begins shipping logs immediately; Loki indexes over next 1-2 minutes
- **Alert evaluation:** Alert rules evaluated every 30 seconds after Prometheus starts

---

## Documentation References

- **Architecture Design:** [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- **Prometheus Setup:** [`infra/prometheus/README.md`](prometheus/README.md)
- **Grafana Setup:** [`infra/grafana/README.md`](grafana/README.md)
- **Loki Setup:** [`infra/loki/README.md`](loki/README.md)
- **Pre-Flight Checklist:** [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md)
- **Verification Checklist:** [`VERIFY_STAGING.md`](VERIFY_STAGING.md)
- **Access Instructions:** [`ACCESS_STAGING.md`](ACCESS_STAGING.md)
