# Operational Runbook - ClarityRouter Observability Stack

## Overview

This runbook defines Service Level Objectives (SLOs), on-call responsibilities, and incident response procedures for the production observability stack.

**Stack Status:** ✓ Production (us-east-1)  
**On-Call Schedule:** 24/7 with escalation  
**SLA Target:** 99.5% availability

---

## Table of Contents

1. [SLO Definitions](#slo-definitions)
2. [On-Call Responsibilities](#on-call-responsibilities)
3. [Incident Response](#incident-response)
4. [Escalation Policy](#escalation-policy)
5. [Communication Plan](#communication-plan)
6. [Maintenance Windows](#maintenance-windows)
7. [SLO Reporting](#slo-reporting)

---

## SLO Definitions

### 1. Prometheus Availability: 99.5%

**Definition:** Prometheus API is responsive and accepting queries

**Target:** >99.5% uptime = 3.6 hours unavailability per month

**Measurement Methods:**
- Primary: HTTP 200 on `/-/healthy` endpoint
- Secondary: Successful PromQL query execution
- Tertiary: Metric ingestion rate >0

**Success Criteria:**
```bash
# Prometheus health check
curl -s http://prometheus-kube-prom-prometheus:9090/-/healthy
# Expected: HTTP 200

# Prometheus targets health
curl -s http://prometheus-kube-prom-prometheus:9090/api/v1/targets | jq '.data.activeTargets | length'
# Expected: >100 targets

# Metric count
curl -s http://prometheus-kube-prom-prometheus:9090/api/v1/query?query=count\(up\) | jq '.data.result[0].value[1]'
# Expected: >5000 metrics
```

**Alert Rules:**
```promql
# PrometheusDown - fires if Prometheus unreachable for 2 minutes
alert: PrometheusDown
expr: up{job="prometheus"} == 0
for: 2m

# PrometheusTargetsDown - fires if >25% targets down
alert: PrometheusTargetsDown
expr: count(up == 0) / count(up) > 0.25
for: 10m
```

**Escalation:**
- Minor: Single target down → 10 min to fix
- Major: 50% targets down → 5 min to respond
- Critical: All targets down → Page immediately

---

### 2. Grafana Availability: 99.5%

**Definition:** Grafana UI is accessible and dashboards load

**Target:** >99.5% uptime

**Measurement Methods:**
- Primary: HTTP 200 on `/api/health` endpoint
- Secondary: Dashboard load time <5 seconds
- Tertiary: Data source connectivity

**Success Criteria:**
```bash
# Grafana health
curl -s http://grafana:3000/api/health
# Expected: HTTP 200, {"status":"ok"}

# Dashboard load (simulated)
curl -s http://grafana:3000/api/dashboards | jq '.dashboards | length'
# Expected: >3 dashboards

# Data source connectivity
curl -s http://grafana:3000/api/datasources | jq '.[] | .name'
# Expected: "Prometheus", "Loki"
```

**Alert Rules:**
```promql
# GrafanaDown
alert: GrafanaDown
expr: up{job="grafana"} == 0
for: 2m

# GrafanaHighLatency
alert: GrafanaHighLatency
expr: histogram_quantile(0.95, rate(grafana_request_duration_ms_bucket[5m])) > 1000
for: 5m
```

**Escalation:**
- Minor: Grafana responding but slow → 15 min to investigate
- Major: Grafana down (<1 min) → Page immediately

---

### 3. Loki Log Ingestion: 99.9%

**Definition:** Logs successfully ingested and queryable

**Target:** >99.9% uptime = 8.6 hours unavailability per month

**Measurement Methods:**
- Primary: Log ingestion rate via `loki_distributor_lines_received_total`
- Secondary: Successful log queries via LogQL
- Tertiary: No log ingestion lag (>1 min)

**Success Criteria:**
```bash
# Log ingestion rate (should be non-zero)
curl -s http://loki:3100/metrics | grep loki_distributor_lines_received_total
# Expected: counter > 1000/sec

# Log query success
curl -s 'http://loki:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="kubernetes-pods"}' \
  --data-urlencode 'start=<timestamp>' \
  --data-urlencode 'end=<timestamp>' | jq '.status'
# Expected: "success"

# Ingestion lag
curl -s http://loki:3100/metrics | grep loki_loki_boltdb_shipper_queue_duration_seconds_bucket
# Expected: <60 seconds
```

**Alert Rules:**
```promql
# LokiDown
alert: LokiDown
expr: up{job="loki"} == 0
for: 2m

# LokiHighIngestionLag
alert: LokiHighIngestionLag
expr: loki_loki_boltdb_shipper_queue_duration_seconds > 60
for: 5m

# LokiNoIncomingLogs
alert: LokiNoIncomingLogs
expr: rate(loki_distributor_lines_received_total[5m]) == 0
for: 10m
```

**Escalation:**
- Minor: Slow ingestion (lag 30-60s) → 20 min to investigate
- Major: No logs ingesting → Page in 5 min
- Critical: Data loss detected → Page immediately

---

### 4. AlertManager: 99.9%

**Definition:** Alerts are routed and delivered to Slack/PagerDuty

**Target:** >99.9% alert delivery success

**Measurement Methods:**
- Primary: Test alert delivery to Slack channel
- Secondary: AlertManager API responsiveness
- Tertiary: Notification queue depth

**Success Criteria:**
```bash
# AlertManager health
curl -s http://alertmanager:9093/api/v1/alerts | jq '.status'
# Expected: "success"

# Slack webhook test
curl -X POST $SLACK_WEBHOOK_URL \
  -H 'Content-type: application/json' \
  -d '{"text":"Test from AlertManager"}' \
# Expected: HTTP 200

# Active alerts (should be minimal)
curl -s http://alertmanager:9093/api/v1/alerts | jq '.data | length'
# Expected: <20 firing alerts during normal operations
```

**Alert Rules:**
```promql
# AlertManagerDown
alert: AlertManagerDown
expr: up{job="alertmanager"} == 0
for: 2m

# AlertManagerFailedNotifications
alert: AlertManagerFailedNotifications
expr: increase(alertmanager_notifications_failed_total[5m]) > 10
for: 5m
```

**Escalation:**
- Minor: <5 failed notifications → 30 min to investigate
- Major: No notifications for >30 min → Page in 5 min
- Critical: All notifications failing → Page immediately

---

### 5. Metrics Collection: 99%

**Definition:** 100+ metrics collected from all sources

**Target:** >99% metric availability (all targets scraping)

**Measurement Methods:**
- Primary: `count(up==1)` > 100 targets
- Secondary: No metric scrape failures
- Tertiary: Target error rate <1%

**Success Criteria:**
```bash
# Healthy target count
curl -s http://prometheus:9090/api/v1/query?query=count\(up==1\) | jq '.data.result[0].value[1]'
# Expected: >150 targets

# Failed target count (should be 0)
curl -s http://prometheus:9090/api/v1/query?query=count\(up==0\) | jq '.data.result[0].value[1]'
# Expected: 0 or <5

# Scrape error rate
curl -s http://prometheus:9090/api/v1/query?query=rate\(up==0\[5m\]\) | jq '.data.result | length'
# Expected: minimal
```

**Alert Rules:**
```promql
# TargetsDown
alert: TargetsDown
expr: count(up == 0) > 10
for: 5m

# PrometheusTargetScrapeError
alert: PrometheusTargetScrapeError
expr: rate(prometheus_tsdb_symbol_table_size_bytes == 0[5m]) > 0.1
for: 10m
```

---

### 6. Dashboard Load Time: <5 seconds

**Definition:** Grafana dashboards fully load and render

**Target:** <5 seconds for full page load (p95)

**Measurement Methods:**
- Primary: Browser DevTools measurement
- Secondary: Grafana metric `grafana_request_duration_ms`
- Tertiary: Query latency measurement

**Success Criteria:**
```bash
# Measure query latency (should contribute <1s to dashboard load)
kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 &
time curl -s 'http://localhost:9090/api/v1/query?query=up' > /dev/null
# Expected: <1000ms total
```

---

### 7. Query Latency: <2 seconds

**Definition:** PromQL and LogQL queries complete within timeout

**Target:** <2 seconds for p99 latency

**Measurement Methods:**
- Primary: Prometheus metric `prometheus_http_request_duration_seconds`
- Secondary: Loki metric `loki_request_duration_seconds`
- Tertiary: Manual query timing

**Success Criteria:**
```bash
# Check query latency histogram (p99)
curl -s 'http://prometheus:9090/api/v1/query?query=histogram_quantile%280.99%2C%20prometheus_http_request_duration_seconds_bucket%29' | jq '.data.result[0].value[1]'
# Expected: <2 (seconds)

# For Loki
curl -s 'http://prometheus:9090/api/v1/query?query=histogram_quantile%280.99%2C%20loki_request_duration_seconds_bucket%29' | jq '.data.result[0].value[1]'
# Expected: <2 (seconds)
```

---

## SLO Summary Table

| Component | SLO Target | Measurement | Alert Threshold | On-Call Response |
|-----------|-----------|-------------|-----------------|-----------------|
| Prometheus | 99.5% | Health endpoint | 2 min down | 10 min |
| Grafana | 99.5% | HTTP 200 | 2 min down | 15 min |
| Loki | 99.9% | Ingestion rate | No logs | 5 min |
| AlertManager | 99.9% | Delivery rate | >10 failures | 5 min |
| Metrics | 99% | Target count | >25% down | 10 min |
| Dashboard Load | <5s | Page load time | >8s | 30 min |
| Query Latency | <2s | p99 latency | >5s | 30 min |

---

## On-Call Responsibilities

### Daily Shift Start (Beginning of Shift)

**Time Required:** 15 minutes  
**Frequency:** Once per shift

Perform these checks at the start of each shift:

```bash
# 1. Verify all components healthy
echo "=== Pod Status ==="
kubectl get pods -n observability -o wide
# Expected: All READY, RUNNING

# 2. Check for overnight alerts
echo "=== Active Alerts ==="
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v1/alerts | jq '.data[] | {alertname: .labels.alertname, severity: .labels.severity}'
# Expected: 0-5 alerts (not 100+)

# 3. Check storage usage
echo "=== Storage Usage ==="
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- df -h /prometheus
# Expected: <30% full
kubectl exec -n observability loki-0 -- df -h /loki/chunks
# Expected: <30% full

# 4. Review error logs from past 2 hours
echo "=== Error Logs ==="
kubectl logs -n observability -l app.kubernetes.io/name=prometheus --since=2h --tail=20 | grep -i error || echo "No errors"
kubectl logs -n observability -l app.kubernetes.io/name=loki --since=2h --tail=20 | grep -i error || echo "No errors"

# 5. Check for failed snapshots (EFS backups)
echo "=== Backup Status ==="
aws ec2 describe-snapshots --owner-ids self --filters "Name=status,Values=error" --region us-east-1

# 6. Read #observability-incidents channel for overnight issues
echo "Review Slack: #observability-incidents"
```

**Checklist:**
- [ ] All pods running (3 Prometheus, 3 Loki, 2 Grafana, 2 AlertManager, N Promtail)
- [ ] Storage usage normal (<30%)
- [ ] No critical alerts firing
- [ ] No failed backups in past 24 hours
- [ ] No persistent error messages in logs

---

### Weekly Review (Friday EOD)

**Time Required:** 1 hour  
**Frequency:** Weekly on Friday

Perform deeper analysis and testing:

```bash
# 1. Review SLO attainment for the past week
echo "=== SLO Review (Past 7 Days) ==="
for COMPONENT in prometheus grafana loki alertmanager; do
    UPTIME=$(kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
             sleep 1
             curl -s "http://localhost:9090/api/v1/query?query=avg_over_time(up{job=\"$COMPONENT\"}[7d])*100" | \
             jq '.data.result[0].value[1]')
    echo "$COMPONENT uptime (past 7d): ${UPTIME}%"
done

# 2. Identify and address bottlenecks
echo "=== Performance Analysis ==="
# Query latency trend
curl -s 'http://localhost:9090/api/v1/query_range?query=histogram_quantile(0.95,rate(prometheus_http_request_duration_seconds_bucket[5m]))&start=<7d-ago>&end=<now>&step=3600' | \
  jq '.data.result[0].values | .[-1]'
# Check if trending upward

# 3. Test failover scenario (optional)
# WARNING: Only do this in maintenance window
# Kill one Prometheus pod and verify recovery
echo "=== Failover Test (Optional) ==="
echo "To test failover: kubectl delete pod -n observability prometheus-kube-prom-prometheus-0"
echo "Wait 5 minutes and verify:"
echo "  - New pod created automatically"
echo "  - Metrics still flowing"
echo "  - No data gaps"

# 4. Review and update runbooks
echo "=== Runbook Review ==="
echo "Check these files for accuracy:"
echo "  - RUNBOOK_OPERATIONS.md (this file)"
echo "  - ROLLBACK_PRODUCTION.md"
echo "  - DISASTER_RECOVERY.md"
echo "  - ACCESS_PRODUCTION.md"

# 5. Capacity planning
echo "=== Storage Growth Analysis ==="
echo "Prometheus daily growth: $(df -h | grep prometheus | awk '{print $5}')"
echo "Loki daily growth: $(df -h | grep loki | awk '{print $5}')"
echo "At current growth rate, storage full in: [calculate based on growth]"
```

**Weekly Checklist:**
- [ ] SLO attainment >99.5% (Prometheus, Grafana, AlertManager)
- [ ] SLO attainment >99.9% (Loki)
- [ ] Query latency p95 <2 seconds
- [ ] No bottlenecks identified
- [ ] Failover test passed (if performed)
- [ ] Runbooks reviewed and accurate
- [ ] Storage growth rate acceptable
- [ ] No persistent warnings or errors

**Document findings in weekly report:**
```
Week of [Date]:
- SLO Attainment: [%]
- Incidents: [Number and list]
- Performance: [Baseline/Improved/Degraded]
- Action Items: [List]
- Next Week Focus: [Areas]
```

---

### Monthly Review (First Friday of Month)

**Time Required:** 2-3 hours  
**Frequency:** Monthly

Perform comprehensive performance and security audit:

```bash
# 1. Complete performance audit
echo "=== Performance Audit ==="
# Query latencies
# - p50: [value]
# - p95: [value]
# - p99: [value]
# Ingestion rates
# - Metrics per second: [rate]
# - Logs per second: [rate]
# Storage metrics
# - Prometheus growth: [GB/day]
# - Loki growth: [GB/day]

# 2. Capacity planning
echo "=== Capacity Planning ==="
# Current usage: [%]
# Growth rate: [%/month]
# Months until full: [N]
# Recommendation: [Expand/Monitor/Optimize]

# 3. Security audit
echo "=== Security Review ==="
# RBAC audit: Do permissions match principle of least privilege?
# Secret audit: Are all secrets rotated within 90 days?
# Network policies: Are firewall rules still correct?
# TLS certificates: Days until expiration?

# 4. Upgrade planning
echo "=== Upgrade Planning ==="
# Check available Helm chart versions
helm repo update
helm search repo prometheus-community/kube-prometheus-stack --versions
helm search repo grafana/grafana --versions
helm search repo loki/loki --versions

# 5. Disaster recovery drill
echo "=== DR Drill Planning ==="
echo "Schedule full disaster recovery drill for next month"
```

**Monthly Checklist:**
- [ ] Performance audit complete (latencies, rates, storage)
- [ ] Capacity plan for next 3 months
- [ ] Security audit performed (RBAC, secrets, TLS)
- [ ] Helm chart upgrade plan
- [ ] Disaster recovery drill scheduled
- [ ] Monthly report published

---

## Incident Response

### Alert Severity Levels

**CRITICAL (Red):**
- Immediate page sent to on-call + team lead + manager
- Response time: <5 minutes
- All hands on deck

Examples:
- All Prometheus replicas down
- All Grafana replicas down
- Data loss >1 hour
- Complete stack unavailable

**MAJOR (Orange):**
- Page sent to on-call + team lead
- Response time: <15 minutes
- Focus on quick resolution

Examples:
- 50% of Prometheus targets down
- Grafana down but queue backup available
- Query latency >10 seconds (p99)
- Alert delivery failures >50%

**MINOR (Yellow):**
- Alert in Slack only
- Response time: <30 minutes
- Investigate during next available window

Examples:
- 1-2 Prometheus targets down
- Storage >80% full
- Query latency elevated (2-5s)
- Non-critical log warnings

---

### Incident Response Workflow

#### Step 1: Acknowledge Alert (Immediate)

```bash
# 1. Check alert details in AlertManager or Slack
# Severity: [CRITICAL/MAJOR/MINOR]
# Alert: [Name]
# Duration: [How long firing]

# 2. For CRITICAL: Declare SEV-1 incident
# For MAJOR: Declare SEV-2 incident
# For MINOR: Declare SEV-3 incident

# 3. Post to #observability-incidents
message="
:warning: Incident Declared: SEV-[1/2/3]

Alert: [Alert Name]
Severity: [CRITICAL/MAJOR/MINOR]
Detected At: [Time]
On-Call Engineer: @me
Status: Investigating

Will post updates every 5 minutes.
"

# 4. Start timer (Response SLO clock)
echo "Incident start: $(date)"
```

#### Step 2: Triage (First 5 Minutes)

```bash
# Run quick diagnostic commands based on alert type

# For "PrometheusDown" alert:
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus
kubectl describe pod -n observability prometheus-kube-prom-prometheus-0
kubectl logs -n observability prometheus-kube-prom-prometheus-0 --tail=50

# For "GrafanaDown" alert:
kubectl get pods -n observability -l app.kubernetes.io/name=grafana
kubectl describe pod -n observability grafana-7d8f5c9b8-xxxx
kubectl logs -n observability grafana-7d8f5c9b8-xxxx --tail=50

# For "LokiDown" alert:
kubectl get pods -n observability -l app.kubernetes.io/name=loki
kubectl exec -n observability loki-0 -- ls -la /loki/chunks/
kubectl logs -n observability loki-0 --tail=50

# For "StorageFull" alert:
kubectl describe pvc prometheus-storage -n observability
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- du -sh /prometheus/*
kubectl exec -n observability loki-0 -- du -sh /loki/chunks/*

# Determine: Is this a code/config issue, or a resource/capacity issue?
ROOT_CAUSE="[diagnosis]"
echo "Root Cause: $ROOT_CAUSE"
```

#### Step 3: Communication (Every 5 Minutes)

Post status update to #observability-incidents every 5 minutes:

```bash
message="
:hourglass: Incident Update [+5 min]

Alert: [Alert Name]
Status: [Investigating/Troubleshooting/Resolved]
Root Cause: [If known]
Action: [Current action being taken]
ETA to Resolution: [If available]

Next update: [time+5min]
"
```

#### Step 4: Mitigation/Remediation

**If pod is down (crash):**
```bash
# Check if rolling restart helps
kubectl rollout restart -n observability deployment/grafana
kubectl rollout restart -n observability statefulset/prometheus-kube-prom-prometheus

# If still down, check logs for startup errors
kubectl logs -n observability <pod> --previous

# If needed, scale down and back up
kubectl scale <resource> --replicas=0 -n observability
sleep 10
kubectl scale <resource> --replicas=3 -n observability
```

**If storage full:**
```bash
# Check retention and enable automatic cleanup
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- \
  prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.retention.size=25GB

# Or manually expand PVC
kubectl patch pvc prometheus-storage -n observability \
  -p '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'

# Wait for expansion to complete (may take 5-10 minutes)
kubectl get pvc prometheus-storage -n observability
```

**If alerts flooding:**
```bash
# Silence problematic alert to prevent notification spam
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &

curl -X POST http://localhost:9093/api/v1/silences \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [
      {"name": "alertname", "value": "ProblematicAlert", "isRegex": false}
    ],
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')'",
    "endsAt": "'$(date -u -d '+1 hour' +'%Y-%m-%dT%H:%M:%S.000Z')'",
    "createdBy": "on-call-engineer",
    "comment": "Silencing during incident investigation"
  }'
```

#### Step 5: Verification (After Fix)

```bash
# 1. Verify service restored
kubectl get pods -n observability
# All should be READY and RUNNING

# 2. Verify metrics/logs flowing
curl -s http://prometheus-kube-prom-prometheus:9090/api/v1/query?query=up | jq '.data.result | length'
# Should return >50

# 3. Verify alert cleared
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v1/alerts | jq '.data | length'
# Should be 0 or back to normal

# 4. Verify no cascading failures
kubectl logs -n observability --all-containers=true --since=5m | grep -i error | wc -l
# Should be 0 or minimal
```

#### Step 6: Incident Closure

```bash
# 1. Post final status update
message="
:white_check_mark: Incident Resolved

Alert: [Alert Name]
Duration: [XX minutes]
Root Cause: [Specific cause]
Resolution: [What was done]

Impact: [Services/users affected, if any]
Data Loss: [None/describe]

Post-mortem scheduled for: [Date/Time]
"

# 2. Complete incident report
INCIDENT_REPORT=$(cat << EOF
## Incident Summary
- Severity: [SEV-1/2/3]
- Duration: [Start Time] to [End Time] ([X minutes])
- Service Affected: Observability Stack ([Component])
- Root Cause: [Specific technical cause]

## Timeline
- [Time] Alert fired: [Alert Name]
- [Time] On-call notified
- [Time] Issue diagnosed: [Finding]
- [Time] Mitigation began: [Action]
- [Time] Service restored
- [Time] Verification complete

## Action Items (Follow-up)
1. [Preventive measure] - Owner: [Name] - Due: [Date]
2. [Monitoring improvement] - Owner: [Name] - Due: [Date]
3. [Documentation update] - Owner: [Name] - Due: [Date]

## Post-Mortem
Scheduled for: [Date/Time]
Attendees: @on-call @team-lead @engineer @manager
EOF
)
echo "$INCIDENT_REPORT" > incident-$(date +%Y%m%d-%H%M%S).md
```

---

## Escalation Policy

### Alert Escalation Matrix

| Alert | Severity | Response Time | Primary | Secondary | Tertiary |
|-------|----------|---------------|---------|-----------|----------|
| PrometheusDown | CRITICAL | 5 min | On-call | Team Lead | Manager |
| GrafanaDown | CRITICAL | 5 min | On-call | Team Lead | Manager |
| LokiDown | CRITICAL | 5 min | On-call | Team Lead | Manager |
| StorageFull | MAJOR | 15 min | On-call | Team Lead | - |
| HighQueryLatency | MAJOR | 15 min | On-call | Team Lead | - |
| TargetsDown (>50%) | MAJOR | 15 min | On-call | Team Lead | - |
| AlertDeliveryFailed | MAJOR | 15 min | On-call | Team Lead | - |
| StorageAlmostFull (80%) | MINOR | 30 min | On-call | - | - |
| SingleTargetDown | MINOR | 30 min | On-call | - | - |
| HighMemoryUsage | MINOR | 30 min | On-call | - | - |

### Escalation Procedure

**For CRITICAL Alerts:**

```bash
# 1. Immediate actions (on-call engineer)
# - Acknowledge alert in PagerDuty
# - Post to #observability-incidents
# - Begin triage (2 min max)

# 2. Page team lead (if not resolved in 3 minutes)
# - Send PagerDuty escalation
# - Provide current status and findings
# - Request pairing/assistance

# 3. Page manager (if not resolved in 7 minutes)
# - Indicate escalation to manager
# - Share incident summary
# - Request decision authority

# 4. Post incident summary every 5 minutes
```

**For MAJOR Alerts:**

```bash
# 1. On-call begins investigation immediately
# - Acknowledge alert
# - Post to #observability-incidents
# - Assess impact and root cause

# 2. Page team lead after 10 minutes if unresolved
# - Provide diagnosis and proposed mitigation
# - Indicate if escalation to manager needed

# 3. Continue status updates every 10 minutes
```

**For MINOR Alerts:**

```bash
# 1. Add to backlog/queue
# - Investigate during normal work hours
# - May not require immediate response
# - Post in Slack #observability-alerts (not -incidents)

# 2. Resolve during shift
# - Document root cause
# - Implement fix or add to next sprint

# 3. Post update once per day
```

---

## Communication Plan

### Incident Communication Channels

**Primary:** `#observability-incidents` (Slack)
**Secondary:** PagerDuty (on-call notifications)
**Tertiary:** Email (post-incident summary)

### Update Frequency by Severity

| Severity | Frequency | Channel |
|----------|-----------|---------|
| CRITICAL | Every 5 min | Slack + PagerDuty |
| MAJOR | Every 10 min | Slack + PagerDuty |
| MINOR | Every 30 min | Slack only |

### Post-Incident Communication

**Timeline:**
- **Immediately:** Brief status posted
- **+5 minutes:** Ongoing updates in #observability-incidents
- **+15 minutes:** Full incident report if unresolved
- **After resolution:** Final summary posted to channel
- **+1 day:** Post-mortem document shared
- **+1 week:** Action items status update

**Post-Incident Report Template:**

```markdown
## Incident Report: [Date] - [Alert Name]

**Severity:** SEV-1/2/3
**Duration:** [Start] to [End] ([X minutes])
**Affected Services:** [List]
**On-Call Engineer:** @name
**Root Cause:** [Specific technical cause]

### Timeline
- [Time] Alert fired
- [Time] Triage complete
- [Time] Mitigation began
- [Time] Service restored

### Impact
- [Service X] unavailable for X minutes
- [Number] of affected requests
- Data loss: None/[describe]

### Prevention
1. [Preventive measure]
2. [Monitoring improvement]
3. [Testing/validation]

### Action Items
- [ ] [Action 1] - Owner: @name - Due: [Date]
- [ ] [Action 2] - Owner: @name - Due: [Date]
```

---

## Maintenance Windows

### Planned Maintenance Announcement

Post 48 hours before maintenance:

```
:construction: Scheduled Maintenance Window

Component(s): [List affected components]
Start: [Date] [Time] UTC
Duration: [XX minutes]
Expected Impact: [Minimal/Brief interruption/Unavailable]

We recommend:
- Avoid critical operations during this time
- Ensure backup monitoring in place
- Have escalation contacts ready

Updates: #observability-incidents
```

### During Maintenance

Update #observability-incidents every 15 minutes:
- Progress
- Any unexpected issues
- Revised ETA if needed

### After Maintenance

```
:white_check_mark: Maintenance Complete

Component(s): [List]
Completed: [Time]
Duration: [XX minutes]
Issues: [None/describe any problems]

Monitoring resumed. Thank you for your patience.
```

---

## SLO Reporting

### Weekly SLO Report

Sent every Friday EOD to stakeholders:

```markdown
## SLO Attainment - Week of [Date]

### Availability
- Prometheus: 99.8% ✓ (Target: 99.5%)
- Grafana: 99.7% ✓ (Target: 99.5%)
- Loki: 99.95% ✓ (Target: 99.9%)
- AlertManager: 99.9% ✓ (Target: 99.9%)

### Performance
- Query Latency p95: 1.2s ✓ (Target: <2s)
- Dashboard Load: 3.2s ✓ (Target: <5s)
- Log Ingestion: 5000 lines/sec ✓

### Incidents
- Critical: 0
- Major: 1 (Loki PVC alert)
- Minor: 2 (Single targets)

### Metrics Collection
- Active Targets: 152 ✓ (Target: >100)
- Metrics Stored: 8.5M ✓

### Storage
- Prometheus: 18% full (Target: <70%)
- Loki: 22% full (Target: <70%)
- Trend: Stable

### Next Week Focus
- [Item 1]
- [Item 2]
```

### Monthly SLO Summary

Sent first day of month with comprehensive analytics and trend analysis.

---

## Emergency Contact Information

**On-Call Rotation:** [Link to schedule]

**Primary On-Call:** [Name] - [Phone] - [Slack @handle]
**Secondary On-Call:** [Name] - [Phone] - [Slack @handle]
**Team Lead:** [Name] - [Phone] - [Slack @handle]
**Infrastructure Manager:** [Name] - [Phone] - [Slack @handle]

**Slack Channels:**
- `#observability-incidents` - For incidents
- `#observability-alerts` - For operational alerts
- `#observability-general` - For discussions

**External Escalation:**
- PagerDuty Team: [Link]
- Incident Commander: [Name/Process]

---

**Related Documentation:**
- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - Data recovery procedures
- [`ROLLBACK_PRODUCTION.md`](ROLLBACK_PRODUCTION.md) - Emergency rollback
- [`ACCESS_PRODUCTION.md`](ACCESS_PRODUCTION.md) - Component access methods
- [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md) - Optimization strategies
