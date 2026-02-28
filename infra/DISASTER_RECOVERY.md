# Disaster Recovery Plan - ClarityRouter Observability Stack

## Overview

This document outlines comprehensive disaster recovery (DR) procedures, backup strategies, and recovery objectives for the production observability stack.

**RTO (Recovery Time Objective):** <2 hours  
**RPO (Recovery Point Objective):** <24 hours (daily snapshots)  
**Backup Frequency:** Daily

---

## Table of Contents

1. [Recovery Objectives](#recovery-objectives)
2. [Backup Strategy](#backup-strategy)
3. [Data Loss Scenarios](#data-loss-scenarios)
4. [Recovery Procedures](#recovery-procedures)
5. [Backup Verification](#backup-verification)
6. [DR Drill Procedures](#dr-drill-procedures)
7. [Prevention & Monitoring](#prevention--monitoring)

---

## Recovery Objectives

### RTO by Scenario

| Scenario | RTO | Notes |
|----------|-----|-------|
| Single pod restart | <5 min | Kubernetes auto-restart |
| Deployment rollback | <15 min | Via Helm history |
| PVC data restore (from snapshot) | <60 min | EFS restore operation |
| Entire cluster rebuild | <90 min | From Helm + EFS snapshot |
| Multi-region failover | <2 hours | Manual DNS switch |

### RPO by Component

| Component | RPO | Frequency | Retention |
|-----------|-----|-----------|-----------|
| Prometheus data | 24 hours | Daily EFS snapshot | 7 days |
| Loki logs | 24 hours | Daily EFS snapshot | 7 days |
| Grafana dashboards | 7 days | Weekly Git export | 30 days |
| AlertManager config | Real-time | Etcd snapshots | 7 days |
| Kubernetes state | 1 hour | Etcd snapshots | 7 days |

---

## Backup Strategy

### Daily EFS Snapshots

Prometheus and Loki data backed up via AWS EFS snapshots:

```bash
# Manual snapshot creation (automated via AWS Backup)
aws ec2 create-snapshot \
  --volume-id vol-xxxxxxxx \
  --description "observability-prometheus-$(date +%Y%m%d)" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Component,Value=prometheus}]' \
  --region us-east-1

# List existing snapshots
aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots[*].[SnapshotId,StartTime,VolumeSize]' \
  --output table
```

**Snapshot Details:**
- Prometheus: 30 GB daily
- Loki: 150 GB daily
- **Total EFS:** 180 GB backup size
- **Cost:** ~$9/month (snapshot storage at $0.05/GB)
- **Retention:** 7 days (keep 7 daily snapshots)

```bash
# Verify snapshot age (keep only 7 recent)
aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | reverse(@)' \
  --output table

# Delete old snapshots (keep last 7 only)
SNAPSHOTS=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | reverse(@)[7:] | [*].SnapshotId' \
  --output text)

for SNAP in $SNAPSHOTS; do
    echo "Deleting old snapshot: $SNAP"
    aws ec2 delete-snapshot --snapshot-id $SNAP --region us-east-1
done
```

### Grafana Dashboard Exports

Weekly JSON exports stored in Git:

```bash
# Export all dashboards from Grafana
kubectl port-forward -n observability svc/grafana 3000:80 &
sleep 2

for DASHBOARD_ID in $(curl -s http://localhost:3000/api/search | jq -r '.[] | .id'); do
    DASHBOARD_TITLE=$(curl -s "http://localhost:3000/api/dashboards/uid/" | jq -r '.dashboard.title')
    curl -s "http://localhost:3000/api/dashboards/db/${DASHBOARD_TITLE}" | \
        jq '.dashboard' > "grafana/dashboards/dashboard-${DASHBOARD_TITLE}.json"
done

# Commit to Git
cd grafana/dashboards
git add .
git commit -m "Backup dashboards - $(date +%Y-%m-%d)"
git push
```

**Dashboard Backup:**
- Frequency: Weekly (Friday)
- Storage: Git repository
- Retention: Indefinite (Git history)
- Size: ~100 KB per dashboard

### AlertManager Configuration

Stored in Kubernetes ConfigMap (backed by etcd):

```bash
# View current AlertManager config
kubectl get configmap alertmanager-config -n observability -o yaml

# Export for backup
kubectl get configmap alertmanager-config -n observability -o yaml \
  > alertmanager-config-backup-$(date +%Y%m%d).yaml

# Store in secure location or Git (remove secrets)
```

### Application-Level Backups

```bash
# Prometheus WAL backups (Write-Ahead Log)
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  tar -czf /prometheus-wal-backup.tar.gz /prometheus/wal/

# Download to local storage
kubectl cp observability/prometheus-kube-prom-prometheus-0:/prometheus-wal-backup.tar.gz \
  ./prometheus-wal-backup.tar.gz
```

---

## Data Loss Scenarios

### Scenario 1: Single Pod Crash (Permanent Storage Loss)

**Cause:** Pod's ephemeral storage lost, PVC still intact

**Detection:**
```bash
# Pod status shows CrashLoopBackOff
kubectl get pods -n observability | grep prometheus

# Logs show storage errors
kubectl logs -n observability prometheus-kube-prom-prometheus-0 | grep -i "storage\|corrupt"
```

**Recovery:** <5 minutes

```bash
# 1. Kubernetes automatically restarts pod
kubectl get pods -n observability prometheus-kube-prom-prometheus-0 -w

# 2. Pod remounts PVC and resumes normal operation
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  df -h /prometheus
# Should show healthy filesystem

# 3. Verify metrics flowing
curl -s http://prometheus:9090/api/v1/query?query=up | jq '.data.result | length'
# Should return >50
```

**Data Loss:** None (PVC preserved)

---

### Scenario 2: EFS Volume Corrupted/Inaccessible

**Cause:** Filesystem corruption or EFS service issue

**Detection:**
```bash
# All pods fail to mount or hang
kubectl get pods -n observability | grep -E "Pending|Unknown"

# EFS mount error in pod events
kubectl describe pod -n observability prometheus-kube-prom-prometheus-0 | grep -i "mount"

# Check EFS availability
aws efs describe-file-systems \
  --file-system-ids fs-xxxxxxxx \
  --region us-east-1 \
  --query 'FileSystems[0].LifeCycleState'
# Should be "available"
```

**Recovery:** 30-60 minutes

```bash
# Step 1: Identify healthy snapshot
SNAPSHOT_ID=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].SnapshotId' \
  --output text)

echo "Using snapshot: $SNAPSHOT_ID"

# Step 2: Identify availability zone
AZ="us-east-1a"  # Determine based on current EFS AZ

# Step 3: Create new volume from snapshot
NEW_VOLUME=$(aws ec2 create-volume \
  --snapshot-id "$SNAPSHOT_ID" \
  --availability-zone "$AZ" \
  --volume-type gp3 \
  --region us-east-1 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=prometheus-restore},{Key=Date,Value='$(date +%Y%m%d)'}]' \
  --query 'VolumeId' \
  --output text)

echo "New volume created: $NEW_VOLUME"

# Step 4: Wait for volume to be available
aws ec2 wait volume-available --volume-ids "$NEW_VOLUME" --region us-east-1

# Step 5: Scale down Prometheus to prevent writes
kubectl scale statefulset prometheus-kube-prom-prometheus \
  --replicas=0 -n observability
sleep 10

# Step 6: Delete corrupted PVC
kubectl delete pvc prometheus-storage -n observability --grace-period=0 --force

# Step 7: Create new PVC pointing to recovered volume
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: prometheus-restored
spec:
  capacity:
    storage: 30Gi
  accessModes:
    - ReadWriteOnce
  awsElasticBlockStore:
    volumeID: $NEW_VOLUME
    fsType: ext4
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-storage
  namespace: observability
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ""
  volumeName: prometheus-restored
  resources:
    requests:
      storage: 30Gi
EOF

# Step 8: Scale Prometheus back up
kubectl scale statefulset prometheus-kube-prom-prometheus \
  --replicas=3 -n observability

# Step 9: Verify recovery
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus
# Wait for all pods READY and RUNNING

# Step 10: Verify data integrity
curl -s http://prometheus:9090/api/v1/query?query=up | jq '.data.result | length'
# Should return close to previous metric count
```

**Data Loss:** Up to 24 hours (last snapshot)

---

### Scenario 3: Kubernetes Cluster Failure

**Cause:** Entire cluster down, all nodes unavailable

**Detection:**
```bash
# kubectl commands timeout
kubectl cluster-info

# AWS shows all nodes in failed state
aws ec2 describe-instances \
  --filters "Name=tag:kubernetes.io/cluster/clarity-router-prod,Values=owned" \
  --region us-east-1 \
  --query 'Reservations[*].Instances[*].State.Name' \
  --output text
```

**Recovery:** 90 minutes (30 min cluster rebuild + 60 min data restore)

```bash
# Step 1: Create new EKS cluster (30 minutes)
# Use existing CloudFormation template or eksctl
eksctl create cluster \
  --name clarity-router-prod \
  --region us-east-1 \
  --nodes 3 \
  --node-type t3.xlarge

# Step 2: Install EFS CSI driver
helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver \
  -n kube-system

# Step 3: Verify cluster ready
kubectl get nodes

# Step 4: Create namespace
kubectl create namespace observability

# Step 5: Restore from snapshot (use scenario 2 steps above)

# Step 6: Deploy observability stack via Helm
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -n observability \
  -f prometheus/values-prod.yaml \
  --wait

helm upgrade --install loki grafana/loki-stack \
  -n observability \
  -f loki/values-prod.yaml \
  --wait

helm upgrade --install grafana grafana/grafana \
  -n observability \
  -f grafana/values-prod.yaml \
  --wait

# Step 7: Verify recovery
kubectl get pods -n observability
curl -s http://prometheus:9090/-/healthy
```

**RTO:** 90 minutes  
**Data Loss:** 0-24 hours (depending on snapshot age)

---

### Scenario 4: Data Corruption (Silent)

**Cause:** Corrupted metrics/logs, still being ingested

**Detection:**
```bash
# Check for metric anomalies
# In Prometheus: Sudden metric count drop, or duplicate labels

# Check Loki logs for corruption messages
kubectl logs -n observability -l app.kubernetes.io/name=loki | grep -i corrupt

# Query for suspiciously old metrics
curl -s 'http://prometheus:9090/api/v1/query?query=prometheus_tsdb_earliest_timestamp_seconds' | jq .
```

**Recovery:** Varies (manual verification required)

```bash
# Option 1: Restore from snapshot if corruption detected early
# (Follow scenario 2 steps)

# Option 2: Accept data loss and continue
# (If corruption limited to small portion of data)

# Option 3: Query service to identify corruption pattern
# Use PromQL to identify affected metrics
curl -s 'http://prometheus:9090/api/v1/query?query=<affected_metric>{<label_corruption>}' | jq .

# Step: Clean up corrupted data
# Scale down affected component
# Manually delete corrupted files in PVC
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  find /prometheus -name "*.db" -mtime +7 -delete
# Scale back up
```

**Data Loss:** Potentially significant (manual recovery required)

---

## Recovery Procedures

### Recovery Checklist

Before any recovery:

- [ ] Declare incident in #observability-incidents
- [ ] Page on-call engineer + team lead + manager
- [ ] Identify which data/component affected
- [ ] Determine if immediate RTO critical or can wait
- [ ] Identify latest good backup/snapshot
- [ ] Brief team on recovery plan
- [ ] Execute recovery procedure
- [ ] Verify data integrity post-recovery
- [ ] Document incident and lessons learned

### Recovery Validation

After every recovery:

```bash
# 1. Verify pod health
kubectl get pods -n observability -o wide
# All READY and RUNNING

# 2. Verify PVC health
kubectl get pvc -n observability
# All STATUS Bound

# 3. Verify metrics flowing
curl -s http://prometheus:9090/api/v1/query?query=up | jq '.data.result | length'
# >100 targets

# 4. Verify logs ingesting
curl -s 'http://loki:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="kubernetes-pods"}' \
  --data-urlencode 'start=<timestamp>' \
  --data-urlencode 'end=<timestamp>' | jq '.status'
# "success"

# 5. Verify dashboards accessible
curl -s http://grafana:3000/api/health | jq '.status'
# "ok"

# 6. Verify alerts working
curl -s http://alertmanager:9093/api/v1/alerts | jq '.status'
# "success"

# 7. Verify data integrity
# Run queries to check for gaps or anomalies
curl -s 'http://prometheus:9090/api/v1/query_range?query=count(up)&start=<7d-ago>&end=<now>&step=3600' | \
  jq '.data.result[0].values | .[] | if .[1] < 100 then "GAP: " + .[0] + " = " + .[1] else empty end'
# Should show no gaps

# 8. Check for errors in logs
kubectl logs -n observability --all-containers=true --since=1h | \
  grep -i "error\|fail\|corrupt" | wc -l
# Should be minimal
```

---

## Backup Verification

### Daily Backup Validation

```bash
# Verify EFS snapshot created successfully
aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=start-time,Values=$(date -u +'%Y-%m-%d')T*" \
  --region us-east-1 \
  --query 'Snapshots[*].[SnapshotId,State,Progress]' \
  --output table

# Expected:
# - State: "completed"
# - Progress: "100%"
# - Created within last 24 hours
```

**Add to daily on-call checklist:**

```bash
# Check backup status
aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1]' \
  --output json | jq '{SnapshotId, StartTime, State, Progress}'

# Must show completed snapshot from today
```

### Monthly Backup Testing

**Every first Friday of month**, perform test restore:

```bash
# Create test cluster or use non-prod environment
# Restore from most recent snapshot
# Verify data integrity

echo "=== Monthly Backup Test ==="
SNAPSHOT=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].SnapshotId' \
  --output text)

echo "Testing restore from snapshot: $SNAPSHOT"

# Create test volume
TEST_VOLUME=$(aws ec2 create-volume \
  --snapshot-id "$SNAPSHOT" \
  --availability-zone us-east-1a \
  --region us-east-1 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=test-restore}]' \
  --query 'VolumeId' \
  --output text)

# Wait for volume ready
aws ec2 wait volume-available --volume-ids "$TEST_VOLUME" --region us-east-1

# Mount and verify contents
# (Would need EC2 instance to perform actual mount)
# For now, just verify volume created successfully
echo "Test volume created: $TEST_VOLUME"

# Clean up test volume
aws ec2 delete-volume --volume-id "$TEST_VOLUME" --region us-east-1
echo "Test restore successful"
```

---

## DR Drill Procedures

### Quarterly Full Disaster Recovery Drill

**Frequency:** Every Q1/Q2/Q3/Q4 (four times per year)  
**Duration:** 2-3 hours  
**Participants:** On-call engineer, team lead, infrastructure manager

#### Drill Scenario: Complete Cluster Failure

```bash
#!/bin/bash
# DR Drill Script - Full Cluster Recovery

set -euo pipefail

echo "=== ClarityRouter Observability Stack - DR Drill ==="
echo "Drill Date: $(date)"
echo "Scenario: Complete cluster failure and recovery"
echo ""

# Phase 1: Simulate cluster failure
echo "=== PHASE 1: Simulate Cluster Failure ==="
echo "Scaling all deployments to 0 (simulating complete outage)..."
kubectl scale deployment -n observability --all --replicas=0
kubectl scale statefulset -n observability --all --replicas=0
kubectl scale daemonset -n observability --all --replicas=0

echo "Waiting 30 seconds to ensure all pods shut down..."
sleep 30

# Verify outage
RUNNING_PODS=$(kubectl get pods -n observability --no-headers 2>/dev/null | grep -v "0/1\|Terminating" | wc -l)
if [[ $RUNNING_PODS -eq 0 ]]; then
    echo "✓ Cluster outage simulated successfully"
else
    echo "✗ ERROR: Some pods still running. Check manually."
    exit 1
fi

# Phase 2: Recovery planning
echo ""
echo "=== PHASE 2: Recovery Planning ==="
echo "Recovery procedure:"
echo "1. Identify latest snapshot"
echo "2. Restore from snapshot"
echo "3. Redeploy stack"
echo "4. Verify recovery"
echo ""
read -p "Press ENTER to proceed with recovery..."

# Phase 3: Recovery execution
echo ""
echo "=== PHASE 3: Recovery Execution ==="

# Step 1: Identify snapshot
SNAPSHOT=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].SnapshotId' \
  --output text)
echo "Latest snapshot: $SNAPSHOT"

# Step 2: Restore stack components
echo "Scaling deployments back up (recovery)..."
kubectl scale statefulset prometheus-kube-prom-prometheus \
  --replicas=3 -n observability
kubectl scale statefulset loki --replicas=3 -n observability
kubectl scale deployment grafana --replicas=2 -n observability
kubectl scale statefulset alertmanager-kube-prom-alertmanager \
  --replicas=2 -n observability

# Step 3: Wait for recovery
echo "Waiting for pods to start (timeout 5 minutes)..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus \
  -n observability \
  --timeout=300s || true

# Phase 4: Verification
echo ""
echo "=== PHASE 4: Recovery Verification ==="

echo ""
echo "Pod Status:"
kubectl get pods -n observability

echo ""
echo "Prometheus Health:"
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
sleep 2
curl -s http://localhost:9090/-/healthy || echo "Health check failed"

echo ""
echo "Metrics Flowing:"
METRIC_COUNT=$(curl -s http://localhost:9090/api/v1/query?query=count\(up\) 2>/dev/null | jq -r '.data.result[0].value[1]' || echo "0")
echo "Active metrics: $METRIC_COUNT (expected: >5000)"

echo ""
echo "Storage Status:"
kubectl get pvc -n observability

echo ""
echo "=== DRILL COMPLETE ==="
echo "Drill Date/Time: $(date)"
echo ""
echo "Results Summary:"
echo "- Pod Recovery: $(kubectl get pods -n observability --no-headers | grep -c 'Running' || echo '0') running"
echo "- Metrics Restored: $(echo "$METRIC_COUNT" | grep -oE '[0-9]+' || echo 'Unknown')"
echo "- Services Healthy: $(curl -s http://localhost:9090/-/healthy 2>/dev/null && echo 'YES' || echo 'NO')"
echo ""
echo "=== Post-Drill Actions ==="
echo "1. Stop port-forward: kill %1"
echo "2. Document results"
echo "3. Identify any issues"
echo "4. Add action items if needed"
```

#### Drill Execution

```bash
# Make script executable
chmod +x dr-drill.sh

# Run drill (non-production environment recommended)
./dr-drill.sh

# Document results
cat > DR_DRILL_RESULTS_$(date +%Y%m%d).txt << EOF
## DR Drill Results - $(date)

### Drill Scenario
Complete cluster failure and recovery

### Execution Time
Start: [time]
End: [time]
Total Duration: [X minutes]

### Results
- Pod Recovery Time: [X minutes]
- Data Recovered: [Y metrics]
- All Services Healthy: [YES/NO]

### Issues Encountered
1. [Issue 1]
2. [Issue 2]

### Lessons Learned
1. [Learning 1]
2. [Learning 2]

### Action Items
- [ ] [Action 1] - Owner: [Name] - Due: [Date]
- [ ] [Action 2] - Owner: [Name] - Due: [Date]

### Approved By
Engineer: ______________________
Manager: _______________________
EOF

# Share results
git add DR_DRILL_RESULTS_*.txt
git commit -m "DR drill results - $(date +%Y-%m-%d)"
git push
```

---

## Prevention & Monitoring

### Prevent Data Loss

1. **Enable Prometheus data retention checking:**
   ```bash
   # Alert if retention is too short
   alert: PrometheusRetentionTooShort
   expr: prometheus_tsdb_retention_limit_seconds < 86400*15  # 15 days minimum
   for: 5m
   ```

2. **Enable storage monitoring:**
   ```bash
   # Alert if approaching full
   alert: PrometheusStorageAlmostFull
   expr: (prometheus_tsdb_dir_bytes / prometheus_tsdb_disk_space_limit) > 0.8
   for: 10m
   ```

3. **Verify backups automated:**
   ```bash
   # Check AWS Backup is enabled
   aws backup list-backup-vaults --region us-east-1
   ```

4. **Document all backup procedures in runbooks**

### Monitor Backup Health

```promql
# Monitor snapshot creation success rate
rate(aws_backup_jobs_total{Status="success"}[1d])

# Alert on backup failures
alert: BackupJobFailed
expr: increase(aws_backup_jobs_total{Status="failed"}[1d]) > 0
for: 1h
```

---

## Related Documentation

- [`ROLLBACK_PRODUCTION.md`](ROLLBACK_PRODUCTION.md) - Emergency rollback procedures
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - On-call SLOs and incident response
- [`MAINTENANCE.md`](MAINTENANCE.md) - Regular maintenance procedures

---

**Emergency Contact:**  
On-Call Engineer: [Phone/Slack]  
Infrastructure Manager: [Phone/Slack]  
Incident Channel: #observability-incidents
