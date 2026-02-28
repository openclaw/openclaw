# Staging Observability Stack - Data Collection Validation

## Overview
This guide validates that metrics and logs are being correctly collected, stored, and queryable in the staging observability stack.

**Prerequisites:**
- All components running and healthy (see TEST_COMPONENTS_STAGING.md)
- kubectl configured for staging cluster
- Prometheus and Loki port-forwards available
- At least 1 hour of data collection since deployment

---

## Metrics Validation (Prometheus)

### Router Metrics Collection

Verify clarityrouter application metrics are present:

```bash
# Query all router metrics
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_request_latency_ms' | jq '.data.result | length'
# Expected: >0 (at least one time series)
```

**Router Request Latency Metric:**

```bash
# Check for latency percentiles
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_request_latency_ms{quantile="0.99"}' \
  | jq '.data.result[] | {labels: .metric, value: .value}'
# Expected labels: {instance, job, quantile}
# Expected value: milliseconds (typically 100-500)
```

Verify latency distribution:

```bash
# Query p50, p95, p99 latencies
for percentile in 0.50 0.95 0.99; do
  echo "P$((percentile * 100)) latency:"
  curl -s "http://localhost:9090/api/v1/query?query=clarityrouter_request_latency_ms{quantile=\"$percentile\"}" \
    | jq '.data.result[0].value'
done
# Expected: P50 < P95 < P99
```

**Success Criteria:**
- Latency metric available with multiple quantiles
- P50, P95, P99 labels present
- Values in reasonable range (p99 typically <500ms)

---

**Router Requests Total Metric:**

```bash
# Check total requests counter (should be increasing)
BEFORE=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' \
  | jq '.data.result[0].value[1]')
sleep 10
AFTER=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' \
  | jq '.data.result[0].value[1]')
echo "Requests before: $BEFORE"
echo "Requests after: $AFTER"
# Expected: AFTER > BEFORE
```

**Success Criteria:**
- Requests counter exists and is incrementing
- Value increases over time (positive trend)

---

**Router Errors Total Metric:**

```bash
# Check error rate
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_errors_total' \
  | jq '.data.result[] | {labels: .metric, value: .value}'
# Expected: Value present but typically low (stable or slow growth)
```

Verify error rate percentage:

```bash
# Calculate error rate percentage
TOTAL=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' \
  | jq '.data.result[0].value[1]')
ERRORS=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_errors_total' \
  | jq '.data.result[0].value[1]')
ERROR_RATE=$(echo "scale=2; ($ERRORS / $TOTAL) * 100" | bc)
echo "Error rate: $ERROR_RATE%"
# Expected: <1%
```

**Success Criteria:**
- Error metric available
- Error rate stable and low (<1%)
- No sudden spikes

---

**Router Availability Metric:**

```bash
# Check availability metric (should be near 1.0)
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_router_availability' \
  | jq '.data.result[] | {instance: .metric.instance, value: .value}'
# Expected: Value between 0.95-1.0 (95-100% availability)
```

**Success Criteria:**
- Availability metric exists
- Value between 0.95-1.0 (95-100%)
- Consistent across all instances

---

### Kubernetes Metrics Collection

**Container CPU Usage:**

```bash
# Query CPU metrics for all containers
curl -s 'http://localhost:9090/api/v1/query?query=count(container_cpu_usage_seconds_total)' \
  | jq '.data.result[0].value'
# Expected: >100 (containers from all pods)
```

Sample container CPU data:

```bash
# Get CPU usage for monitoring namespace pods
curl -s 'http://localhost:9090/api/v1/query?query=rate(container_cpu_usage_seconds_total{namespace="monitoring"}[5m])' \
  | jq '.data.result[] | {pod: .metric.pod, cpu: .value}'
# Expected: CPU usage values in cores (0.1-2.0 typical)
```

**Success Criteria:**
- CPU metrics collected from all pods
- Values in reasonable range (cores)
- All namespaces represented

---

**Container Memory Usage:**

```bash
# Query memory metrics
curl -s 'http://localhost:9090/api/v1/query?query=count(container_memory_usage_bytes)' \
  | jq '.data.result[0].value'
# Expected: >100 (containers from all pods)
```

Sample memory data:

```bash
# Get memory usage for monitoring pods (convert to GB)
curl -s 'http://localhost:9090/api/v1/query?query=container_memory_usage_bytes{namespace="monitoring"}' \
  | jq '.data.result[] | {pod: .metric.pod, memory_gb: (.value[1] | tonumber / (1024*1024*1024) | round / 1)}'
# Expected: Memory values in gigabytes (0.05-2.0 typical)
```

**Success Criteria:**
- Memory metrics collected from all containers
- Values in reasonable range (bytes)
- All namespaces represented

---

**Node Memory Available:**

```bash
# Query available memory per node
curl -s 'http://localhost:9090/api/v1/query?query=node_memory_MemAvailable_bytes' \
  | jq '.data.result[] | {node: .metric.node, available_gb: (.value[1] | tonumber / (1024*1024*1024) | round / 1)}'
# Expected: All nodes showing available memory, typically >10GB
```

**Success Criteria:**
- Memory available queried from all nodes
- Values in expected range for cluster size
- No nodes showing critical low memory

---

**Pod Start Duration:**

```bash
# Query pod startup time metrics
curl -s 'http://localhost:9090/api/v1/query?query=kubelet_pod_start_duration_seconds' \
  | jq '.data.result[] | {namespace: .metric.namespace, value: .value}'
# Expected: Duration values in seconds (typically 5-30s)
```

**Success Criteria:**
- Pod lifecycle metrics collected
- Startup times in expected range
- Useful for SLO tracking

---

### Recording Rules Evaluation

**Verify Recording Rules Are Computed:**

```bash
# Query recording rules status
curl -s 'http://localhost:9090/api/v1/rules?type=record' \
  | jq '.data.groups[] | {name, rules: (.rules | length), state: .rules[0].state}'
# Expected: Multiple rule groups with state="ok"
```

**Router Latency P50 Recording Rule:**

```bash
# Query p50 latency computed value
curl -s 'http://localhost:9090/api/v1/query?query=router:latency:p50' \
  | jq '.data.result[] | {cluster: .metric.cluster, latency_ms: .value}'
# Expected: Computed value for latency p50
```

Verify rule evaluation:

```bash
# Check last evaluation time
curl -s 'http://localhost:9090/api/v1/rules?type=record' \
  | jq '.data.groups[] | select(.name == "router_latency") | .rules[] | {name, lastEvaluation}'
# Expected: Recent timestamp (within last 5 minutes)
```

**Success Criteria:**
- P50 latency rule evaluated
- Value computed correctly
- Evaluation interval <5 minutes

---

**Router Latency P99 Recording Rule:**

```bash
# Query p99 latency computed value
curl -s 'http://localhost:9090/api/v1/query?query=router:latency:p99' \
  | jq '.data.result[] | {cluster: .metric.cluster, latency_ms: .value}'
# Expected: Higher value than p50
```

**Success Criteria:**
- P99 latency rule evaluated
- Value higher than p50
- Updated regularly

---

**Router Error Rate Recording Rule:**

```bash
# Query error rate computed value
curl -s 'http://localhost:9090/api/v1/query?query=router:error_rate' \
  | jq '.data.result[] | {cluster: .metric.cluster, error_rate: .value}'
# Expected: Error rate percentage (typically <1%)
```

**Success Criteria:**
- Error rate rule evaluated
- Value in percentage format
- Stable over time

---

**Router Availability Recording Rule:**

```bash
# Query availability computed value
curl -s 'http://localhost:9090/api/v1/query?query=router:availability' \
  | jq '.data.result[] | {cluster: .metric.cluster, availability: .value}'
# Expected: Availability percentage (0.95-1.0)
```

**Success Criteria:**
- Availability rule evaluated
- Value between 0-1 (or 0-100%)
- Reflects cluster health

---

## Logs Validation (Loki)

### Log Ingestion from All Namespaces

**Verify Default Namespace Logs:**

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100 &

# Query logs from default namespace
curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="default"}' \
  | jq '.data.result | length'
# Expected: >0 logs
```

**Verify kube-system Namespace Logs:**

```bash
# Query Kubernetes system logs
curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="kube-system"}' \
  | jq '.data.result | length'
# Expected: >0 logs (DNS, API server, etc.)
```

**Verify Monitoring Namespace Logs:**

```bash
# Query observability stack logs
curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="monitoring"}' \
  | jq '.data.result | length'
# Expected: >0 logs (Prometheus, Grafana, Loki, AlertManager)
```

**Verify Application Namespace Logs:**

```bash
# Query application logs (replace with actual app namespace)
curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="clarity-router-staging"}' \
  | jq '.data.result | length'
# Expected: >0 logs (if application deployed)
```

**Success Criteria:**
- Logs ingested from at least 3 namespaces
- Each namespace has recent log entries
- No namespace is missing logs

---

### Log Format Validation

**Verify JSON Log Parsing:**

```bash
# Query logs and check for structured fields
curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="monitoring"} | json' \
  | jq '.data.result[0].values | .[0] | .[1] | fromjson | keys'
# Expected: JSON fields like timestamp, level, message, etc.
```

**Success Criteria:**
- Logs are in JSON format
- Structured fields are parsed
- Standard fields present (timestamp, level, message)

---

### Kubelet Log Collection

**Verify Kubelet Metrics Logs:**

```bash
# Query kubelet logs
curl -s 'http://localhost:3100/loki/api/v1/query?query={job="kubelet"}' \
  | jq '.data.result | length'
# Expected: >0 logs
```

**Check Kubelet Log Content:**

```bash
# Sample kubelet log entries
curl -s 'http://localhost:3100/loki/api/v1/query?query={job="kubelet"}' \
  | jq '.data.result[0].values | .[0:2] | .[] | .[1]'
# Expected: Kubelet operational logs
```

**Success Criteria:**
- Kubelet logs being collected
- Logs contain relevant kubelet events
- Regular log entries (not stale)

---

### Log Label Validation

**Verify Cluster Label:**

```bash
# Query unique cluster values
curl -s 'http://localhost:3100/loki/api/v1/label/cluster/values' \
  | jq '.values'
# Expected: ["staging"] or ["staging", ...]
```

**Verify Namespace Labels:**

```bash
# Query unique namespace values
curl -s 'http://localhost:3100/loki/api/v1/label/namespace/values' \
  | jq '.values | length'
# Expected: >3 (at least default, kube-system, monitoring)
```

**Verify Pod Labels:**

```bash
# Query pod labels
curl -s 'http://localhost:3100/loki/api/v1/label/pod/values' \
  | jq '.values | length'
# Expected: >10 (multiple pods running)
```

**Verify Container Labels:**

```bash
# Query container labels
curl -s 'http://localhost:3100/loki/api/v1/label/container/values' \
  | jq '.values | length'
# Expected: >20 (containers from multiple pods)
```

**Success Criteria:**
- Cluster label set to "staging"
- Namespace label present and accurate
- Pod and container labels populated
- All expected labels present

---

### Log Retention Validation

**Query Logs from 24 Hours Ago:**

```bash
# Calculate timestamps (in nanoseconds for Loki)
CURRENT_TIME=$(date +%s)000000000
START_TIME=$((CURRENT_TIME - 86400000000000))  # 24 hours ago

# Query logs from past 24 hours
curl -s "http://localhost:3100/loki/api/v1/query_range?query={namespace=\"monitoring\"}&start=$START_TIME&end=$CURRENT_TIME&limit=100" \
  | jq '.data.result | length'
# Expected: >0 (logs available from past 24 hours)
```

**Query Logs from 7 Days Ago:**

```bash
# Calculate 7-day timestamp
START_TIME=$((CURRENT_TIME - 604800000000000))  # 7 days ago

# Query logs from past 7 days
curl -s "http://localhost:3100/loki/api/v1/query_range?query={namespace=\"monitoring\"}&start=$START_TIME&end=$CURRENT_TIME&limit=100" \
  | jq '.data.result | length'
# Expected: >0 (logs available from past 7 days)
```

**Success Criteria:**
- Logs available from at least 24 hours ago
- Logs available from at least 7 days ago
- No gaps in retention
- 30-day retention policy enforced

---

### Log Query Performance

**Benchmark Simple Label Query:**

```bash
# Simple label query (should be <500ms)
time curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' > /dev/null
# Expected: <500ms execution time
```

**Benchmark Range Query:**

```bash
# Range query over time period (should be <2s)
CURRENT=$(date +%s)000000000
START=$((CURRENT - 3600000000000))
time curl -s "http://localhost:3100/loki/api/v1/query_range?query={namespace=\"monitoring\"}&start=$START&end=$CURRENT&step=60" > /dev/null
# Expected: <2s execution time
```

**Benchmark Complex Regex Query:**

```bash
# Complex regex pattern (should be <2s)
time curl -s 'http://localhost:3100/loki/api/v1/query?query={job=~".*router.*", level="error"}' > /dev/null
# Expected: <2s execution time
```

**Benchmark Aggregation Query:**

```bash
# Aggregation query (should be <2s)
time curl -s 'http://localhost:3100/loki/api/v1/query?query=sum by (namespace) (count_over_time({job="kubelet"}[5m]))' > /dev/null
# Expected: <2s execution time
```

**Success Criteria:**
- Simple queries <500ms
- Range queries <2s
- Complex queries <2s
- No timeout errors (default: 30s)

---

## Data Consistency Validation

### Metric-Log Correlation

**Verify Logs Match Metrics Timeline:**

```bash
# Get metric timestamp
METRIC_TIME=$(curl -s 'http://localhost:9090/api/v1/query?query=up' \
  | jq '.data.result[0].value[0]')

# Get log timestamp (convert to seconds)
LOG_TIME=$(curl -s 'http://localhost:3100/loki/api/v1/query?query={namespace="monitoring"}' \
  | jq '.data.result[0].values[0][0] | tonumber / 1000000000 | floor')

# Calculate difference
DIFF=$((METRIC_TIME - LOG_TIME))
echo "Metric-Log time difference: $DIFF seconds"
# Expected: <60 seconds difference
```

**Success Criteria:**
- Metrics and logs collected at similar timestamps
- Time difference <1 minute
- No significant clock skew

---

### Data Volume Consistency

**Verify Steady Log Ingestion:**

```bash
# Check ingestion rate
curl -s 'http://localhost:3100/loki/api/v1/query?query=rate(loki_distributor_lines_received_total[5m])' \
  | jq '.data.result[0].value'
# Expected: Steady rate (>100 lines/sec for active cluster)
```

**Verify Steady Metric Collection:**

```bash
# Check scrape rate
curl -s 'http://localhost:9090/api/v1/query?query=rate(prometheus_tsdb_symbol_table_size_bytes[5m])' \
  | jq '.data.result[0].value'
# Expected: Steady rate (no gaps)
```

**Success Criteria:**
- Consistent log ingestion rate
- Consistent metric scrape rate
- No gaps or anomalies

---

## Storage Utilization Validation

### Prometheus Storage Check

```bash
# Check Prometheus PVC usage
kubectl -n monitoring get pvc prometheus-data -o json | \
  jq '.status.capacity.storage as $cap | .status.allocatedResources.storage as $used | 
      {capacity: $cap, used: $used, percent: (($used | rtrimstr("Gi") | tonumber) / ($cap | rtrimstr("Gi") | tonumber) * 100 | round)}'
# Expected: <50% full
```

**Success Criteria:**
- Prometheus PVC <50% full
- Growth rate indicates 10+ days of retention
- No immediate storage concerns

---

### Loki Storage Check

```bash
# Check Loki PVC usage
kubectl -n monitoring get pvc loki-data -o json | \
  jq '.status.capacity.storage as $cap | .status.allocatedResources.storage as $used | 
      {capacity: $cap, used: $used, percent: (($used | rtrimstr("Gi") | tonumber) / ($cap | rtrimstr("Gi") | tonumber) * 100 | round)}'
# Expected: <50% full
```

**Success Criteria:**
- Loki PVC <50% full
- Growth rate indicates 15+ days of retention
- No immediate storage concerns

---

## Validation Success Checklist

### Metrics Collection
- [ ] Router metrics (latency, requests, errors, availability) present
- [ ] Container CPU/memory metrics from all pods
- [ ] Node memory available from all nodes
- [ ] Pod startup duration metrics available
- [ ] Recording rules evaluated (p50, p99, error_rate, availability)
- [ ] All rules have recent evaluation time

### Logs Collection
- [ ] Logs ingested from default namespace
- [ ] Logs ingested from kube-system namespace
- [ ] Logs ingested from monitoring namespace
- [ ] Logs ingested from application namespace
- [ ] JSON log format correctly parsed
- [ ] Kubelet logs collected and searchable

### Log Labels
- [ ] Cluster label = "staging"
- [ ] Namespace label present and accurate
- [ ] Pod labels populated
- [ ] Container labels populated
- [ ] All expected labels in query results

### Data Retention
- [ ] Logs available from 24 hours ago
- [ ] Logs available from 7 days ago
- [ ] Metrics available from 1+ hour ago
- [ ] 30-day log retention policy active
- [ ] 15-day metric retention active

### Query Performance
- [ ] Simple log queries <500ms
- [ ] Range log queries <2s
- [ ] Complex regex queries <2s
- [ ] Metric aggregation queries <2s
- [ ] No timeout errors

### Storage
- [ ] Prometheus PVC <50% full
- [ ] Loki PVC <50% full
- [ ] Growth rates sustainable
- [ ] No disk pressure warnings
