# Production Rollback Procedures - ClarityRouter Observability Stack

## Overview

This document provides step-by-step procedures to rollback the production observability stack to a previous stable state. Rollback may be necessary due to:

- Critical bugs or regressions
- Performance degradation
- Data corruption
- Security vulnerabilities
- Component failures

**Rollback Time Objective (RTO):** <15 minutes  
**Decision Window:** 5 minutes to decide if rollback needed

---

## Table of Contents

1. [Rollback Decision Tree](#rollback-decision-tree)
2. [Pre-Rollback Checklist](#pre-rollback-checklist)
3. [Quick Rollback (Helm)](#quick-rollback-helm)
4. [Component-Specific Rollback](#component-specific-rollback)
5. [Data Rollback (EFS)](#data-rollback-efs)
6. [Post-Rollback Verification](#post-rollback-verification)
7. [Communication Plan](#communication-plan)

---

## Rollback Decision Tree

### Should We Rollback?

**YES** if any of the following occur:

- [ ] **Critical alert firing** - PrometheusDown, GrafanaDown, LokiDown
- [ ] **Data loss detected** - Metrics/logs missing from all replicas
- [ ] **Persistent connectivity errors** - Services unreachable for >5 minutes
- [ ] **Performance degradation** - Query latency >10 seconds (p99)
- [ ] **Security vulnerability** - Unauthenticated data exposure
- [ ] **Pod CrashLoop** - Component stuck in restart loop
- [ ] **PVC full** - Storage exhaustion preventing writes

**MAYBE** if:

- [ ] Single pod unhealthy but replicas handling traffic
- [ ] Minor performance issue (latency 2-5s)
- [ ] Partial data loss recovered via queries

**NO** if:

- [ ] Issue is just configuration mismatch
- [ ] Performance issue affects <1% of queries
- [ ] No data loss or security risk

### Escalation & Approval

**Decision Authority:**
- MINOR issue: On-call engineer can decide
- MAJOR issue: Requires on-call + team lead approval
- CRITICAL: All three (on-call + lead + manager) agree

```bash
# Send approval message to #observability-incidents
message="
:warning: Rollback Decision Required

Severity: [MINOR/MAJOR/CRITICAL]
Issue: [Brief description]
Impact: [Number of affected services]
Proposed Action: Rollback to [version/date]

Approved By: @on-call-engineer @team-lead @manager
```

---

## Pre-Rollback Checklist

### 1. Document Current State

Before any rollback action, capture the current state for post-incident review:

```bash
# Save current pod status
kubectl get pods -n observability -o wide > /tmp/pre-rollback-pods.txt

# Save recent logs
kubectl logs -n observability -l app.kubernetes.io/name=prometheus --tail=100 > /tmp/pre-rollback-prometheus.log
kubectl logs -n observability -l app.kubernetes.io/name=loki --tail=100 > /tmp/pre-rollback-loki.log
kubectl logs -n observability -l app.kubernetes.io/name=grafana --tail=100 > /tmp/pre-rollback-grafana.log

# Save Helm release status
helm status prometheus -n observability > /tmp/pre-rollback-prometheus-helm.txt
helm status loki -n observability > /tmp/pre-rollback-loki-helm.txt
helm status grafana -n observability > /tmp/pre-rollback-grafana-helm.txt

# Save AlertManager alerts
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v1/alerts > /tmp/pre-rollback-alerts.json

echo "Pre-rollback state captured to /tmp/pre-rollback-*.txt"
```

### 2. Notify Team

```bash
# Post to #observability-incidents
message="
:rotating_light: ROLLBACK IN PROGRESS

Component: [Prometheus/Loki/Grafana/All]
Reason: [Specific issue]
Previous Version: [version]
Target Version: [version]
ETA: 15 minutes

Will update every 2 minutes.
"
```

### 3. Verify Backup Availability

```bash
# Check EFS snapshots exist (for data rollback if needed)
aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots[*].[SnapshotId,StartTime,VolumeSize]' \
  --output table

# Should show at least one snapshot from today
# If no snapshots: can only rollback Helm, not data
```

### 4. Verify Helm Release History

```bash
# Check available rollback versions
helm history prometheus -n observability
helm history loki -n observability
helm history grafana -n observability
```

Expected output:
```
REVISION  UPDATED                   STATUS      CHART                             APP VERSION   DESCRIPTION
1         Mon Feb 15 14:00:00 2026   superseded  kube-prometheus-stack-XX.XX.XX   v1.XX.X       Install complete
2         Mon Feb 15 15:30:00 2026   deployed    kube-prometheus-stack-XX.XX.XX   v1.XX.X       Upgrade complete
```

---

## Quick Rollback (Helm)

### Fastest Option: Helm Rollback

Rolls back to the previous Helm release (within seconds).

```bash
# Decide which component to rollback
# Options: prometheus, loki, grafana, or all three

# For single component (example: Prometheus)
echo "Rolling back Prometheus to previous release..."
helm rollback prometheus -n observability

# For specific revision number (get from helm history)
helm rollback prometheus 1 -n observability  # Rollback to revision 1

# Verify rollback
helm status prometheus -n observability

# Wait for pods to restart
kubectl rollout status statefulset/prometheus-kube-prom-prometheus -n observability --timeout=5m

# Check pod status
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus
```

### Rollback Multiple Components

```bash
# Rollback all three components simultaneously
for COMPONENT in prometheus loki grafana; do
    echo "Rolling back $COMPONENT..."
    helm rollback $COMPONENT -n observability &
done

# Wait for all rollbacks to complete
wait

# Verify all rollbacks
for COMPONENT in prometheus loki grafana; do
    echo "Status of $COMPONENT:"
    helm status $COMPONENT -n observability
done
```

### Verify Rollback Completed

```bash
# Check all pods are running
kubectl get pods -n observability

# Check no pods in CrashLoopBackOff
kubectl get pods -n observability -o wide | grep -i "crashloop\|pending\|error" || echo "All pods healthy"

# Test service connectivity
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl -s http://prometheus-kube-prom-prometheus:9090/-/healthy

# Verify metrics are flowing
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
sleep 2
curl -s http://localhost:9090/api/v1/query?query=up | jq '.data.result | length'
# Should return >50
```

---

## Component-Specific Rollback

### Rollback Prometheus Only

```bash
# Helm rollback
helm rollback prometheus -n observability --wait --timeout=5m

# Verify StatefulSet scaled correctly
kubectl get statefulset prometheus-kube-prom-prometheus -n observability

# Verify all replicas ready
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus \
  -n observability \
  --timeout=300s

# Test queries
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
curl -s http://localhost:9090/api/v1/query?query=up
```

### Rollback Loki Only

```bash
# Helm rollback
helm rollback loki -n observability --wait --timeout=5m

# Verify StatefulSet
kubectl get statefulset loki -n observability

# Verify all replicas ready
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=loki \
  -n observability \
  --timeout=300s

# Verify Promtail is still running (should restart automatically)
kubectl get daemonset -n observability -l app=promtail

# Test log queries
kubectl port-forward -n observability svc/loki 3100:3100 &
curl -s 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="kubernetes-pods"}' \
  --data-urlencode 'start=1'  --data-urlencode 'end=2' | jq .
```

### Rollback Grafana Only

```bash
# Helm rollback
helm rollback grafana -n observability --wait --timeout=5m

# Verify Deployment
kubectl get deployment grafana -n observability

# Verify all replicas ready
kubectl wait --for=condition=available deployment/grafana \
  -n observability \
  --timeout=300s

# Test Grafana API
kubectl port-forward -n observability svc/grafana 3000:80 &
curl -s http://localhost:3000/api/health
```

---

## Data Rollback (EFS)

### Only If Data Corruption Detected

**WARNING:** Data rollback requires EFS snapshot restore, which:
- Takes 30+ minutes
- May result in data loss (reverts to snapshot time)
- Should only be done for data corruption, not for code issues

### Detect Data Corruption

```bash
# Query metrics to check for gaps
# In Prometheus: http://localhost:9090

# Look for:
# - Sudden drop in metric count
# - Duplicate metrics
# - Missing time ranges

# Check Loki for corruption
kubectl logs -n observability -l app.kubernetes.io/name=loki --all-containers=true | grep -i "corrupt\|error\|fail"
```

### Rollback Prometheus Data (via EFS Snapshot)

```bash
# 1. Stop Prometheus to prevent writes
kubectl scale statefulset prometheus-kube-prom-prometheus --replicas=0 -n observability

# 2. Identify EFS snapshot
SNAPSHOT_ID=$(aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=tag:Component,Values=prometheus" \
  --region us-east-1 \
  --query 'Snapshots[0].SnapshotId' \
  --output text)

echo "Using snapshot: $SNAPSHOT_ID"

# 3. Delete corrupted EFS volume
EFS_ID=$(kubectl get pvc prometheus-storage -n observability -o jsonpath='{.spec.volumeName}' | cut -d'-' -f1)
# Manual step: Delete via AWS console or AWS CLI (requires careful verification)

# 4. Create new volume from snapshot
NEW_VOLUME=$(aws ec2 create-volume \
  --snapshot-id "$SNAPSHOT_ID" \
  --availability-zone us-east-1a \
  --region us-east-1 \
  --query 'VolumeId' \
  --output text)

echo "New volume created: $NEW_VOLUME"

# 5. Scale Prometheus back up
kubectl scale statefulset prometheus-kube-prom-prometheus --replicas=3 -n observability

# 6. Verify recovery
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus
```

**Note:** Data rollback via EFS snapshot is complex. For help, follow the full procedure in [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).

---

## Post-Rollback Verification

### Immediate Verification (2-5 minutes)

```bash
# 1. Check all pods healthy
kubectl get pods -n observability
# Expected: All READY, RUNNING, RESTARTS=0

# 2. Check services accessible
for SERVICE in prometheus loki grafana alertmanager; do
    echo "Testing $SERVICE..."
    kubectl run test --image=curlimages/curl -n observability --rm -it -- \
      curl -s http://$SERVICE:* &
done

# 3. Check Prometheus metrics flowing
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
METRIC_COUNT=$(curl -s http://localhost:9090/api/v1/query?query=up | jq '.data.result | length')
if [[ $METRIC_COUNT -gt 50 ]]; then
    echo "✓ Metrics flowing (count: $METRIC_COUNT)"
else
    echo "✗ Low metric count: $METRIC_COUNT (expected >50)"
fi

# 4. Check Loki logs ingesting
kubectl port-forward -n observability svc/loki 3100:3100 &
LOG_COUNT=$(curl -s 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="kubernetes-pods"}' \
  --data-urlencode 'start=1' --data-urlencode 'end=2' | jq '.data.result | length')
if [[ $LOG_COUNT -gt 0 ]]; then
    echo "✓ Logs ingesting (count: $LOG_COUNT)"
else
    echo "✗ No logs found"
fi

# 5. Check Grafana responsive
kubectl port-forward -n observability svc/grafana 3000:80 &
GRAFANA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)
if [[ $GRAFANA_STATUS -eq 200 ]]; then
    echo "✓ Grafana healthy"
else
    echo "✗ Grafana error: $GRAFANA_STATUS"
fi
```

### Extended Verification (5-15 minutes)

```bash
# 1. Check storage usage (should be normal)
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- df -h /prometheus
# Expected: <30% full

# 2. Verify no alert storms
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &
ALERT_COUNT=$(curl -s http://localhost:9093/api/v1/alerts | jq '.data | length')
echo "Current alerts: $ALERT_COUNT"
# Expected: <10 (normal operational alerts)

# 3. Check logs for errors in past 5 minutes
for COMPONENT in prometheus loki grafana; do
    echo "Checking logs for $COMPONENT..."
    kubectl logs -n observability -l app.kubernetes.io/name=$COMPONENT \
      --since=5m --tail=50 | grep -i "error\|fail\|crash" || echo "No errors"
done

# 4. Verify no data loss
# Run metric query to check for gaps
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=1&end=2&step=60' | jq '.data.result | length'
```

### Dashboards & Alerting

```bash
# 1. Verify Grafana dashboards load
kubectl port-forward -n observability svc/grafana 3000:80 &
# Visit http://localhost:3000 and load each dashboard
# Check: All panels render, no "No data" messages

# 2. Verify alerts display in Prometheus UI
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
# Visit http://localhost:9090/alerts
# Check: Alert rules loaded, firing alerts display correctly

# 3. Test alert notification
curl -X POST http://localhost:9093/api/v1/alerts \
  -H 'Content-Type: application/json' \
  -d '{
    "alerts": [{
      "status": "firing",
      "labels": {"alertname": "RollbackTest"},
      "annotations": {"summary": "Rollback verification alert"}
    }]
  }'
# Check: Alert appears in Slack #observability-alerts
```

---

## Rollback Validation Checklist

- [ ] All pods in READY/RUNNING state (kubectl get pods -n observability)
- [ ] No pods in CrashLoopBackOff state
- [ ] Prometheus metrics flowing (>50 targets up)
- [ ] Loki logs ingesting (>0 log entries)
- [ ] Grafana dashboards loading (<5s)
- [ ] AlertManager routing alerts correctly
- [ ] Slack notifications working
- [ ] No data gaps in metrics/logs
- [ ] Storage usage normal (<30% for Prometheus, <30% for Loki)
- [ ] No error storms in logs
- [ ] Performance baseline restored (query latency <2s p99)

---

## Communication Plan

### Rollback Initiated

```bash
message="
:warning: Observability Stack Rollback Initiated

Component: [Prometheus/Loki/Grafana/All]
Reason: [Brief issue description]
Previous Release: 2
Target Release: 1
Estimated Duration: 10-15 minutes

Slack notifications paused during rollback.
Will resume monitoring after verification.
Next update at [time+5min]
"
```

### Rollback In Progress

```bash
message="
:hourglass: Rollback In Progress

Status: Rolling back [component] to release [N]
- Helm release being reverted...
- Pods restarting...
- Services re-connecting...

ETA to completion: [time]
Current pod status: [X/Y ready]
"
```

### Rollback Completed

```bash
message="
:white_check_mark: Rollback Completed Successfully

Component: [Component]
Duration: [X minutes]
Verification Status:
- All pods healthy ✓
- Metrics flowing ✓
- Logs ingesting ✓
- Alerts working ✓

Resuming normal monitoring.
Incident post-mortem scheduled for [date/time].
"
```

### Rollback Failed

```bash
message="
:x: Rollback Encountered Issues

Issue: [Description]
Status: [Current state]
Next Action: [Manual intervention / escalation]

@on-call-engineer @team-lead @manager
Immediate attention required.
"
```

---

## Recovery After Rollback

### 1. Post-Incident Review

```bash
# Collect information for incident review
INCIDENT_SUMMARY=$(cat << EOF
## Incident Summary
- Duration: [start time] to [end time]
- Components Affected: [List]
- Cause: [Root cause determination]
- Rollback Time: [X minutes]
- Data Loss: [None/Y GB]

## Timeline
- [Time] Issue detected: [What]
- [Time] Rollback initiated: [Who]
- [Time] Rollback completed: [Success/Partial]
- [Time] Verification passed

## Action Items
1. [Item] - Owner: [Name] - Due: [Date]
2. [Item] - Owner: [Name] - Due: [Date]
EOF
)
echo "$INCIDENT_SUMMARY"
```

### 2. Preventive Measures

For each incident type, update prevention:

- **For code bugs:** Add pre-deployment testing
- **For configuration issues:** Add validation checks
- **For performance issues:** Add baseline monitoring
- **For data issues:** Improve backup/snapshot frequency

### 3. Document the Incident

```bash
# Create incident report in shared location
cat > INCIDENT_$(date +%Y%m%d)-observability.md << EOF
# Incident Report - [Date]

**Title:** [Brief title]
**Severity:** [SEV-1/2/3]
**Duration:** [Start] to [End] (X minutes)
**Affected Services:** [List]
**Rollback Time:** [X minutes]

## Root Cause
[Description of what went wrong]

## Resolution
Rolled back [component] from release N to N-1

## Impact
- [Service X] interrupted for X minutes
- [Approximate number] of failed requests
- Data loss: [None or amount]

## Prevention
1. [Future improvement 1]
2. [Future improvement 2]

## References
- Prometheus logs: `/tmp/pre-rollback-prometheus.log`
- Helm history: `helm history [component] -n observability`
EOF
```

---

## Rollback Troubleshooting

### Helm Rollback Failed

```bash
# Error: "release [component] not found"
# Solution: Verify release exists
helm list -n observability

# Error: "no previous release"
# Solution: Component on first release, cannot rollback
# Alternative: Delete and redeploy, or use manual PVC recovery
```

### Pods Not Starting After Rollback

```bash
# Check pod status
kubectl describe pod -n observability <pod-name>

# Check logs for startup errors
kubectl logs -n observability <pod-name> --previous

# Possible causes:
# 1. PVC not bound - check PVC status
# 2. ConfigMap/Secret missing - check ConfigMaps
# 3. Resource limits - check node capacity
```

### Data Still Corrupted After Rollback

```bash
# Helm rollback only reverts code/config, not data
# For corrupted data, need EFS snapshot restore

# Check current PVC status
kubectl get pvc -n observability

# If data not recoverable:
# 1. Accept data loss and continue with rollback
# 2. Or: Follow DISASTER_RECOVERY.md for full recovery
```

### Metrics/Logs Not Flowing After Rollback

```bash
# Check Prometheus targets
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
# Visit http://localhost:9090/targets
# Check if any targets are RED (down)

# If targets down:
# - Check router pod is running
# - Check ServiceMonitor objects
# - Check labels match selectors

# For Loki:
# Check Promtail DaemonSet
kubectl get daemonset -n observability -l app=promtail

# If Promtail not running:
# - Check node capacity
# - Check node labels/taints
# - Check RBAC permissions
```

---

## Related Documentation

- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - For full data recovery procedures
- [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) - Deployment overview
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - Incident response SLOs

---

**Emergency Contact:**
- On-Call Engineer: [Phone/Slack]
- Team Lead: [Phone/Slack]
- Infrastructure Manager: [Phone/Slack]

**Incident Channel:** #observability-incidents
