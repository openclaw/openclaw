# Access Instructions - Observability Stack Components
## Staging Cluster (`clarity-router-staging`, us-west-2)

**Document Version:** 1.0  
**Last Updated:** February 15, 2026  

---

## Overview

This document provides detailed instructions for accessing and interacting with each observability stack component deployed in the staging cluster.

---

## Prerequisites

- kubectl configured with access to `clarity-router-staging` cluster
- Port forwarding capability (local development machines)
- Web browser for UI components (Grafana, Prometheus, AlertManager)

---

## Port Forwarding Setup

All observability components run in the `monitoring` namespace and are accessed via port-forwarding or internal DNS names.

### Enable Multiple Port Forwards (Terminal Sessions)

To access multiple components simultaneously, open separate terminal sessions for each port-forward:

```bash
# Terminal 1: Prometheus
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090

# Terminal 2: Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000

# Terminal 3: Loki (optional, accessed via Grafana)
# Not needed if accessing via Grafana Explore

# Terminal 4: AlertManager
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093
```

### Alternative: Use Background Sessions

```bash
# Start all port-forwards in background
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090 &
kubectl port-forward -n monitoring svc/grafana 3000:3000 &
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093 &

# Kill all background jobs
kill %1 %2 %3
# Or: pkill -f "kubectl port-forward"
```

---

## Prometheus

### Access Prometheus UI

```bash
# 1. Start port-forward
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090

# 2. Open browser
# URL: http://localhost:9090
```

### Prometheus Web Interface Overview

| Section | Purpose | Key Information |
|---------|---------|-----------------|
| **Graph** | Query metrics & visualize | Main PromQL query interface |
| **Status** | System information | Configuration, targets, rules |
| **Alerts** | Active alerts | Firing alerts & silence rules |
| **Metrics** | Available metrics | Browse all scraped metrics |
| **Targets** | Scrape targets | Per-job target status |
| **Service Discovery** | Target discovery | ServiceMonitor details |

### Common Prometheus Queries

#### System Availability
```promql
# Overall cluster availability
up

# Router availability (if deployed)
clarityrouter_router_availability

# Pod running status
kube_pod_status_phase{phase="Running"}
```

#### Performance Metrics
```promql
# Request latency P99
histogram_quantile(0.99, rate(clarityrouter_request_latency_ms[5m]))

# Request throughput
rate(clarityrouter_requests_total[5m])

# Error rate
rate(clarityrouter_errors_total[5m])
```

#### System Metrics
```promql
# Node CPU utilization
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Node memory usage
1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# Pod CPU usage
rate(container_cpu_usage_seconds_total[5m])
```

### Prometheus API Access

```bash
# Query API (examples)
curl 'http://localhost:9090/api/v1/query?query=up'
curl 'http://localhost:9090/api/v1/query_range?query=up&start=1609459200&end=1609545600&step=3600'

# Get available metrics
curl 'http://localhost:9090/api/v1/label/__name__/values'

# Get targets
curl 'http://localhost:9090/api/v1/targets'

# Get alerts
curl 'http://localhost:9090/api/v1/alerts'
```

---

## Grafana

### Access Grafana UI

```bash
# 1. Start port-forward
kubectl port-forward -n monitoring svc/grafana 3000:3000

# 2. Open browser
# URL: http://localhost:3000

# 3. Login with credentials
# Username: admin
# Password: (see below)
```

### Get Grafana Admin Password

```bash
# Retrieve from Kubernetes secret
kubectl get secret grafana-admin-secret -n monitoring \
  -o jsonpath='{.data.password}' | base64 -d
# Output: <22-character password>
```

### Grafana Web Interface Overview

| Section | Purpose | Access |
|---------|---------|--------|
| **Home** | Dashboard selection | Left sidebar → Home or click logo |
| **Dashboards** | View saved dashboards | Left sidebar → Dashboards → Manage |
| **Explore** | Ad-hoc metric queries | Left sidebar → Explore |
| **Alerts** | Alert management | Left sidebar → Alerting → Alert Rules |
| **Configuration** | Datasources, users, etc. | Left sidebar → Configuration |
| **Administration** | System settings | Left sidebar → Administration |

### Available Dashboards

#### 1. Router Health Overview
**Purpose:** At-a-glance operational status  
**Access:** Dashboards → Manage → "Router Health Overview"

**Key Panels:**
- Availability Gauge (SLO: >99.95%)
- P99 Latency Stat (SLO: <200ms)
- Error Rate % Stat (SLO: <1%)
- Request Throughput (graph)
- Running Pods (stat)
- Pod Status (table)
- Error Rate Trend (graph)
- P50/P95/P99 Heatmap
- Pod Restarts (table)
- Active Alerts (table)

#### 2. Performance Details
**Purpose:** Deep-dive performance debugging  
**Access:** Dashboards → Manage → "Performance Details"

**Key Panels:**
- Latency Heatmap (histogram buckets)
- Error Types Breakdown (by error_type)
- Top 10 Slowest Endpoints
- Top 10 Highest Error Rate
- Pod CPU Usage
- Pod Memory Usage
- Network I/O Per Pod
- Goroutine Count
- Heap Allocation
- Live Request Count

#### 3. Infrastructure Health
**Purpose:** Cluster resource utilization  
**Access:** Dashboards → Manage → "Infrastructure Health"

**Key Panels:**
- Node CPU Usage (gauges)
- Node Memory Usage (gauges)
- Node Disk Usage (gauges)
- PVC Usage % (tables)
- Certificate Expiry (days)
- CPU/Memory/Disk Trends (graphs)
- Disk I/O Latency
- Network I/O Per Node
- Pod Restart Count (table)
- Kubelet/Container Runtime Errors

### Query Metrics in Grafana Explore

**Access:** Left sidebar → Explore

```
1. Select datasource: "prometheus-staging"
2. In query box, enter PromQL:
   - up
   - clarityrouter_requests_total
   - histogram_quantile(0.99, clarityrouter_request_latency_ms)
3. Click "Run query" (play button)
4. View results in graph or table
```

### Query Logs in Grafana Explore

**Access:** Left sidebar → Explore

```
1. Select datasource: "loki-staging"
2. In query box, enter LogQL:
   - {namespace="monitoring"}
   - {namespace="monitoring"} | json | level="ERROR"
3. Click "Run query"
4. View logs in timeline/table
```

### Configure Alerts in Grafana

**Access:** Left sidebar → Alerting → Alert Rules

1. Navigate to existing dashboard panel
2. Click panel → Edit
3. Go to "Alert" tab
4. Configure condition, threshold, and notification channel
5. Save

---

## Loki

### Access Loki Logs

Loki is accessed through **Grafana Explore** (not directly via UI).

### Query Logs via Grafana

```bash
# 1. Port-forward Grafana (see above)
# 2. In Grafana: Explore → Select "loki-staging" datasource
# 3. Enter LogQL query in the query box
```

### LogQL Query Examples

#### Find all logs from monitoring namespace
```logql
{namespace="monitoring"}
```

#### Find error logs (assuming JSON structured logs)
```logql
{app="router"} | json | level="ERROR"
```

#### Find slow requests
```logql
{namespace="monitoring"} | json | duration > 300
```

#### Find router unavailable errors
```logql
{namespace="monitoring"} | json | error_type="ROUTER_OUTAGE"
```

#### Get log statistics
```logql
{namespace="monitoring"} | json | stats count() as total_logs by status
```

### Loki API Access (Advanced)

```bash
# Query logs via API (requires Loki service accessible)
# First, find Loki pod
LOKI_POD=$(kubectl get pods -n monitoring -l app=loki -o jsonpath='{.items[0].metadata.name}')

# Port-forward to Loki (optional)
kubectl port-forward -n monitoring $LOKI_POD 3100:3100

# Query Loki API
curl -G -d 'query={namespace="monitoring"}' http://localhost:3100/loki/api/v1/query
```

---

## AlertManager

### Access AlertManager UI

```bash
# 1. Start port-forward
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093

# 2. Open browser
# URL: http://localhost:9093
```

### AlertManager Web Interface Overview

| Section | Purpose | Use Cases |
|---------|---------|-----------|
| **Alerts** | View firing alerts | Monitor active incidents |
| **Groups** | View grouped alerts | See alert clustering |
| **Status** | System information | Check configuration & peers |
| **Silences** | Create alert silences | Suppress expected failures |

### Create a Silence (Suppress Alert)

**Access:** AlertManager UI → Silences → "New Silence"

```
1. Enter matching labels (filter which alerts to silence)
   Example: severity="warning", job="clarityrouter"
2. Set duration (how long to suppress)
   Example: 1 hour, 24 hours, custom
3. Add optional comment
4. Click "Create"
```

### View Routing Configuration

**Access:** AlertManager UI → Status → Configuration

Shows:
- Webhook receivers (Slack, PagerDuty, etc.)
- Routing rules (which alerts go to which receiver)
- Group settings (alert grouping parameters)

### Test Webhook Integration

```bash
# Send test alert to AlertManager
curl -X POST http://localhost:9093/api/v1/alerts \
  -H 'Content-Type: application/json' \
  -d '[{
    "status": "firing",
    "labels": {
      "alertname": "TestAlert",
      "severity": "critical",
      "job": "test"
    },
    "annotations": {
      "summary": "This is a test alert",
      "description": "Testing AlertManager webhook routing"
    }
  }]'

# Verify alert appears in UI
# Check Slack channel for notification
```

---

## Internal Service DNS Names

For pods within the cluster (no port-forward needed):

### Service DNS Names

```bash
# Prometheus
prometheus-stack-kube-prom-prometheus.monitoring:9090

# AlertManager
prometheus-stack-kube-prom-alertmanager.monitoring:9093

# Grafana
grafana.monitoring:3000

# Loki
loki.monitoring:3100

# kube-state-metrics
prometheus-stack-kube-prom-kube-state-metrics.monitoring:8080
```

### Test From Within Cluster

```bash
# Create test pod
kubectl run -it --rm --restart=Never --image=alpine:latest test-pod -- sh

# From pod shell, test services
wget -O - http://prometheus-stack-kube-prom-prometheus.monitoring:9090/-/healthy
wget -O - http://grafana.monitoring:3000/api/health
wget -O - http://loki.monitoring:3100/loki/api/v1/status/buildinfo
```

---

## Kubectl Commands for Inspection

### View Component Status

```bash
# Check all pods
kubectl get pods -n monitoring

# Check specific component pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus
kubectl get pods -n monitoring -l app.kubernetes.io/name=alertmanager
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
kubectl get pods -n monitoring -l app=loki

# Check service endpoints
kubectl get endpoints -n monitoring

# Check PersistentVolumeClaims
kubectl get pvc -n monitoring

# Check ConfigMaps
kubectl get configmap -n monitoring
```

### View Logs

```bash
# Prometheus logs
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus -f

# AlertManager logs
kubectl logs -n monitoring -l app.kubernetes.io/name=alertmanager -f

# Grafana logs
kubectl logs -n monitoring -l app.kubernetes.io/name=grafana -f

# Loki logs
kubectl logs -n monitoring -l app=loki -f

# Promtail logs
kubectl logs -n monitoring -l app=promtail -f
```

### Execute Commands in Pods

```bash
# Connect to Prometheus pod
kubectl exec -it prometheus-stack-kube-prom-prometheus-0 -n monitoring -- /bin/sh

# Check Prometheus config
kubectl exec prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  cat /etc/prometheus/prometheus.yml

# Query Prometheus from pod
kubectl exec prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  curl -s http://localhost:9090/api/v1/query?query=up | jq .
```

---

## Common Troubleshooting Access Issues

### Port-Forward Hangs / Cannot Connect

```bash
# Kill existing port-forwards
pkill -f "kubectl port-forward"

# Try again with explicit binding
kubectl port-forward -n monitoring svc/grafana 3000:3000 --address 127.0.0.1

# If still failing, check pod status
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
kubectl describe pod -n monitoring grafana-0
```

### Service Not Found

```bash
# Verify service exists
kubectl get svc -n monitoring grafana

# Check service endpoints
kubectl get endpoints -n monitoring grafana

# If endpoints empty, check pod status
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
```

### Pod Cannot Connect to Service

```bash
# Check network policies (if any)
kubectl get networkpolicy -n monitoring

# Test DNS resolution from pod
kubectl exec -it <pod-name> -n monitoring -- nslookup grafana.monitoring

# Test service connectivity
kubectl exec -it <pod-name> -n monitoring -- curl http://grafana.monitoring:3000/api/health
```

---

## Security Considerations

### Accessing From External Network

⚠️ **Important:** Default configuration uses localhost port-forwarding (secure).

For external access (production), consider:
- Ingress controller with TLS
- VPN/Bastion host access
- Cloud provider network security (AWS Security Groups, etc.)

### Storing Credentials Securely

- **Grafana password:** Retrieved via `kubectl get secret`
- Never commit credentials to Git
- Store in secure vault (1Password, AWS Secrets Manager, etc.)

---

## Grafana User Management

### Create New User via UI

1. **Configuration → Users → Create User**
2. Fill user details:
   - Name, Email, Login, Password
   - Role: Viewer / Editor / Admin
3. Click "Create"

### Create User via API

```bash
# Set admin password first
GRAFANA_PASSWORD=$(kubectl get secret grafana-admin-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d)

# Create new user
curl -X POST http://admin:${GRAFANA_PASSWORD}@localhost:3000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "login": "john",
    "password": "SecurePassword123!",
    "isGrafanaAdmin": false
  }'
```

---

## Documentation References

- **Deployment Checklist:** [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md)
- **Installation Guide:** [`INSTALL_STAGING.md`](INSTALL_STAGING.md)
- **Verification Checklist:** [`VERIFY_STAGING.md`](VERIFY_STAGING.md)
- **Rollback Procedure:** [`ROLLBACK_STAGING.md`](ROLLBACK_STAGING.md)
- **Architecture:** [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- **Prometheus Docs:** https://prometheus.io/docs/
- **Grafana Docs:** https://grafana.com/docs/grafana/latest/
- **Loki Docs:** https://grafana.com/docs/loki/latest/
- **AlertManager Docs:** https://prometheus.io/docs/alerting/latest/overview/
