# Production Verification Checklist - ClarityRouter Observability Stack

## Verification Overview

This checklist ensures all components are deployed correctly and operating as expected in the production environment. **Estimated time: 20-30 minutes**

## Pre-Verification Checks

- [ ] Deployment completed without errors (check logs from `deploy-production.sh`)
- [ ] All stakeholders notified of deployment completion
- [ ] Monitoring team on standby during verification
- [ ] Communication channel (#observability-incidents) active

---

## 1. Kubernetes Resources Verification

### Namespace and RBAC

```bash
# Verify namespace exists
kubectl get namespace observability
```

Expected:
```
NAME            STATUS   AGE
observability   Active   ~5 minutes
```

- [ ] Namespace exists and is active
- [ ] RBAC policies configured (ServiceAccounts, ClusterRoles, ClusterRoleBindings)

```bash
# Verify service accounts
kubectl get serviceaccount -n observability
```

Expected: Service accounts for Prometheus, Grafana, Loki, Promtail

### Pod Status

```bash
# Get detailed pod status
kubectl get pods -n observability -o wide
```

Expected output (or similar):
```
NAME                                    READY   STATUS    RESTARTS   AGE   IP              NODE
prometheus-kube-prom-prometheus-0       2/2     Running   0          3m    10.0.1.50       ip-10-0-1-100.ec2.internal
prometheus-kube-prom-prometheus-1       2/2     Running   0          2m    10.0.2.51       ip-10-0-2-100.ec2.internal
prometheus-kube-prom-prometheus-2       2/2     Running   0          1m    10.0.3.52       ip-10-0-3-100.ec2.internal
loki-0                                  1/1     Running   0          3m    10.0.1.60       ip-10-0-1-100.ec2.internal
loki-1                                  1/1     Running   0          2m    10.0.2.61       ip-10-0-2-100.ec2.internal
loki-2                                  1/1     Running   0          1m    10.0.3.62       ip-10-0-3-100.ec2.internal
grafana-7d8f5c9b8-2n9m9                1/1     Running   0          3m    10.0.1.70       ip-10-0-1-100.ec2.internal
grafana-7d8f5c9b8-4x2p5                1/1     Running   0          2m    10.0.2.72       ip-10-0-2-100.ec2.internal
alertmanager-kube-prom-alertmanager-0  2/2     Running   0          3m    10.0.1.80       ip-10-0-1-100.ec2.internal
alertmanager-kube-prom-alertmanager-1  2/2     Running   0          2m    10.0.2.81       ip-10-0-2-100.ec2.internal
promtail-xxx1x                          1/1     Running   0          3m    10.0.1.100      ip-10-0-1-100.ec2.internal
promtail-xxx2x                          1/1     Running   0          3m    10.0.2.100      ip-10-0-2-100.ec2.internal
promtail-xxx3x                          1/1     Running   0          3m    10.0.3.100      ip-10-0-3-100.ec2.internal
```

Verification checklist:

- [ ] All Prometheus pods READY 2/2 (3 replicas expected)
- [ ] All Loki pods READY 1/1 (3 replicas expected)
- [ ] All Grafana pods READY 1/1 (2 replicas expected)
- [ ] All AlertManager pods READY 2/2 (2+ replicas)
- [ ] All Promtail pods READY 1/1 (one per node)
- [ ] No pods in CrashLoopBackOff or Pending state
- [ ] Pod restart count is 0 (or minimal for expected restarts)

### Persistent Volume and Claims

```bash
# Check PVCs
kubectl get pvc -n observability -o wide
```

Expected:
```
NAME                   STATUS   VOLUME                                     CAPACITY   ACCESS MODES
prometheus-storage     Bound    pvc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   30Gi       RWO
loki-storage           Bound    pvc-yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy   150Gi      RWX
grafana-storage        Bound    pvc-zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz   2Gi        RWO
```

- [ ] All PVCs show STATUS: Bound
- [ ] Prometheus PVC size: 30Gi
- [ ] Loki PVC size: 150Gi
- [ ] Grafana PVC size: 2Gi

### Helm Releases

```bash
# Check Helm releases
helm list -n observability
```

Expected:
```
NAME        NAMESPACE       REVISION   UPDATED                    STATUS     CHART                             APP VERSION
prometheus  observability   1          2026-02-15 14:30:00        deployed   kube-prometheus-stack-XX.XX.XX   v1.XX.X
loki        observability   1          2026-02-15 14:32:00        deployed   loki-stack-XX.XX.XX              v3.XX.X
grafana     observability   1          2026-02-15 14:34:00        deployed   grafana-XX.XX.XX                 v10.XX.X
```

- [ ] All three Helm releases show STATUS: deployed
- [ ] No failed or pending releases

---

## 2. Service and Network Verification

### Services Created

```bash
# List all services
kubectl get svc -n observability
```

Expected:
```
NAME                                    TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
prometheus-kube-prom-prometheus         ClusterIP   10.100.XXX.XXX  <none>        9090/TCP
prometheus-kube-prom-alertmanager       ClusterIP   10.100.XXX.XXX  <none>        9093/TCP
loki                                    ClusterIP   10.100.XXX.XXX  <none>        3100/TCP
grafana                                 ClusterIP   10.100.XXX.XXX  <none>        80/TCP
```

- [ ] Prometheus service accessible on port 9090
- [ ] Grafana service accessible on port 80
- [ ] Loki service accessible on port 3100
- [ ] AlertManager service accessible on port 9093

### Network Connectivity

```bash
# Test Prometheus connectivity from a pod
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl -s http://prometheus-kube-prom-prometheus:9090/-/healthy

# Test Grafana connectivity
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl -s -o /dev/null -w "%{http_code}" http://grafana/api/health

# Test Loki connectivity
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl -s -o /dev/null -w "%{http_code}" http://loki:3100/ready
```

- [ ] Prometheus health endpoint returns HTTP 200
- [ ] Grafana health endpoint returns HTTP 200
- [ ] Loki ready endpoint returns HTTP 200

---

## 3. Prometheus Verification

### Prometheus API Health

```bash
# Port forward to Prometheus
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &

# Check health endpoint (in another terminal)
curl -s http://localhost:9090/-/healthy
```

Expected: HTTP 200 response

- [ ] Prometheus API responds to health check

### Scrape Targets

Navigate to: `http://localhost:9090/targets`

Expected targets (may vary based on configuration):
- **Prometheus** (self-monitoring)
- **Router** (clarity-router:8089)
- **Node Exporter** (all nodes)
- **kubelet** (kubernetes metrics)
- **kube-apiserver**
- **kube-controller-manager**
- **kube-scheduler**

Verification:
- [ ] All targets show GREEN (up=1)
- [ ] No targets showing RED (up=0)
- [ ] Scrape success rate >99%

### Metrics Query

In Prometheus UI, run these queries:

```promql
# Check Prometheus is collecting metrics
count(prometheus_tsdb_symbol_table_size_bytes)

# Check router metrics
count(clarity_router_requests_total)

# Check node metrics
count(node_cpu_seconds_total)
```

- [ ] All queries return results (not "No data")
- [ ] Metric count >100 (indicates healthy collection)

---

## 4. Grafana Verification

### Access Grafana UI

```bash
# Port forward to Grafana
kubectl port-forward -n observability svc/grafana 3000:80 &

# In browser, navigate to http://localhost:3000
```

- [ ] Grafana login page accessible
- [ ] Login with credentials from secret successful

### Data Sources

Navigate to: **Configuration → Data Sources**

Expected data sources:
1. **Prometheus**
   - URL: `http://prometheus-kube-prom-prometheus:9090`
   - Status: Green (connected)

2. **Loki**
   - URL: `http://loki:3100`
   - Status: Green (connected)

Verification:
- [ ] Both data sources show "Data source is working"
- [ ] No red error messages

### Dashboards

Navigate to: **Dashboards → Browse**

Expected dashboards (if imported):
- Observability Stack Health
- Router Performance
- Infrastructure Health
- Alert Status

- [ ] All dashboards load without errors
- [ ] Dashboards display metrics (not empty panels)
- [ ] No red "No data" messages

### Test Dashboard Creation

Create a simple test dashboard:
1. Click "Create → Dashboard"
2. Add a panel with query: `up`
3. Verify query results display

- [ ] Dashboard creation works
- [ ] Prometheus query returns results

---

## 5. Loki Log Ingestion Verification

### Check Loki Service

```bash
# Port forward to Loki
kubectl port-forward -n observability svc/loki 3100:3100 &

# Test Loki ready endpoint
curl -s http://localhost:3100/ready

# Check ingestion metrics
curl -s http://localhost:3100/metrics | grep loki_distributor_lines_received_total
```

Expected:
- Health check returns HTTP 200
- Ingestion metrics show non-zero values

- [ ] Loki ready endpoint responds
- [ ] Ingestion metrics present

### Check Promtail Collection

```bash
# Verify Promtail DaemonSet
kubectl get daemonset -n observability

# Check Promtail logs
kubectl logs -n observability -l app=promtail --tail=20 --all-containers=true
```

Expected Promtail output (no errors about file access)

- [ ] Promtail running on all nodes
- [ ] Promtail logs show successful ingestion

### Query Logs in Grafana

1. Navigate to **Explore** in Grafana
2. Select **Loki** data source
3. Run query: `{job="kubernetes-pods"}`

Expected: Log lines from container pods

- [ ] Log queries return results
- [ ] Logs are recent (within last few minutes)

---

## 6. AlertManager Verification

### AlertManager UI

```bash
# Access AlertManager
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &

# Navigate to http://localhost:9093
```

- [ ] AlertManager UI accessible
- [ ] Status page shows active AlertManager replicas

### Alert Rules

In Prometheus UI (`/alerts` path):

```
http://localhost:9090/alerts
```

Expected:
- Alert rules loaded (check count at top)
- No failed alert rules

- [ ] Alert rules page loads
- [ ] Rule count >5 (PrometheusDown, GrafanaDown, etc.)

### Test Alert Delivery

Send test alert to AlertManager:

```bash
# Send test alert
curl -X POST http://localhost:9093/api/v1/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "alerts": [{
      "status": "firing",
      "labels": {
        "alertname": "TestAlert",
        "severity": "critical"
      },
      "annotations": {
        "summary": "This is a test alert"
      }
    }]
  }'
```

- [ ] Test alert received in AlertManager UI
- [ ] Check Slack for notification in #observability-alerts

### Slack Integration Test

Manually verify Slack webhook works:

```bash
# Get webhook URL from secret
WEBHOOK=$(kubectl get secret slack-webhook -n observability -o jsonpath='{.data.webhook-url}' | base64 -d)

# Send test message
curl -X POST "$WEBHOOK" \
  -H 'Content-type: application/json' \
  -d '{
    "text": "✓ Observability stack deployed and Slack integration working!"
  }'
```

- [ ] Test message appears in #observability-alerts Slack channel

### PagerDuty Integration Test (if enabled)

```bash
# Verify PagerDuty secret exists
kubectl get secret pagerduty-integration -n observability

# Check AlertManager config includes PagerDuty
kubectl get configmap alertmanager-config -n observability -o yaml | grep -i pagerduty
```

- [ ] PagerDuty secret exists
- [ ] AlertManager config includes PagerDuty routing

---

## 7. Storage and Backup Verification

### PVC Storage Usage

```bash
# Check storage usage on PVCs
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  df -h /prometheus

kubectl exec -n observability loki-0 -- \
  df -h /loki/chunks

kubectl exec -n observability grafana-7d8f5c9b8-2n9m9 -- \
  df -h /var/lib/grafana
```

Expected:
- Prometheus: <30% full initially
- Loki: <30% full initially
- Grafana: <50% full

- [ ] Prometheus storage <30% full
- [ ] Loki storage <30% full
- [ ] Grafana storage <50% full

### EFS Mount Verification

```bash
# Verify EFS is mounted correctly
kubectl describe pvc prometheus-storage -n observability | grep "Mounted By"
kubectl describe pvc loki-storage -n observability | grep "Mounted By"

# Check mount options
kubectl get pv -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.storageClassName}{"\n"}{end}'
```

- [ ] All PVCs showing mounted pods
- [ ] EFS volumes mounted on multiple AZs

---

## 8. Performance and Latency Verification

### Prometheus Query Performance

In Prometheus UI, run some test queries and check response time:

```promql
# Simple query
rate(prometheus_http_request_duration_seconds_sum[5m])

# Complex query
sum(rate(clarity_router_requests_total[5m])) by (status)

# Range query (check slow query log)
increase(clarity_router_latency_seconds_bucket[1h])
```

- [ ] Simple queries complete in <500ms
- [ ] Complex queries complete in <2s
- [ ] No "Timeout" errors

### Grafana Dashboard Load Time

Open each dashboard and measure load time:

1. Open Developer Tools (F12)
2. Go to **Network** tab
3. Reload page
4. Observe total load time

Expected:
- Full page load: <5 seconds
- API calls: <2 seconds

- [ ] Observability dashboards load in <5s
- [ ] Panel rendering smooth (no jank)

### Log Query Latency

In Grafana Explore (Loki), run these queries and measure latency:

```logql
{job="kubernetes-pods"} | json | level="error"
```

- [ ] Log queries complete in <2s
- [ ] No timeout errors

---

## 9. High Availability and Failover Verification

### Replica Distribution

```bash
# Verify pods spread across multiple nodes
kubectl get pods -n observability -o wide | grep -E "prometheus|loki|grafana"
```

Expected: Each component replicas on different nodes

- [ ] Prometheus replicas on 3 different nodes
- [ ] Loki replicas on 3 different nodes
- [ ] Grafana replicas on 2 different nodes

### Pod Disruption Budgets

```bash
# Check PDBs configured
kubectl get poddisruptionbudget -n observability
```

Expected: PDBs for Prometheus, Loki, Grafana

- [ ] PDB exists for each component
- [ ] PDB min-available or max-unavailable configured

### Failover Test (Optional but Recommended)

**Warning:** Only perform during maintenance window

```bash
# Delete one Prometheus pod
kubectl delete pod -n observability prometheus-kube-prom-prometheus-0

# Monitor new pod creation
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus -w

# Verify metrics still being collected after 2 minutes
curl -s http://localhost:9090/api/v1/query?query=up | jq '.data.result | length'
```

Expected:
- New pod created to replace deleted pod
- Metrics still being collected
- No data gaps in Prometheus

- [ ] Pod replaced automatically
- [ ] Metrics collection continues
- [ ] No data loss observed

---

## 10. Security Verification

### Secrets Management

```bash
# Verify secrets are not exposed in pod environment
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- env | grep -i secret

# Verify secrets mounted as files (not env vars)
kubectl exec -n observability alertmanager-kube-prom-alertmanager-0 -- \
  ls -la /etc/alertmanager/secrets/
```

- [ ] No secrets exposed in pod environment
- [ ] Secrets mounted as files only

### RBAC

```bash
# Verify service accounts have minimal permissions
kubectl get clusterrole -l app.kubernetes.io/name=prometheus
kubectl get clusterrolebinding | grep observability
```

- [ ] RBAC roles follow least privilege principle
- [ ] No wildcard permissions

### Network Policies (if enabled)

```bash
# Check network policies
kubectl get networkpolicy -n observability
```

- [ ] Network policies restrict egress to necessary services
- [ ] No overly permissive policies

---

## 11. Documentation and Runbooks

- [ ] All runbooks accessible:
  - [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - SLO and incident response
  - [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - Backup and recovery
  - [`ACCESS_PRODUCTION.md`](ACCESS_PRODUCTION.md) - Access methods
  - [`ROLLBACK_PRODUCTION.md`](ROLLBACK_PRODUCTION.md) - Rollback procedures

- [ ] On-call team trained on runbooks
- [ ] Escalation contacts documented and verified
- [ ] Incident channels created (#observability-incidents)

---

## 12. Sign-Off and Completion

### Pre-Production Verification Summary

| Component | Status | Notes |
|-----------|--------|-------|
| Kubernetes Resources | ✓ | All pods running, 3 replicas HA |
| Services & Networking | ✓ | All services accessible |
| Prometheus Metrics | ✓ | >100 metrics collected |
| Grafana Dashboards | ✓ | All dashboards loading |
| Loki Logs | ✓ | Logs ingesting successfully |
| AlertManager | ✓ | Alerts routing to Slack/PagerDuty |
| Storage | ✓ | PVCs bound, <30% full |
| High Availability | ✓ | Replicas across nodes |
| Security | ✓ | RBAC and secrets secure |
| Performance | ✓ | Queries <2s latency |

### Sign-Off

**Production Deployment Verification:**

- [ ] All 12 verification sections completed
- [ ] No critical issues found
- [ ] Team trained and on-call ready
- [ ] Runbooks accessible and reviewed

**Verified By:** _________________  
**Date & Time:** _________________  
**Environment:** Production (clarity-router-prod)  

---

## Post-Verification Activities

1. **Ongoing Monitoring (First 24 hours)**
   - [ ] Monitor error logs for any issues
   - [ ] Review Slack #observability-incidents for alerts
   - [ ] Verify no unexpected pod restarts
   - [ ] Check storage growth rate

2. **Performance Baseline**
   - [ ] Record current query latency (p50, p95, p99)
   - [ ] Record current storage usage
   - [ ] Record current metric ingestion rate
   - [ ] Record current log ingestion rate

3. **Scheduled Activities**
   - [ ] First backup created (check AWS Backup)
   - [ ] First on-call rotation started
   - [ ] First SLO reporting period started
   - [ ] Monthly disaster recovery drill scheduled

---

**Status:** ✓ Production deployment verified and operational

**Next Steps:**
1. Review [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) for on-call procedures
2. Begin monitoring SLOs
3. Schedule monthly verification and testing
4. Plan quarterly capacity reviews
