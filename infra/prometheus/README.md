# Prometheus Helm Configuration for ClarityRouter Observability

This directory contains Helm values and Kubernetes manifests for deploying Prometheus to monitor ClarityRouter in both production and staging EKS clusters.

## File Structure

```
infra/prometheus/
├── README.md                      # This file
├── values-common.yaml             # Shared Helm chart configuration
├── values-prod.yaml               # Production environment overrides (us-east-1)
├── values-staging.yaml            # Staging environment overrides (us-west-2)
├── servicemonitor-router.yaml     # ServiceMonitor for router metrics scraping
├── prometheusrule-alerts.yaml     # Recording and alert rules
└── pvc-storage.yaml               # Persistent volume claims (EFS storage)
```

## Prerequisites

Before deploying Prometheus, ensure the following prerequisites are met:

### Cluster Requirements
- **Kubernetes 1.28+** on EKS (both production and staging clusters)
- **Helm 3.12+** installed locally
- **kubectl** configured with access to both clusters

### AWS Infrastructure
- EFS file system created in production cluster (us-east-1)
- EFS file system created in staging cluster (us-west-2)
- EFS CSI driver installed on both clusters
- StorageClass `efs-sc` defined on both clusters
- Namespace `monitoring` created on both clusters

### Helm Repositories
```bash
# Add Prometheus Helm repository
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

## Configuration Overview

### Common Configuration (values-common.yaml)

Shared settings applied to both environments:

| Setting | Value | Purpose |
|---------|-------|---------|
| **Scrape Interval** | 30s | Collect metrics from targets every 30 seconds |
| **Scrape Timeout** | 15s | Wait up to 15 seconds for target response |
| **Evaluation Interval** | 30s | Evaluate alert/recording rules every 30 seconds |
| **Storage** | 100GB EFS | Time-series database (15-day retention) |
| **Replicas** | 2 | High availability deployment |
| **Pod Anti-Affinity** | Required | Spread replicas across separate nodes |
| **Resource Requests** | CPU: 1000m, Mem: 2Gi | Guaranteed resources |
| **Resource Limits** | CPU: 1500m, Mem: 3Gi | Maximum resource caps |

### Production Overrides (values-prod.yaml)

Production-specific configuration for us-east-1:

```yaml
externalLabels:
  cluster: "clarity-router-prod"
  environment: "production"
  region: "us-east-1"

alertmanager:
  route:
    - match: { severity: critical }
      receiver: "pagerduty-critical"      # Critical → PagerDuty escalation
      group_wait: 10s
      repeat_interval: 1h
    
    - match: { severity: warning }
      receiver: "slack-warnings"          # Warnings → Slack #monitoring-alerts
      group_wait: 1m
      repeat_interval: 6h
```

### Staging Overrides (values-staging.yaml)

Staging-specific configuration for us-west-2:

```yaml
externalLabels:
  cluster: "clarity-router-staging"
  environment: "staging"
  region: "us-west-2"

alertmanager:
  # All alerts route to Slack (no PagerDuty escalation)
  route:
    - match: { severity: critical }
      receiver: "slack-critical"
      group_wait: 30s
      repeat_interval: 6h
```

## Deployment Instructions

### Step 1: Create Monitoring Namespace

```bash
# Production cluster
kubectl config use-context clarity-router-prod
kubectl create namespace monitoring
kubectl label namespace monitoring app=monitoring

# Staging cluster
kubectl config use-context clarity-router-staging
kubectl create namespace monitoring
kubectl label namespace monitoring app=monitoring
```

### Step 2: Verify EFS Storage Prerequisites

```bash
# Check EFS CSI driver is running
kubectl get pods -n kube-system -l app=efs-csi-controller
kubectl get pods -n kube-system -l app=efs-csi-node

# Verify StorageClass exists
kubectl get storageclass efs-sc

# Expected output:
# NAME    PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE   ALLOWVOLUMEEXPANSION
# efs-sc  efs.csi.aws.com         Delete          Immediate           true
```

### Step 3: Deploy Storage PVCs

```bash
# Apply to both clusters
kubectl apply -f infra/prometheus/pvc-storage.yaml -n monitoring

# Verify PVCs are Bound
kubectl get pvc -n monitoring
# Expected: prometheus-storage, loki-storage, grafana-storage, alertmanager-storage (all Bound)
```

### Step 4: Create Secret for AlertManager Webhooks

Production cluster with PagerDuty:
```bash
kubectl create secret generic alertmanager-webhooks \
  --from-literal=slack-webhook-url='https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK' \
  --from-literal=pagerduty-service-key='YOUR_PAGERDUTY_SERVICE_KEY' \
  -n monitoring
```

Staging cluster (Slack only):
```bash
kubectl create secret generic alertmanager-webhooks \
  --from-literal=slack-webhook-url='https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK' \
  -n monitoring
```

### Step 5: Deploy Prometheus Stack

Install Prometheus using Helm with values merging:

```bash
# Production
kubectl config use-context clarity-router-prod

helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values infra/prometheus/values-common.yaml \
  --values infra/prometheus/values-prod.yaml \
  --wait

# Verify installation
kubectl rollout status statefulset/prometheus-stack-kube-prom-prometheus -n monitoring
```

```bash
# Staging
kubectl config use-context clarity-router-staging

helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values infra/prometheus/values-common.yaml \
  --values infra/prometheus/values-staging.yaml \
  --wait

# Verify installation
kubectl rollout status statefulset/prometheus-stack-kube-prom-prometheus -n monitoring
```

### Step 6: Apply Metrics Scraping Configuration

```bash
# Apply ServiceMonitor for router metrics
kubectl apply -f infra/prometheus/servicemonitor-router.yaml

# Verify ServiceMonitor is discovered
kubectl get servicemonitor -A
kubectl describe servicemonitor clarityrouter-metrics -n clarity-router
```

### Step 7: Apply Recording and Alert Rules

```bash
# Apply recording rules and alerts
kubectl apply -f infra/prometheus/prometheusrule-alerts.yaml -n monitoring

# Verify PrometheusRule is loaded
kubectl get prometheusrule -n monitoring
kubectl describe prometheusrule clarityrouter-rules -n monitoring
```

### Step 8: Verify Prometheus Configuration

```bash
# Port-forward to Prometheus
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090 &

# Visit http://localhost:9090 and check:
# 1. Status → Targets: Should show router and Kubernetes targets (green)
# 2. Alerts: Should show firing alerts for critical conditions
# 3. Rules: Should show recording rules (slo:clarityrouter_*)
# 4. Status → Configuration: Verify external labels and retention
```

## Helm Values Merging

The deployment uses **layered Helm values** for flexibility:

```bash
helm install ... \
  --values values-common.yaml \      # Base configuration
  --values values-prod.yaml           # Environment-specific overrides
```

**Merge order (last file wins):**
1. `values-common.yaml` - Shared settings
2. Environment-specific file (`values-prod.yaml` or `values-staging.yaml`)

**Example: How overrides work**
```yaml
# values-common.yaml
prometheus:
  prometheusSpec:
    retention: 15d

# values-prod.yaml (override not needed if same)
prometheus:
  prometheusSpec:
    externalLabels:
      cluster: "clarity-router-prod"  # ADDED to values-common settings
```

## Metrics Collection

### Router Metrics (clarityrouter)

ServiceMonitor `servicemonitor-router.yaml` scrapes:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `clarityrouter_request_latency_ms` | Histogram | method, endpoint | Request latency distribution |
| `clarityrouter_requests_total` | Counter | status, job | Total requests (success/error) |
| `clarityrouter_errors_total` | Counter | error_type, stage | Errors by failure category |
| `clarityrouter_router_availability` | Gauge | - | Binary health (0=down, 1=up) |
| `go_*` | Various | - | Go runtime metrics (memory, goroutines) |
| `process_*` | Various | - | Process metrics (CPU, file handles) |

### Kubernetes Metrics (included in chart)

Automatically scraped via `prometheus-community/kube-prometheus-stack`:

- **kube-state-metrics**: Pod, Deployment, StatefulSet, Job status
- **node-exporter**: CPU, Memory, Disk, Network per node
- **kubelet**: Container metrics, PVC usage, probe results
- **kube-apiserver**: API server health, request latencies

## Recording Rules (Computed SLO Metrics)

PrometheusRule `prometheusrule-alerts.yaml` defines:

### 5-Minute Averages
```promql
# Latency percentiles
slo:clarityrouter_latency_p50:5m    # Median latency
slo:clarityrouter_latency_p95:5m    # 95th percentile
slo:clarityrouter_latency_p99:5m    # 99th percentile (SLO target: <200ms)

# Availability
slo:clarityrouter_availability:5m   # % successful requests (SLO: >99.95%)

# Error rate
slo:clarityrouter_error_rate:5m     # % failed requests (threshold: <1%)

# Throughput
slo:clarityrouter_rps:5m            # Requests per second
```

### 1-Hour Averages (Trend Analysis)
```promql
slo:clarityrouter_latency_p99:1h
slo:clarityrouter_availability:1h
```

## Alert Rules (Operational Notifications)

### Critical Severity (PagerDuty in production)
| Alert | Threshold | Window | Action |
|-------|-----------|--------|--------|
| **RouterUnavailable** | Availability = 0 | 2 min | Immediate escalation |
| **LatencySLOBreach** | P99 > 250ms | 5 min | Investigate performance |
| **HighErrorRate** | Error % > 1.0 | 2 min | Investigate failures |
| **AllPodsDown** | 0 running pods | 1 min | Manual intervention |
| **NodeCPUExhaustion** | CPU > 95% | 5 min | Capacity planning |

### Warning Severity (Slack in both environments)
| Alert | Threshold | Window | Action |
|-------|-----------|--------|--------|
| **LatencyDegraded** | P99 > 200ms | 10 min | Monitor for escalation |
| **ElevatedErrorRate** | Error % > 0.5 | 5 min | Root cause analysis |
| **CertificateExpiryWarning** | <7 days | - | Schedule renewal |
| **PodRestartLoop** | >3 restarts/1h | - | Check logs |
| **HighCPUUsage** | CPU > 80% | 10 min | Resource planning |
| **HighMemoryUsage** | Memory > 800MB | 10 min | Detect memory leaks |
| **DiskUsageHigh** | Disk > 85% | 10 min | Cleanup old data |
| **PVCUsageHigh** | PVC > 80% | 10 min | Resize storage |

## Helm Update/Upgrade

To update Prometheus configuration after deployment:

```bash
# Production
helm upgrade prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values infra/prometheus/values-common.yaml \
  --values infra/prometheus/values-prod.yaml

# Staging
helm upgrade prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values infra/prometheus/values-common.yaml \
  --values infra/prometheus/values-staging.yaml
```

## Verification Checklist

After deployment, verify each component:

### Prometheus Pod Status
```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus
# Expected: 2 running Prometheus replicas
```

### Prometheus Targets
```bash
# Port-forward to Prometheus UI
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090

# Visit http://localhost:9090/targets
# Expected:
# - clarityrouter (from ServiceMonitor)
# - kube-state-metrics (running)
# - kubelet (3 nodes)
# - node-exporter (3 nodes)
# - prometheus (self)
# - alertmanager
```

### Scraped Metrics
```bash
# Query for router metrics
curl 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total'

# Should return active series from router pods
```

### Recording Rules
```bash
# Query for SLO metrics (should exist after 1+ minute)
curl 'http://localhost:9090/api/v1/query?query=slo:clarityrouter_latency_p99:5m'
curl 'http://localhost:9090/api/v1/query?query=slo:clarityrouter_availability:5m'
```

### Alert Rules
```bash
# View active alerts
curl http://localhost:9090/api/v1/alerts

# View alert rules configuration
kubectl get prometheusrule -n monitoring
```

### AlertManager Status
```bash
# Port-forward to AlertManager
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093

# Visit http://localhost:9093 to see alerts and routing configuration
```

## Troubleshooting

### Issue: ServiceMonitor not discovered by Prometheus

**Symptoms**: Router targets not appearing in Prometheus targets list

**Resolution**:
```bash
# 1. Check ServiceMonitor label matches Prometheus selector
kubectl get servicemonitor -n clarity-router -o yaml | grep labels: -A3

# 2. Verify Prometheus selector includes the label
kubectl get prometheus -n monitoring -o yaml | grep serviceMonitorSelector -A3

# 3. Restart Prometheus to pick up new ServiceMonitor
kubectl rollout restart statefulset/prometheus-stack-kube-prom-prometheus -n monitoring

# 4. Wait for targets to appear (up to 1 minute)
```

### Issue: PVC remains Pending

**Symptoms**: PVC stuck in Pending state

**Resolution**:
```bash
# Check PVC status
kubectl describe pvc prometheus-storage -n monitoring

# Verify EFS CSI driver is running
kubectl get pods -n kube-system -l app=efs-csi-controller

# Check CSI controller logs
kubectl logs -n kube-system -l app=efs-csi-controller | grep error

# Verify EFS mount targets exist in AWS
aws efs describe-mount-targets --file-system-id fs-xxxxx
```

### Issue: High memory/CPU usage

**Symptoms**: Prometheus pod uses excessive resources

**Resolution**:
```bash
# Check retention is configured correctly
kubectl get prometheus -n monitoring -o yaml | grep retention

# Verify storage isn't full
kubectl exec prometheus-0 -n monitoring -- df -h /prometheus

# Check for misbehaving scrape targets (high cardinality)
# In Prometheus UI: Status → TSDB
# Look for high series count or labels explosion
```

### Issue: Alerts not firing

**Symptoms**: No alerts appear even when conditions are met

**Resolution**:
```bash
# Verify PrometheusRule exists and is valid
kubectl get prometheusrule -n monitoring
kubectl get prometheusrule clarityrouter-rules -n monitoring -o yaml

# Check alert rule syntax
# Alert expressions should reference metrics that exist

# Restart Prometheus
kubectl rollout restart statefulset/prometheus-stack-kube-prom-prometheus -n monitoring
```

## Performance Tuning

### For High-Cardinality Metrics

If Prometheus uses excessive memory or storage:

```yaml
# Add metric relabeling to drop high-cardinality labels
servicemonitor-router.yaml:
  metricRelabelings:
    - sourceLabels: [__name__]
      regex: "go_.*_labels"
      action: drop  # Drop high-cardinality Go runtime labels
```

### For Large Deployments (>100 targets)

```yaml
# Increase Prometheus resources
values-prod.yaml:
  prometheus:
    prometheusSpec:
      resources:
        requests:
          cpu: 2000m    # 2 cores
          memory: 4Gi   # 4GB
        limits:
          cpu: 3000m    # 3 cores
          memory: 6Gi   # 6GB
```

### For Query Performance

```yaml
# Enable query result caching (if using Prometheus 2.42+)
prometheus:
  prometheusSpec:
    additionalFlags:
      - --query.max-samples=1000000    # Increase max samples per query
      - --query.timeout=2m              # Increase query timeout
```

## Cost Estimation

| Component | Production (mo.) | Staging (mo.) | Total |
|-----------|---|---|---|
| EFS Storage (Prometheus 100GB) | $5.00 | $5.00 | $10.00 |
| EFS Storage (Loki 150GB) | $7.50 | $7.50 | $15.00 |
| EFS Storage (Grafana 10GB) | $0.50 | $0.50 | $1.00 |
| EFS Data Transfer | $1.00 | $0.50 | $1.50 |
| **Total Storage** | **$13.50** | **$13.50** | **~$27/month** |

*Note: EC2 nodes and EKS control plane costs excluded (included in cluster budget)*

## Next Steps

1. **Deploy Grafana** (separate chart): `infra/grafana/values.yaml`
2. **Deploy Loki** for log aggregation: `infra/loki/values.yaml`
3. **Import Dashboards** into Grafana
4. **Configure Alert Notifications** to PagerDuty/Slack
5. **Test Alert Firing** by simulating failures
6. **Document Runbooks** for common alerts
7. **Setup Backup/Restore** procedures for EFS snapshots

## References

- [Prometheus Helm Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [ServiceMonitor API](https://prometheus-operator.dev/docs/operator/latest/api/#monitoring.coreos.com/v1.ServiceMonitor)
- [PrometheusRule API](https://prometheus-operator.dev/docs/operator/latest/api/#monitoring.coreos.com/v1.PrometheusRule)
- [AWS EFS CSI Driver](https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html)
