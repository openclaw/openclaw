# Frequently Asked Questions (FAQ)

**For:** Everyone  
**Updated:** ________________  

---

## General Questions

### Q: What is the OpenClaw Observability Stack?

**A:** An integrated monitoring system consisting of:
- **Prometheus** - collects 100+ metrics every 30 seconds
- **Grafana** - displays dashboards with real-time visualizations
- **Loki** - aggregates and searches container logs
- **AlertManager** - routes alerts to Slack and PagerDuty based on thresholds

It monitors the ClarityRouter and Kubernetes infrastructure to detect issues, investigate problems, and track performance.

---

### Q: Who manages the observability stack?

**A:** 
- **Engineering team** manages upgrades, architecture changes, feature development
- **Operations team** manages day-to-day monitoring, incident response, alert tuning
- **Both teams** collaborate on troubleshooting and optimization

See [`HANDOFF_CHECKLIST.md`](HANDOFF_CHECKLIST.md) for ownership transfer.

---

### Q: How much does it cost?

**A:** Approximately **$351/month for both clusters** (staging + production):
- EKS control planes: $146/month
- EFS storage (260GB): $150/month
- Data transfer: $8/month
- EFS snapshots (backups): $15/month
- Network load balancer: $32/month

See [`ARCHITECTURE_SUMMARY.md`](ARCHITECTURE_SUMMARY.md#-cost-breakdown) for detailed breakdown.

---

### Q: Is the observability stack itself monitored?

**A:** Yes! See [`META_MONITORING.md`](META_MONITORING.md) for how we monitor Prometheus, Grafana, Loki, and AlertManager themselves. We have alerts for component failures, storage capacity, certificate expiry, etc.

---

## Metrics Questions

### Q: What's the difference between Prometheus and Loki?

**A:** 
| Feature | Prometheus | Loki |
|---------|-----------|------|
| **Stores** | Metrics (time-series data) | Logs (raw text) |
| **Example** | `cpu_usage=95%` (one number) | `INFO processed request in 250ms` (log line) |
| **Query** | PromQL (metric queries) | LogQL (log queries) |
| **Retention** | 15 days | 30 days |
| **Use for** | Dashboards, alerts | Debugging, searching |

**In practice:**
- Use Prometheus to see "system is slow" (high latency metric)
- Use Loki to see "why is it slow" (look at error logs for requests)

---

### Q: Where do metrics come from?

**A:** Two sources:
1. **ClarityRouter pods** - expose custom metrics on `:8080/metrics` (latency, requests, errors)
2. **Kubernetes infrastructure** - kubelet, kube-state-metrics, node-exporter (CPU, memory, disk, network)

Prometheus scrapes both every 30 seconds via ServiceMonitors.

---

### Q: Can I add custom metrics from my application?

**A:** Yes! Your app needs to:
1. Expose metrics on `:<port>/metrics` endpoint (Prometheus format)
2. Create a `ServiceMonitor` YAML that targets your pods
3. Restart Prometheus to pick up new scrape target

Example:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app
  namespace: default
spec:
  selector:
    matchLabels:
      app: my-app
  endpoints:
  - port: metrics
    interval: 30s
```

See [`prometheus/README.md#adding-custom-metrics`](prometheus/README.md) for detailed instructions.

---

### Q: How long is metrics data retained?

**A:** **15 days** - metrics older than 15 days are automatically deleted.

**Why 15 days?**
- Balances storage cost (~100GB) with historical context
- Covers typical incident investigation window (5+ days back)
- Aligns with AWS data retention policies

**If you need longer:** See [`MAINTENANCE.md`](MAINTENANCE.md#changing-retention) for how to increase retention (increases storage cost).

---

### Q: How often are metrics collected?

**A:** **Every 30 seconds** (scrape interval).

**What this means:**
- Metrics are ~30 seconds old (normal staleness)
- Alerts evaluated every 15 seconds
- For 1-second precision, you'd need Prometheus on faster interval (not recommended)

**Why 30 seconds?**
- Balances storage usage with freshness
- Standard for most infrastructure monitoring
- 30s × 50 targets × 365 days = manageable storage

---

### Q: Can I see metrics for a specific time range?

**A:** Yes! Prometheus stores metrics with 1-second precision:
- **Past 1 day:** No problem, query returns ~86,400 data points
- **Past 30 days:** No problem, ~2.5M data points
- **Past 15 days (limit):** Retention policy deletes older data

**Performance note:** Querying 15-day range for complex metrics takes ~2-5 seconds. For dashboards, use shorter ranges (24h) or recording rules (pre-calculated queries).

---

## Dashboard Questions

### Q: Which dashboard should I check first?

**A:** **Router Health Overview** - your first stop always:
- Shows request rate, latency, error rate, availability
- Color-coded (green=good, red=bad)
- Immediately shows if system is healthy

If something is red, drill down to **Performance Details** for investigation.

---

### Q: Can I customize dashboards?

**A:** Yes! Grafana dashboards are fully editable:
1. Open dashboard
2. Click "Edit" (pencil icon, top right)
3. Add/remove panels, change queries, resize
4. Click "Save" (Ctrl+S)

**Note:** Dashboards are stored in EFS and persist across pod restarts.

---

### Q: How do I export a dashboard?

**A:** 
1. Open dashboard
2. Click "Share" (top right)
3. Click "Export"
4. Save JSON file

You can import this dashboard into another Grafana instance via **Dashboards** → **Import** → paste JSON.

---

### Q: Why is my dashboard slow?

**A:** Usually due to expensive queries:
1. Check panel query (Edit panel → see PromQL)
2. Try query directly in Prometheus UI - if slow there, issue is Prometheus
3. Reduce time range (30d → 7d) or optimize query
4. Consider using recording rules for pre-calculated metrics

See [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md) for optimization guide.

---

### Q: Can I share dashboards with non-engineers?

**A:** Yes, but with considerations:
- **All dashboards public (no auth):** Simple, but insecure
- **All dashboards authenticated:** Secure, but requires Grafana accounts
- **Read-only viewers:** Can view dashboards but not edit (recommended for managers)

See [`grafana/README.md#sharing`](grafana/README.md) for sharing options.

---

## Alert Questions

### Q: How do I acknowledge/silence an alert?

**A:** Two ways:

**Method 1 - AlertManager UI:**
```bash
kubectl port-forward svc/alertmanager 9093:9093 -n monitoring
# Visit http://localhost:9093
# Click the alert, then "Silence alert"
# Set duration (1 hour, 1 day, etc.)
```

**Method 2 - Grafana UI:**
- See alert in Grafana dashboard (if alert panel added)
- Click alert → "Acknowledge"

See [`OPERATIONS_QUICK_START.md#silence-a-noisy-alert`](OPERATIONS_QUICK_START.md) for step-by-step guide.

---

### Q: What's the difference between silencing and acknowledging?

**A:** 
| Action | Effect | Duration | When |
|--------|--------|----------|------|
| **Silence** | Stops notifications (Slack, PagerDuty) for this alert | 1 hour-∞ | Known false positive, planned maintenance |
| **Acknowledge** | Marks you're investigating (in AlertManager UI) | Until resolved | You're working on it, alert still fires |

**Example:** You silence a "low disk" alert while you expand storage (silence 2 hours). You acknowledge a "high CPU" alert while investigating (acknowledge until fixed).

---

### Q: Why am I getting alerts for the same issue?

**A:** Likely not grouped properly. AlertManager should group similar alerts:
- **Correctly grouped:** 5 "NodeHighCPU" alerts → 1 notification "Grouped: 5 alerts"
- **Not grouped:** 5 separate notifications

**Fix:** Check AlertManager config grouping:
```bash
kubectl get configmap alertmanager-config -n monitoring -o yaml | grep -A 5 "group_by"
```

See [`RUNBOOK_OPERATIONS.md#alert-grouping`](RUNBOOK_OPERATIONS.md) for details.

---

### Q: Can I change alert thresholds?

**A:** Yes! Edit the PrometheusRule:
```bash
kubectl edit prometheusrule -n monitoring
# Find the alert (e.g., HighLatency)
# Change threshold value
# Save
# Prometheus evaluates within 15 seconds
```

**Example:**
```yaml
- alert: HighLatency
  expr: histogram_quantile(0.95, router_latency_ms) > 1000  # 1000ms threshold
  for: 5m  # fire only if true for 5 minutes
  annotations:
    summary: "P95 latency exceeded 1000ms"
```

**Caution:** Be careful changing thresholds:
- Too low = false positives (noisy alerts)
- Too high = miss real issues

Tune based on operational experience. See [`RUNBOOK_OPERATIONS.md#alert-tuning`](RUNBOOK_OPERATIONS.md) for guidance.

---

### Q: How do I create a custom alert?

**A:** Create a PrometheusRule with your PromQL:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: custom-alerts
  namespace: monitoring
spec:
  groups:
  - name: custom
    rules:
    - alert: MyCustomAlert
      expr: my_metric > 100
      for: 5m
      annotations:
        summary: "My custom alert fired"
        description: "Value is {{ $value }}"
```

Apply with `kubectl apply -f rule.yaml` and Prometheus will evaluate it within 15 seconds.

See [`prometheus/README.md#custom-alerts`](prometheus/README.md) for more examples.

---

### Q: What happens if AlertManager is down?

**A:** Alerts fire in Prometheus (you can check UI), but notifications aren't sent. Operations team won't know unless they check Prometheus UI directly.

**Mitigation:**
- AlertManager runs as 2+ replicas (one can fail)
- If both fail, escalate immediately
- See [`META_MONITORING.md`](META_MONITORING.md) for alerting on AlertManager failure

---

## Log Questions

### Q: How do I view logs for my pod?

**A:** Two ways:

**Method 1 - Kubectl (raw logs):**
```bash
kubectl logs <pod-name> -n <namespace>
```

**Method 2 - Grafana Loki (searchable, JSON parsed):**
```bash
kubectl port-forward svc/grafana 3000:3000 -n monitoring
# Visit http://localhost:3000
# Click "Explore"
# Select "Loki" datasource
# Query: {pod="<pod-name>"}
```

Grafana is better for searching across many logs, kubectl is faster for single pod.

---

### Q: How long are logs retained?

**A:** **30 days** - logs older than 30 days are automatically deleted.

**Why 30 days?**
- Balances storage cost (~150GB) with historical debugging window
- Most issues resolved within 7 days, few need 30-day history
- Longer retention possible at higher cost

**If you need specific logs beyond 30 days:** Archive them manually or implement S3 archival (future enhancement).

---

### Q: How do I search logs?

**A:** Use LogQL in Grafana Explore:
```
# Basic: logs from namespace
{namespace="default"}

# Advanced: multiple filters
{namespace="production", level="ERROR", service="router"}

# Text search (slow on large datasets)
{job="promtail"} |= "timeout"

# Regex
{job="promtail"} |= "error_code=5\\d\\d"

# JSON parsing
{job="promtail"} | json | http_status >= 500
```

See [`loki/README.md#logql-examples`](loki/README.md) for more query examples.

---

### Q: Why can't I see logs from my pod?

**A:** Likely causes:
1. **Pod in wrong namespace:** Promtail scrapes all pods, but query filters by namespace
2. **Logs not to STDOUT:** Logs to files (not container STDOUT) won't be captured
3. **Loki down:** Check `kubectl get pod loki -n monitoring`
4. **Ingestion lag:** Logs take <30 seconds to appear after emission

**Debug steps:**
```bash
# 1. Check pod logs go to STDOUT
kubectl logs <pod> -n <namespace>

# 2. Check Loki has logs from that pod
# Grafana → Explore → Loki → query {pod="<pod-name>"}

# 3. Check Promtail DaemonSet running
kubectl get daemonset promtail -n monitoring
```

See [`loki/README.md#troubleshooting`](loki/README.md) for more help.

---

## High Availability Questions

### Q: What happens if a pod crashes?

**A:** Kubernetes automatically restarts it:
1. Pod crashes
2. Kubelet detects (within seconds)
3. New pod created
4. Pod joins the cluster and resumes work

**For services with multiple replicas:**
- If 1 of 3 replicas crashes: 2 replicas handle full traffic
- If 2 of 3 crash: 1 replica handles full traffic (degraded)
- If all 3 crash: Service down (alerts fire)

See [`ARCHITECTURE_SUMMARY.md#failover-behavior`](ARCHITECTURE_SUMMARY.md) for failover times.

---

### Q: What if storage fails?

**A:** EFS (AWS Elastic File System) is highly available:
- Multi-AZ replicated (fails over automatically)
- Automatic backups (daily snapshots)

**If EFS becomes unavailable (rare):**
1. All pods fail to mount storage
2. Services fail to start
3. Immediate escalation (SEV 1)
4. Restore from latest snapshot (ETA 30-60 min)

See [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) for recovery procedures.

---

### Q: Can I drain a node without losing data?

**A:** Yes! Kubernetes handles graceful evacuation:
```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

**What happens:**
1. Kubelet stops accepting new pods on the node
2. Existing pods gracefully shut down (30s default)
3. Pods restart on other nodes (using shared storage)
4. No data loss (if using persistent volumes)

See [`DISASTER_RECOVERY.md#node-failure`](DISASTER_RECOVERY.md) for details.

---

## Scaling Questions

### Q: How do I scale components up?

**A:** Use kubectl scale:
```bash
# Scale to 4 replicas
kubectl scale deployment prometheus --replicas=4 -n monitoring

# Check new pods starting
kubectl get pods -n monitoring -w
```

**Typical scaling scenarios:**
- **More load:** Increase replicas (up to one per node for pod anti-affinity)
- **More storage:** Increase PVC size (requires downtime currently)
- **Better performance:** Add recording rules (pre-calculated metrics)

---

### Q: When should I scale up?

**A:** Scale up when:
- **Storage >85% full:** Reduce retention or expand PVC
- **High CPU load:** Increase replicas or increase per-replica limits
- **High memory load:** Increase memory requests/limits
- **Network bottleneck:** Add network policies, enable compression

Check metrics in Grafana Infrastructure Health dashboard.

---

### Q: How do I expand PVC storage?

**A:** PVC expansion is done via kubectl patch:
```bash
# Check current size
kubectl get pvc prometheus-kube-prom-prometheus -n monitoring

# Expand by 50GB (if StorageClass supports expansion)
kubectl patch pvc prometheus-kube-prom-prometheus -n monitoring -p '{"spec":{"resources":{"requests":{"storage":"150Gi"}}}}'

# Verify
kubectl get pvc -n monitoring
```

**Note:** Some storage classes don't support online expansion (requires downtime).

See [`MAINTENANCE.md#pvc-expansion`](MAINTENANCE.md) for detailed steps.

---

## Backup & Disaster Recovery

### Q: How are backups taken?

**A:** Daily EFS snapshots:
- **Frequency:** Once per day (automatic)
- **Retention:** 7-day rolling window (oldest deleted daily)
- **Coverage:** Prometheus, Loki, Grafana data all included
- **RTO:** <1 hour to restore to new PVC

See [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) for details.

---

### Q: Can I restore to a specific point in time?

**A:** Partially:
- **Prometheus:** Restore from snapshot gets you all data up to snapshot time
- **Loki:** Same (all logs up to snapshot time)
- **Point-in-time restore:** Not supported (would need database transaction logs)

**Typical recovery:** "Restore from yesterday's snapshot" → lose <24 hours of data.

---

### Q: How do I restore from a backup?

**A:** See detailed procedures in [`DISASTER_RECOVERY.md#restore-procedures`](DISASTER_RECOVERY.md):
1. Identify snapshot to restore
2. Create new PVC from snapshot
3. Mount PVC to new pod
4. Verify data integrity
5. Switch services to new PVC

**Time:** ~30-60 minutes for full recovery.

---

## Upgrade & Maintenance Questions

### Q: How are components upgraded?

**A:** Via Helm chart updates:
1. Test upgrade in staging cluster
2. Run `helm upgrade openclaw-observability` with new version
3. Rolling restart (each pod restarted one at a time)
4. Zero downtime (other replicas serve traffic)

See [`MAINTENANCE.md#upgrading`](MAINTENANCE.md) for detailed procedures.

---

### Q: Do upgrades cause downtime?

**A:** No! Kubernetes does rolling updates:
1. New pod version started (old pod still running)
2. Traffic gradually shifted to new pod
3. Old pod gracefully shut down
4. Repeat for each replica

**Effect:** No user-visible downtime (other replicas absorb traffic).

---

### Q: How often are security patches applied?

**A:** Typically:
- **Critical:** ASAP (within 24 hours)
- **High:** Monthly security patch day
- **Medium/Low:** Quarterly or with other updates

See [`MAINTENANCE.md`](MAINTENANCE.md) for patch schedule.

---

## Cost Optimization Questions

### Q: How can I reduce costs?

**A:** Several options:
1. **Reduce retention:** 15→7 days (saves ~30% storage)
2. **Log sampling:** Only keep 10% of logs (future feature)
3. **Move to S3:** S3 cheaper than EFS for long-term storage (future)
4. **Consolidate clusters:** Shared monitoring across clusters (future)

Current cost: $351/month. With optimizations: could reduce to $200-250/month.

See [`COST_OPTIMIZATION.md`](COST_OPTIMIZATION.md) for detailed analysis.

---

### Q: Is there a way to reduce alert fatigue?

**A:** Yes:
1. **Tune thresholds:** Too low = false positives
2. **Add alert grouping:** Combine similar alerts
3. **Set alert severity:** Only page on critical
4. **Inhibition rules:** Parent alert suppresses child alerts

See [`RUNBOOK_OPERATIONS.md#alert-tuning`](RUNBOOK_OPERATIONS.md) for guidance.

---

## Troubleshooting Questions

### Q: Alerts aren't firing - what's wrong?

**A:** Systematic debugging:
1. **Check Prometheus:** Visit http://localhost:9090/targets → any down?
2. **Check alert rules:** http://localhost:9090/rules → any errors?
3. **Check AlertManager:** http://localhost:9093 → receiving alerts?
4. **Check Slack webhook:** Is it configured and valid?

See [`TROUBLESHOOTING_QUICK_REF.md#alerts`](TROUBLESHOOTING_QUICK_REF.md) for detailed troubleshooting.

---

### Q: Dashboards are slow - what do I do?

**A:**
1. **Identify slow panel:** Edit dashboard, hover over panel, check query
2. **Test query in Prometheus:** Run query directly, check latency
3. **Optimize:**
   - Reduce time range (30d → 7d)
   - Add recording rule (pre-calculate expensive queries)
   - Use aggregation (average instead of raw data)
4. **Restart Prometheus:** Clear cache if still slow

See [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md) for optimization guide.

---

### Q: I can't find the answer - where do I go?

**A:** Check these in order:
1. **This file:** [`FAQ.md`](FAQ.md) (you're reading it!)
2. **Quick reference:** [`TROUBLESHOOTING_QUICK_REF.md`](TROUBLESHOOTING_QUICK_REF.md)
3. **Component README:** [`prometheus/README.md`](prometheus/README.md), [`grafana/README.md`](grafana/README.md), etc.
4. **Operations runbook:** [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)
5. **Ask team:** Post in #monitoring-team Slack channel

---

## Document Links

- **Architecture overview:** [`ARCHITECTURE_SUMMARY.md`](ARCHITECTURE_SUMMARY.md)
- **Quick start guide:** [`OPERATIONS_QUICK_START.md`](OPERATIONS_QUICK_START.md)
- **Troubleshooting:** [`TROUBLESHOOTING_QUICK_REF.md`](TROUBLESHOOTING_QUICK_REF.md)
- **Runbooks:** [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)
- **Disaster recovery:** [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)
- **Performance tuning:** [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md)
- **Maintenance:** [`MAINTENANCE.md`](MAINTENANCE.md)
- **Cost optimization:** [`COST_OPTIMIZATION.md`](COST_OPTIMIZATION.md)

---

**Last updated:** ________________  
**Next review:** ________________  
**Maintainer:** ________________
