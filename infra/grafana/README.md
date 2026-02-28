# Grafana Helm Configuration for ClarityRouter Observability

Complete Grafana visualization layer deployment for ClarityRouter production and staging clusters with 3 production-grade operational dashboards, datasource configurations, and Kubernetes-native integrations.

## File Structure

```
infra/grafana/
├── README.md                                # This file
├── values-common.yaml                       # Shared Helm configuration
├── values-prod.yaml                         # Production overrides (us-east-1)
├── values-staging.yaml                      # Staging overrides (us-west-2)
├── datasources-configmap.yaml               # Prometheus + Loki datasource definitions
├── dashboards-configmap.yaml                # Dashboard ConfigMap (Router Health)
└── dashboards/
    ├── dashboard-router-health.json          # Health Overview (12 panels)
    ├── dashboard-performance-details.json    # Performance Deep-Dive (10 panels)
    └── dashboard-infrastructure-health.json  # Infrastructure & Capacity (13 panels)
```

## Prerequisites

### Cluster Requirements
- **Kubernetes 1.28+** on EKS (both production and staging clusters)
- **Helm 3.12+** installed locally
- **kubectl** configured with access to both clusters
- **Prometheus & Loki** already deployed in `monitoring` namespace (from [`infra/prometheus/`](../prometheus/README.md))

### AWS Infrastructure
- EFS file system created in both clusters
- EFS CSI driver installed
- StorageClass `efs-sc` configured
- Namespace `monitoring` created

### Helm Repositories
```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

## Installation Instructions

### Step 1: Create Kubernetes Secret for Admin Password

Generate a secure random password:
```bash
# Production cluster
kubectl config use-context clarity-router-prod

# Generate random password (22 characters)
ADMIN_PASSWORD=$(openssl rand -base64 22)
echo "Grafana Admin Password: $ADMIN_PASSWORD"

# Create secret
kubectl create secret generic grafana-admin-secret \
  --from-literal=password="$ADMIN_PASSWORD" \
  -n monitoring

# Staging cluster
kubectl config use-context clarity-router-staging

ADMIN_PASSWORD=$(openssl rand -base64 22)
echo "Grafana Admin Password: $ADMIN_PASSWORD"

kubectl create secret generic grafana-admin-secret \
  --from-literal=password="$ADMIN_PASSWORD" \
  -n monitoring
```

**Important:** Store these passwords securely (e.g., 1Password, AWS Secrets Manager).

### Step 2: Apply Datasource ConfigMap

Deploy Prometheus + Loki datasource definitions:

```bash
# Production
kubectl config use-context clarity-router-prod
kubectl apply -f infra/grafana/datasources-configmap.yaml -n monitoring

# Staging
kubectl config use-context clarity-router-staging
kubectl apply -f infra/grafana/datasources-configmap.yaml -n monitoring

# Verify
kubectl get configmap -n monitoring | grep grafana-datasources
```

### Step 3: Deploy Grafana using Helm

Install Grafana with layered Helm values (common + environment-specific):

```bash
# Production
kubectl config use-context clarity-router-prod

helm install grafana grafana/grafana \
  --namespace monitoring \
  --values infra/grafana/values-common.yaml \
  --values infra/grafana/values-prod.yaml \
  --wait

# Verify deployment
kubectl rollout status deployment/grafana -n monitoring
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
```

```bash
# Staging
kubectl config use-context clarity-router-staging

helm install grafana grafana/grafana \
  --namespace monitoring \
  --values infra/grafana/values-common.yaml \
  --values infra/grafana/values-staging.yaml \
  --wait

# Verify deployment
kubectl rollout status deployment/grafana -n monitoring
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
```

### Step 4: Apply Dashboard ConfigMaps

Deploy dashboard definitions:

```bash
# Production & Staging (same ConfigMaps for both)
kubectl apply -f infra/grafana/dashboards-configmap.yaml -n monitoring

# Verify
kubectl get configmap -n monitoring | grep grafana-dashboards
```

Dashboards will be auto-discovered if ConfigMap label `grafana_dashboard: "1"` is present.

### Step 5: Port-Forward and Verify

Test local connectivity:

```bash
# Production
kubectl port-forward -n monitoring svc/grafana 3000:3000 &

# Visit http://localhost:3000
# Login: admin / <PASSWORD_FROM_SECRET>
# Expected: Router Health Overview dashboard visible
```

## Configuration Details

### Helm Values Merging

Grafana uses **layered Helm values** for environment-specific customization:

```bash
helm install grafana grafana/grafana \
  --values values-common.yaml \        # Base shared settings
  --values values-prod.yaml             # Environment-specific overrides
```

**Merge order (last file wins):**
1. `values-common.yaml` - Shared settings for both clusters
2. Environment file (`values-prod.yaml` or `values-staging.yaml`)

### Key Configuration Points

| Setting | Common | Prod | Staging | Purpose |
|---------|--------|------|---------|---------|
| **Replicas** | 2 | 2 | 2 | HA deployment across nodes |
| **Storage** | 10Gi EFS | 20Gi EFS | 15Gi EFS | Dashboard + config persistence |
| **CPU Limit** | 1000m | 2000m | 1500m | Performance scaling |
| **Memory Limit** | 2Gi | 4Gi | 3Gi | Large dashboard support |
| **Datasources** | Prometheus + Loki | Prod + Staging sources | Staging primary | Multi-environment support |
| **Ingress** | Enabled | TLS enabled | TLS enabled | HTTPS access |
| **Pod Anti-Affinity** | Required | Required | Required | Spread replicas across nodes |

### Datasources Configuration

Four datasources are configured in [`datasources-configmap.yaml`](datasources-configmap.yaml):

| Datasource | Type | URL | Environment | Default |
|------------|------|-----|-------------|---------|
| **prometheus-prod** | Prometheus | `http://prometheus-kube-prom-prometheus.monitoring:9090` | Production | ✅ Yes |
| **prometheus-staging** | Prometheus | `http://prometheus-staging-kube-prom-prometheus.monitoring:9090` | Staging | No |
| **loki-prod** | Loki | `http://loki.monitoring:3100` | Production | No |
| **loki-staging** | Loki | `http://loki-staging.monitoring:3100` | Staging | No |

**Features per datasource:**
- Query timeout: 60s
- HTTP method: GET
- Health check: enabled (60s interval)
- TLS skip verify: false (production: off, staging: off)

### Three Production-Grade Dashboards

#### Dashboard 1: Router Health Overview ([`dashboard-router-health.json`](dashboards/dashboard-router-health.json))
**Purpose:** At-a-glance operational status for on-call engineers  
**Refresh:** 30s  
**Time range:** Last 24h (default)  
**Panels (12):**
1. **Availability Gauge** - clarityrouter_router_availability (0-1 scale, SLO >99.95%)
2. **P99 Latency Stat** - P99 latency in ms (SLO <200ms, threshold red >250ms)
3. **Error Rate % Stat** - Request error % (SLO <1%, threshold red >1%)
4. **Requests/Second Graph** - Throughput trend over 24h
5. **Running Pods Stat** - count(kube_pod_status_phase{phase="Running"})
6. **Pod Status Table** - Name, namespace, phase, restart count, age
7. **Error Rate Timeseries** - Error % trend with thresholds
8. **P50/P95/P99 Heatmap** - Latency distribution buckets
9. **Pod Restarts Alert** - Pods with restarts in last hour
10. **SLO Status Panel** - Combined SLO health (P99 <200ms AND Availability >99.95% AND Error rate <1%)
11. **Last Alert Time** - Seconds since last alert
12. **Quick Links** - Buttons to Performance & Infrastructure dashboards

**Templates:**
- `$cluster` - prod/staging selector
- `$datasource` - Prometheus datasource picker
- `$namespace` - optional namespace filter
- `$pod` - optional pod filter

#### Dashboard 2: Detailed Performance Analysis ([`dashboard-performance-details.json`](dashboards/dashboard-performance-details.json))
**Purpose:** Deep-dive performance debugging for latency/error issues  
**Refresh:** 15s  
**Time range:** Last 6h (default, can zoom to 1h)  
**Panels (10):**
1. **Latency Heatmap** - Histogram buckets over time (color intensity = frequency)
2. **Error Types Breakdown** - clarityrouter_errors_total by error_type (stacked bar)
3. **Top 10 Slowest Endpoints** - Endpoints by P99 latency (horizontal bar)
4. **Top 10 Highest Error Rate** - Endpoints by error % (horizontal bar)
5. **Pod CPU Usage** - container_cpu_usage_seconds_total per pod
6. **Pod Memory Usage** - container_memory_usage_bytes per pod
7. **Network I/O Per Pod** - RX/TX bytes/sec (stacked area)
8. **Goroutine Count** - go_goroutines per pod (memory leak detector)
9. **Heap Allocation** - go_memstats_heap_alloc_bytes per pod (memory issues)
10. **Live Request Count** - In-flight requests (instantaneous rate)

**Templates:**
- `$cluster` - cluster selector
- `$datasource` - Prometheus datasource

#### Dashboard 3: Infrastructure Health & Capacity Planning ([`dashboard-infrastructure-health.json`](dashboards/dashboard-infrastructure-health.json))
**Purpose:** Cluster resource utilization for capacity planning  
**Refresh:** 30s  
**Time range:** Last 24h (default)  
**Panels (13):**
1. **Node CPU %** - CPU utilization gauge (red >90%, yellow >80%)
2. **Node Memory %** - Memory utilization gauge (red >85%, yellow >75%)
3. **Node Disk %** - Disk usage gauge (red >90%, yellow >80%)
4. **PVC Usage %** - Prometheus/Loki/Grafana PVC % full (red >85%)
5. **Certificate Expiry Days** - Days until cert expiry (red <7 days)
6. **CPU Over Time** - CPU trend by node (24h)
7. **Memory Over Time** - Memory trend by node (24h)
8. **Disk I/O Latency** - Read/write latency percentiles (ms)
9. **Network I/O Per Node** - RX/TX bytes/sec by node
10. **Pod Restart Count** - Pods with >3 restarts in 1h (table)
11. **Kubelet Errors** - kubelet_runtime_operations_errors rate
12. **Container Runtime Errors** - container_runtime_errors rate
13. **API Server Latency** - API server request latency P99 (ms)

**Templates:**
- `$cluster` - cluster selector
- `$datasource` - Prometheus datasource

### Teams & RBAC

Two teams are configured in Helm values:

**Production Cluster:**
- **Production Team** (Editor role) - full dashboard/alert edit access
- **Staging Team** (Viewer role) - read-only access to staging metrics
- **On-Call Team** (Editor role) - alert acknowledgment + dashboard edit

**Staging Cluster:**
- **Staging Team** (Editor role) - staging-focused access
- **Production Team** (Viewer role) - production metrics (read-only)

To create teams via Grafana UI:
1. Navigate to **Configuration → Teams**
2. Click **+ New team**
3. Set team name, member list, and role

### LDAP/OAuth Configuration (Optional)

To enable LDAP authentication, uncomment in `values-prod.yaml` or `values-staging.yaml`:

```yaml
grafana.ini:
  security:
    ldap_config_file: /etc/grafana/ldap.toml
  auth.ldap:
    enabled: true
    config_file: /etc/grafana/ldap.toml
    allow_sign_up: true
```

Create LDAP ConfigMap:
```bash
kubectl create configmap ldap-config --from-file=ldap.toml -n monitoring
```

And mount via `extraVolumes` / `extraVolumeMounts` in Helm values.

## Ingress & TLS Configuration

### Production Ingress

```yaml
# values-prod.yaml configured for:
ingress:
  enabled: true
  hosts:
    - grafana.clarity-router.prod
  tls:
    - secretName: grafana-tls-prod
      hosts:
        - grafana.clarity-router.prod
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

Requires cert-manager to be installed for automatic TLS.

### Staging Ingress

```yaml
# values-staging.yaml configured for:
ingress:
  enabled: true
  hosts:
    - grafana.clarity-router.staging
  tls:
    - secretName: grafana-tls-staging
      hosts:
        - grafana.clarity-router.staging
```

## Alerting Integration with Prometheus

Grafana automatically discovers alerts from Prometheus AlertManager:

```bash
# Port-forward to Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000

# Access: http://localhost:3000
# Navigate to: Alerting → Alert Rules
# Shows all PrometheusRule alerts configured in prometheus-stack
```

AlertManager annotations (vertical lines on dashboards):
- Automatically rendered on all dashboards
- Configured in datasource provisioning
- Shows alert name, cluster, severity

## Dashboard Import/Customization

### Automatic Dashboard Import

Dashboards are auto-discovered via ConfigMap label `grafana_dashboard: "1"`.

If manually importing:
1. Go to **Dashboards → Import**
2. Upload JSON file or paste JSON content
3. Select Prometheus datasource
4. Click **Import**

### Customizing Dashboards

Edit dashboard JSON directly in Grafana UI:
1. Open dashboard
2. Click **Edit** (top right)
3. Modify panels, queries, thresholds
4. Click **Save** (Ctrl+S)

**Important:** Changes are stored in Grafana database (PVC), not ConfigMap.

To version-control dashboard edits:
1. Export dashboard (Dashboard → Share → Export JSON)
2. Update [`infra/grafana/dashboards/dashboard-*.json`](dashboards/)
3. Commit to Git

## User Management

### Creating Users via API

```bash
# Port-forward to Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000 &

# Create user with API
curl -X POST http://admin:$PASSWORD@localhost:3000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@clarity-router.prod",
    "login": "john",
    "password": "NewPassword123!",
    "isGrafanaAdmin": false
  }'
```

### Creating Users via UI

1. Navigate to **Configuration → Users**
2. Click **+ New User** or **Invite**
3. Fill user details
4. Assign role (Admin, Editor, Viewer)
5. Click **Create** or **Send Invite**

## Alerting Configuration

### Notification Channels

Grafana supports multiple notification backends:

**Slack:**
```bash
# Create notification channel via UI:
# Configuration → Notifications → New Channel
# Type: Slack
# Webhook URL: https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

**PagerDuty:**
```bash
# Configuration → Notifications → New Channel
# Type: PagerDuty
# Service Key: <PagerDuty integration key>
```

**Email:**
```bash
# Requires SMTP configuration in grafana.ini:
[smtp]
enabled = true
host = smtp.example.com
port = 587
user = alerts@clarity-router.prod
password = <password>
from_address = alerts@clarity-router.prod
```

### Alert Rules

Configure alert rules on dashboard panels:
1. Open dashboard
2. Click panel → **Edit**
3. Go to **Alert** tab
4. Set conditions, thresholds, and notification channel
5. Click **Save**

Example: P99 Latency >250ms alert
```
Condition: clarityrouter_request_latency_ms{quantile="0.99"} > 250
For: 5 minutes
Send to: Production Alerts - Slack
```

## Performance Tuning

### For Large Datasets (>1M time series)

Increase resource limits:
```yaml
# values-prod.yaml
grafana:
  resources:
    limits:
      cpu: 3000m
      memory: 6Gi
    requests:
      cpu: 2000m
      memory: 4Gi
```

### Query Performance Optimization

1. **Increase datasource timeout:**
   ```yaml
   datasources.yaml:
     jsonData:
       queryTimeout: 120s  # Increase from 60s
   ```

2. **Reduce dashboard refresh intervals:**
   - Overview: 30s → 1m
   - Performance: 15s → 30s
   - Infrastructure: 30s → 1m

3. **Limit time ranges:**
   - Default to 6h instead of 24h
   - Provide time range selector to users

### Memory Optimization

Dashboard with 50+ panels can use 1-2GB RAM. Mitigation:
1. Split into separate dashboards (already done)
2. Reduce series count via metric relabeling
3. Increase `refresh_intervals` in Prometheus

## Backup & Restore Procedures

### Backup Grafana Database (SQLite)

```bash
# Port-forward Grafana PVC
kubectl exec -it grafana-0 -n monitoring -- \
  cp /var/lib/grafana/grafana.db /tmp/grafana-backup.db

# Copy to local machine
kubectl cp monitoring/grafana-0:/tmp/grafana-backup.db ./grafana-backup.db
```

### Backup via Grafana API

```bash
# Export all dashboards
for uid in $(curl -s http://admin:$PASSWORD@localhost:3000/api/search | jq -r '.[].uid'); do
  curl -s http://admin:$PASSWORD@localhost:3000/api/dashboards/uid/$uid | jq '.' > dashboard-$uid.json
done
```

### Restore from Backup

```bash
# Restore SQLite database
kubectl cp ./grafana-backup.db monitoring/grafana-0:/tmp/grafana-backup.db

kubectl exec grafana-0 -n monitoring -- \
  cp /tmp/grafana-backup.db /var/lib/grafana/grafana.db

# Restart Grafana
kubectl rollout restart deployment/grafana -n monitoring
```

## Troubleshooting

### Issue: Dashboards Not Appearing

**Symptoms:** Dashboards list is empty or showing "No dashboards found"

**Resolution:**
```bash
# 1. Verify ConfigMap exists
kubectl get configmap -n monitoring | grep grafana-dashboards

# 2. Check ConfigMap has correct label
kubectl get configmap grafana-dashboards -n monitoring -o yaml | grep grafana_dashboard

# 3. Verify dashboard JSON is valid
kubectl get configmap grafana-dashboards -n monitoring -o jsonpath='{.data}' | jq .

# 4. Restart Grafana to reload
kubectl rollout restart deployment/grafana -n monitoring

# 5. Check Grafana logs
kubectl logs -n monitoring -l app.kubernetes.io/name=grafana --tail=100
```

### Issue: Datasources Not Connected

**Symptoms:** "Datasource is missing" error or red X on datasource

**Resolution:**
```bash
# 1. Verify datasource ConfigMap
kubectl get configmap grafana-datasources -n monitoring -o yaml

# 2. Test Prometheus connectivity from pod
kubectl exec -it grafana-0 -n monitoring -- curl -v http://prometheus-kube-prom-prometheus.monitoring:9090/api/v1/query?query=up

# 3. Check firewall/network policies
kubectl get networkpolicy -n monitoring

# 4. Restart Grafana
kubectl rollout restart deployment/grafana -n monitoring
```

### Issue: High Memory Usage

**Symptoms:** Grafana pod OOMKilled or ~3Gi+ memory usage

**Resolution:**
```bash
# 1. Check resource limits
kubectl describe pod grafana-0 -n monitoring | grep -A 5 "Limits\|Requests"

# 2. Review dashboard query complexity
# In Grafana UI: Inspect → Performance
# Look for queries with >100K series

# 3. Increase memory limits in Helm values
resources:
  limits:
    memory: 6Gi  # Increase from 4Gi

# 4. Upgrade Helm release
helm upgrade grafana grafana/grafana \
  -n monitoring \
  --values values-common.yaml \
  --values values-prod.yaml
```

### Issue: Slow Dashboard Load

**Symptoms:** Dashboard takes >5 seconds to load

**Resolution:**
```bash
# 1. Reduce number of panels (max 20 per dashboard)
# Current dashboards: 12, 10, 13 panels (within limits)

# 2. Increase datasource query timeout
datasources:
  jsonData:
    queryTimeout: 120s

# 3. Reduce time range (24h → 6h)
time:
  from: "now-6h"
  to: "now"

# 4. Disable auto-refresh during troubleshooting
refresh: "off"
```

### Issue: Ingress Not Resolving

**Symptoms:** Cannot access grafana.clarity-router.prod

**Resolution:**
```bash
# 1. Check Ingress resource
kubectl get ingress -n monitoring
kubectl describe ingress grafana -n monitoring

# 2. Check Ingress controller
kubectl get pods -n ingress-nginx

# 3. Check DNS resolution
nslookup grafana.clarity-router.prod
dig grafana.clarity-router.prod

# 4. Check TLS certificate
kubectl get certificate -n monitoring
kubectl describe certificate grafana-tls-prod -n monitoring

# 5. Port-forward as temporary workaround
kubectl port-forward -n monitoring svc/grafana 3000:3000
# Visit http://localhost:3000
```

### Issue: Alerts Not Firing

**Symptoms:** No alerts visible in Grafana despite configured conditions

**Resolution:**
```bash
# 1. Verify AlertManager is running
kubectl get pods -n monitoring -l app.kubernetes.io/name=alertmanager

# 2. Check Prometheus alerts
kubectl port-forward -n monitoring svc/prometheus-kube-prom-prometheus 9090:9090
# Visit http://localhost:9090/alerts

# 3. Verify notification channel in Grafana
# Configuration → Notification channels
# Test notification (send test alert)

# 4. Check AlertManager routes
kubectl get alertmanager -n monitoring -o yaml | grep -A 10 "route:"
```

## Helm Update/Upgrade

To modify Grafana configuration after deployment:

```bash
# Production
helm upgrade grafana grafana/grafana \
  --namespace monitoring \
  --values infra/grafana/values-common.yaml \
  --values infra/grafana/values-prod.yaml

# Staging
helm upgrade grafana grafana/grafana \
  --namespace monitoring \
  --values infra/grafana/values-common.yaml \
  --values infra/grafana/values-staging.yaml

# Wait for rollout
kubectl rollout status deployment/grafana -n monitoring
```

## Cost Estimation

| Component | Production (mo.) | Staging (mo.) | Total |
|-----------|---|---|---|
| Grafana PVC (20Gi + 15Gi EFS) | $1.00 | $0.75 | $1.75 |
| Grafana replicas (2 × 1Gi + 2 × 0.75Gi mem) | Included in node costs | Included | - |
| **Total Grafana Cost** | **<$1/month** | **<$1/month** | **~$2-3/month** |

*Note: EFS storage costs dominate. Compute (CPU/memory) costs included in node budget.*

## Next Steps

1. ✅ Deploy Grafana (this guide)
2. ✅ Verify datasources connect to Prometheus/Loki
3. ✅ Import three dashboards
4. ✅ Test alerts and notification channels
5. Configure backup/restore procedures (EFS snapshots)
6. Set up runbooks for common alerts
7. Train team on dashboard navigation
8. Schedule dashboard reviews (weekly/monthly)

## References

- [Grafana Helm Chart](https://github.com/grafana/helm-charts/tree/main/charts/grafana)
- [Grafana Documentation](https://grafana.com/docs/grafana/latest/)
- [Grafana Dashboard JSON Model](https://grafana.com/docs/grafana/latest/dashboards/manage-dashboards/)
- [Prometheus Datasource](https://grafana.com/docs/grafana/latest/datasources/prometheus/)
- [Loki Datasource](https://grafana.com/docs/loki/latest/clients/grafana/)
- [Alerting in Grafana](https://grafana.com/docs/grafana/latest/alerting/)
- [Helm Values Reference](https://grafana.com/docs/grafana/latest/setup-grafana/installation/helm/)

## Support & Troubleshooting Checklist

Before escalating issues:
- [ ] Verify Prometheus/Loki datasources are running and accessible
- [ ] Check network policies allow Grafana → Prometheus/Loki traffic
- [ ] Review Grafana pod logs: `kubectl logs -f pod/grafana-0 -n monitoring`
- [ ] Confirm PVC is bound and has available space: `kubectl get pvc -n monitoring`
- [ ] Test datasource health via Grafana UI: Configuration → Data sources → Test
- [ ] Verify admin password stored securely and matches secret
- [ ] Check Ingress certificate validity: `kubectl describe cert grafana-tls-prod -n monitoring`
- [ ] Confirm no Pod Disruption Budget blocking updates
