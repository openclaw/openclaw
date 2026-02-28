# Observability Stack Verification Checklist - Staging Cluster
## Post-Deployment Validation

**Document Version:** 1.0  
**Target Cluster:** `clarity-router-staging` (us-west-2)  
**Validation Date:** ________________  

---

## Overview

This comprehensive verification checklist ensures all observability stack components are operational and properly configured after deployment. Complete each section sequentially and record results.

**Prerequisites:** Deployment completed via [`deploy-staging.sh`](deploy-staging.sh) and [`INSTALL_STAGING.md`](INSTALL_STAGING.md).

---

## Section 1: Kubernetes Cluster Health

### 1.1 Verify Cluster Connectivity

```bash
# Check cluster info
kubectl cluster-info
# Expected: Kubernetes control plane running and API server accessible

# Check cluster status
kubectl get nodes -o wide
# Expected: All nodes in Ready state

# Result: ☐ PASS ☐ FAIL
```

**Troubleshooting:** If nodes not ready, check `kubectl describe node <node-name>` for events.

### 1.2 Verify Namespace Exists

```bash
# Check monitoring namespace
kubectl get namespace monitoring
# Expected: STATUS = Active

# Verify namespace labels
kubectl get namespace monitoring -o jsonpath='{.metadata.labels}' | jq .
# Expected: {"app":"monitoring","environment":"staging"}

# Result: ☐ PASS ☐ FAIL
```

### 1.3 Verify API Resources Available

```bash
# Check for ServiceMonitor CRD (from Prometheus Operator)
kubectl get crd servicemonitors.monitoring.coreos.com
# Expected: servicemonitors.monitoring.coreos.com listed

# Check for PrometheusRule CRD
kubectl get crd prometheusrules.monitoring.coreos.com
# Expected: prometheusrules.monitoring.coreos.com listed

# Check for Prometheus CRD
kubectl get crd prometheuses.monitoring.coreos.com
# Expected: prometheuses.monitoring.coreos.com listed

# Result: ☐ PASS ☐ FAIL
```

---

## Section 2: Monitoring Namespace Pods

### 2.1 Verify All Pods Running and Ready

```bash
# List all pods in monitoring namespace
kubectl get pods -n monitoring
# Expected: All pods in Running state with Ready column showing full readiness

# Get detailed pod status
kubectl get pods -n monitoring -o wide

# Result: ☐ PASS ☐ FAIL

# Expected pods:
# - prometheus-stack-kube-prom-prometheus-0, -1 (2 replicas)
# - prometheus-stack-kube-prom-alertmanager-0, -1 (2 replicas)
# - prometheus-stack-kube-prom-kube-state-metrics-* (1 replica)
# - prometheus-stack-kube-prom-node-exporter-* (1 per node)
# - grafana-0, -1 (2 replicas)
# - loki-0, -1 (2 replicas)
# - promtail-* (1 per node, DaemonSet)
```

### 2.2 Check Pod Resource Allocation

```bash
# Check Prometheus resource usage
kubectl top pod -n monitoring -l app.kubernetes.io/name=prometheus
# Expected: CPU <500m, Memory <2Gi (actual usage, not limits)

# Check Grafana resource usage
kubectl top pod -n monitoring -l app.kubernetes.io/name=grafana
# Expected: CPU <100m, Memory <512Mi

# Check Loki resource usage
kubectl top pod -n monitoring -l app=loki
# Expected: CPU <250m, Memory <1Gi

# Result: ☐ PASS ☐ FAIL
```

### 2.3 Check Pod Events for Errors

```bash
# Get namespace events (last 20 minutes)
kubectl get events -n monitoring --sort-by='.lastTimestamp' | tail -20
# Expected: No CrashLoopBackOff or ImagePullBackOff events

# Check for pod restarts
kubectl get pods -n monitoring -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\n"}{end}'
# Expected: All restart counts = 0

# Result: ☐ PASS ☐ FAIL
```

---

## Section 3: Kubernetes Services

### 3.1 Verify All Services Created

```bash
# List services in monitoring namespace
kubectl get svc -n monitoring
# Expected: Services for Prometheus, AlertManager, Grafana, Loki

# Result: ☐ PASS ☐ FAIL

# Expected services:
# - prometheus-stack-kube-prom-prometheus (port 9090)
# - prometheus-stack-kube-prom-alertmanager (port 9093)
# - grafana (port 3000)
# - loki (port 3100)
# - prometheus-stack-kube-prom-kube-state-metrics (port 8080)
```

### 3.2 Verify Service Endpoints

```bash
# Check Prometheus service endpoints
kubectl get endpoints -n monitoring prometheus-stack-kube-prom-prometheus
# Expected: 2 endpoints (both replicas)

# Check AlertManager service endpoints
kubectl get endpoints -n monitoring prometheus-stack-kube-prom-alertmanager
# Expected: 2 endpoints

# Check Grafana service endpoints
kubectl get endpoints -n monitoring grafana
# Expected: 2 endpoints

# Check Loki service endpoints
kubectl get endpoints -n monitoring loki
# Expected: 2 endpoints

# Result: ☐ PASS ☐ FAIL
```

---

## Section 4: Persistent Storage

### 4.1 Verify PersistentVolumeClaims

```bash
# List PVCs in monitoring namespace
kubectl get pvc -n monitoring
# Expected: PVCs for prometheus-stack-kube-prom-prometheus, loki, grafana all in Bound state

# Result: ☐ PASS ☐ FAIL
```

### 4.2 Check PVC Storage Capacity

```bash
# Get PVC details
kubectl describe pvc -n monitoring prometheus-stack-kube-prom-prometheus
# Expected: Storage capacity 100Gi, Status Bound

kubectl describe pvc -n monitoring loki
# Expected: Storage capacity 150Gi, Status Bound

kubectl describe pvc -n monitoring grafana
# Expected: Storage capacity 10Gi, Status Bound

# Result: ☐ PASS ☐ FAIL
```

### 4.3 Monitor PVC Usage

```bash
# Get storage usage for Prometheus
kubectl exec prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  df -h /prometheus
# Expected: Shows mounted EFS with <80% usage

# Get storage usage for Loki
kubectl exec loki-0 -n monitoring -- \
  df -h /loki/storage
# Expected: Shows mounted EFS with <80% usage

# Get storage usage for Grafana
kubectl exec grafana-0 -n monitoring -- \
  df -h /var/lib/grafana
# Expected: Shows mounted EFS with <80% usage

# Result: ☐ PASS ☐ FAIL
```

---

## Section 5: Prometheus Metrics Collection

### 5.1 Port-Forward to Prometheus

```bash
# Open terminal session
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090

# In another terminal, verify connectivity
curl http://localhost:9090/-/healthy
# Expected: HTTP 200

# Result: ☐ PASS ☐ FAIL
```

### 5.2 Verify Targets are Scraping

**Access Prometheus UI at http://localhost:9090**

1. Navigate to **Status → Targets**
2. Verify targets listed and status:

```
Expected targets:
☐ prometheus (1/1 up) - self-monitoring
☐ prometheus-stack-kube-prom-alertmanager (2/2 up) - AlertManager
☐ prometheus-stack-kube-prom-kube-state-metrics (1/1 up) - k8s metrics
☐ prometheus-stack-kube-prom-node-exporter (N/N up) - node metrics
☐ prometheus-stack-kube-prom-kubelet (N/N up) - kubelet metrics
☐ clarityrouter (N/N up) - router metrics (may be 0/0 if router not deployed)
```

```bash
# Alternatively, check via API
curl 'http://localhost:9090/api/v1/targets' | jq '.data.activeTargets | length'
# Expected: >10 targets

# Result: ☐ PASS ☐ FAIL
```

### 5.3 Verify Metrics are Being Scraped

```bash
# Query for Prometheus internal metrics
curl 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length'
# Expected: >10 results (at least 10 targets showing "up" metric)

# Query for kube-state-metrics
curl 'http://localhost:9090/api/v1/query?query=kube_pod_info' | jq '.data.result | length'
# Expected: >0 results (pods detected)

# Query for node metrics
curl 'http://localhost:9090/api/v1/query?query=node_uname_info' | jq '.data.result | length'
# Expected: 2-3 results (one per node)

# Result: ☐ PASS ☐ FAIL
```

### 5.4 Verify Recording Rules are Loaded

```bash
# Query for recording rules
curl 'http://localhost:9090/api/v1/rules' | jq '.data.groups[0].rules | length'
# Expected: >10 recording rules loaded

# List rule groups
curl 'http://localhost:9090/api/v1/rules' | jq '.data.groups[].name'
# Expected: clarityrouter.rules group listed

# Query for SLO metrics
curl 'http://localhost:9090/api/v1/query?query=slo:clarityrouter_latency_p99:5m' | jq '.data.result | length'
# Expected: If router deployed, >0 results

# Result: ☐ PASS ☐ FAIL
```

### 5.5 Verify AlertManager Integration

**In Prometheus UI, navigate to Status → Configuration**

```
Verify:
☐ alerting configured
☐ AlertManager replicas: localhost:9093
☐ Rule evaluation interval: 30s
```

---

## Section 6: Grafana Dashboards

### 6.1 Port-Forward to Grafana

```bash
# Open terminal session
kubectl port-forward -n monitoring svc/grafana 3000:3000

# In another terminal, verify connectivity
curl http://localhost:3000/api/health
# Expected: HTTP 200 with {"status":"ok"}

# Result: ☐ PASS ☐ FAIL
```

### 6.2 Access Grafana Web UI

**Open browser: http://localhost:3000**

```
Login credentials:
- Username: admin
- Password: <from grafana-admin-secret>

Get password:
kubectl get secret grafana-admin-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d
```

```
After login, verify:
☐ Home dashboard loads without errors
☐ Left sidebar shows Dashboards menu
☐ Navigation works (no JavaScript errors in console)

Result: ☐ PASS ☐ FAIL
```

### 6.3 Verify Datasources Connected

**In Grafana UI: Configuration → Data Sources**

```
Expected datasources:
☐ prometheus-staging (Prometheus, URL: http://prometheus-stack-kube-prom-prometheus.monitoring:9090)
☐ loki-staging (Loki, URL: http://loki.monitoring:3100)

For each datasource:
☐ Click "Test" button → Expected: "Data source is working"
☐ Check "Last queried": Should show recent timestamp

Result: ☐ PASS ☐ FAIL
```

### 6.4 Verify Dashboards Imported

**In Grafana UI: Dashboards → Manage**

```
Expected dashboards:
☐ Router Health Overview (12 panels)
   - Availability gauge
   - P99 Latency stat
   - Error Rate % stat
   - Request throughput graph
   
☐ Performance Details (10 panels)
   - Latency heatmap
   - Error breakdown by type
   - Top slowest endpoints
   - CPU/memory usage per pod

☐ Infrastructure Health (13 panels)
   - Node CPU/Memory/Disk gauges
   - PVC usage status
   - Pod restart tracking
   - Certificate expiry

Result: ☐ PASS ☐ FAIL
```

### 6.5 Open Each Dashboard and Verify Data

**For each dashboard:**

1. Click dashboard name
2. Verify panels load without errors
3. Check for "No data" messages

```
Expected observations:
☐ Panels display without JavaScript errors
☐ Refresh rate updates data (observe for 30 seconds)
☐ Time range selector works (try changing from "Last 24h" to "Last 6h")
☐ Template variables work (if present: $cluster, $datasource, etc.)

Note: If router not deployed, router-specific panels may show "No data" - this is OK.

Result: ☐ PASS ☐ FAIL
```

---

## Section 7: Loki Log Aggregation

### 7.1 Port-Forward to Loki

```bash
# Verify Loki connectivity from within cluster
kubectl run -it --rm --restart=Never --image=alpine:latest loki-test -- \
  wget -O - http://loki.monitoring:3100/loki/api/v1/status/buildinfo

# Expected: HTTP 200 with Loki build info

# Result: ☐ PASS ☐ FAIL
```

### 7.2 Verify Promtail is Shipping Logs

```bash
# Check Promtail pod logs
kubectl logs -n monitoring -l app=promtail -f --tail=20
# Expected: Logs showing successful connection to Loki, no errors

# Verify Promtail DaemonSet
kubectl get daemonset -n monitoring promtail
# Expected: READY = DESIRED (one per node)

# Result: ☐ PASS ☐ FAIL
```

### 7.3 Query Logs from Grafana

**In Grafana UI: Explore → Select loki-staging datasource**

```
Query logs:
1. Select labels: namespace="monitoring" | job="kubernetes-pods"
2. Click "Run query" (play button)
3. Verify logs returned and displaying in timeline

Expected:
☐ Logs displayed in table format
☐ Log entries show timestamp, labels, message
☐ Multiple log entries visible (from different pods/containers)

Result: ☐ PASS ☐ FAIL
```

### 7.4 Test LogQL Query

**In Grafana Explore → LogQL query:**

```logql
{namespace="monitoring"} | json | level="ERROR"
```

```
Expected:
☐ Query executes without errors
☐ Results displayed (even if empty)
☐ Status bar shows query duration and lines processed

Result: ☐ PASS ☐ FAIL
```

---

## Section 8: AlertManager Configuration

### 8.1 Port-Forward to AlertManager

```bash
# Open terminal session
kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-alertmanager 9093:9093

# Verify connectivity
curl http://localhost:9093/-/healthy
# Expected: HTTP 200

# Result: ☐ PASS ☐ FAIL
```

### 8.2 Access AlertManager Web UI

**Open browser: http://localhost:9093**

```
Expected page loads:
☐ AlertManager UI accessible
☐ Shows "Alerts" and "Groups" tabs
☐ Configuration visible (click "Status" → "Configuration")
☐ Silence editor available

Result: ☐ PASS ☐ FAIL
```

### 8.3 Verify Slack Integration Configuration

```bash
# Get AlertManager configuration
kubectl get configmap -n monitoring alertmanager -o jsonpath='{.data.alertmanager\.yaml}' | head -50
# Expected: Slack webhook URL configured in receiver

# Check secret
kubectl get secret alertmanager-webhooks -n monitoring -o jsonpath='{.data.slack-webhook-url}' | base64 -d
# Expected: Shows Slack webhook URL

# Result: ☐ PASS ☐ FAIL
```

### 8.4 Verify Alert Rules Loaded

```bash
# Check PrometheusRule
kubectl get prometheusrule -n monitoring
# Expected: clarityrouter-rules listed

# Get alert count
kubectl get prometheusrule -n monitoring -o jsonpath='{.items[].spec.groups[].rules | length}'
# Expected: >10 alert rules

# Result: ☐ PASS ☐ FAIL
```

---

## Section 9: High Availability Verification

### 9.1 Verify Pod Replica Count

```bash
# Check Prometheus replicas
kubectl get statefulset -n monitoring prometheus-stack-kube-prom-prometheus -o jsonpath='{.spec.replicas}'
# Expected: 2

# Check AlertManager replicas
kubectl get statefulset -n monitoring prometheus-stack-kube-prom-alertmanager -o jsonpath='{.spec.replicas}'
# Expected: 2

# Check Grafana replicas
kubectl get deployment -n monitoring grafana -o jsonpath='{.spec.replicas}'
# Expected: 2

# Check Loki replicas
kubectl get statefulset -n monitoring loki -o jsonpath='{.spec.replicas}'
# Expected: 2

# Result: ☐ PASS ☐ FAIL
```

### 9.2 Verify Pod Affinity Rules

```bash
# Check Prometheus anti-affinity
kubectl get statefulset -n monitoring prometheus-stack-kube-prom-prometheus -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution | length}'
# Expected: >0 (affinity rule configured)

# Verify pods are on different nodes
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus -o wide
# Expected: DIFFERENT NODE for each replica

# Result: ☐ PASS ☐ FAIL
```

### 9.3 Test Pod Disruption Budget

```bash
# Verify PDB exists
kubectl get pdb -n monitoring
# Expected: PodDisruptionBudget for prometheus, alertmanager, grafana, loki

# Check Prometheus PDB
kubectl describe pdb prometheus-pdb -n monitoring 2>/dev/null || echo "PDB not found (may not be explicitly created)"
# Expected: minAvailable: 1 (or equivalent)

# Result: ☐ PASS ☐ FAIL
```

---

## Section 10: Security Verification

### 10.1 Verify RBAC Configuration

```bash
# Check ServiceAccount for Prometheus
kubectl get sa -n monitoring | grep prometheus
# Expected: ServiceAccount found

# Check RBAC roles
kubectl get clusterrole | grep prometheus
# Expected: Prometheus operator created RBAC roles

# Result: ☐ PASS ☐ FAIL
```

### 10.2 Verify Secrets Security

```bash
# Verify secrets exist (not values)
kubectl get secrets -n monitoring
# Expected: alertmanager-webhooks, grafana-admin-secret, and others

# Verify secret is not world-readable (check file permissions in mounted pods)
kubectl exec prometheus-0 -n monitoring -- ls -la /var/run/secrets/kubernetes.io/serviceaccount/ 2>/dev/null || echo "Cannot verify from Prometheus pod"

# Result: ☐ PASS ☐ FAIL
```

### 10.3 Verify Network Policies (if configured)

```bash
# Check network policies in monitoring namespace
kubectl get networkpolicy -n monitoring
# Expected: NetworkPolicies enforcing traffic rules (or empty if not configured)

# If present, verify policies allow necessary traffic
kubectl describe networkpolicy -n monitoring 2>/dev/null || echo "No NetworkPolicies configured"

# Result: ☐ PASS ☐ FAIL
```

---

## Section 11: Metrics Validation

### 11.1 Verify System Metrics Available

```bash
# Query for system metrics (node_cpu_seconds_total)
curl -s 'http://localhost:9090/api/v1/query?query=node_cpu_seconds_total' | jq '.data.result | length'
# Expected: >0 (system metrics collected)

# Query for pod metrics (container_cpu_usage_seconds_total)
curl -s 'http://localhost:9090/api/v1/query?query=container_cpu_usage_seconds_total' | jq '.data.result | length'
# Expected: >0 (container metrics collected)

# Query for kube metrics (kube_pod_info)
curl -s 'http://localhost:9090/api/v1/query?query=kube_pod_info' | jq '.data.result | length'
# Expected: >0 (kubernetes metrics collected)

# Result: ☐ PASS ☐ FAIL
```

### 11.2 Verify Retention Policies

```bash
# Check Prometheus retention setting
kubectl get prometheus -n monitoring -o jsonpath='{.items[0].spec.retention}'
# Expected: 15d (or similar)

# Check Prometheus retention size
kubectl get prometheus -n monitoring -o jsonpath='{.items[0].spec.retentionSize}'
# Expected: 90GB or similar

# Check Loki retention (check pod logs/config)
kubectl get statefulset -n monitoring loki -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LOKI_RETENTION_PERIOD")].value}'
# Expected: 720h (30 days) or similar

# Result: ☐ PASS ☐ FAIL
```

---

## Section 12: Data Collection Verification

### 12.1 Verify Prometheus Metrics Count

```bash
# Query for metric count
curl -s 'http://localhost:9090/api/v1/label/__name__/values' | jq '.data | length'
# Expected: >100 metrics collected

# Query for active series
curl -s 'http://localhost:9090/api/v1/query?query=count(count by (__name__) ({job!=""}))'
# Expected: Numeric count of active time series (>1000 expected)

# Result: ☐ PASS ☐ FAIL
```

### 12.2 Verify Minimum Hour of Data Collected

```bash
# Check Prometheus oldest data point
kubectl exec prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  /bin/prometheus --storage.tsdb.path=/prometheus query-max-samples 2>/dev/null || echo "Cannot query directly"

# Alternative: Check filesystem age
kubectl exec prometheus-stack-kube-prom-prometheus-0 -n monitoring -- \
  find /prometheus -type f -mmin +60 2>/dev/null | wc -l
# Expected: >0 files older than 60 minutes (means data retained)

# Result: ☐ PASS ☐ FAIL
```

### 12.3 Verify Loki Has Logs

```bash
# Query Loki for log entries
curl -s -G -d 'query={namespace="monitoring"}' http://localhost:3100/loki/api/v1/query | jq '.data.result | length' 2>/dev/null || echo "Loki query failed"

# Alternative: Check from Grafana Explore tab
# Expected: Log entries visible when querying {namespace="monitoring"}

# Result: ☐ PASS ☐ FAIL
```

---

## Section 13: Performance Baseline

### 13.1 Measure Query Performance

```bash
# Time a simple query
time curl -s 'http://localhost:9090/api/v1/query?query=up' > /dev/null
# Expected: Query completes in <1 second

# Time a complex query
time curl -s 'http://localhost:9090/api/v1/query_range?query=rate(prometheus_http_requests_total[5m])&start=$(date -d '1 hour ago' +%s)&end=$(date +%s)&step=60' > /dev/null
# Expected: Query completes in <5 seconds

# Result: ☐ PASS ☐ FAIL
```

### 13.2 Monitor Resource Usage

```bash
# Check current resource usage
kubectl top pods -n monitoring
# Expected: No pods exceeding requested resources

# Check node capacity
kubectl top nodes
# Expected: Node utilization <70% (healthy headroom)

# Result: ☐ PASS ☐ FAIL
```

---

## Section 14: Integration Tests

### 14.1 Test Alert Firing

```bash
# Create test alert (optional - only if safe in environment)
# Note: Skip in production unless explicitly testing

# Instead, verify alert rules syntax
kubectl get prometheusrule -n monitoring -o jsonpath='{.items[0].spec.groups[0].rules[0].alert}'
# Expected: Alert name returned

# Result: ☐ PASS ☐ FAIL (mark pass if rules syntax valid)
```

### 14.2 Test Cross-Component Communication

```bash
# Test Prometheus → AlertManager
curl -s http://localhost:9090/api/v1/status | jq '.data.alertmanagers'
# Expected: AlertManager endpoints listed

# Test Grafana → Prometheus datasource
curl -s -u admin:<password> http://localhost:3000/api/datasources \
  | jq '.[] | select(.name=="prometheus-staging") | .jsonData.httpMethod'
# Expected: "GET" or similar

# Result: ☐ PASS ☐ FAIL
```

---

## Section 15: Documentation & Runbooks

### 15.1 Verify Runbook References

```bash
# Check alert annotations reference runbooks
kubectl get prometheusrule -n monitoring -o yaml | grep -i runbook | head -5
# Expected: runbook URLs in alert annotations

# Result: ☐ PASS ☐ FAIL
```

### 15.2 Verify Operator Access Documentation

```bash
# Files should be present:
# ☐ ACCESS_STAGING.md (component access instructions)
# ☐ VERIFY_STAGING.md (this document)
# ☐ ROLLBACK_STAGING.md (rollback procedures)
# ☐ deploy-staging.sh (automated deployment script)

# Result: ☐ PASS ☐ FAIL
```

---

## Final Verification Sign-Off

### Comprehensive Status Summary

```
☐ Section 1: Cluster Health - PASS/FAIL
☐ Section 2: Monitoring Pods - PASS/FAIL
☐ Section 3: Kubernetes Services - PASS/FAIL
☐ Section 4: Persistent Storage - PASS/FAIL
☐ Section 5: Prometheus Metrics - PASS/FAIL
☐ Section 6: Grafana Dashboards - PASS/FAIL
☐ Section 7: Loki Logs - PASS/FAIL
☐ Section 8: AlertManager - PASS/FAIL
☐ Section 9: High Availability - PASS/FAIL
☐ Section 10: Security - PASS/FAIL
☐ Section 11: Metrics Validation - PASS/FAIL
☐ Section 12: Data Collection - PASS/FAIL
☐ Section 13: Performance - PASS/FAIL
☐ Section 14: Integration Tests - PASS/FAIL
☐ Section 15: Documentation - PASS/FAIL
```

### Overall Deployment Status

```
☐ ALL SECTIONS PASS - Deployment Complete & Operational
☐ SOME FAILURES - Review failed sections and troubleshoot
☐ CRITICAL FAILURES - Rollback recommended (see ROLLBACK_STAGING.md)
```

### Sign-Off

```
Verification Completed: ________________
Verified By: ________________
Date: ________________

Notes/Issues Found:
____________________________________________________________
____________________________________________________________
____________________________________________________________
```

---

## Next Steps

### If All Tests Pass ✓
1. Document baseline metrics for future comparison
2. Share access credentials with team (securely)
3. Begin monitoring for first 24 hours
4. Schedule review meeting with operations team

### If Issues Found ⚠️
1. Document specific failures above
2. Review troubleshooting section in relevant README
3. Check component logs: `kubectl logs -n monitoring <pod-name>`
4. Escalate if unable to resolve

### If Critical Failures ✗
1. See [`ROLLBACK_STAGING.md`](ROLLBACK_STAGING.md)
2. Execute rollback procedure
3. Post-mortem investigation
4. Re-deploy after fixing issues

---

## Troubleshooting Reference

| Issue | Check |
|-------|-------|
| Pod not starting | `kubectl describe pod -n monitoring <pod-name>` |
| PVC stuck pending | `kubectl describe pvc -n monitoring <pvc-name>` |
| Prometheus targets down | `http://localhost:9090/targets` (UI) |
| Grafana no data | Check datasource connectivity in Configuration |
| Loki no logs | Verify Promtail DaemonSet running on all nodes |
| AlertManager not routing | Check secret webhooks and routing config |

---

## References

- **Deployment Checklist:** [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md)
- **Installation Guide:** [`INSTALL_STAGING.md`](INSTALL_STAGING.md)
- **Access Instructions:** [`ACCESS_STAGING.md`](ACCESS_STAGING.md)
- **Rollback Procedure:** [`ROLLBACK_STAGING.md`](ROLLBACK_STAGING.md)
- **Architecture Design:** [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- **Prometheus README:** [`infra/prometheus/README.md`](prometheus/README.md)
- **Grafana README:** [`infra/grafana/README.md`](grafana/README.md)
