# Performance Tuning Guide - ClarityRouter Observability Stack

## Overview

This guide provides optimization strategies to improve performance, reduce latency, and efficiently scale the production observability stack.

**Target Metrics:**
- Query latency p99: <2 seconds
- Dashboard load time: <5 seconds
- Metrics ingestion: 5000+ metrics/second
- Log ingestion: 1000+ logs/second

---

## Table of Contents

1. [Prometheus Performance Tuning](#prometheus-performance-tuning)
2. [Grafana Performance Tuning](#grafana-performance-tuning)
3. [Loki Performance Tuning](#loki-performance-tuning)
4. [Storage Optimization](#storage-optimization)
5. [Scaling Strategies](#scaling-strategies)
6. [Query Optimization](#query-optimization)
7. [Monitoring Performance](#monitoring-performance)

---

## Prometheus Performance Tuning

### 1. WAL (Write-Ahead Log) Configuration

The WAL stores incoming samples before compaction:

```yaml
# Current Helm values configuration
prometheus:
  prometheusSpec:
    storageSpec:
      volumeClaimTemplate:
        spec:
          resources:
            requests:
              storage: 30Gi
    
    # WAL segment size (default 512MB)
    # Increase for higher ingestion rates
    # Trade-off: Higher memory usage, faster compaction
    extraArgs:
      - --tsdb.wal-segment-size=512MB
      
    # WAL compression (reduces disk I/O)
    # Trade-off: Higher CPU usage
    - --tsdb.wal.compression=snappy
```

**Tuning by Ingestion Rate:**

| Metrics/sec | WAL Size | Memory | Config |
|------------|----------|--------|--------|
| <500 | 256 MB | 2 GB | Default |
| 500-2000 | 512 MB | 2 GB | Recommended |
| 2000-5000 | 1 GB | 3 GB | High volume |
| 5000+ | 2 GB | 4+ GB | Very high |

```bash
# Check current WAL usage
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  du -sh /prometheus/wal/

# If approaching limit, increase WAL segment size:
kubectl patch statefulset prometheus-kube-prom-prometheus -n observability \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"prometheus","args":["--tsdb.wal-segment-size=1GB"]}]}}}}'
```

### 2. Query Concurrency Limits

Control simultaneous query execution:

```yaml
prometheus:
  prometheusSpec:
    extraArgs:
      # Maximum concurrent queries (default 20)
      - --query.max-concurrency=50
      
      # Maximum samples in a query (default 50M)
      - --query.max-samples=100000000
      
      # Query timeout (default 2m)
      - --query.timeout=2m
```

**Recommendation:**
- `max-concurrency`: Set to (CPU cores * 2)
- `max-samples`: Increase only if you have >10GB RAM
- `timeout`: Keep at 2-5 minutes

```bash
# Check current settings
kubectl get statefulset prometheus-kube-prom-prometheus -n observability \
  -o jsonpath='{.spec.template.spec.containers[0].args}'

# Update max-concurrency
kubectl set env statefulset/prometheus-kube-prom-prometheus \
  --containers=prometheus \
  -n observability \
  PROMETHEUS_ARGS="--query.max-concurrency=50"
```

### 3. Scrape Configuration Optimization

```yaml
# Prometheus scrape config
prometheus:
  prometheusSpec:
    scrapeInterval: 30s      # Default is fine (30 seconds)
    scrapeTimeout: 10s       # Default, increase if targets slow
    evaluationInterval: 30s  # Alert rule evaluation frequency
    
    # Reduce cardinality explosion
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: 'container_.*'
        action: drop  # Drop high-cardinality metrics if needed
```

**Best Practices:**
1. **Avoid unbounded label combinations** (e.g., user_id as label)
2. **Drop unnecessary metrics** at scrape time (faster than later)
3. **Set appropriate scrape intervals** (15-60 seconds)
4. **Use metric_relabel_configs** to drop expensive metrics:

```bash
# Identify high-cardinality metrics
curl -s 'http://prometheus:9090/api/v1/label/__name__/values' | \
  jq 'length' | head -20

# Find problematic labels
curl -s 'http://prometheus:9090/api/v1/series?match=<metric>' | \
  jq '.data[0].metric | keys' | head
```

### 4. Memory Management

```yaml
prometheus:
  prometheusSpec:
    resources:
      requests:
        memory: "2Gi"
        cpu: "500m"
      limits:
        memory: "3Gi"
        cpu: "1000m"
    
    # Enable memory profiling
    enablePrometheusRulesWebsdServer: true
```

**Monitor Memory:**

```bash
# Check current memory usage
kubectl top pod -n observability \
  -l app.kubernetes.io/name=prometheus

# Get detailed memory stats
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  cat /proc/self/status | grep -i "vmrss\|vmsize"

# If approaching limits, increase or optimize queries
```

**Memory Optimization:**

1. Reduce retention period (15d → 7d saves ~50%)
2. Reduce number of scrape targets
3. Drop high-cardinality metrics
4. Increase WAL segment size (better memory utilization)

---

## Grafana Performance Tuning

### 1. Query Caching

Enable query result caching:

```yaml
grafana:
  persistence:
    enabled: true
    
  # Query caching configuration
  env:
    - name: GF_QUERY_CACHE_ENABLED
      value: "true"
    
    - name: GF_QUERY_CACHE_TTL
      value: "300"  # Cache for 5 minutes
      
    - name: GF_QUERY_CACHE_SIZE_MB
      value: "100"  # Cache size in MB
```

**Cache Hit Rate Monitoring:**

```bash
# Check cache effectiveness
curl -s http://grafana:3000/api/admin/stats | jq '.cacheStats'
```

### 2. Rendering Optimization

For dashboards with many panels:

```yaml
grafana:
  env:
    # Server-side rendering (faster for complex dashboards)
    - name: GF_PANELS_ENABLE_RENDERER
      value: "true"
    
    # Panel timeout
    - name: GF_RENDERER_TIMEOUT
      value: "30s"
    
    # Concurrent rendering workers
    - name: GF_RENDERER_CONCURRENT_WORKERS
      value: "4"
```

### 3. Dashboard Optimization

**Best Practices:**
1. **Limit panels per dashboard:** Max 20-30 panels
2. **Use simple queries:** Avoid regex queries on large datasets
3. **Set appropriate refresh rates:** 30s-5m (not 5s)
4. **Use alert states** instead of complex queries for status

```bash
# Measure dashboard load time
# In browser DevTools:
# 1. Open Network tab
# 2. Reload dashboard
# 3. Check total load time
# 4. Look for slow API calls

# Slow queries will show high response times
# Optimize by:
# - Adding PromQL range selectors ([5m])
# - Reducing metric cardinality
# - Using recording rules for complex queries
```

### 4. Data Source Connection Pooling

```yaml
grafana:
  env:
    # Prometheus connection pool
    - name: GF_DATASOURCE_PROMETHEUS_MAX_CONNECTIONS
      value: "100"
    
    # Loki connection pool
    - name: GF_DATASOURCE_LOKI_MAX_CONNECTIONS
      value: "100"
```

---

## Loki Performance Tuning

### 1. Chunk Configuration

```yaml
loki:
  config:
    chunk_store_config:
      # Chunk size (256KB typical)
      chunk_idle_period: 3m
      chunk_block_size: 262144  # 256KB
      
      # Flush settings (balance latency vs throughput)
      max_chunk_age: 1h
      
    ingester:
      # Flush period (more frequent = lower latency, more I/O)
      flush_interval: 30s
      max_chunk_idle_period: 5m
      
      # In-memory buffer
      chunk_retain_period: 1m
```

**Tuning by Log Volume:**

| Logs/sec | Chunk Size | Flush Interval | Memory |
|----------|-----------|----------------|--------|
| <100 | 256 KB | 5m | 256 MB |
| 100-500 | 256 KB | 2m | 512 MB |
| 500-2000 | 512 KB | 1m | 1 GB |
| 2000+ | 1 MB | 30s | 2+ GB |

### 2. Query Optimization

```yaml
loki:
  config:
    limits_config:
      # Query timeout
      max_query_lookback: 720h  # 30 days
      
      # Rate limiting
      rate_limit_enabled: true
      rate_limit_bytes: 100000000  # 100MB/sec
      
      # Cardinality limits
      cardinality_limit: 100000
      
      # Query maximum range
      max_queries_per_second: 1000
```

**Optimize Log Queries:**

```logql
# Slow: searches entire dataset
{job="kubernetes-pods"}

# Better: restrict time range
{job="kubernetes-pods"} | logfmt | timestamp > "2026-02-15T20:00:00Z"

# Better: use specific labels
{namespace="observability", pod_name=~"prometheus-.*"} | json

# Best: combine label and content filtering
{namespace="observability"} | json | level="error"
```

### 3. Retention & Cleanup

```yaml
loki:
  config:
    limits_config:
      # Retention period
      retention_period: 30d
      
      # Enable retention enforcement
      enforce_metric_name: false
```

**Monitor Retention:**

```bash
# Check retention enforcement
curl -s http://loki:3100/config | grep retention

# Check log age
curl -s 'http://prometheus:9090/api/v1/query?query=max(loki_oldest_timestamp_seconds)' | \
  jq '.data.result[0].value[1]'
```

### 4. Promtail Optimization

```yaml
promtail:
  config:
    clients:
      - url: http://loki:3100/loki/api/v1/push
        # Batch settings
        batch_size: 102400  # 100KB batches
        batch_timeout: 10s
        
    scrape_configs:
      - job_name: kubernetes-pods
        # Relabeling to reduce cardinality
        relabel_configs:
          # Drop pod_version label (high cardinality)
          - source_labels: [pod_version]
            action: drop
        
        # Limit label set
        labeldrop:
          - pod_ip
          - container_hash
```

---

## Storage Optimization

### 1. Compression

Enable transparent compression:

```yaml
# For EFS-backed volumes
# Configure compression at filesystem level (if supported)

# At application level
prometheus:
  prometheusSpec:
    extraArgs:
      - --tsdb.wal.compression=snappy
      
loki:
  config:
    compression: snappy
```

### 2. Retention Tuning

**Prometheus:**
```yaml
prometheus:
  prometheusSpec:
    retention: 15d  # Current: 15 days
    # Can reduce to 7d to save 50% space
    # Or increase to 30d if storage available
    
    retentionSize: "25GB"  # Stop writing when full
```

**Loki:**
```yaml
loki:
  config:
    limits_config:
      retention_period: 30d  # Current: 30 days
      # Fine-tune based on storage growth
```

### 3. Storage Monitoring

```bash
# Check current usage
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  du -sh /prometheus

kubectl exec -n observability loki-0 -- \
  du -sh /loki/chunks

# Calculate growth rate
# Compare sizes from daily checks to estimate days until full

# Set alerts for high storage
alert: PrometheusStorageHighUsage
expr: (prometheus_tsdb_dir_bytes / prometheus_tsdb_disk_space_limit) > 0.7
for: 10m
```

---

## Scaling Strategies

### 1. Horizontal Scaling (Add Replicas)

Increase replicas when:
- Query latency p95 >2 seconds
- CPU usage >70% sustained
- Memory usage >80% sustained

```bash
# Scale Prometheus replicas
kubectl scale statefulset prometheus-kube-prom-prometheus \
  --replicas=5 -n observability

# Scale Loki replicas
kubectl scale statefulset loki \
  --replicas=5 -n observability

# Scale Grafana replicas
kubectl scale deployment grafana \
  --replicas=3 -n observability

# Verify scaling
kubectl get pods -n observability
kubectl top pods -n observability
```

### 2. Vertical Scaling (Increase Resources)

Increase resources when:
- Single pod CPU >80%
- Single pod memory >90%
- Node doesn't have capacity for more replicas

```bash
# Increase Prometheus memory
kubectl set resources statefulset prometheus-kube-prom-prometheus \
  --containers=prometheus \
  --limits=memory=4Gi,cpu=1000m \
  -n observability

# Verify new resources
kubectl get statefulset prometheus-kube-prom-prometheus -n observability \
  -o jsonpath='{.spec.template.spec.containers[0].resources}'
```

### 3. Storage Scaling

Expand PVC when >70% full:

```bash
# For static provisioning (no dynamic expansion)
# 1. Create new PVC with larger size
# 2. Migrate data
# 3. Update pod to use new PVC
# 4. Delete old PVC

# For dynamic provisioning (automatic expansion)
kubectl patch pvc prometheus-storage -n observability \
  -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'

# Verify expansion
kubectl get pvc prometheus-storage -n observability
```

---

## Query Optimization

### Recording Rules

Pre-compute expensive queries:

```yaml
# Prometheus recording rules
prometheus:
  prometheusSpec:
    additionalPrometheusRules:
      - name: observability
        interval: 30s
        rules:
          # Pre-compute 5-minute rate
          - record: clarity_router:request_rate:5m
            expr: rate(clarity_router_requests_total[5m])
          
          # Pre-compute error rate
          - record: clarity_router:error_rate:5m
            expr: rate(clarity_router_requests_total{status=~"5.."}[5m])
          
          # Pre-compute latency percentile
          - record: clarity_router:latency_p95:5m
            expr: histogram_quantile(0.95, rate(clarity_router_latency_seconds_bucket[5m]))
```

**Benefits:**
- Queries on recording rules are 10-100x faster
- Reduce load on Prometheus
- Enable complex dashboards to load faster

### Query Patterns

**Slow Pattern:**
```promql
# Searches entire time range for all series
clarity_router_requests_total
```

**Fast Pattern:**
```promql
# Uses rate() to reduce points returned
rate(clarity_router_requests_total[5m])
```

**Faster Pattern:**
```promql
# Uses pre-computed recording rule
clarity_router:request_rate:5m
```

---

## Monitoring Performance

### Performance Metrics

Monitor these metrics to identify bottlenecks:

```bash
# Query latency (Prometheus)
curl -s 'http://prometheus:9090/api/v1/query?query=histogram_quantile(0.95,prometheus_http_request_duration_seconds_bucket)' | jq .

# Ingestion rate (Prometheus)
curl -s 'http://prometheus:9090/api/v1/query?query=rate(prometheus_tsdb_symbol_table_size_bytes[5m])' | jq .

# Storage size
curl -s 'http://prometheus:9090/api/v1/query?query=prometheus_tsdb_dir_bytes' | jq .

# Chunk age (Loki)
curl -s 'http://prometheus:9090/api/v1/query?query=loki_loki_boltdb_shipper_max_age_seconds' | jq .

# Log ingestion rate (Loki)
curl -s 'http://prometheus:9090/api/v1/query?query=rate(loki_distributor_lines_received_total[5m])' | jq .
```

### Performance Alerts

Create alerts for performance issues:

```yaml
# High query latency
alert: PrometheusHighQueryLatency
expr: histogram_quantile(0.95, rate(prometheus_http_request_duration_seconds_bucket[5m])) > 2
for: 5m

# High memory usage
alert: PrometheusHighMemoryUsage
expr: prometheus_tsdb_memory_bytes / 1024^3 > 2.5
for: 10m

# Slow storage writes
alert: PrometheusSlowStorage
expr: rate(prometheus_tsdb_compactions_failed_total[5m]) > 0
for: 5m

# Log ingestion lag (Loki)
alert: LokiHighIngestionLag
expr: loki_loki_boltdb_shipper_queue_duration_seconds > 60
for: 5m
```

---

## Performance Testing

### Load Testing Script

```bash
#!/bin/bash
# Simple load test to identify bottlenecks

PROMETHEUS_URL="http://prometheus:9090"
QUERIES=10
DURATION=300  # 5 minutes

for i in $(seq 1 $QUERIES); do
    curl -X GET \
      "${PROMETHEUS_URL}/api/v1/query_range?query=rate(clarity_router_requests_total[5m])&start=1&end=$(($(date +%s)))&step=60" \
      &
done

wait

echo "Load test complete"
```

### Performance Baseline

Record baseline after tuning:

```bash
# Query latency baseline
echo "Query Latency (p95): $(curl -s 'http://prometheus:9090/api/v1/query?query=histogram_quantile(0.95,prometheus_http_request_duration_seconds_bucket)' | jq '.data.result[0].value[1]') seconds"

# Ingestion rate
echo "Ingestion Rate: $(curl -s 'http://prometheus:9090/api/v1/query?query=rate(prometheus_tsdb_symbol_table_size_bytes[5m])' | jq '.data.result[0].value[1]') bytes/sec"

# Storage size
echo "Storage Size: $(curl -s 'http://prometheus:9090/api/v1/query?query=prometheus_tsdb_dir_bytes' | jq '.data.result[0].value[1] / 1024^3 | round') GB"
```

---

**Related Documentation:**
- [`MAINTENANCE.md`](MAINTENANCE.md) - Regular maintenance procedures
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - SLO targets and performance goals
- [`COST_OPTIMIZATION.md`](COST_OPTIMIZATION.md) - Cost reduction through optimization
