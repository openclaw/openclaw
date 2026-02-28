# Operations Quick Start Guide

**For:** Operations team  
**Version:** 1.0  
**Last Updated:** ________________  

---

## 🚀 5-Minute Daily Startup Checklist

**Goal:** Verify all systems operational before handoff to business

### Step 1: Cluster Health (1 min)
```bash
# Check all nodes healthy
kubectl get nodes -o wide

# Expected: All nodes STATUS=Ready, ROLES appropriate
```

### Step 2: Monitoring Namespace (1 min)
```bash
# Check all monitoring pods running
kubectl get pods -n monitoring

# Expected: All pods STATUS=Running, READY=1/1 or greater
```

### Step 3: Storage Status (1 min)
```bash
# Check persistent volumes
kubectl get pvc -n monitoring

# Expected: All PVCs STATUS=Bound, no errors
```

### Step 4: Recent Alerts (1 min)
```bash
# Check AlertManager (in another terminal/window)
kubectl port-forward svc/alertmanager 9093:9093 -n monitoring &
# Visit: http://localhost:9093
# Expected: No critical alerts, silences as expected
```

### Step 5: Grafana Status (1 min)
```bash
# Quick visual check
kubectl port-forward svc/grafana 3000:3000 -n monitoring &
# Visit: http://localhost:3000
# Expected: Dashboards responsive, no datasource errors
```

---

## 📊 Daily Dashboard Access (30 seconds)

### Fast Launch - Grafana
```bash
# Option 1: Port-forward
kubectl port-forward -n monitoring svc/grafana 3000:3000
# Then open: http://localhost:3000

# Option 2: Via ingress (if configured)
# Just visit: https://grafana.prod.your-domain.com
```

**Bookmarks to save:**
- Prometheus: http://localhost:9090 (or your ingress)
- Grafana: http://localhost:3000 (or your ingress)
- AlertManager: http://localhost:9093 (or your ingress)

### Three Key Dashboards
1. **Router Health Overview** - Start here first
   - Real-time request rate, error rate, availability
   - One-stop view of system health
   - Alerts highlight in red

2. **Performance Details** - Drill down here
   - Latency heatmap, error breakdown
   - Resource utilization trends
   - Used when investigating slowness

3. **Infrastructure Health** - Check when scaling needed
   - Node resource usage, PVC capacity
   - Certificate expiry, pod restarts
   - Used when planning capacity

---

## ⚙️ Common Operations (5-10 min each)

### 1. Silence a Noisy Alert (3 min)

```bash
# Via AlertManager UI:
# 1. Port-forward: kubectl port-forward svc/alertmanager 9093:9093 -n monitoring
# 2. Visit: http://localhost:9093
# 3. Click alert → "Silence alert"
# 4. Set duration (e.g., 1 hour)
# 5. Optional: Add comment (e.g., "False positive, investigating")
```

### 2. Check Metric Value (2 min)

```bash
# Via Prometheus
kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring

# Visit: http://localhost:9090
# Click "Graph"
# Enter metric name (e.g., router_request_latency_ms)
# View current value and graph
```

**Common metrics to check:**
- `router_request_latency_ms` - Current latency
- `router_requests_total` - Total request count
- `router_requests_failed_total` - Failed request count
- `up` - Scrape target status

### 3. View Recent Logs (5 min)

```bash
# Via Grafana Explore
kubectl port-forward svc/grafana 3000:3000 -n monitoring

# Steps:
# 1. Visit http://localhost:3000
# 2. Click "Explore" (left sidebar)
# 3. Select "Loki" from dropdown
# 4. Query: {namespace="default"} (or your namespace)
# 5. Click "Run query"
# 6. See recent logs with timestamps
```

**Example queries:**
```
# All logs from default namespace
{namespace="default"}

# Logs from specific pod
{pod="my-pod-123"}

# Error logs
{level="ERROR"}

# Specific service
{service="router"}

# Combine filters
{namespace="production", level="ERROR"}
```

### 4. Restart a Component (3 min)

```bash
# Roll out restart (creates new pods)
kubectl rollout restart deployment/prometheus -n monitoring
kubectl rollout restart deployment/grafana -n monitoring
kubectl rollout restart deployment/loki -n monitoring
kubectl rollout restart deployment/alertmanager -n monitoring

# Expected: Pods terminate and restart, service stays up due to other replicas
# Check status: kubectl get pods -n monitoring -w (watch mode)
```

### 5. Scale Up for Higher Load (2 min)

```bash
# Get current replicas
kubectl get deployment -n monitoring

# Scale deployment to N replicas
kubectl scale deployment prometheus --replicas=4 -n monitoring
kubectl scale deployment grafana --replicas=3 -n monitoring
kubectl scale deployment loki --replicas=3 -n monitoring
kubectl scale deployment alertmanager --replicas=3 -n monitoring

# Verify: kubectl get pods -n monitoring (should show new pods)
# Wait: Up to 5 minutes for pods to become ready
```

### 6. Check PVC Usage (2 min)

```bash
# Get PVC info
kubectl describe pvc -n monitoring

# Look for "Used" field (approximate)
# Or mount PVC and check directly
kubectl exec -it <pod-name> -n monitoring -- df -h /path/to/mount

# Expected growth rates:
# Prometheus: ~100-500 MB/day
# Loki: ~500MB-1GB/day (depending on log volume)
# Grafana: ~10MB/day (minimal)
```

**If approaching 85% capacity:**
1. Option A: Reduce retention period (Prometheus: 15→7 days, Loki: 30→14 days)
2. Option B: Increase PVC size (see MAINTENANCE.md for procedure)
3. Option C: Archive old data to S3 (future enhancement)

---

## 🚨 Incident Response (1-5 min to start)

### When an Alert Fires

1. **PagerDuty pages you** (for critical prod alerts)
2. **Go to AlertManager UI:**
   ```bash
   kubectl port-forward svc/alertmanager 9093:9093 -n monitoring
   # Visit: http://localhost:9093/#/alerts
   ```
3. **Click the alert** to see details:
   - Alert name
   - Severity (warning/critical)
   - Affected instance/pod
   - Current value vs threshold
   - Graph of metric over time

4. **Identify the issue:**
   - Check related dashboard (Router Health, Performance, Infrastructure)
   - Check logs for error messages
   - Check pod status: `kubectl get pods -n monitoring -o wide`
   - Check node status: `kubectl get nodes`

5. **Follow runbook:**
   - Alert name → search in [`infra/RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)
   - Follow specific resolution steps
   - Document what you did in incident notes

6. **Mitigate (if immediate action needed):**
   ```bash
   # Common mitigations:
   kubectl rollout restart deployment/<component> -n monitoring  # Restart
   kubectl scale deployment/<component> --replicas=<N> -n monitoring  # Scale
   kubectl edit configmap/<config> -n monitoring  # Change config
   ```

7. **Communicate progress** (every 15 minutes):
   - Post to #monitoring-incidents or #incidents
   - Status: "Investigating", "Mitigating", "Monitoring", "Resolved"

8. **Verify resolution:**
   - Alert returns to "Firing=No" state
   - Metric back to normal range
   - No related errors in logs

9. **Post-resolution:**
   - Document issue in runbook (if new scenario)
   - Note in knowledge base for future reference
   - Schedule post-mortem if major incident

---

## 🔍 Quick Troubleshooting (Reference)

**Symptom: No metrics showing**
- [ ] Check Prometheus status: `kubectl get pod prometheus-kube-prom-prometheus-0 -n monitoring`
- [ ] Check targets: `kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090` → /targets
- [ ] Look for red "DOWN" targets - click to see error
- **Fix:** Usually ServiceMonitor misconfigured or pod not running
- **Runbook:** See [`infra/TROUBLESHOOTING_QUICK_REF.md`](TROUBLESHOOTING_QUICK_REF.md#no-metrics)

**Symptom: Dashboard slow or timing out**
- [ ] Check Prometheus query latency in Expression Browser
- [ ] Query with smaller time range (try 1 hour instead of 30 days)
- [ ] Check for heavy queries in browser DevTools
- **Fix:** Use recording rules for expensive queries, or optimize query
- **Runbook:** See [`infra/PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md)

**Symptom: No logs visible**
- [ ] Check Promtail pods: `kubectl get pods -n monitoring -l app=promtail`
- [ ] Check Loki pod: `kubectl get pod loki-0 -n monitoring`
- [ ] Try query: `{job="promtail"}` to see if Loki receiving logs
- **Fix:** Restart Promtail or check file permissions
- **Runbook:** See [`infra/loki/README.md`](loki/README.md#troubleshooting)

**Symptom: Alerts not reaching Slack**
- [ ] Check AlertManager status: `kubectl get pod alertmanager-0 -n monitoring`
- [ ] Check webhook secret: `kubectl get secret alertmanager-slack-webhook -n monitoring`
- [ ] Check AlertManager logs: `kubectl logs alertmanager-0 -n monitoring`
- **Fix:** Update webhook URL or restart AlertManager
- **Runbook:** See [`infra/alertmanager/README.md`](alertmanager/README.md#troubleshooting)

---

## 📋 Daily Responsibilities Checklist

| Task | Frequency | Time | Owner |
|------|-----------|------|-------|
| Startup checklist | Daily | 5 min | On-call |
| Check alert backlog | Every 4 hours | 2 min | On-call |
| Review dashboard trends | Daily | 10 min | Engineer |
| Storage capacity check | Weekly | 5 min | Engineer |
| Alert tuning review | Weekly | 20 min | Team |
| SLO metrics review | Weekly | 10 min | Team |
| On-call handoff | Every shift | 5 min | Outgoing + Incoming |

---

## 🆘 Immediate Action Items

**If something is VERY wrong:**
1. **Acknowledge alert/page** (confirm you're investigating)
2. **Check if it's a false positive** (temporary config change, test, etc.)
3. **If critical production issue:**
   - Restart affected component: `kubectl rollout restart deployment/<name> -n monitoring`
   - If that doesn't work, scale down to 1 replica and observe
   - Call engineering lead if issue persists >5 minutes
4. **Document everything** (time, symptoms, actions, outcome)

**Who to call:**
- **Quick question:** Engineering Slack #monitoring or team
- **Urgent issue:** Engineering on-call phone number: _____________________
- **Major incident:** Engineering lead + ops manager

---

## 📚 Documentation Links

- **Quick reference:** See [`TROUBLESHOOTING_QUICK_REF.md`](TROUBLESHOOTING_QUICK_REF.md)
- **Full runbooks:** See [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)
- **FAQ:** See [`FAQ.md`](FAQ.md)
- **Architecture:** See [`ARCHITECTURE_SUMMARY.md`](ARCHITECTURE_SUMMARY.md)
- **Disaster recovery:** See [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)
- **Performance tuning:** See [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md)

---

## ⚡ Pro Tips

✅ **Keep these bookmarked:**
- Grafana: http://localhost:3000
- Prometheus: http://localhost:9090
- AlertManager: http://localhost:9093

✅ **Print this guide** and keep at desk

✅ **Create aliases** in shell:
```bash
alias prom-fwd='kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring'
alias grafana-fwd='kubectl port-forward svc/grafana 3000:3000 -n monitoring'
alias alert-fwd='kubectl port-forward svc/alertmanager 9093:9093 -n monitoring'
alias mon-pods='kubectl get pods -n monitoring -w'
```

✅ **Set up dashboard refresh:**
- Grafana → each dashboard → top-right dropdown → auto-refresh to 30s

✅ **Configure Slack notifications** so you see alerts in real-time (should already be set up)

✅ **Join #monitoring-alerts channel** in Slack to see all alert notifications

---

## Questions?

See [`FAQ.md`](FAQ.md) for common questions and answers, or contact your engineering lead.

**Last updated by:** ________________  
**Next review date:** ________________
