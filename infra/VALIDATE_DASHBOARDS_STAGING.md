# Staging Observability Stack - Dashboard Validation Guide

## Overview
This guide validates that all three dashboards display correctly with live data from the staging cluster.

**Prerequisites:**
- Grafana deployed and accessible
- Prometheus and Loki datasources configured
- At least 1 hour of metric/log collection
- Valid Grafana API token or admin login credentials

---

## Dashboard Access

### Setup Port-Forward

```bash
kubectl -n monitoring port-forward svc/grafana 3000:3000 &
# Access at http://localhost:3000
# Default login: admin:admin (change in production)
```

### Get API Token

```bash
# If using API token authentication
curl -X POST 'http://localhost:3000/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"user":"admin","password":"admin"}' | jq '.token'
# Store token for API requests: TOKEN="eyJrOiI..."
```

---

## Dashboard 1: Router Health Overview

### Dashboard Details

**File Location:** `infra/dashboards/router-health-overview.json`

**Dashboard UID:** `router-overview`

**Refresh Interval:** 30 seconds

**Time Range Default:** Last 24 hours

### Access Dashboard

```bash
# Via UI
open http://localhost:3000/d/router-overview/router-health-overview

# Via API
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin \
  | jq '.dashboard | {title, refresh, panels: (.panels | length), tags}'
```

### Panel 1: Availability Gauge

**Expected:**
- Title: "Availability (%)"
- Type: Gauge
- Metric: `router:availability`
- Display: Percentage (0-100%) or decimal (0-1)
- Color: Green if >99%, yellow if 95-99%, red if <95%

**Validation:**

```bash
# Query availability metric
curl -s 'http://localhost:9090/api/v1/query?query=router:availability' \
  | jq '.data.result[0].value'
# Expected: Value between 0.95-1.0
```

Check panel rendering:

```bash
# Verify panel data
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin \
  | jq '.dashboard.panels[] | select(.title=="Availability (%)")'
# Expected: Panel with gauge visualization
```

**Success Criteria:**
- Panel displays availability percentage
- Value between 0-100% (or 0-1)
- Gauge shows correct color coding
- Value matches Prometheus query result

---

### Panel 2: P99 Latency Stat

**Expected:**
- Title: "P99 Latency"
- Type: Stat
- Metric: `router:latency:p99`
- Display: Milliseconds
- Color: Green if <200ms, yellow if 200-500ms, red if >500ms

**Validation:**

```bash
# Query p99 latency
curl -s 'http://localhost:9090/api/v1/query?query=router:latency:p99' \
  | jq '.data.result[0].value'
# Expected: Latency in milliseconds (100-500 typical)
```

Check panel configuration:

```bash
# Verify panel setup
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin \
  | jq '.dashboard.panels[] | select(.title=="P99 Latency")'
# Expected: Stat panel with millisecond unit
```

**Success Criteria:**
- Panel displays latency in milliseconds
- Value <500ms (green if <200ms)
- Stat shows current value with trend
- Unit correctly set to "ms"

---

### Panel 3: Error Rate Stat

**Expected:**
- Title: "Error Rate"
- Type: Stat
- Metric: `router:error_rate`
- Display: Percentage
- Color: Green if <1%, yellow if 1-5%, red if >5%

**Validation:**

```bash
# Query error rate
curl -s 'http://localhost:9090/api/v1/query?query=router:error_rate' \
  | jq '.data.result[0].value'
# Expected: Error rate percentage (<1% typical)
```

**Success Criteria:**
- Panel displays error rate as percentage
- Value <1% (green color)
- Shows trend indicator
- Thresholds correctly configured

---

### Panel 4: Requests/Sec Graph

**Expected:**
- Title: "Requests/Sec"
- Type: Time series graph
- Metric: `rate(clarityrouter_requests_total[1m])`
- Time Range: Last 24 hours
- Display: Line graph with legend

**Validation:**

```bash
# Query requests per second
CURRENT=$(date +%s)
START=$((CURRENT - 86400))
curl -s "http://localhost:9090/api/v1/query_range?query=rate(clarityrouter_requests_total[1m])&start=$START&end=$CURRENT&step=300" \
  | jq '.data.result | length'
# Expected: >0 (at least one time series)
```

Verify graph shows multiple data points:

```bash
# Check data points over 24 hours
curl -s "http://localhost:9090/api/v1/query_range?query=rate(clarityrouter_requests_total[1m])&start=$START&end=$CURRENT&step=300" \
  | jq '.data.result[0].values | length'
# Expected: >100 (data points every 5 minutes over 24 hours)
```

**Success Criteria:**
- Graph displays requests per second trend
- Multiple data points visible
- Shows variation over 24 hours
- Legend shows individual instances
- Y-axis labeled in requests/sec

---

### Panel 5: Pod Status Table

**Expected:**
- Title: "Pod Status"
- Type: Table
- Columns: Pod Name, Status, CPU (%), Memory (%), Restarts
- Data Source: Prometheus

**Validation:**

```bash
# Query pod status
curl -s 'http://localhost:9090/api/v1/query?query=kubernetes_pod_info{namespace="clarity-router-staging"}' \
  | jq '.data.result | length'
# Expected: >0 (at least one pod)
```

Verify pod metrics:

```bash
# Check pod resource usage
curl -s 'http://localhost:9090/api/v1/query?query=rate(container_cpu_usage_seconds_total{namespace="clarity-router-staging"}[5m])' \
  | jq '.data.result[] | {pod: .metric.pod, cpu: .value}'
# Expected: CPU usage values for each pod
```

**Success Criteria:**
- Table displays all running pods
- Pod names and status visible
- CPU/Memory percentages calculated and shown
- Restart counts displayed
- All columns populated

---

### Panel 6: SLO Status Panel

**Expected:**
- Title: "SLO Status"
- Type: Stat or gauge
- Metrics: All SLO targets
- Status: Green if all met, red if any breached

**Validation:**

```bash
# Check SLO metrics
curl -s 'http://localhost:9090/api/v1/query?query=slo_target_latency' \
  | jq '.data.result[] | {slo: .metric.slo, target: .value}'
# Expected: SLO targets met
```

**Success Criteria:**
- Panel shows all SLO metrics
- Status indicates "All targets met" (green)
- Updates in real-time
- Links to detail dashboard

---

## Dashboard 2: Performance Details

### Dashboard Details

**File Location:** `infra/dashboards/performance-details.json`

**Dashboard UID:** `performance-details`

**Refresh Interval:** 15 seconds (real-time)

**Time Range Default:** Last 4 hours

### Access Dashboard

```bash
# Via UI
open http://localhost:3000/d/performance-details/performance-details

# Via API
curl -s 'http://localhost:3000/api/dashboards/uid/performance-details' -u admin:admin \
  | jq '.dashboard | {title, refresh, panels: (.panels | length)}'
```

### Panel 1: Latency Heatmap

**Expected:**
- Title: "Latency Distribution"
- Type: Heatmap
- Metric: `histogram_quantile` across buckets
- Display: Time-based heatmap showing latency distribution

**Validation:**

```bash
# Query latency histogram
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_request_latency_ms' \
  | jq '.data.result | map(.metric) | unique'
# Expected: Multiple quantile labels (0.50, 0.95, 0.99)
```

**Success Criteria:**
- Heatmap shows latency distribution over time
- Color intensity indicates frequency
- Axis shows latency percentiles
- Dark areas show typical latencies
- Bright areas show outliers

---

### Panel 2: Error Breakdown

**Expected:**
- Title: "Error Types"
- Type: Bar chart or pie chart
- Metric: Errors grouped by type
- Display: Count of each error type

**Validation:**

```bash
# Query error breakdown
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_errors_total' \
  | jq '.data.result[] | {error_type: .metric.error_type, count: .value}'
# Expected: Different error types with counts
```

**Success Criteria:**
- Chart displays all error types
- Counts accurate and up-to-date
- Legend shows each error type
- Responsive to error spikes

---

### Panel 3: Pod CPU Trends

**Expected:**
- Title: "Pod CPU Usage"
- Type: Time series graph
- Metric: `rate(container_cpu_usage_seconds_total[5m])`
- Display: Separate line per pod

**Validation:**

```bash
# Query CPU trends for router pods
curl -s 'http://localhost:9090/api/v1/query?query=rate(container_cpu_usage_seconds_total{namespace="clarity-router-staging"}[5m])' \
  | jq '.data.result | length'
# Expected: >0 (CPU data from pods)
```

**Success Criteria:**
- Graph shows CPU trend for each pod
- Y-axis in CPU cores (0-2 typical)
- Time range shows 4 hours
- Lines smooth and interpretable
- Legend identifies each pod

---

### Panel 4: Pod Memory Trends

**Expected:**
- Title: "Pod Memory Usage"
- Type: Time series graph
- Metric: `container_memory_usage_bytes`
- Display: Separate line per pod

**Validation:**

```bash
# Query memory trends
curl -s 'http://localhost:9090/api/v1/query?query=container_memory_usage_bytes{namespace="clarity-router-staging"}' \
  | jq '.data.result | length'
# Expected: >0 (memory data from pods)
```

**Success Criteria:**
- Graph shows memory trend for each pod
- Y-axis in gigabytes (0-2 typical)
- Time range shows 4 hours
- Lines show stable memory usage
- No sharp spikes indicating leaks

---

### Panel 5: Goroutine Count

**Expected:**
- Title: "Goroutine Count"
- Type: Time series graph
- Metric: `process_go_goroutines` or similar
- Display: Goroutine count over time

**Validation:**

```bash
# Query goroutine metrics
curl -s 'http://localhost:9090/api/v1/query?query=go_goroutines' \
  | jq '.data.result[] | {instance: .metric.instance, goroutines: .value}'
# Expected: Goroutine counts per instance
```

**Success Criteria:**
- Graph shows stable goroutine count
- No continuous growth (leak indicator)
- Count stable around baseline
- Spikes correlate with request spikes

---

### Panel 6: Network I/O

**Expected:**
- Title: "Network I/O"
- Type: Time series graph
- Metric: `rate(container_network_transmit_bytes_total[5m])`
- Display: Bytes sent/received per pod

**Validation:**

```bash
# Query network metrics
curl -s 'http://localhost:9090/api/v1/query?query=rate(container_network_transmit_bytes_total{namespace="clarity-router-staging"}[5m])' \
  | jq '.data.result | length'
# Expected: >0 (network data available)
```

**Success Criteria:**
- Graph shows network throughput
- Y-axis in bytes/sec
- Shows separate send/receive rates
- Correlation with request rate expected
- No unexplained traffic spikes

---

## Dashboard 3: Infrastructure Health

### Dashboard Details

**File Location:** `infra/dashboards/infrastructure-health.json`

**Dashboard UID:** `infra-health`

**Refresh Interval:** 30 seconds

**Time Range Default:** Last 24 hours

### Access Dashboard

```bash
# Via UI
open http://localhost:3000/d/infra-health/infrastructure-health

# Via API
curl -s 'http://localhost:3000/api/dashboards/uid/infra-health' -u admin:admin \
  | jq '.dashboard | {title, refresh, panels: (.panels | length)}'
```

### Panel 1: Node CPU Gauge

**Expected:**
- Title: "Node CPU Usage (%)"
- Type: Gauge
- Metric: CPU usage per node
- Display: Percentage (0-100%)
- Color: Green if <80%, yellow if 80-90%, red if >90%

**Validation:**

```bash
# Query node CPU usage
curl -s 'http://localhost:9090/api/v1/query?query=100*(1-avg by(node)(rate(node_cpu_seconds_total{mode="idle"}[5m])))' \
  | jq '.data.result[] | {node: .metric.node, cpu_percent: .value}'
# Expected: All nodes <80%
```

**Success Criteria:**
- Gauge shows CPU usage per node
- All nodes green (<80%)
- Values match expected load
- Thresholds appropriately set

---

### Panel 2: Node Memory Gauge

**Expected:**
- Title: "Node Memory Usage (%)"
- Type: Gauge
- Metric: Memory usage per node
- Display: Percentage (0-100%)
- Color: Green if <80%, yellow if 80-90%, red if >90%

**Validation:**

```bash
# Query node memory usage
curl -s 'http://localhost:9090/api/v1/query?query=100*(1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)' \
  | jq '.data.result[] | {node: .metric.node, memory_percent: .value}'
# Expected: All nodes <80%
```

**Success Criteria:**
- Gauge shows memory usage per node
- All nodes green (<80%)
- Values indicate healthy memory state
- No node at critical levels

---

### Panel 3: Disk Usage Graph

**Expected:**
- Title: "Disk Usage %"
- Type: Time series graph
- Metric: `node_filesystem_avail_bytes`
- Display: Available space trend per filesystem

**Validation:**

```bash
# Query disk usage
curl -s 'http://localhost:9090/api/v1/query?query=100*(1-node_filesystem_avail_bytes/node_filesystem_size_bytes)' \
  | jq '.data.result[] | {device: .metric.device, usage_percent: .value}'
# Expected: All filesystems <80% full
```

**Success Criteria:**
- Graph shows disk usage trends
- All filesystems <80% full
- Available space visible on Y-axis
- Growth rate sustainable

---

### Panel 4: PVC Usage

**Expected:**
- Title: "PVC Usage"
- Type: Bar chart or table
- Metrics: PVC capacity and current usage
- Display: Usage percentage per PVC

**Validation:**

```bash
# Query PVC usage
kubectl -n monitoring get pvc -o json | jq '.items[] | {name: .metadata.name, capacity: .spec.resources.requests.storage, status: .status.capacity.storage}'
# Expected: <50% full for each PVC
```

**Success Criteria:**
- All PVCs listed with current usage
- Prometheus PVC <50% full
- Loki PVC <50% full
- Growth rates sustainable

---

### Panel 5: Certificate Expiry

**Expected:**
- Title: "Certificate Expiry"
- Type: Stat or gauge
- Metric: Days until certificate expiration
- Color: Green if >30d, yellow if 14-30d, red if <14d

**Validation:**

```bash
# Query certificate expiry metrics
curl -s 'http://localhost:9090/api/v1/query?query=certmanager_certificate_expiration_timestamp_seconds' \
  | jq '.data.result[] | {certificate: .metric.name, days_until_expiry: ((.value[1] | tonumber - now) / 86400)}'
# Expected: All certificates >30 days remaining
```

**Success Criteria:**
- All certificates show expiry time
- All >30 days remaining (green)
- Warning for <30 days (yellow)
- Critical if <7 days (red)

---

### Panel 6: Node Pressure Status

**Expected:**
- Title: "Node Pressure"
- Type: Status panel or table
- Metrics: CPU Pressure, Memory Pressure, Disk Pressure
- Display: Status for each node

**Validation:**

```bash
# Query node conditions
kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, conditions: (.status.conditions[] | select(.type | IN("MemoryPressure", "DiskPressure", "PIDPressure")) | {type: .type, status: .status})}'
# Expected: All conditions "False"
```

**Success Criteria:**
- All nodes show healthy status
- No CPU/Memory/Disk pressure indicators
- All conditions "False"
- Panel clearly indicates health

---

## Cross-Dashboard Navigation

### Dashboard Linking

Verify dashboard links work correctly:

```bash
# Test link from Router Health to Performance Details
curl -s 'http://localhost:3000/d/router-overview' -u admin:admin | \
  jq '.dashboard | {title, links: .links}'
# Expected: Links present to other dashboards
```

### Variable Selectors

Verify dashboard variables work:

```bash
# Check for variable support (cluster, namespace, pod)
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | \
  jq '.dashboard.templating.list[] | {name, type, current}'
# Expected: Variables for filtering (cluster, namespace, pod)
```

---

## Dashboard Rendering Verification

### Browser Console Check

Open each dashboard in browser and check browser console for errors:

```bash
# Open in Firefox/Chrome and press F12 to open DevTools
# Go to Console tab
# Verify no red error messages
# Check Network tab for failed requests (all should be 200/304)
```

### API Health Check

```bash
# Verify datasources are healthy
curl -s 'http://localhost:3000/api/datasources' -u admin:admin | \
  jq '.[] | {name, type, healthy}'
# Expected: All datasources showing healthy=true
```

### Panel Query Validation

```bash
# Verify each panel's queries run without error
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | \
  jq '.dashboard.panels[] | {title, targets: .targets}'
# Expected: Each panel has valid targets
```

---

## Performance Benchmarks

### Dashboard Load Time

```bash
# Measure dashboard load time
time curl -s 'http://localhost:3000/d/router-overview' > /dev/null
# Expected: <2 seconds
```

### Panel Rendering Time

Open dashboard in browser and check:
- Initial load: <3 seconds
- Panel rendering: <2 seconds per panel
- Refresh: <1 second

---

## Success Checklist

### Router Health Overview Dashboard
- [ ] Dashboard loads without errors
- [ ] Availability gauge displays percentage (0-100%)
- [ ] P99 latency stat shows milliseconds
- [ ] Error rate stat shows percentage (<1%)
- [ ] Requests/sec graph shows 24-hour trend
- [ ] Pod status table lists all running pods
- [ ] SLO status panel shows all targets met
- [ ] All panels have data populated
- [ ] Refresh interval (30s) working correctly

### Performance Details Dashboard
- [ ] Dashboard loads without errors
- [ ] Latency heatmap shows distribution
- [ ] Error breakdown chart shows error types
- [ ] Pod CPU graph shows trends for all pods
- [ ] Pod memory graph shows trends for all pods
- [ ] Goroutine count stable (no leaks)
- [ ] Network I/O graph shows throughput
- [ ] All panels have data populated
- [ ] Refresh interval (15s) working correctly

### Infrastructure Health Dashboard
- [ ] Dashboard loads without errors
- [ ] Node CPU gauges show <80% usage
- [ ] Node memory gauges show <80% usage
- [ ] Disk usage graph shows all filesystems
- [ ] PVC usage shows Prometheus/Loki <50% full
- [ ] Certificate expiry shows >30 days
- [ ] Node pressure shows all healthy
- [ ] All panels have data populated
- [ ] Refresh interval (30s) working correctly

### Cross-Dashboard Features
- [ ] Variable selectors work ($cluster, $namespace, $pod)
- [ ] Links to other dashboards functional
- [ ] Time range selector works on all dashboards
- [ ] Refresh button triggers updates
- [ ] No error messages in browser console
- [ ] All datasources healthy and accessible
