# Staging Observability Stack - Performance Baseline Benchmarking

## Overview
This guide establishes performance baselines and benchmarks for the observability stack components. These baselines serve as references for production readiness and performance tuning.

**Prerequisites:**
- All components running and healthy
- At least 1 hour of data collection
- kubectl configured for staging cluster
- curl and jq installed
- Time synchronization across cluster (NTP)

---

## Metrics Collection Performance

### Prometheus Scrape Job Performance

**Measure Scrape Interval Compliance:**

```bash
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &

# Check target scrape interval configuration
curl -s 'http://localhost:9090/api/v1/targets?state=active' | \
  jq '.data.activeTargets[] | {job, scrapeInterval: .scrapeInterval, lastScrape: .lastScrape}' | head -20
```

**Expected Output:**
```json
{
  "job": "kubernetes-pods",
  "scrapeInterval": "30s",
  "lastScrape": "2024-01-01T12:00:00Z"
}
```

**Measure Scrape Duration:**

```bash
# Query scrape duration metrics
curl -s 'http://localhost:9090/api/v1/query?query=scrape_duration_seconds' | \
  jq '.data.result[] | {job: .metric.job, duration: .value}'
# Expected: <30 seconds for each job
```

**Benchmark Results Collection:**

```bash
# Measure average scrape times for all jobs
curl -s 'http://localhost:9090/api/v1/query?query=avg by (job) (scrape_duration_seconds)' | \
  jq '.data.result[] | {job: .metric.job, avg_duration_seconds: (.value[1] | tonumber)}'
```

Sample expected results:
```
prometheus:         2-5 seconds
kubernetes-nodes:   3-8 seconds
kubernetes-pods:    5-15 seconds
kubernetes-cadvisor: 8-12 seconds
kube-state-metrics: 2-4 seconds
```

**Success Criteria:**
- All scrape jobs complete within target interval (30s)
- No job takes >25 seconds (allowing 5s margin)
- Scrape times consistent (standard deviation <20%)
- P99 scrape duration <25s

---

### Prometheus Query Latency

**Benchmark Simple Metric Range Query:**

```bash
# Simple metric range query (should be <100ms)
time curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=3600&end=0&step=300' > /dev/null

# Expected execution time: <100ms
```

Run 10 iterations and calculate average:

```bash
total=0
for i in {1..10}; do
  start=$(date +%s%N)
  curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=3600&end=0&step=300' > /dev/null
  end=$(date +%s%N)
  elapsed=$((($end - $start) / 1000000))
  total=$((total + elapsed))
  echo "Query $i: ${elapsed}ms"
done
avg=$((total / 10))
echo "Average: ${avg}ms"
# Expected: <100ms
```

**Benchmark Aggregation Query:**

```bash
# Aggregation query (should be <500ms)
time curl -s 'http://localhost:9090/api/v1/query_range?query=sum%20by%20(job)%20(up)&start=3600&end=0&step=300' > /dev/null
# Expected: <500ms
```

**Benchmark Complex Percentile Query:**

```bash
# Complex query with histogram_quantile (should be <2s)
time curl -s 'http://localhost:9090/api/v1/query_range?query=histogram_quantile(0.99,rate(http_request_duration_seconds_bucket%5B5m%5D))&start=3600&end=0&step=300' > /dev/null
# Expected: <2 seconds
```

**Benchmark Results Summary:**

| Query Type | Expected Latency | Measurement |
|-----------|------------------|-------------|
| Simple range | <100ms | [record your result] |
| Aggregation | <500ms | [record your result] |
| Percentile | <2s | [record your result] |
| Complex multi-step | <2s | [record your result] |

**Success Criteria:**
- Simple queries: <100ms (p95)
- Aggregation queries: <500ms (p95)
- Complex percentile queries: <2s (p95)
- P99 latency: 2x of p95 or better
- No timeout errors (default: 30s)

---

### Prometheus Cardinality Metrics

**Measure Total Time Series Count:**

```bash
# Query total TSDB size
curl -s 'http://localhost:9090/api/v1/query?query=prometheus_tsdb_symbol_table_size_bytes' | \
  jq '.data.result[] | {instance: .metric.instance, size_bytes: .value}'

# Estimate cardinality (roughly 1KB per time series)
SIZE=$(curl -s 'http://localhost:9090/api/v1/query?query=prometheus_tsdb_symbol_table_size_bytes' | \
  jq '.data.result[0].value[1]' | cut -d'.' -f1)
CARDINALITY=$((SIZE / 1024))
echo "Estimated cardinality: ~${CARDINALITY} time series"
# Expected: <100,000 for this deployment
```

**Measure Memory Usage:**

```bash
# Check Prometheus memory consumption
kubectl -n monitoring top pod -l app=prometheus
# Expected: <2GB per replica
```

**Success Criteria:**
- Total cardinality <100,000 time series
- Memory per replica <2GB
- No OOMKill events
- Cardinality growth rate sustainable

---

## Log Collection Performance

### Loki Ingestion Rate

**Measure Log Ingestion Rate:**

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100 &

# Query ingestion rate
curl -s 'http://localhost:3100/loki/api/v1/query?query=rate(loki_distributor_lines_received_total%5B5m%5D)' | \
  jq '.data.result[] | {instance: .metric.instance, lines_per_sec: .value}'
```

Expected ingestion rate:
- Active cluster: >100 lines/sec
- Stable rate: consistent (variation <20%)

**Sample Output:**
```
loki-0: 250 lines/sec
loki-1: 245 lines/sec
Average: 247.5 lines/sec
```

**Success Criteria:**
- Ingestion rate: >100 lines/sec
- Consistent rate (std deviation <20%)
- No dropped lines
- No ingestion lag

---

### Loki Query Performance

**Benchmark Simple Label Query:**

```bash
# Simple label query (should be <500ms)
time curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' > /dev/null
# Expected: <500ms
```

Run 10 iterations:

```bash
total=0
for i in {1..10}; do
  start=$(date +%s%N)
  curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' > /dev/null
  end=$(date +%s%N)
  elapsed=$((($end - $start) / 1000000))
  total=$((total + elapsed))
done
avg=$((total / 10))
echo "Average query time: ${avg}ms"
# Expected: <500ms average
```

**Benchmark Range Query:**

```bash
# Range query over 4 hours (should be <2s)
CURRENT=$(date +%s)000000000
START=$((CURRENT - 14400000000000))
time curl -s "http://localhost:3100/loki/api/v1/query_range?query={namespace=\"monitoring\"}&start=$START&end=$CURRENT&step=300" > /dev/null
# Expected: <2 seconds
```

**Benchmark Complex Regex Query:**

```bash
# Complex pattern matching (should be <2s)
time curl -s 'http://localhost:3100/loki/api/v1/query?query={job=~".*router.*", level="error"} | pattern "<_> <_> <_> <_> <_>"' > /dev/null
# Expected: <2 seconds
```

**Benchmark Query Results:**

| Query Type | Expected Latency | Measurement |
|-----------|------------------|-------------|
| Simple label | <500ms | [record your result] |
| Range query | <2s | [record your result] |
| Complex regex | <2s | [record your result] |
| Aggregation | <2s | [record your result] |

**Success Criteria:**
- Simple label queries: <500ms (p95)
- Range queries: <2s (p95)
- Complex regex queries: <2s (p95)
- No timeout errors (default: 30s)

---

### Loki Storage Metrics

**Measure Ingestion Volume:**

```bash
# Query bytes ingested per minute
curl -s 'http://localhost:3100/loki/api/v1/query?query=rate(loki_distributor_bytes_received_total%5B5m%5D)' | \
  jq '.data.result[] | {instance: .metric.instance, bytes_per_sec: (.value[1] | tonumber), mb_per_min: ((.value[1] | tonumber) * 60 / 1024 / 1024 | round)}'
```

Expected storage growth:
- 50-100 MB per minute typical
- 72-144 GB per day
- For 30-day retention: ~2.2-4.3 TB

**Calculate Storage Requirements:**

```bash
# Get current Loki disk usage
kubectl -n monitoring exec loki-0 -- du -sh /loki

# Calculate retention capacity
SIZE_GB=$(kubectl -n monitoring exec loki-0 -- du -sb /loki | awk '{print $1}')
SIZE_GB=$((SIZE_GB / 1024 / 1024 / 1024))
echo "Current usage: ${SIZE_GB} GB"

# Measure growth rate over 1 hour
BEFORE=$SIZE_GB
sleep 3600
SIZE_GB=$(kubectl -n monitoring exec loki-0 -- du -sb /loki | awk '{print $1}')
SIZE_GB=$((SIZE_GB / 1024 / 1024 / 1024))
HOURLY_GROWTH=$((SIZE_GB - BEFORE))
DAILY_GROWTH=$((HOURLY_GROWTH * 24))
echo "Hourly growth: ${HOURLY_GROWTH} GB"
echo "Daily growth: ${DAILY_GROWTH} GB"

# Calculate retention capacity
PVC_CAPACITY_GB=100  # Adjust based on actual PVC size
AVAILABLE_GB=$((PVC_CAPACITY_GB - SIZE_GB))
RETENTION_DAYS=$((AVAILABLE_GB / DAILY_GROWTH))
echo "Retention capacity: ~${RETENTION_DAYS} days"
# Expected: >30 days
```

**Success Criteria:**
- Disk usage growth: 50-100 GB per day
- PVC <50% full with 30+ day retention
- Storage sufficient for retention policy
- Growth rate stable and predictable

---

## Storage Performance

### Prometheus PVC Performance

**Check Prometheus PVC Usage:**

```bash
# Check capacity and current usage
kubectl -n monitoring get pvc prometheus-data -o json | \
  jq '.status | {capacity: .capacity.storage, allocatedResources: .allocatedResources.storage}'

# Calculate percentage
kubectl -n monitoring get pvc prometheus-data -o json | \
  jq -r '.status.allocatedResources.storage' | sed 's/Gi//' | \
  awk -v cap=100 '{print "Usage: " int($1) " GB (" int(($1/cap)*100) "%)"}'
```

**Expected:**
- Capacity: 100 GB (adjustable)
- Current usage: <50 GB
- Growth rate: ~2-5 GB per day
- 15+ day retention capability

**Measure Disk I/O Performance:**

```bash
# Monitor disk I/O latency
kubectl -n monitoring exec prometheus-0 -- \
  sh -c 'echo "Measuring write latency..."; time dd if=/dev/zero of=/prometheus/test.tmp bs=1M count=100; rm /prometheus/test.tmp'
# Expected: <50ms latency for 100MB write
```

**Success Criteria:**
- Disk I/O latency <50ms
- No "slow disk" warnings
- Consistent performance under load
- No dropped/delayed scrapes due to I/O

---

### Loki PVC Performance

**Check Loki PVC Usage:**

```bash
# Check capacity and current usage
kubectl -n monitoring get pvc loki-data -o json | \
  jq '.status | {capacity: .capacity.storage, allocatedResources: .allocatedResources.storage}'

# Calculate percentage
kubectl -n monitoring get pvc loki-data -o json | \
  jq -r '.status.allocatedResources.storage' | sed 's/Gi//' | \
  awk -v cap=150 '{print "Usage: " int($1) " GB (" int(($1/cap)*100) "%)"}'
```

**Expected:**
- Capacity: 150 GB (adjustable)
- Current usage: <75 GB
- Growth rate: ~72-144 GB per day
- 30+ day retention capability

**Measure Index Performance:**

```bash
# Check index size (boltdb-shipper cache)
kubectl -n monitoring exec loki-0 -- du -sh /loki/boltdb-shipper-cache
# Expected: <5 GB (depends on cardinality)
```

**Success Criteria:**
- Index cache <5 GB
- Query performance not impacted by index size
- Compaction running regularly
- No index corruption errors

---

## Alerting Performance

### Alert Detection Latency

**Measure Time from Metric to Slack:**

```bash
# 1. Send alert
ALERT_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "LatencyTest", "severity": "critical"},
    "annotations": {"summary": "Latency benchmark"},
    "startsAt": "'$ALERT_TIME'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# 2. Note exact time (ALERT_TIME)
# 3. Monitor Slack for notification arrival
# 4. Note Slack timestamp
# 5. Calculate difference
# Expected: <2 minutes (120 seconds)
```

Typical latency breakdown:
- AlertManager ingestion: <1 second
- Route evaluation: <1 second
- Webhook processing: <30 seconds
- **Total**: <60 seconds typical

**Success Criteria:**
- Alert detection latency <2 minutes
- P95 latency <60 seconds
- Consistent performance (no outliers)

---

### Alert Grouping Performance

**Measure Grouping Efficiency:**

```bash
# Send 20 alerts in rapid succession (simulating problem cascade)
for i in {1..20}; do
  curl -X POST 'http://localhost:9093/api/v1/alerts' \
    -H 'Content-Type: application/json' \
    -d '[{
      "labels": {
        "alertname": "GroupTest",
        "severity": "critical",
        "instance": "instance-'$i'"
      },
      "annotations": {"summary": "Alert '$i'"},
      "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
      "endsAt": "0001-01-01T00:00:00Z"
    }]'
  sleep 0.5
done

# Monitor Slack message count
# Expected: 1 message (not 20) with all instances grouped
```

**Success Criteria:**
- 20 related alerts → 1 Slack message
- Grouping reduces notification volume by 20x
- Alert count shown accurately ("20 alerts")
- Grouping window working (group_wait: 10s)

---

### Silence Application Performance

**Measure Silence Application Time:**

```bash
# Create silence and measure time to take effect
START_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
END_TIME=$(date -u -d '+10 minutes' +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST 'http://localhost:9093/api/v1/silences' \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [{"name": "alertname", "value": "SilenceTest"}],
    "startsAt": "'$START_TIME'",
    "endsAt": "'$END_TIME'",
    "comment": "Performance test"
  }'

# Send alert immediately
sleep 1
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "SilenceTest", "severity": "critical"},
    "annotations": {"summary": "Test"},
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Measure time until Slack notification suppression confirmed
# Expected: <30 seconds
```

**Success Criteria:**
- Silence application time <30 seconds
- No Slack notification sent
- Alert still tracked in AlertManager
- Silence removal takes effect <30 seconds

---

## System Resource Utilization

### CPU Usage

**Measure Component CPU:**

```bash
# Check CPU usage for all components
kubectl -n monitoring top pod

# Expected typical usage:
# Prometheus: 200-500m (0.2-0.5 cores)
# Grafana: 50-100m (0.05-0.1 cores)
# Loki: 200-400m (0.2-0.4 cores)
# AlertManager: 10-50m (0.01-0.05 cores)
# Promtail/node-exporter: 20-100m each
```

**Monitor CPU Trends:**

```bash
# Continuous monitoring
watch -n 5 'kubectl -n monitoring top pod | sort -k3 -rn'
# Observe for 5+ minutes
# Expected: Consistent usage (no trends up/down)
```

**Success Criteria:**
- No component exceeding CPU request
- Typical usage: <1 core total
- No CPU throttling warnings
- P99 usage <1.5 cores

---

### Memory Usage

**Measure Component Memory:**

```bash
# Check memory usage
kubectl -n monitoring top pod

# Expected typical usage:
# Prometheus: 500-1000 MB per replica
# Grafana: 200-400 MB per replica
# Loki: 300-800 MB per replica
# AlertManager: 50-100 MB per replica
```

**Monitor Memory Trends:**

```bash
# Check for memory leaks (increasing trend)
for i in {1..10}; do
  kubectl -n monitoring top pod | grep -E 'prometheus|grafana|loki|alertmanager'
  echo "---"
  sleep 60
done
# Expected: Stable memory (not continuously increasing)
```

**Success Criteria:**
- No component exceeding memory limit
- Total memory <4 GB
- No memory leaks (stable usage)
- No OOMKill events

---

### Disk I/O

**Measure Read/Write Performance:**

```bash
# Monitor disk I/O (Linux only)
kubectl -n monitoring exec prometheus-0 -- iostat -d -x 1 5

# Look for:
# r/s (reads/sec): typical 10-50
# w/s (writes/sec): typical 20-100
# r_await (read latency): should be <10ms
# w_await (write latency): should be <50ms
```

**Success Criteria:**
- Read latency <10ms
- Write latency <50ms
- No disk saturation (util% <80%)
- No I/O timeout errors

---

## Network Performance

### Network Latency Between Components

**Measure Latency Prometheus → Loki:**

```bash
# From Prometheus pod, ping Loki service
kubectl -n monitoring exec prometheus-0 -- \
  sh -c 'for i in {1..10}; do time curl -s http://loki:3100/ready > /dev/null; done'
# Expected: <50ms per request
```

**Success Criteria:**
- Inter-service latency <50ms
- No packet loss
- Consistent latency (std dev <10ms)

---

## Benchmark Results Template

Create a file: `infra/BENCHMARK_RESULTS_STAGING.md`

```markdown
# Observability Stack - Benchmark Results
Date: YYYY-MM-DD
Environment: Staging
Duration: [X hours of testing]

## Prometheus Performance
| Metric | Expected | Measured | Status |
|--------|----------|----------|--------|
| Scrape duration (avg) | <5s | [___] | [✓/✗] |
| Query latency (p50) | <100ms | [___] | [✓/✗] |
| Query latency (p95) | <500ms | [___] | [✓/✗] |
| Cardinality | <100k | [___] | [✓/✗] |
| Memory usage | <2GB | [___] | [✓/✗] |

## Loki Performance
| Metric | Expected | Measured | Status |
|--------|----------|----------|--------|
| Ingestion rate | >100 lines/s | [___] | [✓/✗] |
| Query latency (p50) | <500ms | [___] | [✓/✗] |
| Query latency (p95) | <2s | [___] | [✓/✗] |
| Disk growth/day | 72-144 GB | [___] | [✓/✗] |
| Retention capability | >30 days | [___] | [✓/✗] |

## Alerting Performance
| Metric | Expected | Measured | Status |
|--------|----------|----------|--------|
| Alert latency | <2min | [___] | [✓/✗] |
| Grouping efficiency | 20:1 | [___] | [✓/✗] |
| Silence latency | <30s | [___] | [✓/✗] |

## Resource Utilization
| Component | CPU | Memory | Disk | Status |
|-----------|-----|--------|------|--------|
| Prometheus | [___] | [___] | [___] | [✓/✗] |
| Loki | [___] | [___] | [___] | [✓/✗] |
| Grafana | [___] | [___] | [___] | [✓/✗] |
| AlertManager | [___] | [___] | [___] | [✓/✗] |

## Notes
[Any observations or anomalies]
```

---

## Success Checklist

- [ ] Prometheus scrape duration <30 seconds
- [ ] Prometheus query latency (p95) <500ms
- [ ] Loki ingestion rate >100 lines/sec
- [ ] Loki query latency (p95) <2 seconds
- [ ] Alert detection latency <2 minutes
- [ ] Alert grouping working (20:1 efficiency)
- [ ] Memory usage stable (no leaks)
- [ ] Disk I/O latency <50ms
- [ ] Network latency <50ms
- [ ] All components within resource limits
