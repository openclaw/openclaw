# Staging Observability Stack - Failure Scenario & Resilience Testing

## Overview
This guide tests how the observability stack handles failures and recovers gracefully. These tests verify high availability, data consistency, and operational resilience.

**Prerequisites:**
- All components healthy and passing previous tests
- kubectl access to staging cluster
- Understanding of PodDisruptionBudgets (PDBs)
- Backup procedures documented before testing
- Slack notifications monitored during tests

**WARNING:** These tests intentionally cause failures. Run during designated maintenance windows with team awareness.

---

## Pod Failure Testing

### Test 1: Prometheus Pod Failure

**Kill Prometheus-0 Pod:**

```bash
# Kill the first Prometheus replica
kubectl -n monitoring delete pod prometheus-0

# Prometheus StatefulSet will automatically recreate it
# Monitor recreation
kubectl -n monitoring get pods -l app=prometheus -w
# Expected: prometheus-0 in "ContainerCreating" state, then "Running"
```

**Verify Continued Operation:**

```bash
# Query Prometheus through service (load balancer)
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &

# Should still work through remaining replica (prometheus-1)
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length'
# Expected: >0 (queries still work)
```

**Verify Data Continuity:**

```bash
# Compare metric values before/after pod restart
BEFORE=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' | jq '.data.result[0].value[1]')
sleep 60
AFTER=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' | jq '.data.result[0].value[1]')

# Values should increase (no data loss)
echo "Before: $BEFORE"
echo "After: $AFTER"
# Expected: AFTER > BEFORE (metrics still being collected)
```

**Check PVC Persistence:**

```bash
# Verify data was persisted on the PVC
kubectl -n monitoring get pvc prometheus-data-prometheus-0

# New pod should mount same PVC and have all historical data
curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=3600&end=0&step=300' | jq '.data.result[0].values | length'
# Expected: >100 (data points from past hour still available)
```

**Success Criteria:**
- Pod recreates automatically
- Queries work through remaining replica
- No data loss
- Historical metrics available from PVC
- Recovery time <2 minutes

---

### Test 2: Grafana Pod Failure

**Kill Grafana-0 Pod:**

```bash
# Kill one Grafana replica
kubectl -n monitoring delete pod grafana-0

# Monitor recreation
kubectl -n monitoring get pods -l app=grafana -w
```

**Verify Dashboards Still Accessible:**

```bash
# Access Grafana through service
kubectl -n monitoring port-forward svc/grafana 3000:3000 &

# Should route to grafana-1
curl -s 'http://localhost:3000/api/health' -u admin:admin | jq '.version'
# Expected: Returns version (connection succeeds)
```

**Verify Dashboard Persistence:**

```bash
# Dashboards stored in external database or ConfigMap
# Should not be lost when pod restarts

# Check saved dashboards still accessible
curl -s 'http://localhost:3000/api/search' -u admin:admin | jq '.[].title'
# Expected: All dashboards still listed
```

**Success Criteria:**
- Pod recreates automatically
- Grafana accessible through load balancer
- Dashboards survive pod restart
- Datasource connections restored
- Recovery time <2 minutes

---

### Test 3: Loki Pod Failure

**Kill Loki-0 Pod:**

```bash
# Kill one Loki replica
kubectl -n monitoring delete pod loki-0

# Monitor recreation
kubectl -n monitoring get pods -l app=loki -w
```

**Verify Log Ingestion Continues:**

```bash
# Promtail should send to remaining Loki replica
kubectl -n monitoring port-forward svc/loki 3100:3100 &

# Query logs
curl -s 'http://localhost:3100/loki/api/v1/query?query={cluster="staging"}' | jq '.data.result | length'
# Expected: >0 (logs still ingested)
```

**Verify Logs Not Lost:**

```bash
# Historical logs should still be queryable
CURRENT=$(date +%s)000000000
START=$((CURRENT - 3600000000000))
curl -s "http://localhost:3100/loki/api/v1/query_range?query={namespace=\"monitoring\"}&start=$START&end=$CURRENT" | \
  jq '.data.result | length'
# Expected: >0 (logs from past hour available)
```

**Success Criteria:**
- Pod recreates automatically
- Log ingestion continues
- No logs lost
- Historical logs queryable
- Recovery time <2 minutes

---

### Test 4: AlertManager Pod Failure

**Kill AlertManager-0 Pod:**

```bash
# Kill one AlertManager replica
kubectl -n monitoring delete pod alertmanager-0

# Monitor recreation
kubectl -n monitoring get pods -l app=alertmanager -w
```

**Verify Alerts Still Route:**

```bash
# Send test alert
kubectl -n monitoring port-forward svc/alertmanager 9093:9093 &

curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "PodFailureTest", "severity": "critical"},
    "annotations": {"summary": "Testing pod failure"},
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Verify alert routes and Slack notification sent
# Expected: Alert in #monitoring-staging-critical within 1 minute
```

**Success Criteria:**
- Pod recreates automatically
- Alert routing continues
- Slack notifications delivered
- No alerts lost
- Recovery time <2 minutes

---

## Replica Synchronization Testing

### Prometheus Data Consistency

**Verify Replicas Have Identical Metrics:**

```bash
# Query same metric from both replicas
kubectl -n monitoring port-forward pod/prometheus-0 9090:9090 &
PROM0=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' | jq '.data.result[0].value[1]')

pkill -f "port-forward pod/prometheus-0"
kubectl -n monitoring port-forward pod/prometheus-1 9090:9090 &
PROM1=$(curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_requests_total' | jq '.data.result[0].value[1]')

# Calculate difference percentage
DIFF=$(echo "scale=2; (($PROM1 - $PROM0) / $PROM0) * 100" | bc)
echo "Difference: ${DIFF}%"
# Expected: <1% difference
```

**Verify Timestamps Match:**

```bash
# Query timestamps should be within 1 scrape interval
PROM0_TIME=$(curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result[0].value[0]')

pkill -f "port-forward pod/prometheus-0"
kubectl -n monitoring port-forward pod/prometheus-1 9090:9090 &
PROM1_TIME=$(curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result[0].value[0]')

DIFF=$((PROM1_TIME - PROM0_TIME))
echo "Timestamp difference: $DIFF seconds"
# Expected: <5 seconds
```

**Success Criteria:**
- Metric values within 1% between replicas
- Timestamps within 5 seconds
- Both replicas serve consistent queries
- No replication lag visible

---

### AlertManager Deduplication

**Test Alert Deduplication Across Replicas:**

```bash
# Send same alert to both AlertManager replicas
ALERT_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

# Send to AlertManager pod-0
kubectl -n monitoring port-forward pod/alertmanager-0 9093:9093 &
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "DeduplicateTest", "severity": "critical"},
    "annotations": {"summary": "Dedup test"},
    "startsAt": "'$ALERT_TIME'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

sleep 2

# Send same alert to pod-1
pkill -f "port-forward pod/alertmanager-0"
kubectl -n monitoring port-forward pod/alertmanager-1 9093:9093 &
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "DeduplicateTest", "severity": "critical"},
    "annotations": {"summary": "Dedup test"},
    "startsAt": "'$ALERT_TIME'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Monitor Slack for single notification (not two)
# Expected: 1 Slack message (not 2)
```

**Success Criteria:**
- Same alert to both replicas → 1 Slack message
- Deduplication working across cluster
- No duplicate notifications
- Alert state consistent between replicas

---

### Loki Index Consistency

**Verify Both Replicas Have Same Indices:**

```bash
# Query label cardinality from both replicas
kubectl -n monitoring port-forward pod/loki-0 3100:3100 &
LOKI0=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

pkill -f "port-forward pod/loki-0"
kubectl -n monitoring port-forward pod/loki-1 3100:3100 &
LOKI1=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

echo "Loki-0 labels: $LOKI0"
echo "Loki-1 labels: $LOKI1"
# Expected: Same or within 1 label
```

**Success Criteria:**
- Label indices consistent between replicas
- Same log entries queryable from both
- No index corruption
- Replication lag <1 minute

---

## Storage Failure Testing

### Test 1: PVC Space Pressure

**Monitor Disk Usage Growth:**

```bash
# Create script to monitor PVC usage
while true; do
  kubectl -n monitoring get pvc -o json | \
    jq '.items[] | {name: .metadata.name, capacity: .spec.resources.requests.storage, status: .status.capacity.storage}'
  sleep 300
done
```

**Simulate Storage Pressure (Optional):**

```bash
# WARNING: This may impact system stability
# Create large files to reduce available space
# Monitor system behavior at different capacity levels:
# - 50% full: Normal operation
# - 70% full: Performance degradation
# - 85% full: Warnings, potential throttling
# - 95% full: Severe degradation, possible data loss risk
```

**Verify Graceful Degradation:**

```bash
# At 90% capacity:
# - Queries should still work (possibly slower)
# - Retention should still delete old data
# - Ingestion should continue (or slow gracefully)
# - No data loss should occur

# Monitor component logs for disk pressure warnings
kubectl -n monitoring logs -f deployment/prometheus | grep -i "disk\|storage"
kubectl -n monitoring logs -f deployment/loki | grep -i "disk\|storage"
```

**Success Criteria:**
- System operates at 90% full
- No sudden failures
- Warnings logged appropriately
- Retention policies still function
- No data corruption

---

### Test 2: PVC Restore

**Simulate PVC Restoration:**

```bash
# Create backup before test
kubectl -n monitoring get pvc prometheus-data -o yaml > prometheus-pvc-backup.yaml

# Delete PVC (WARNING: will delete all data on that PVC)
# kubectl -n monitoring delete pvc prometheus-data
# DON'T ACTUALLY RUN THIS - VERIFY IT'S DOCUMENTED ONLY

# Restore from backup
# kubectl -n monitoring apply -f prometheus-pvc-backup.yaml

# In production, use snapshot-based recovery:
# kubectl -n monitoring get volumesnapshot
```

**Success Criteria:**
- Procedure documented and tested
- Data can be restored
- No data loss during restore
- Components restart correctly with restored data

---

## Alerting Under Load

### Test: High Volume Alerts

**Generate Multiple Alerts Simultaneously:**

```bash
# Send 50 critical alerts in quick succession
for i in {1..50}; do
  curl -X POST 'http://localhost:9093/api/v1/alerts' \
    -H 'Content-Type: application/json' \
    -d '[{
      "labels": {
        "alertname": "LoadTest",
        "severity": "critical",
        "instance": "instance-'$i'"
      },
      "annotations": {"summary": "Load test alert $i"},
      "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
      "endsAt": "0001-01-01T00:00:00Z"
    }]' &
done
wait

# All background jobs complete, alerts sent
```

**Verify Processing:**

```bash
# Monitor AlertManager performance
kubectl -n monitoring logs -f deployment/alertmanager | grep -E "alert|group|notification"

# Check Slack for messages
# Expected: Grouped messages, not 50 individual ones
# Expected latency: <2 minutes
```

**Monitor Resource Usage:**

```bash
# Watch AlertManager resource usage during load
kubectl -n monitoring top pod -l app=alertmanager --containers
# Expected: CPU spike but no memory leak, returns to normal
```

**Success Criteria:**
- 50 alerts processed without errors
- Proper grouping applied (1 message, not 50)
- Slack notifications delivered
- CPU usage spikes but recovers
- No dropped alerts or notifications

---

## Network Failure Testing

### Test: Temporary Service Connectivity Loss

**Simulate Network Partition (Controlled):**

```bash
# Create network policy to block traffic (then remove it)
# WARNING: Only for controlled testing

# Temporarily block Prometheus → AlertManager
kubectl -n monitoring create networkpolicy deny-alertmanager --deny-ingress -l app=alertmanager

# During partition, send alert
# It should fail to route
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[...]'
# Expected: Fails or times out

# Remove network policy
kubectl -n monitoring delete networkpolicy deny-alertmanager

# Alert should reach AlertManager once restored
```

**Monitor Recovery:**

```bash
# Check that queued alerts are processed once connection restored
# Check logs for retry behavior

# Expected: Alerts eventually delivered despite temporary partition
```

**Success Criteria:**
- Temporary network partition detected
- Components gracefully handle timeouts
- Recovery automatic once connectivity restored
- No data loss
- Alerts eventually delivered

---

## Metric/Log Ingestion Failure

### Test: Metric Ingestion Degradation

**Simulate Slow Metric Collection:**

```bash
# Introduce latency in metrics scraping
# (Requires modifying scrape job or target latency)

# Monitor Prometheus behavior:
# - Scrape job timeouts after 30 seconds
# - Metrics marked as "stale" after 5 minutes
# - Alerting rules based on stale metrics may not fire
```

**Verify Graceful Handling:**

```bash
# Query system behavior with stale metrics
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length'

# Check for stale data warnings
kubectl -n monitoring logs -f deployment/prometheus | grep -i stale
```

**Success Criteria:**
- Stale metrics marked appropriately
- Queries still work on available data
- Alerts based on non-stale metrics still fire
- No cascading failures
- Recovery automatic when scraping resumes

---

### Test: Log Ingestion Backpressure

**Simulate High Log Volume:**

```bash
# Generate extreme log volume (caution: may impact system)
for i in {1..10000}; do
  logger "Test log message $i"
done &

# Monitor Loki behavior
kubectl -n monitoring top pod -l app=loki
# Expected: CPU increases, but doesn't OOM

# Check Loki logs for backpressure handling
kubectl -n monitoring logs -f deployment/loki | grep -i "buffer\|queue\|backpressure"
```

**Monitor Recovery:**

```bash
# Once log generation stops, Loki should catch up
# Query recent logs to verify ingestion complete
curl -s 'http://localhost:3100/loki/api/v1/query?query={job="test"}' | \
  jq '.data.result | length'
```

**Success Criteria:**
- Loki handles high volume without crashing
- Backpressure applied gracefully (rate-limiting)
- No logs lost
- Recovers when volume decreases
- CPU and memory return to normal

---

## Kubernetes Node Failure

### Test: Node Evacuation

**Simulate Node Evacuation (Controlled):**

```bash
# Cordon a node (prevent new pods)
NODE=$(kubectl -n monitoring get pod prometheus-0 -o jsonpath='{.spec.nodeName}')
kubectl cordon $NODE

# Drain the node (evict pods - respects PDBs)
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data

# Monitor pod eviction
kubectl -n monitoring get pods -w
# Expected: Pods recreate on other nodes
```

**Verify Application Continues:**

```bash
# After pod migration, queries should still work
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length'
# Expected: >0 (still operational)
```

**Uncordon Node:**

```bash
# Once testing complete, restore node
kubectl uncordon $NODE
```

**Success Criteria:**
- PDBs prevent simultaneous pod evictions
- Pods migrate to other nodes
- Data preserved during migration
- Service continues uninterrupted
- Pod rescheduling completes in <5 minutes

---

## PodDisruptionBudget Verification

**Verify PDBs Are Configured:**

```bash
# Check PDBs exist for all components
kubectl -n monitoring get pdb
# Expected: One PDB per component requiring HA
```

**Verify PDB Protection:**

```bash
# Attempt to evict more pods than allowed
# PDB should prevent it

# Check PDB status
kubectl -n monitoring get pdb prometheus -o yaml | jq '.status'
# Expected: disruptionsAllowed: 1 (for 2 replicas)
```

**Success Criteria:**
- All HA components have PDBs
- PDBs prevent simultaneous failures
- minAvailable or maxUnavailable correctly set
- Disruption budgets respected during node drain

---

## Success Checklist

- [ ] Pod failure triggers automatic recreation
- [ ] Remaining replicas maintain service continuity
- [ ] Data persists across pod restarts
- [ ] Replica synchronization verified
- [ ] Deduplication working across cluster
- [ ] System handles 90% disk capacity
- [ ] Graceful degradation at high capacity
- [ ] High alert volume grouped and deduplicated
- [ ] Network partition handled gracefully
- [ ] Metric ingestion failures don't cascade
- [ ] Log ingestion backpressure working
- [ ] Node evacuation respects PDBs
- [ ] Pods migrate successfully to other nodes
- [ ] PDBs prevent simultaneous failures
- [ ] All recovery operations complete in <5 minutes
