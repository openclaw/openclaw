# Staging Observability Stack - Success Criteria & Acceptance

## Overview
This document defines pass/fail acceptance criteria for the observability stack deployment. All criteria must be met before proceeding to production deployment.

**Test Execution Date:** [Record date]  
**Tested By:** [Record name]  
**Approval Status:** [ ] PASS [ ] FAIL [ ] CONDITIONAL

---

## Component Availability

### Prometheus - MUST PASS

**Criteria:**
- [ ] 2 of 2 replicas healthy and running
- [ ] All scrape targets in "UP" state (>50 targets)
- [ ] Prometheus API responds to health checks (HTTP 200)
- [ ] PVC has adequate space (>10GB available)
- [ ] No pod restart loops (restart count stable)
- [ ] Memory usage <2GB per replica
- [ ] CPU usage <500m per replica

**Evidence Required:**
```bash
kubectl -n monitoring get pods -l app=prometheus
kubectl -n monitoring get pvc prometheus-data
curl http://prometheus:9090/-/healthy
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Grafana - MUST PASS

**Criteria:**
- [ ] 2 of 2 replicas healthy and running
- [ ] Web interface accessible and responding (HTTP 200)
- [ ] Default admin login functional (admin:admin)
- [ ] All 3 dashboards load without errors
- [ ] Datasources show healthy status
- [ ] No authentication/authorization errors
- [ ] Memory usage <400MB per replica
- [ ] CPU usage <100m per replica

**Evidence Required:**
```bash
kubectl -n monitoring get pods -l app=grafana
curl http://grafana:3000/api/health
curl http://grafana:3000/api/datasources
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Loki - MUST PASS

**Criteria:**
- [ ] 2 of 2 replicas healthy and running
- [ ] /ready endpoint responds with 200
- [ ] Log ingestion active (>100 lines/sec)
- [ ] PVC has adequate space (>50GB available)
- [ ] No ingester errors in logs
- [ ] Memory usage <800MB per replica
- [ ] CPU usage <400m per replica

**Evidence Required:**
```bash
kubectl -n monitoring get pods -l app=loki
kubectl -n monitoring get pvc loki-data
curl http://loki:3100/ready
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### AlertManager - MUST PASS

**Criteria:**
- [ ] 2 of 2 replicas healthy and running
- [ ] API health check returns 200
- [ ] Configuration loaded successfully
- [ ] Slack webhook connectivity verified
- [ ] All routing rules configured
- [ ] Memory usage <100MB per replica
- [ ] CPU usage <50m per replica

**Evidence Required:**
```bash
kubectl -n monitoring get pods -l app=alertmanager
curl http://alertmanager:9093/-/healthy
curl http://alertmanager:9093/api/v1/status
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Data Collection & Storage

### Metrics Collection - MUST PASS

**Criteria:**
- [ ] >50 targets scraping successfully
- [ ] All scrape jobs completing within interval (<30s)
- [ ] No scrape timeouts or errors
- [ ] Metrics available from ≥1 hour ago
- [ ] Historical data retention ≥15 days verified
- [ ] Query latency p95 <500ms for complex queries
- [ ] Recording rules evaluating successfully
- [ ] No missing or stale metrics

**Test Commands:**
```bash
curl http://prometheus:9090/api/v1/targets
curl http://prometheus:9090/api/v1/rules?type=record
curl http://prometheus:9090/api/v1/query_range?query=up
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Log Collection - MUST PASS

**Criteria:**
- [ ] Logs ingested from ≥4 namespaces (default, kube-system, monitoring, app-namespace)
- [ ] Log ingestion rate >100 lines/sec
- [ ] Logs available from ≥24 hours ago
- [ ] 30-day retention policy active
- [ ] No ingestion errors in Loki logs
- [ ] Query latency p95 <2s for label queries
- [ ] Log labels correctly applied (cluster, namespace, pod, container)
- [ ] No duplicate or missing logs

**Test Commands:**
```bash
curl http://loki:3100/loki/api/v1/labels
curl http://loki:3100/loki/api/v1/query?query={cluster=\"staging\"}
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Data Consistency - MUST PASS

**Criteria:**
- [ ] Metrics collected at consistent timestamps
- [ ] Prometheus replicas have <1% metric difference
- [ ] Loki replicas have identical indices
- [ ] No data loss on pod restart
- [ ] No stale data in queries
- [ ] Replication lag <1 minute
- [ ] Both replicas answering queries independently

**Test Commands:**
```bash
# Query both replicas and compare
curl http://prometheus-0:9090/api/v1/query?query=up
curl http://prometheus-1:9090/api/v1/query?query=up
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Dashboard Functionality

### Dashboard 1: Router Health Overview - MUST PASS

**Criteria:**
- [ ] Dashboard loads without errors
- [ ] Availability gauge displays 0-100% (green if >99%)
- [ ] P99 latency stat shows milliseconds (green if <200ms)
- [ ] Error rate stat shows percentage (green if <1%)
- [ ] Requests/sec graph shows 24h trend with data
- [ ] Pod status table lists all running pods
- [ ] SLO status shows all targets met
- [ ] All panels have data (no "No data" messages)

**Test URL:** `http://grafana:3000/d/router-overview/`

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Dashboard 2: Performance Details - MUST PASS

**Criteria:**
- [ ] Dashboard loads without errors
- [ ] Latency heatmap displays distribution
- [ ] Error breakdown shows error types
- [ ] Pod CPU/memory graphs show trends
- [ ] Goroutine count graph is stable
- [ ] Network I/O graph shows throughput
- [ ] All panels populated with data
- [ ] 15-second refresh working

**Test URL:** `http://grafana:3000/d/performance-details/`

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Dashboard 3: Infrastructure Health - MUST PASS

**Criteria:**
- [ ] Dashboard loads without errors
- [ ] Node CPU gauges <80% utilization
- [ ] Node memory gauges <80% utilization
- [ ] Disk usage shows all filesystems
- [ ] PVC usage: Prometheus <50%, Loki <50%
- [ ] Certificate expiry shows >30 days
- [ ] Node pressure status shows healthy
- [ ] All panels have data

**Test URL:** `http://grafana:3000/d/infra-health/`

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Alert Routing & Notifications

### Alert Routing - MUST PASS

**Criteria:**
- [ ] Test critical alert routes to #monitoring-staging-critical
- [ ] Test warning alert routes to #monitoring-staging-alerts
- [ ] Test info alert routes to #monitoring-staging-general
- [ ] All routing rules correctly configured in AlertManager
- [ ] Alert grouping working (10 alerts → 1 message)
- [ ] Alert deduplication across replicas working
- [ ] Inhibition rules suppress child alerts

**Test Procedures:**
```bash
# Send test alerts and monitor Slack
curl -X POST http://alertmanager:9093/api/v1/alerts -d '[...]'
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Slack Notifications - MUST PASS

**Criteria:**
- [ ] Alerts arrive in Slack within 1 minute
- [ ] Message includes alert name, summary, and labels
- [ ] Severity emoji visible (🔴 critical, 🟠 warning, 🟢 resolved)
- [ ] Links to Grafana dashboards work
- [ ] Silence/Acknowledge buttons functional
- [ ] Alert grouping shows correct count
- [ ] No duplicate notifications
- [ ] Resolution messages show when alerts clear

**Manual Test:** Send test alert and verify in Slack

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## High Availability & Resilience

### Replica Redundancy - MUST PASS

**Criteria:**
- [ ] All components deployed with 2+ replicas
- [ ] Kill one pod → remaining replicas serve requests
- [ ] Killed pod automatically recreates
- [ ] No service interruption from single pod failure
- [ ] Load balancer distributes traffic to remaining replicas
- [ ] PDBs prevent simultaneous pod evictions

**Test Procedure:**
```bash
kubectl -n monitoring delete pod prometheus-0
kubectl -n monitoring get pods -w  # Verify recreation
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Data Persistence - MUST PASS

**Criteria:**
- [ ] PVCs properly attached to pods
- [ ] Data survives pod restart
- [ ] PVC capacity adequate for retention
- [ ] No data loss on pod failure
- [ ] Metrics available from before pod restart
- [ ] Logs available from before pod restart

**Test Procedure:**
```bash
kubectl -n monitoring delete pod prometheus-0
# After recreation, verify metrics still available
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

### Network Connectivity - MUST PASS

**Criteria:**
- [ ] All inter-component DNS resolution works
- [ ] Service-to-service connectivity verified
- [ ] Kubernetes service discovery working
- [ ] External access to Grafana/AlertManager
- [ ] No connection timeouts between components
- [ ] Network policies (if present) allow required traffic

**Test Commands:**
```bash
kubectl -n monitoring exec prometheus-0 -- nslookup loki
kubectl -n monitoring exec grafana-0 -- nslookup prometheus
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Performance Baselines

### Prometheus Performance - SHOULD PASS

**Criteria:**
- [ ] Scrape duration: avg <10s, p95 <30s
- [ ] Query latency p50: <100ms (simple queries)
- [ ] Query latency p95: <500ms (aggregation)
- [ ] Query latency p99: <2s (complex)
- [ ] Cardinality: <100k time series
- [ ] Memory: <2GB per replica
- [ ] No query timeouts

**Measurement Command:**
```bash
# Time sample queries and record results
time curl http://prometheus:9090/api/v1/query_range?query=...
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Baseline Recorded:** _______________________________________________

---

### Loki Performance - SHOULD PASS

**Criteria:**
- [ ] Ingestion rate: >100 lines/sec
- [ ] Query latency p50: <500ms (label queries)
- [ ] Query latency p95: <2s (range queries)
- [ ] Memory: <800MB per replica
- [ ] Disk growth: 50-100 GB/day (sustainable)
- [ ] No query timeouts
- [ ] Index cache <5GB

**Measurement Command:**
```bash
time curl http://loki:3100/loki/api/v1/query?query=...
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Baseline Recorded:** _______________________________________________

---

### Alerting Performance - SHOULD PASS

**Criteria:**
- [ ] Alert detection latency: <2 minutes
- [ ] Alert grouping efficiency: 20+ alerts → 1 message
- [ ] Silence application: <30 seconds
- [ ] No dropped alerts under load
- [ ] Slack notification delivery: <100% success

**Measurement:** Send test alerts and time notification arrival

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Baseline Recorded:** _______________________________________________

---

## Resource Utilization

### Resource Limits - MUST PASS

**Criteria:**
- [ ] Prometheus CPU <1 core (both replicas)
- [ ] Prometheus Memory <2GB (both replicas)
- [ ] Grafana CPU <200m (both replicas)
- [ ] Grafana Memory <400MB (both replicas)
- [ ] Loki CPU <800m (both replicas)
- [ ] Loki Memory <800MB (both replicas)
- [ ] AlertManager CPU <100m (both replicas)
- [ ] AlertManager Memory <200MB (both replicas)

**Measurement:**
```bash
kubectl -n monitoring top pod
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Current Usage:** _______________________________________________

---

### Disk Space - MUST PASS

**Criteria:**
- [ ] Prometheus PVC: <50% full
- [ ] Loki PVC: <50% full
- [ ] Node root filesystem: <80% full
- [ ] Adequate space for 15+ days Prometheus retention
- [ ] Adequate space for 30+ days Loki retention
- [ ] Growth rate monitored and sustainable

**Measurement:**
```bash
kubectl -n monitoring get pvc
kubectl get nodes -o json | jq '.items[].status.allocatable.ephemeralStorage'
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Current Usage:** _______________________________________________

---

## Security & RBAC

### Access Control - SHOULD PASS

**Criteria:**
- [ ] Default admin password changed (production)
- [ ] Service accounts have minimal required permissions
- [ ] RBAC roles properly configured
- [ ] No overly permissive role bindings
- [ ] Secrets stored securely (not in ConfigMaps)
- [ ] API tokens rotated per policy

**Verification:**
```bash
kubectl -n monitoring get serviceaccount
kubectl -n monitoring get role
kubectl -n monitoring get rolebinding
```

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Integration Testing

### Cross-Component Communication - MUST PASS

**Criteria:**
- [ ] Prometheus rules evaluate and fire
- [ ] Alerts flow: Prometheus → AlertManager → Slack
- [ ] Grafana queries Prometheus successfully
- [ ] Grafana queries Loki successfully
- [ ] Promtail sends logs to Loki
- [ ] AlertManager deduplicates across replicas

**Test:** Run complete alert flow test (see TEST_INTEGRATION_STAGING.md)

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Documentation & Runbooks

### Operational Readiness - SHOULD PASS

**Criteria:**
- [ ] All test guides completed and verified
- [ ] Runbooks documented for common failures
- [ ] Escalation procedures documented
- [ ] Backup/restore procedures tested
- [ ] On-call documentation available
- [ ] Component owners assigned

**Checklist:**
- [ ] TEST_COMPONENTS_STAGING.md - Complete
- [ ] VALIDATE_DATA_STAGING.md - Complete
- [ ] VALIDATE_DASHBOARDS_STAGING.md - Complete
- [ ] VALIDATE_ALERTS_STAGING.md - Complete
- [ ] BENCHMARK_STAGING.md - Complete
- [ ] TEST_INTEGRATION_STAGING.md - Complete
- [ ] TEST_FAILURE_SCENARIOS_STAGING.md - Complete
- [ ] Runbooks for production failures

**Pass/Fail:** [ ] PASS [ ] FAIL  
**Notes:** _______________________________________________

---

## Summary

### Overall Assessment

**Component Availability:** [ ] PASS [ ] FAIL  
**Data Collection:** [ ] PASS [ ] FAIL  
**Dashboards:** [ ] PASS [ ] FAIL  
**Alerting:** [ ] PASS [ ] FAIL  
**High Availability:** [ ] PASS [ ] FAIL  
**Performance:** [ ] PASS [ ] FAIL  
**Resources:** [ ] PASS [ ] FAIL  
**Integration:** [ ] PASS [ ] FAIL  

### Overall Status
**[ ] PASS** - All critical criteria met, ready for production  
**[ ] PASS WITH OBSERVATIONS** - All critical criteria met, noted items for production  
**[ ] FAIL** - Critical criteria not met, additional work required  

---

## Issues Found

### Critical Issues (Block Production)
1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

### Non-Critical Issues (Recommended Fixes)
1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

### Recommendations for Production
1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

---

## Sign-Off

**Test Lead:** _________________________ Date: _________

**Component Lead (Observability):** _________________________ Date: _________

**QA/Test Engineer:** _________________________ Date: _________

**Operations Lead:** _________________________ Date: _________

**Approved for Production:** [ ] YES [ ] NO [ ] CONDITIONAL

---

## Attachments

- [ ] Screenshots of all dashboards
- [ ] Performance benchmark results
- [ ] Alert test evidence (Slack screenshots)
- [ ] Resource utilization graphs
- [ ] Network connectivity verification
- [ ] Pod failure recovery logs
- [ ] Complete test execution log
