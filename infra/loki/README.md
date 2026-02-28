# Loki Log Aggregation Stack

Centralized log collection and storage across production and staging Kubernetes clusters using Grafana Loki with Promtail.

## Architecture Overview

Loki is a log aggregation system designed for cloud-native environments:

```
┌─────────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │    Pod A     │  │    Pod B     │  │    Pod C     │           │
│  │ stdout/stderr│  │ stdout/stderr│  │ stdout/stderr│           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         │                 │                 │                   │
│         └─────────────────┴─────────────────┘                   │
│                           │                                      │
│                    /var/log/containers/                         │
│                           │                                      │
│         ┌─────────────────▼─────────────────┐                  │
│         │        Promtail DaemonSet         │                  │
│         │  (runs on every node)             │                  │
│         │  - Collects logs from files       │                  │
│         │  - Extracts pod metadata          │                  │
│         │  - Adds labels (cluster, ns, pod) │                  │
│         │  - Sends to Loki                  │                  │
│         └─────────────────┬─────────────────┘                  │
│                           │                                      │
│                      HTTP POST                                   │
│                /loki/api/v1/push                                │
│                           │                                      │
│         ┌─────────────────▼─────────────────┐                  │
│         │        Loki Stack (HA)            │                  │
│         ├─────────────────────────────────┤                  │
│         │ Distributor (frontend)          │                  │
│         │ - Receives logs from Promtail   │                  │
│         │ - Validates and routes logs     │                  │
│         │ - Rate limiting                 │                  │
│         ├─────────────────────────────────┤                  │
│         │ Ingester (processing)           │                  │
│         │ - Chunks and compresses logs    │                  │
│         │ - Builds indexes                │                  │
│         │ - Sends to storage              │                  │
│         ├─────────────────────────────────┤                  │
│         │ Querier (search)                │                  │
│         │ - Queries logs from storage     │                  │
│         │ - Returns results to Grafana    │                  │
│         ├─────────────────────────────────┤                  │
│         │ 2x Replicas (HA)                │                  │
│         │ - Pod anti-affinity             │                  │
│         │ - ReadWriteMany EFS storage     │                  │
│         │ - Pod Disruption Budget         │                  │
│         └─────────────────┬─────────────────┘                  │
│                           │                                      │
│         ┌─────────────────┴─────────────────┐                  │
│         │                                   │                  │
│    EFS Storage (150GB)             S3 Storage (unlimited)      │
│    - Local indexes                 - Log chunks                │
│    - Metadata                      - Long-term backup          │
│         │                                   │                  │
└─────────┼───────────────────────────────────┼──────────────────┘
          │                                   │
     AWS EFS                           AWS S3
  (replicated                       (durable,
   across AZs)                      versioned)
```

## Components

### Loki Distributor
- **Role**: Frontend for log ingestion
- **Responsibility**: 
  - Receives logs from Promtail via HTTP API
  - Validates log format and labels
  - Applies rate limiting
  - Routes logs to ingesters
  - Returns 204 No Content on success
- **Configuration**: `auth_enabled: false` (cluster-internal)

### Loki Ingester
- **Role**: Log processing and chunking
- **Responsibility**:
  - Chunks logs into ~1MB blocks
  - Compresses chunks with snappy algorithm
  - Builds local index (boltdb)
  - Flushes to S3 and EFS when chunks are full
  - Maintains in-memory buffer for recent logs
- **Configuration**:
  - `max_chunk_age: 1h` (force flush after 1 hour)
  - `chunk_idle_period: 30s` (flush idle chunks)
  - `max_streams_per_user: 100000` (prevent cardinality explosion)

### Loki Querier
- **Role**: Log retrieval and queries
- **Responsibility**:
  - Executes LogQL queries
  - Searches indexes in boltdb-shipper
  - Reads chunks from S3 and EFS
  - Returns log entries matching filters
  - Caches query results
- **Configuration**:
  - `max_concurrent: 20` (concurrent queries)
  - `query_timeout: 5m` (max query time)

### Promtail DaemonSet
- **Role**: Log collection agent
- **Runs on**: Every cluster node (including master)
- **Collects**:
  - Container logs: `/var/log/containers/*/*.log`
  - Kubelet logs: `/var/log/kubelet.log*` (optional)
  - System logs: `/var/log/syslog*` (optional)
- **Processing**:
  - Parses JSON from Docker/containerd
  - Extracts pod metadata (namespace, pod name, container)
  - Enriches with Kubernetes labels via API
  - Adds cluster and node information
  - Sends batches to Loki
- **Resource Usage**: 100m CPU / 128Mi memory (per node)

## File Structure

```
infra/loki/
├── values-common.yaml           # Shared Helm values (both clusters)
├── values-prod.yaml             # Production overrides (us-east-1, 3 replicas)
├── values-staging.yaml          # Staging overrides (us-west-2, 2 replicas)
├── promtail-daemonset.yaml      # Promtail DaemonSet + RBAC + Service
├── promtail-config.yaml         # Promtail scrape configuration (ConfigMap)
├── pvc-storage.yaml             # EFS storage claim (150GB)
├── service.yaml                 # Loki service + monitoring + NetworkPolicy
└── README.md                    # This file
```

## Installation

### Prerequisites

1. **Kubernetes Cluster**
   - Version 1.21+ (EFS CSI driver requirement)
   - Both prod and staging clusters prepared

2. **EFS Filesystems**
   - Production: EFS in `us-east-1` (e.g., `fs-PROD_ID`)
   - Staging: EFS in `us-west-2` (e.g., `fs-STAGING_ID`)
   - Enable encryption at rest and in transit

3. **S3 Buckets**
   - Production: `PROD_LOGS_BUCKET` in `us-east-1`
   - Staging: `STAGING_LOGS_BUCKET` in `us-west-2`
   - Enable versioning for disaster recovery

4. **IAM Permissions**
   - Loki pods need S3 access (PutObject, GetObject, ListBucket)
   - Use IRSA (IAM Roles for Service Accounts) if available

5. **EFS CSI Driver**
   ```bash
   helm repo add aws-efs-csi-driver \
     https://kubernetes-sigs.github.io/aws-efs-csi-driver/
   helm install aws-efs-csi-driver \
     aws-efs-csi-driver/aws-efs-csi-driver \
     -n kube-system --create-namespace \
     --set serviceAccount.create=true
   ```

6. **Helm Chart**
   ```bash
   helm repo add grafana https://grafana.github.io/helm-charts
   helm repo update
   ```

### Production Deployment

1. **Update placeholder values** in `values-prod.yaml`:
   ```bash
   # Replace EFS filesystem ID
   sed -i 's/PROD_LOGS_BUCKET/your-prod-bucket/g' values-prod.yaml
   
   # Replace S3 bucket
   sed -i 's/fs-PLACEHOLDER_EFS_ID/fs-your-prod-id/g' pvc-storage.yaml
   ```

2. **Create monitoring namespace**:
   ```bash
   kubectl create namespace monitoring
   ```

3. **Deploy storage**:
   ```bash
   kubectl apply -f pvc-storage.yaml
   ```

4. **Deploy Promtail and Loki** via Helm:
   ```bash
   helm install loki grafana/loki-stack \
     -f values-common.yaml \
     -f values-prod.yaml \
     -n monitoring \
     --create-namespace
   ```

5. **Deploy service and monitoring**:
   ```bash
   kubectl apply -f service.yaml
   kubectl apply -f promtail-config.yaml
   ```

### Staging Deployment

1. **Update placeholder values** in `values-staging.yaml`:
   ```bash
   sed -i 's/STAGING_LOGS_BUCKET/your-staging-bucket/g' values-staging.yaml
   sed -i 's/fs-PLACEHOLDER_EFS_ID/fs-your-staging-id/g' pvc-storage.yaml
   ```

2. **Deploy**:
   ```bash
   helm install loki grafana/loki-stack \
     -f values-common.yaml \
     -f values-staging.yaml \
     -n monitoring \
     --create-namespace
   ```

## Verification

### 1. Check Pod Status

```bash
# Loki pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=loki
# Expected: 2 or 3 Running pods (depending on prod/staging)

# Promtail pods
kubectl get pods -n monitoring -l app.kubernetes.io/name=promtail
# Expected: N Running pods (one per node)
```

### 2. Verify Storage

```bash
# Check PVC
kubectl get pvc -n monitoring
# Expected: loki-storage Bound 150Gi

# Check mount in Loki pod
kubectl exec -it <loki-pod> -n monitoring -- df -h /loki
# Expected: EFS filesystem mounted with 150G capacity
```

### 3. Test Log Ingestion

```bash
# Check Promtail logs
kubectl logs -f <promtail-pod> -n monitoring | head -50
# Expected: No errors, "sent 1 batch" messages

# Check Loki logs
kubectl logs -f <loki-pod> -n monitoring | grep -i distributor
# Expected: "distributor received" messages
```

### 4. Query Logs

```bash
# Exec into Loki pod
kubectl exec -it <loki-pod> -n monitoring -- sh

# Query recent logs
curl 'http://localhost:3100/loki/api/v1/query?query={job="container_logs"}' | jq .

# Expected: JSON response with log entries
```

### 5. Grafana Integration

1. **Add Loki datasource**:
   - Grafana > Configuration > Data Sources > Add
   - Type: Loki
   - URL: `http://loki:3100`
   - Save & Test

2. **Create dashboard**:
   - Grafana > Create > Dashboard
   - Add panel > Query: `{job="container_logs"}`
   - Visualize logs with label filters

## Configuration Details

### Log Labels (Critical for Performance)

Labels are how Loki indexes and retrieves logs. Each unique label combination creates a new "stream" in Loki.

**Recommended labels** (low cardinality):

```
cluster="prod"                    # prod or staging
namespace="clarity-router"        # kubernetes namespace
pod="router-1abc23"              # pod name (varies)
container="router"               # container name
node="ip-10-0-1-42"             # node name
stream="stdout"                  # stdout or stderr
pod_labels_app="clarity-router"  # from pod label
pod_labels_version="v1.2.3"     # from pod label
pod_labels_stage="production"    # from pod label
```

**AVOID** (high cardinality):

```
request_id="abc-123-def"         # ❌ Millions of unique values
user_id="user-42"                # ❌ High cardinality explosion
trace_id="trace-xyz"             # ❌ Log cardinality explosion
timestamp="2024-01-01T12:34:56" # ❌ Every log has unique timestamp
```

**Why?** Each unique label combination creates an index entry. High cardinality = millions of series = slow queries, high memory, expensive storage.

### Retention Policy

Logs older than **30 days** are automatically deleted via `reject_old_samples_max_age`.

```yaml
limits_config:
  reject_old_samples: true
  reject_old_samples_max_age: 30d  # Logs deleted after 30 days
```

**Storage sizing**: ~5GB/day * 30 days = 150GB (matches PVC size)

**To adjust retention**:
1. Edit `values-prod.yaml` or `values-staging.yaml`
2. Change `reject_old_samples_max_age`
3. Update PVC size if needed
4. Redeploy: `helm upgrade loki grafana/loki-stack ...`

### High Availability (HA) Configuration

**Production** (3 replicas):
- Pod anti-affinity: REQUIRED (spread across nodes)
- Pod Disruption Budget: minAvailable=2 (keep 2 running)
- Shared EFS: ReadWriteMany storage
- Load balanced across 3 ingesters

**Staging** (2 replicas):
- Pod anti-affinity: PREFERRED (try to spread)
- Pod Disruption Budget: minAvailable=1
- Shared EFS: ReadWriteMany storage
- Load balanced across 2 ingesters

**Failure scenarios**:

| Scenario | Impact | Recovery |
|----------|--------|----------|
| 1 Loki pod down (3 replicas) | No impact, 2 replicas handle load | Auto-restarts (Kubernetes) |
| 1 Loki pod down (2 replicas) | Reduced capacity, logs still flowing | Auto-restarts |
| EFS down | Loki cannot write index/logs | Data remains in S3, query stalls |
| S3 down | Loki cannot flush chunks | Data in memory, limited to 1-2 hours |
| All Loki pods down | Complete loss of ingestion | Restart pods, Promtail retries with backoff |

## LogQL Query Syntax

LogQL is Loki's query language (similar to Prometheus PromQL).

### Basic Queries

**Get all logs from a namespace**:
```logql
{namespace="clarity-router"}
```

**Get error logs only**:
```logql
{namespace="clarity-router"} |= "error"
```

**Get logs from specific pod**:
```logql
{pod="router-abc123"}
```

**Combine multiple filters**:
```logql
{cluster="prod", namespace="clarity-router"} 
  | json 
  | level="ERROR"
```

### Advanced Queries

**Parse JSON and filter**:
```logql
{job="container_logs"} 
  | json 
  | status_code >= 500
```

**Regex matching**:
```logql
{namespace="clarity-router"} 
  |~ "error.*timeout"
```

**Count logs per pod**:
```logql
count_over_time({namespace="clarity-router"}[5m]) by (pod)
```

**Rate of errors**:
```logql
rate({namespace="clarity-router"} |= "error"[5m])
```

### Label Discovery

**List all namespaces**:
```logql
{job="container_logs"}
```
Then check "Labels" in Grafana

**List all pods in namespace**:
```logql
{namespace="clarity-router"}
```

## Performance Tuning

### Ingestion Bottleneck

**Symptom**: Promtail errors, "ErrStreamRateLimitExceeded"

**Solution**:
1. Increase `max_entries_limit_per_second` in Loki config
2. Reduce log volume (filter unnecessary logs in Promtail)
3. Increase Loki replicas (scale horizontally)

### Query Slowness

**Symptom**: Grafana queries timeout (>5m)

**Solution**:
1. Reduce time range (query less data)
2. Use more specific label filters (reduce series count)
3. Increase `max_concurrent` workers in querier config
4. Enable query result caching (longer TTL)

### Memory Usage High

**Symptom**: Loki pods using >2GB memory

**Solution**:
1. Reduce `max_chunk_age` (flush chunks sooner)
2. Reduce `max_streams_per_user` (prevent high cardinality)
3. Increase Loki replicas (distribute load)
4. Increase pod memory limit (resources.limits.memory)

### CPU Usage High

**Symptom**: Loki pods using >1000m CPU

**Solution**:
1. Reduce scrape frequency in Promtail
2. Optimize regex patterns (avoid backtracking)
3. Reduce compression level (snappy is fast)
4. Increase Loki replicas (distribute load)

## Backup and Disaster Recovery

### Data Persistence

**Primary**: EFS (distributed file system)
- Durability: AWS manages replication across AZs
- Availability: Can be accessed by multiple Loki pods
- Retention: Manual (depends on PVC size)

**Secondary**: S3 (object storage)
- Durability: 99.999999999% (11 9s)
- Availability: Regional + optional cross-region replication
- Retention: Via lifecycle policies or manual deletion

### Backup Strategy

1. **Enable S3 versioning**:
   ```bash
   aws s3api put-bucket-versioning \
     --bucket PROD_LOGS_BUCKET \
     --versioning-configuration Status=Enabled
   ```

2. **Enable EFS backup** (AWS Backup):
   ```bash
   # Via AWS Console > Backup > Create backup plan
   # Or via Terraform
   ```

3. **Monitor backup status**:
   ```bash
   # Check latest S3 objects
   aws s3api list-object-versions --bucket PROD_LOGS_BUCKET \
     --sort-by-date
   ```

### Disaster Recovery Procedure

**Scenario**: Loki pods crash, EFS corrupted

**Recovery Steps**:

1. Check S3 has logs:
   ```bash
   aws s3 ls s3://PROD_LOGS_BUCKET/loki/index_prod_/
   ```

2. If indexes are corrupted, Loki can rebuild from S3:
   - Delete corrupted EFS data (or new PVC)
   - Restart Loki pods
   - Querier rebuilds index from S3 (may take time)

3. Monitor recovery:
   ```bash
   kubectl logs -f <loki-pod> -n monitoring | grep index
   ```

4. Query recent logs:
   ```bash
   # Logs from past 24h should be available
   # Older logs require index rebuild
   ```

## Troubleshooting

### Promtail not sending logs

**Check Promtail pod logs**:
```bash
kubectl logs -f <promtail-pod> -n monitoring
```

**Common errors**:
- `connection refused`: Loki not running, check Loki pods
- `unauthorized`: Check auth in promtail-config.yaml
- `write timeout`: Loki too slow, check resource usage

**Fix**:
```bash
# Restart Promtail
kubectl rollout restart daemonset/promtail -n monitoring

# Check service endpoint
kubectl get svc -n monitoring loki
```

### Loki not ingesting logs

**Check Loki pod logs**:
```bash
kubectl logs -f <loki-pod> -n monitoring
```

**Common errors**:
- `permission denied on /loki`: EFS mount issue, check PVC
- `s3: no such host`: S3 connectivity, check AWS credentials
- `rate limited`: Too many logs, increase rate limit

**Fix**:
```bash
# Check PVC mount
kubectl exec <loki-pod> -n monitoring -- mount | grep loki

# Check S3 credentials
kubectl get secret -n monitoring | grep aws

# Increase rate limit in values files
```

### Queries timing out

**Check querier logs**:
```bash
kubectl logs <loki-pod> -n monitoring | grep querier
```

**Reduce query scope**:
```logql
# Bad: queries last 7 days
{cluster="prod"}[7d]

# Good: queries last 1 hour
{cluster="prod"}[1h]
```

**Add label filters**:
```logql
# Bad: millions of series
{job="container_logs"}

# Good: specific pod
{pod="router-1", namespace="clarity-router"}
```

### Storage full

**Check PVC usage**:
```bash
kubectl exec <loki-pod> -n monitoring -- df -h /loki
# If > 90% usage:

# Option 1: Increase PVC size
kubectl patch pvc loki-storage -n monitoring \
  -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Option 2: Reduce retention
# Edit values-prod.yaml, decrease reject_old_samples_max_age
# Redeploy with `helm upgrade`
```

### High cardinality issues

**Check for high-cardinality labels**:
```bash
# Query Prometheus for Loki metrics
# Metric: loki_ingester_memory_streams

# If high, check Promtail config for dynamic labels
kubectl get configmap promtail-config -n monitoring -o yaml | grep regex
```

**Fix**:
1. Remove high-cardinality labels from Promtail config
2. Restart Promtail: `kubectl rollout restart daemonset/promtail -n monitoring`
3. Old high-cardinality logs will age out after 30 days

## Monitoring and Alerting

### Key Metrics

| Metric | Threshold | Alert |
|--------|-----------|-------|
| `loki_distributor_bytes_received_total` | Baseline | Track ingestion rate |
| `loki_ingester_chunks_created_total` | High spike | May indicate cardinality issue |
| `loki_querier_request_duration_seconds` (p99) | > 5s | Slow queries |
| `loki_ingester_memory_streams` | > 50000 | High cardinality |
| `kubelet_volume_stats_used_bytes` (PVC) | > 80% | Storage nearly full |
| `up{job="loki"}` | 0 | Loki pods down |
| `promtail_read_bytes_total` | No increase | Promtail not reading logs |

### Prometheus Alert Rules

```yaml
groups:
  - name: loki
    rules:
      # Alert if Loki pods are down
      - alert: LokiDown
        expr: up{job="loki"} == 0
        for: 5m
        annotations:
          summary: "Loki pod down"
      
      # Alert if PVC is nearly full
      - alert: LokiStorageFull
        expr: kubelet_volume_stats_used_bytes{persistentvolumeclaim="loki-storage"} 
              / kubelet_volume_stats_capacity_bytes > 0.8
        for: 10m
        annotations:
          summary: "Loki storage >80% full"
      
      # Alert if ingestion rate drops
      - alert: LokiIngestRateLow
        expr: rate(loki_distributor_bytes_received_total[5m]) < 1000000
        for: 15m
        annotations:
          summary: "Loki ingest rate low (check Promtail)"
      
      # Alert if high cardinality
      - alert: LokiHighCardinality
        expr: loki_ingester_memory_streams > 50000
        for: 10m
        annotations:
          summary: "Loki high cardinality (check labels)"
```

### Grafana Dashboard

Create a dashboard with panels:

1. **Ingestion Rate**: `rate(loki_distributor_bytes_received_total[5m])`
2. **Chunk Creation Rate**: `rate(loki_ingester_chunks_created_total[5m])`
3. **Query Duration (p99)**: `loki_querier_request_duration_seconds_bucket{le="5"}`
4. **Cardinality**: `loki_ingester_memory_streams`
5. **Storage Usage**: `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100`
6. **Promtail Read Rate**: `rate(promtail_read_bytes_total[5m])`

## Cost Estimation

### Monthly Costs (Approximate)

| Component | Size | Cost | Notes |
|-----------|------|------|-------|
| EFS Storage | 150GB | $45 | $0.30/GB-month |
| S3 Storage | 150GB | $3.45 | $0.023/GB-month |
| Compute (3 Loki + Promtail) | 3x 1000m CPU | ~$100 | EC2-on-demand pricing |
| Data Transfer (S3) | ~1TB/month | ~$20 | Intra-region |
| **Total (Production)** | | **~$170-200/month** | |

### Cost Optimization

1. **Reduce retention**: 30 days → 14 days = 50% storage savings
2. **Enable S3 Intelligent-Tiering**: Automatic cost optimization
3. **Use EFS autoscaling**: Pay only for used space
4. **Reserve compute**: 1-year reservation for Kubernetes nodes

## Integration with Observability Stack

### With Prometheus

Loki metrics scraped by Prometheus:
```yaml
# In prometheus-config.yaml
scrape_configs:
  - job_name: loki
    static_configs:
      - targets: ['loki:3100']
    metrics_path: /metrics
```

### With Grafana

Loki datasource for log queries:
1. Grafana > Data Sources > Add Loki
2. URL: `http://loki:3100`
3. Use in dashboard panels with LogQL queries

### With AlertManager

Alert rules based on log patterns:
```logql
# Create alert if error rate exceeds threshold
count_over_time({cluster="prod"} |= "error"[5m]) > 100
```

## References

- [Loki Documentation](https://grafana.com/docs/loki/latest/)
- [LogQL Query Language](https://grafana.com/docs/loki/latest/logql/)
- [Promtail Configuration](https://grafana.com/docs/loki/latest/clients/promtail/configuration/)
- [Loki Architecture](https://grafana.com/docs/loki/latest/fundamentals/architecture/)
- [Best Practices](https://grafana.com/docs/loki/latest/best-practices/)

## Support and Troubleshooting

For detailed troubleshooting:
1. Check Loki pod logs: `kubectl logs -f <pod> -n monitoring`
2. Check Promtail pod logs: `kubectl logs -f <pod> -n monitoring`
3. Query Loki health: `curl http://loki:3100/ready`
4. Check metrics: `curl http://loki:3100/metrics | head -30`

Common issues and solutions are documented in the **Troubleshooting** section above.
