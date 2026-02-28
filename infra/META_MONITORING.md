# Meta-Monitoring Guide - ClarityRouter Observability Stack

## Overview

This document outlines procedures for monitoring the observability stack itself (meta-monitoring). Since the observability stack is critical infrastructure, we need to monitor the monitors.

**Key Principle:** The observability stack must have redundancy and its own alerting

---

## Table of Contents

1. [Meta-Monitoring Architecture](#meta-monitoring-architecture)
2. [Health Check Dashboards](#health-check-dashboards)
3. [Alert Rules for Components](#alert-rules-for-components)
4. [External Monitoring](#external-monitoring)
5. [Synthetic Tests](#synthetic-tests)
6. [Alerting on Alerts](#alerting-on-alerts)
7. [Escalation & Runbooks](#escalation--runbooks)

---

## Meta-Monitoring Architecture

### Overview Diagram

```
Production Applications
    ↓
ClarityRouter observability stack
  ├─ Prometheus (self-monitoring)
  ├─ Grafana (dashboards)
  ├─ Loki (logging)
  └─ AlertManager (alerting)
    ↓
Secondary Monitoring (Catch failures of primary stack)
  ├─ External synthetic tests (uptime.com, datadog)
  ├─ Health check API (simple HTTP pings)
  ├─ AWS CloudWatch (basic EC2/EFS metrics)
  └─ Email/SMS alerts (bypass Slack if it's down)
```

### Monitoring Levels

**Level 1:** Component Health (Pod running, healthy status)  
**Level 2:** Service Health (API responding, accepting requests)  
**Level 3:** Data Flow (Metrics ingesting, logs flowing)  
**Level 4:** SLO Attainment (Uptime %, latency targets)

---

## Health Check Dashboards

### 1. Observability Stack Health Dashboard

Create a Grafana dashboard showing real-time health:

```yaml
# Prometheus queries for health dashboard

# Prometheus pod health
up{job="prometheus"}

# Prometheus targets health (% UP)
count(up==1) / count(up) * 100

# Grafana pod health
up{job="grafana"}

# Loki pod health
up{job="loki"}

# AlertManager pod health
up{job="alertmanager"}

# Storage usage (% of capacity)
(prometheus_tsdb_dir_bytes / prometheus_tsdb_disk_space_limit) * 100

# Memory usage (% of limit)
(container_memory_usage_bytes / container_spec_memory_limit_bytes) * 100

# Query latency (p95)
histogram_quantile(0.95, prometheus_http_request_duration_seconds_bucket)

# Metric count (should be stable)
count(up)

# Alert firing count
count(ALERTS{alertstate="firing"})

# API request rate
rate(prometheus_http_requests_total[5m])

# API error rate
rate(prometheus_http_requests_total{handler=~"query|graph"}[5m]) - rate(prometheus_http_requests_total{handler=~"query|graph", code="200"}[5m])
```

**Dashboard Layout:**
```
┌─────────────────────────────────────────────┐
│ ClarityRouter Observability Stack Health    │
├─────────────────────────────────────────────┤
│ Pod Status                                  │
├────────┬─────────┬──────────┬──────────────┤
│Prometheus│Grafana│ Loki    │AlertManager  │
│ 3/3 ✓   │ 2/2 ✓ │ 3/3 ✓   │ 2/2 ✓       │
└────────┴─────────┴──────────┴──────────────┘

│ Component Health Metrics                    │
├──────────────────────────────────────────────┤
│ Prometheus Targets Up: 99.8% ✓              │
│ Grafana API Health: 200 OK ✓                │
│ Loki Ingestion: 5000 lines/sec ✓            │
│ AlertManager: 10 active alerts (normal) ✓   │
└──────────────────────────────────────────────┘

│ Performance Metrics                         │
├──────────────────────────────────────────────┤
│ Query Latency p95: 0.8s ✓ (target <2s)     │
│ Memory Usage: 65% ✓ (target <80%)          │
│ Storage Usage: 28% ✓ (target <70%)         │
│ Metric Count: 8.5M (stable) ✓              │
└──────────────────────────────────────────────┘

│ Alert Status                                │
├──────────────────────────────────────────────┤
│ Firing Alerts: 0 critical ✓                │
│ Alert Delivery Success: 99.9% ✓             │
│ Last Slack Notification: 2 min ago ✓        │
└──────────────────────────────────────────────┘
```

---

## Alert Rules for Components

### Prometheus Down

```yaml
alert: PrometheusDown
expr: up{job="prometheus"} == 0
for: 2m
labels:
  severity: critical
  component: prometheus
annotations:
  summary: "Prometheus pod {{ $labels.pod }} is DOWN"
  description: "Prometheus has been unreachable for 2 minutes"
  runbook: "See RUNBOOK_OPERATIONS.md - Prometheus Down"
```

**Response SLA:** Page on-call immediately (5 min)

### Prometheus High Query Latency

```yaml
alert: PrometheusHighQueryLatency
expr: histogram_quantile(0.95, rate(prometheus_http_request_duration_seconds_bucket[5m])) > 2
for: 10m
labels:
  severity: warning
  component: prometheus
annotations:
  summary: "Prometheus query latency p95 is {{ $value | humanizeDuration }}"
  description: "Target: <2s, Current: {{ $value | humanizeDuration }}"
```

**Response SLA:** Investigate within 30 min

### Prometheus Targets Down (>50%)

```yaml
alert: PrometheusTargetsDown
expr: (count(up==0) / count(up)) > 0.5
for: 5m
labels:
  severity: critical
  component: prometheus
annotations:
  summary: "{{ $value | humanizePercentage }} of Prometheus targets are DOWN"
  description: "More than 50% of scrape targets are unreachable"
  count: "{{ with query `count(up==0)` }}{{ . | first | value }}{{ end }} targets down"
```

**Response SLA:** Respond within 10 min

### Grafana Down

```yaml
alert: GrafanaDown
expr: up{job="grafana"} == 0
for: 2m
labels:
  severity: critical
  component: grafana
annotations:
  summary: "Grafana is DOWN"
  description: "Grafana has not responded for 2 minutes"
```

**Response SLA:** Page immediately (5 min)

### Grafana API Errors

```yaml
alert: GrafanaHighErrorRate
expr: rate(grafana_request_errors_total[5m]) / rate(grafana_request_total[5m]) > 0.1
for: 5m
labels:
  severity: warning
  component: grafana
annotations:
  summary: "Grafana API error rate: {{ $value | humanizePercentage }}"
  description: "More than 10% of requests are failing"
```

**Response SLA:** Investigate within 30 min

### Loki Down

```yaml
alert: LokiDown
expr: up{job="loki"} == 0
for: 2m
labels:
  severity: critical
  component: loki
annotations:
  summary: "Loki is DOWN"
  description: "Loki ingester has been unreachable for 2 minutes"
```

**Response SLA:** Page immediately (5 min)

### Loki No Logs Ingesting

```yaml
alert: LokiNoLogsIngesting
expr: rate(loki_distributor_lines_received_total[5m]) == 0
for: 10m
labels:
  severity: critical
  component: loki
annotations:
  summary: "Loki is not receiving any log lines"
  description: "No logs have been ingested for 10 minutes"
```

**Response SLA:** Respond within 10 min

### AlertManager Down

```yaml
alert: AlertManagerDown
expr: up{job="alertmanager"} == 0
for: 2m
labels:
  severity: critical
  component: alertmanager
annotations:
  summary: "AlertManager is DOWN"
  description: "AlertManager has been unreachable for 2 minutes"
```

**Response SLA:** Page immediately (5 min - critical, alerts can't be delivered!)

### AlertManager Failed Notifications

```yaml
alert: AlertManagerFailedNotifications
expr: rate(alertmanager_notifications_failed_total[5m]) > 0
for: 5m
labels:
  severity: warning
  component: alertmanager
annotations:
  summary: "AlertManager notifications failing"
  description: "{{ $value | humanize }} notifications failed in last 5 minutes"
  channels: "{{ range query `alertmanager_notifications_failed_total` }}{{ .Labels.channel }} {{ end }}"
```

**Response SLA:** Respond within 15 min

### Storage Capacity

```yaml
alert: PrometheusStorageHigh
expr: (prometheus_tsdb_dir_bytes / prometheus_tsdb_disk_space_limit) > 0.8
for: 10m
labels:
  severity: warning
  component: prometheus
annotations:
  summary: "Prometheus storage at {{ $value | humanizePercentage }} capacity"
  description: "Storage will be full in approximately {{ ((1 - ($value / 1)) * 100) / $value }} days"
```

**Response SLA:** Expand storage within 24 hours

```yaml
alert: LokiStorageHigh
expr: (kubelet_volume_stats_used_bytes{persistentvolumeclaim="loki-storage"} / kubelet_volume_stats_capacity_bytes{persistentvolumeclaim="loki-storage"}) > 0.8
for: 10m
labels:
  severity: warning
  component: loki
annotations:
  summary: "Loki storage at {{ $value | humanizePercentage }} capacity"
```

**Response SLA:** Expand storage within 24 hours

### Pod Restart Storms

```yaml
alert: PodRestarts
expr: rate(kube_pod_container_status_restarts_total{namespace="observability"}[1h]) > 0.1
for: 5m
labels:
  severity: warning
  component: "{{ $labels.pod }}"
annotations:
  summary: "Pod {{ $labels.pod }} restarting frequently"
  description: "{{ $value | humanize }} restarts per hour"
```

**Response SLA:** Investigate within 1 hour

### Pod Pending

```yaml
alert: PodPending
expr: count(kube_pod_status_phase{namespace="observability",phase="Pending"}) > 0
for: 10m
labels:
  severity: warning
  component: kubernetes
annotations:
  summary: "{{ $value | humanize }} pods stuck in Pending state"
  description: "Possible resource constraints or scheduling issues"
```

**Response SLA:** Investigate within 30 min

---

## External Monitoring

### Health Check Endpoint

Create a simple HTTP health endpoint that doesn't require Prometheus:

```bash
# Deploy a simple health check service
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: observability-health
  namespace: observability
spec:
  selector:
    app: health-check
  ports:
  - port: 8080
    targetPort: 8080
---
apiVersion: v1
kind: Pod
metadata:
  name: observability-health
  namespace: observability
  labels:
    app: health-check
spec:
  containers:
  - name: health
    image: alpine
    command:
    - sh
    - -c
    - |
      apk add --no-cache curl
      while true; do
        # Check all services
        PROMETHEUS=$(curl -s -o /dev/null -w "%{http_code}" http://prometheus-kube-prom-prometheus:9090/-/healthy)
        GRAFANA=$(curl -s -o /dev/null -w "%{http_code}" http://grafana:3000/api/health)
        LOKI=$(curl -s -o /dev/null -w "%{http_code}" http://loki:3100/ready)
        ALERTMANAGER=$(curl -s -o /dev/null -w "%{http_code}" http://alertmanager:9093/-/healthy)
        
        # Simple HTTP server
        echo "HTTP/1.0 200 OK" | nc -l -p 8080
        echo "Prometheus: $PROMETHEUS"
        echo "Grafana: $GRAFANA"
        echo "Loki: $LOKI"
        echo "AlertManager: $ALERTMANAGER"
      done
    resources:
      requests:
        memory: "64Mi"
        cpu: "10m"
EOF
```

### External Uptime Monitoring

Subscribe to external monitoring service:

```bash
# Uptime.com / StatusPage.io / Datadog uptime monitoring
# Configure to monitor:
# - http://observability.internal/health (health endpoint)
# - http://grafana.internal/api/health
# - http://prometheus.internal/-/healthy

# Alert if any endpoint down for >5 minutes
# Should trigger alerts that bypass Slack (SMS, PagerDuty)
```

### AWS CloudWatch Monitoring

Use CloudWatch for basic EKS/EFS metrics:

```bash
# Create CloudWatch alarms
aws cloudwatch put-metric-alarm \
  --alarm-name observability-pod-count \
  --alarm-description "Alert if observability pods < 6" \
  --metric-name pod_count \
  --namespace observability \
  --statistic Average \
  --period 300 \
  --threshold 6 \
  --comparison-operator LessThanThreshold

# Monitor EFS performance
aws cloudwatch get-metric-statistics \
  --namespace AWS/EFS \
  --metric-name BurstCreditBalance \
  --statistics Minimum \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600
```

---

## Synthetic Tests

### Synthetic Transaction Test

Test the full flow end-to-end:

```bash
#!/bin/bash
# Synthetic test: Write metric, verify in Prometheus

set -euo pipefail

TEST_METRIC="synthetic_test_$(date +%s)"
TEST_VALUE=$RANDOM

# Step 1: Generate test metric
echo "Generating test metric: $TEST_METRIC = $TEST_VALUE"

# Step 2: Wait for scrape
sleep 15

# Step 3: Query Prometheus
RESULT=$(curl -s "http://prometheus:9090/api/v1/query?query=$TEST_METRIC" | \
  jq '.data.result[0].value[1]')

# Step 4: Verify
if [[ "$RESULT" == "$TEST_VALUE" ]]; then
    echo "✓ Synthetic test PASSED"
    exit 0
else
    echo "✗ Synthetic test FAILED - Expected: $TEST_VALUE, Got: $RESULT"
    exit 1
fi
```

Create alert if test fails:

```yaml
alert: SyntheticTestFailed
expr: synthetic_test_last_run_success == 0
for: 5m
labels:
  severity: critical
annotations:
  summary: "Synthetic observability test FAILED"
  description: "End-to-end observability test failed. Stack may be broken."
```

### Log Ingestion Synthetic Test

Test log flow:

```bash
#!/bin/bash
# Test: Write log, verify in Loki

TEST_ID=$(date +%s)

# Write test log
kubectl logs -n observability prometheus-kube-prom-prometheus-0 | \
  tail -1 > /tmp/test-log-$TEST_ID.txt

# Wait for Promtail to ingest
sleep 10

# Query Loki
FOUND=$(curl -s 'http://loki:3100/loki/api/v1/query_range' \
  --data-urlencode "query={job=\"kubernetes-pods\"}" \
  --data-urlencode "start=$(date -d '1 minute ago' +%s)000000000" \
  --data-urlencode "end=$(date +%s)000000000" | \
  jq '.data.result | length')

if [[ $FOUND -gt 0 ]]; then
    echo "✓ Log ingestion test PASSED - Found $FOUND log streams"
else
    echo "✗ Log ingestion test FAILED - No logs found"
fi
```

---

## Alerting on Alerts

### Meta-Alert: No Alerts for Too Long

If no alerts fire for extended period, something is wrong:

```yaml
alert: NoAlertsForTooLong
expr: rate(ALERTS_total[1h]) == 0
for: 12h
labels:
  severity: warning
annotations:
  summary: "No alerts have fired in 12 hours"
  description: "Either no incidents occurred (unlikely) or alerting is broken"
```

### Alert Manager Feedback Loop

Monitor AlertManager's own success:

```yaml
alert: AlertManagerQueueBuildup
expr: alertmanager_notifications_queue_length > 1000
for: 5m
labels:
  severity: warning
annotations:
  summary: "AlertManager notification queue backed up ({{ $value }} pending)"
  description: "Notifications are queued and may be delayed"
```

---

## Escalation & Runbooks

### Escalation Procedure for Meta-Monitoring

**Severity:** CRITICAL (Observability stack down)
- Page: On-call engineer, Team lead, Manager
- Response Time: 5 minutes
- Channel: PagerDuty + SMS (not Slack if Slack is down!)

**Action Items:**
1. Verify observability stack actually down (not just alert noise)
2. Check external monitoring - is it just our observability or broader issue?
3. Follow [`ROLLBACK_PRODUCTION.md`](ROLLBACK_PRODUCTION.md) if needed
4. Declare SEV-1 incident
5. Begin recovery immediately

### Run Books Reference

When meta-monitoring alerts fire:

| Alert | Runbook |
|-------|---------|
| PrometheusDown | RUNBOOK_OPERATIONS.md - Metrics Not Being Collected |
| GrafanaDown | RUNBOOK_OPERATIONS.md - Dashboard Slow or Unresponsive |
| LokiDown | RUNBOOK_OPERATIONS.md - Loki Logs Not Ingesting |
| AlertManagerDown | RUNBOOK_OPERATIONS.md - Alert Ingestion Stopped |
| StorageFull | RUNBOOK_OPERATIONS.md - Storage Full |
| All down | ROLLBACK_PRODUCTION.md - Complete Stack Failure |

---

## Monitoring the Meta-Monitoring

### Redundancy Checklist

- [ ] Primary alerting: Prometheus AlertManager → Slack
- [ ] Secondary alerting: External uptime monitor → Email/SMS
- [ ] Tertiary alerting: CloudWatch alarms → PagerDuty
- [ ] Health check endpoint: Simple HTTP (doesn't require Prometheus)
- [ ] Synthetic tests: Automated, run every 5 minutes
- [ ] External status page: Shows public health status

### Testing Meta-Monitoring

Monthly test: Kill observability components and verify:

```bash
#!/bin/bash
# Test that we get alerts when stack is down

# Simulate failure: Scale Prometheus to 0
kubectl scale statefulset prometheus-kube-prom-prometheus --replicas=0 -n observability

# Verify we get:
# 1. Prometheus down alert in Slack
# 2. Page in PagerDuty (from AlertManager)
# 3. SMS/Email from external monitor (uptime.com)
# 4. CloudWatch alarm triggered

# Wait 10 minutes, then recover
sleep 600
kubectl scale statefulset prometheus-kube-prom-prometheus --replicas=3 -n observability

# Verify we get recovery alerts
```

---

## Example Meta-Monitoring Dashboard JSON

A sample Grafana dashboard showing observability stack health:

```json
{
  "dashboard": {
    "title": "Observability Stack Health",
    "panels": [
      {
        "title": "Prometheus Pods",
        "targets": [
          {"expr": "up{job=\"prometheus\"}"}
        ]
      },
      {
        "title": "Grafana Pods",
        "targets": [
          {"expr": "up{job=\"grafana\"}"}
        ]
      },
      {
        "title": "Prometheus Target Health %",
        "targets": [
          {"expr": "count(up==1) / count(up) * 100"}
        ]
      },
      {
        "title": "Query Latency p95",
        "targets": [
          {"expr": "histogram_quantile(0.95, rate(prometheus_http_request_duration_seconds_bucket[5m]))"}
        ]
      },
      {
        "title": "Prometheus Storage %",
        "targets": [
          {"expr": "(prometheus_tsdb_dir_bytes / prometheus_tsdb_disk_space_limit) * 100"}
        ]
      }
    ]
  }
}
```

---

**Related Documentation:**
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - Detailed incident response
- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - Recovery procedures
- [`ACCESS_PRODUCTION.md`](ACCESS_PRODUCTION.md) - How to access monitoring tools
