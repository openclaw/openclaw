# Staging Observability Stack - Component Testing Guide

## Overview
This guide provides step-by-step procedures to verify each component of the observability stack is operational in the staging environment.

**Prerequisites:**
- Access to staging cluster with kubectl configured
- Pods running in `monitoring` namespace
- Network access to service endpoints
- curl installed locally

---

## Prometheus Testing

### Health Check
Verify Prometheus API is responsive:

```bash
# Test Prometheus health endpoint (on any replica)
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &
curl -s http://localhost:9090/-/healthy
# Expected: HTTP 200
```

**Success Criteria:** Returns 200 status code

---

### Metrics Collection Verification
Verify Prometheus is collecting metrics from targets:

```bash
# Query the "up" metric to see target count
curl -s 'http://localhost:9090/api/v1/query?query=count(up)' | jq '.data.result[0].value'
# Expected: ≥50 targets
```

Check detailed target status:

```bash
# Access Prometheus UI and check Targets page
# http://localhost:9090/targets
# OR query API for target states:
curl -s 'http://localhost:9090/api/v1/targets' | jq '.data.activeTargets[0:5] | map({job, state})'
# Expected: All targets show state="up"
```

**Success Criteria:**
- At least 50 targets in "UP" state
- Target scrape jobs: prometheus, kubernetes-apiservers, kubernetes-nodes, kubernetes-pods, kubernetes-kubelet, kubernetes-cadvisor, kube-state-metrics, node-exporter
- Scrape completion time <30 seconds

---

### Data Persistence
Verify metrics are persisted over time:

```bash
# Query a metric from 1 hour ago
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=3600&end=0&step=300' \
  | jq '.data.result | length'
# Expected: >0 (some metrics from past hour)
```

Verify retention:

```bash
# Check that data older than 1 hour is available
CURRENT_TIME=$(date +%s)
START_TIME=$((CURRENT_TIME - 3600))
curl -s "http://localhost:9090/api/v1/query_range?query=rate(prometheus_tsdb_symbol_table_size_bytes[5m])&start=$START_TIME&end=$CURRENT_TIME&step=300" \
  | jq '.data.result | length'
# Expected: >0
```

**Success Criteria:**
- Metrics available from at least 1 hour ago
- Time-series data points visible in historical range
- No gaps in data collection

---

### Configuration Reload
Verify alerting rules are loaded:

```bash
# Check alerting rules via API
curl -s 'http://localhost:9090/api/v1/rules' | jq '.data.groups | map({name, interval, rules: (.rules | length)})'
# Expected: Multiple rule groups with rules loaded
```

Expected rule groups:
- kubernetes_alerts
- pod_alerts  
- node_alerts
- application_alerts

**Success Criteria:**
- At least 4 rule groups loaded
- Rules count >10
- Last evaluation time recent (within last evaluation interval)

---

### Replication
Verify both Prometheus replicas have matching data:

```bash
# Port-forward to Prometheus 0
kubectl -n monitoring port-forward pod/prometheus-0 9090:9090 &
PROM0_COUNT=$(curl -s 'http://localhost:9090/api/v1/query?query=count(up)' \
  | jq '.data.result[0].value[1]')

# Port-forward to Prometheus 1
kubectl -n monitoring port-forward pod/prometheus-1 9090:9090 &
PROM1_COUNT=$(curl -s 'http://localhost:9090/api/v1/query?query=count(up)' \
  | jq '.data.result[0].value[1]')

echo "Prometheus-0 targets: $PROM0_COUNT"
echo "Prometheus-1 targets: $PROM1_COUNT"
# Expected: Both should be equal or within 1% difference
```

**Success Criteria:**
- Both replicas have same metric count (within 1%)
- Data timestamps match (within 5 seconds)
- Both serve queries independently

---

## Grafana Testing

### Service Health
Verify Grafana API is accessible:

```bash
kubectl -n monitoring port-forward svc/grafana 3000:3000 &
curl -s 'http://localhost:3000/api/health' | jq '.'
# Expected: HTTP 200, commit, version present
```

**Success Criteria:** Returns 200 with health status

---

### Dashboard Loading
Verify all dashboards are accessible via API:

```bash
# List all dashboards
curl -s 'http://localhost:3000/api/search?query=' -H 'Authorization: Bearer YOUR_API_TOKEN' | jq '.[].title'

# Expected dashboard titles:
# - "Router Health Overview"
# - "Performance Details" 
# - "Infrastructure Health"
```

If no API token, login first:

```bash
# Login (default admin:admin)
curl -X POST 'http://localhost:3000/api/datasources' \
  -H 'Content-Type: application/json' \
  -d '{...}' \
  -u admin:admin

# Test with basic auth:
curl -s 'http://localhost:3000/api/health' -u admin:admin
```

Load each dashboard and verify no errors:

```bash
# Get dashboard by UID
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | jq '.dashboard | {title, refresh, panels: (.panels | length)}'
```

**Success Criteria:**
- All 3 dashboards return status 200
- Each dashboard has >4 panels
- No error messages in response

---

### Datasource Connectivity
Verify datasources are configured and working:

```bash
# List datasources
curl -s 'http://localhost:3000/api/datasources' -u admin:admin | jq '.[] | {name, type, healthy}'

# Expected datasources:
# - Prometheus (type: prometheus, healthy: true)
# - Loki (type: loki, healthy: true)
```

Test Prometheus datasource:

```bash
# Test query against Prometheus datasource
curl -s 'http://localhost:3000/api/datasources/proxy/1/api/v1/query?query=up' -u admin:admin | jq '.data.result | length'
# Expected: >0
```

Test Loki datasource:

```bash
# Test query against Loki datasource
curl -s 'http://localhost:3000/api/datasources/proxy/2/api/v1/query_range?query={cluster="staging"}' -u admin:admin | jq '.data.result | length'
# Expected: >0
```

**Success Criteria:**
- Both datasources configured
- Both show healthy=true
- Test queries return data without errors

---

### Authentication
Verify default admin user can login:

```bash
# Test login (default: admin:admin, CHANGE IN PRODUCTION)
curl -X POST 'http://localhost:3000/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"user":"admin","password":"admin"}'
# Expected: HTTP 200, returns auth token
```

**Success Criteria:**
- Login returns valid authentication token
- Token can be used for subsequent API calls

---

### Panel Rendering
Verify each dashboard panel renders correctly:

```bash
# Get dashboard and check panel queries
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | \
  jq '.dashboard.panels[] | {title, type, targets: (.targets | length)}'

# Expected: Each panel has at least 1 target configured
```

Verify panels have data:

```bash
# Check panel query execution
for i in 1 2 3 4 5; do
  curl -s "http://localhost:3000/api/dashboards/uid/router-overview" -u admin:admin | \
    jq ".dashboard.panels[$i] | {title, type}"
done
```

**Success Criteria:**
- All panels have queries configured
- Panels render without errors (check browser console)
- Panels display data from past 24 hours

---

### Grafana High Availability
Verify both Grafana replicas are accessible:

```bash
# Check both replicas
kubectl -n monitoring get pods -l app=grafana -o wide
# Expected: 2 pods in Running state

# Port-forward to pod 0
kubectl -n monitoring port-forward pod/grafana-0 3000:3000 &
curl -s 'http://localhost:3000/api/health' | jq '.version'

# Port-forward to pod 1
kubectl -n monitoring port-forward pod/grafana-1 3000:3000 &
curl -s 'http://localhost:3000/api/health' | jq '.version'
# Both should return version number
```

Verify load balancer routing:

```bash
# Test load balancer endpoint
for i in {1..5}; do
  curl -s 'http://localhost:3000/api/health' | jq '.commit'
done
# Expected: Requests distributed across replicas (check in logs)
```

**Success Criteria:**
- Both Grafana pods healthy and running
- Load balancer accessible
- Connections properly distributed

---

## Loki Testing

### Health Check
Verify Loki is ready for log ingestion:

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100 &
curl -s 'http://localhost:3100/ready'
# Expected: HTTP 200
```

**Success Criteria:** Returns 200 "ready"

---

### Log Ingestion
Verify Loki is receiving logs from Promtail:

```bash
# Check ingester metrics
curl -s 'http://localhost:3100/loki/api/v1/label/job/values' | jq '.values'
# Expected: Labels like "promtail", "kubernetes", "kubelet", etc.
```

Check log streams:

```bash
# Query available log streams
curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values'
# Expected: Multiple labels (cluster, namespace, pod, container, etc.)
```

**Success Criteria:**
- Log streams available from multiple sources
- Recent logs present (within last hour)
- Metrics show successful ingestion rate

---

### Log Retention
Verify logs older than expected retention period are handled:

```bash
# Query logs from 24 hours ago
CURRENT_TIME=$(date +%s)000000000
START_TIME=$((CURRENT_TIME - 86400000000000))
curl -s "http://localhost:3100/loki/api/v1/query_range?query={cluster=\"staging\"}&start=$START_TIME&end=$CURRENT_TIME" \
  | jq '.data.result | length'
# Expected: >0 (logs available from past 24 hours)
```

Check retention policy:

```bash
# Query metrics for retention status
curl -s 'http://localhost:3100/loki/api/v1/label/pod/values' | jq '.values | length'
# Expected: Growing over time, but capped at 30-day retention
```

**Success Criteria:**
- Logs available for at least 24 hours
- 30-day retention policy in effect
- Old logs queued for deletion (not blocking queries)

---

### Query Performance
Benchmark log query latency:

```bash
# Simple label query
time curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' > /dev/null
# Expected: <500ms

# Range query
time curl -s 'http://localhost:3100/loki/api/v1/query_range?query={cluster="staging"}&start=3600&end=0&step=60' > /dev/null
# Expected: <2s

# Regex pattern query
time curl -s 'http://localhost:3100/loki/api/v1/query?query={job=~".*router.*", level="error"}' > /dev/null
# Expected: <2s
```

**Success Criteria:**
- Simple queries <500ms
- Range queries <2s
- Complex regex queries <2s
- No timeout errors

---

### Storage Utilization
Monitor Loki disk usage:

```bash
# Check PVC usage
kubectl -n monitoring get pvc loki-data -o json | jq '.status.capacity.storage, .status.allocatedResources.storage'

# Check pod disk usage
kubectl -n monitoring exec -it loki-0 -- df -h /loki/chunks
# Expected: <50% full
```

Check growth rate:

```bash
# Monitor for 1 minute and calculate growth
BEFORE=$(kubectl -n monitoring exec loki-0 -- du -sb /loki | awk '{print $1}')
sleep 60
AFTER=$(kubectl -n monitoring exec loki-0 -- du -sb /loki | awk '{print $1}')
GROWTH=$((AFTER - BEFORE))
echo "Growth rate: $GROWTH bytes/minute"
# Expected: <1GB per 24 hours
```

**Success Criteria:**
- Disk usage <50% of PVC capacity
- Growth rate sustainable (indicates 15+ days of logs)
- No storage pressure errors

---

### Loki Replication
Verify both Loki replicas have consistent data:

```bash
# Port-forward to Loki 0
kubectl -n monitoring port-forward pod/loki-0 3100:3100 &
LOKI0=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

# Port-forward to Loki 1
kubectl -n monitoring port-forward pod/loki-1 3100:3100 &
LOKI1=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

echo "Loki-0 unique labels: $LOKI0"
echo "Loki-1 unique labels: $LOKI1"
# Expected: Both should be equal or within 1%
```

**Success Criteria:**
- Both replicas have same index count (within 1%)
- Log data available on both replicas
- Replication lag <1 minute

---

## AlertManager Testing

### Health Check
Verify AlertManager is operational:

```bash
kubectl -n monitoring port-forward svc/alertmanager 9093:9093 &
curl -s 'http://localhost:9093/-/healthy'
# Expected: HTTP 200
```

**Success Criteria:** Returns 200 status code

---

### Configuration Status
Verify routing rules and receivers are loaded:

```bash
# Check AlertManager configuration
curl -s 'http://localhost:9093/api/v1/status' | jq '.config'
# Expected: Shows routing tree and receivers configuration
```

Verify receivers:

```bash
# List all configured receivers
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.receivers'
# Expected: 
# - slack-critical
# - slack-alerts  
# - slack-general
```

**Success Criteria:**
- Configuration loaded successfully
- At least 3 receivers configured
- Routing rules show proper grouping

---

### Silence Management
Test silence creation and deletion:

```bash
# Create a test silence
curl -X POST 'http://localhost:9093/api/v1/silences' \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [{"name":"alertname", "value":"TestAlert"}],
    "startsAt": "2024-01-01T00:00:00Z",
    "endsAt": "2024-01-01T01:00:00Z",
    "comment": "Test silence"
  }' | jq '.silenceID'
# Expected: Returns silence ID (e.g., "abc123...")
```

Verify silence is active:

```bash
# List active silences
curl -s 'http://localhost:9093/api/v1/silences' | jq '.data'
# Expected: Returns list including the test silence
```

Delete the silence:

```bash
# Delete by ID
curl -X DELETE 'http://localhost:9093/api/v1/silences/{silenceID}'
# Expected: HTTP 200
```

**Success Criteria:**
- Silence can be created and assigned ID
- Silence appears in active list
- Silence can be deleted without errors

---

### Alert Ingestion
Test alert reception:

```bash
# Send test alert to AlertManager
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestAlert",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "Test alert for validation",
      "description": "This is a test"
    },
    "startsAt": "2024-01-01T00:00:00Z"
  }]'
# Expected: HTTP 202 Accepted
```

Verify alert appears:

```bash
# Query alerts
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname=="TestAlert")'
# Expected: Alert appears in list
```

**Success Criteria:**
- Alert POST returns 202 Accepted
- Alert appears in query results within 5 seconds
- Alert has correct labels and annotations

---

### Notification Routing
Verify alerts route to configured Slack channels:

```bash
# Check routing configuration
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.route'
# Expected: Shows routing tree with severity-based routing
```

Expected routing:
- Severity: critical → #monitoring-staging-critical
- Severity: warning → #monitoring-staging-alerts
- Severity: info → #monitoring-staging-general

**Success Criteria:**
- Routing rules correctly configured
- Each severity has a target receiver
- No routing errors in logs

---

### Deduplication
Test alert grouping across replicas:

```bash
# Verify deduplication configuration
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.route.groupBy'
# Expected: ["alertname", "cluster", "severity"]
```

**Success Criteria:**
- Deduplication enabled
- Grouping labels configured
- Duplicate alerts from different replicas collapsed to single notification

---

## Troubleshooting

### Prometheus Pod Restart
If Prometheus pods are restarting:

```bash
# Check pod logs
kubectl -n monitoring logs -f deployment/prometheus --tail=50

# Check for configuration errors
kubectl -n monitoring get configmap prometheus-config -o yaml | grep -A5 'scrape_configs'

# Restart with new config
kubectl -n monitoring rollout restart deployment/prometheus
```

### Grafana Login Issues
If unable to login:

```bash
# Check Grafana logs
kubectl -n monitoring logs -f deployment/grafana

# Reset admin password
kubectl -n monitoring exec -it grafana-0 -- grafana-cli admin reset-admin-password newpassword

# Verify datasources
kubectl -n monitoring get configmap grafana-datasources -o yaml
```

### Loki Storage Full
If Loki is running out of space:

```bash
# Check current usage
kubectl -n monitoring exec loki-0 -- du -sh /loki

# Check retention policy
kubectl -n monitoring get configmap loki-config -o yaml | grep 'retention'

# Manually trigger compaction
kubectl -n monitoring exec loki-0 -- /loki -config.file=/etc/loki/local-config.yaml -config.expand-env=true -target=compactor
```

### AlertManager Not Routing Alerts
If alerts aren't reaching Slack:

```bash
# Check AlertManager logs
kubectl -n monitoring logs -f deployment/alertmanager

# Verify Slack webhook is configured
kubectl -n monitoring get secret alertmanager-secrets -o yaml | grep slack

# Check routing rules
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.route'

# Test manual alert
curl -X POST 'http://localhost:9093/api/v1/alerts' -d '[{"labels":{"alertname":"Test"}}]'
```

---

## Success Checklist

- [ ] Prometheus returns 200 on health check
- [ ] Prometheus has >50 targets in UP state
- [ ] Prometheus can query metrics from 1+ hour ago
- [ ] At least 4 rule groups loaded successfully
- [ ] Prometheus replicas have matching metric counts
- [ ] Grafana returns 200 on health check
- [ ] All 3 dashboards load without errors
- [ ] Prometheus and Loki datasources show healthy
- [ ] Default admin login successful
- [ ] All dashboard panels display data
- [ ] Both Grafana replicas accessible
- [ ] Loki returns 200 on ready check
- [ ] Logs visible from multiple sources
- [ ] Logs available from past 24 hours
- [ ] Log queries complete in <2s
- [ ] Loki disk usage <50%
- [ ] Both Loki replicas have matching indices
- [ ] AlertManager returns 200 on health check
- [ ] Routing rules and receivers configured
- [ ] Silence creation/deletion works
- [ ] Test alert can be posted and queried
- [ ] Alerts route to correct Slack channels
- [ ] Deduplication across replicas working
