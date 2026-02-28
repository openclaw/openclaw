# Troubleshooting Quick Reference

**For:** Operations team needing fast solutions  
**Use:** Find your symptom, follow fix, escalate if needed  
**Version:** 1.0  

---

## 🔴 CRITICAL Issues (Immediate Action)

### No Metrics in Prometheus

**Symptom:** Prometheus dashboard shows "No Data", graphs empty, 0 targets  
**Impact:** Alerts won't fire, dashboards blank - **SEV 1**

**Quick Diagnosis (2 min):**
```bash
# Check Prometheus pod
kubectl get pod prometheus-kube-prom-prometheus-0 -n monitoring
# Expected: Running

# Check targets
kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring
# Visit: http://localhost:9090/targets
# Look for: Red "DOWN" targets with error messages

# Check scrape config
kubectl get prometheus -n monitoring -o yaml | grep -A 20 "scrapeInterval"
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Pod crashed | `kubectl logs prometheus-0 -n monitoring` → check error | 2 min |
| ServiceMonitor wrong | Verify label match: `kubectl get servicemonitor -n monitoring` | 3 min |
| Network policy blocking | Check: `kubectl get networkpolicy -n monitoring` | 3 min |
| Storage full | Check: `kubectl exec prometheus-0 -c prometheus -n monitoring -- df -h` | 2 min |
| TSDB corrupted | Restart: `kubectl delete pvc prometheus-kube-prom-prometheus -n monitoring` | 5 min |

**If still broken after 5 min:** Escalate to engineering (runbook: `prometheus/README.md#troubleshooting`)

---

### No Alerts Reaching Slack

**Symptom:** Alert fires in Prometheus/AlertManager but Slack message not sent  
**Impact:** Operations team unaware of issues - **SEV 1**

**Quick Diagnosis (2 min):**
```bash
# Check AlertManager pod
kubectl get pod alertmanager-0 -n monitoring
# Expected: Running

# Check webhook secret
kubectl get secret alertmanager-slack-webhook -n monitoring
# Expected: exists

# Check AlertManager logs
kubectl logs alertmanager-0 -n monitoring | tail -50
# Look for: "error", "failed", "timeout"
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Webhook URL wrong/expired | Update secret: See `alertmanager/README.md#slack-setup` | 5 min |
| Network policy blocks egress | Check: `kubectl get networkpolicy -n monitoring` | 3 min |
| Slack API down | Check Slack status page, wait | 1 min |
| AlertManager pod down | `kubectl rollout restart deployment/alertmanager -n monitoring` | 3 min |
| Alert rule not configured | Verify rule exists: `kubectl get prometheusrule -n monitoring` | 2 min |

**If still broken after 5 min:** Escalate to engineering (runbook: `alertmanager/README.md#troubleshooting`)

---

### Grafana Dashboard Timing Out

**Symptom:** Grafana loads but panels take >30s or show "Error loading data"  
**Impact:** Ops can't see dashboards to investigate issues - **SEV 1**

**Quick Diagnosis (2 min):**
```bash
# Check Grafana pod
kubectl get pod grafana-0 -n monitoring
# Expected: Running

# Check Prometheus connectivity
kubectl exec grafana-0 -n monitoring -- curl -s http://prometheus-kube-prom-prometheus:9090/-/healthy
# Expected: 200 OK response

# Check dashboard query performance
# Visit Prometheus UI → Graph → test query directly
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Prometheus slow | Reduce query time range or optimize query | 5 min |
| Grafana OOM | Check: `kubectl describe pod grafana-0 -n monitoring` | 2 min |
| Network latency | Check: `kubectl exec grafana-0 -n monitoring -- ping prometheus` | 2 min |
| Dashboard too many panels | Remove unused panels or split into multiple dashboards | 10 min |
| Data source misconfigured | Check: Grafana → Configuration → Data Sources | 3 min |

**If still broken after 5 min:** Restart Grafana: `kubectl rollout restart deployment/grafana -n monitoring`

---

## 🟠 HIGH Priority Issues (Within 30 min)

### No Logs Visible in Loki

**Symptom:** Grafana Explore shows "No logs", LogQL queries return empty  
**Impact:** Can't investigate container errors - **SEV 2**

**Quick Diagnosis (3 min):**
```bash
# Check Promtail DaemonSet
kubectl get daemonset promtail -n monitoring
# Expected: Desired, Current, Ready should be equal

# Check Promtail logs
kubectl logs -n monitoring -l app=promtail | tail -20
# Look for: errors, permission denied, no targets

# Check Loki pod
kubectl get pod loki-0 -n monitoring
# Expected: Running
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Promtail pod down | `kubectl rollout restart daemonset promtail -n monitoring` | 3 min |
| File permissions wrong | Verify `/var/log/containers` readable: `kubectl exec promtail-XXX -n monitoring -- ls -la /var/log/containers` | 2 min |
| Loki storage full | Check PVC: `kubectl get pvc loki-storage -n monitoring` | 2 min |
| Log format wrong | Check JSON parsing: See `loki/README.md#log-parsing` | 5 min |
| Network policy blocks | Check: `kubectl get networkpolicy -n monitoring` | 3 min |

**If still broken:** See `loki/README.md#troubleshooting`

---

### PVC Storage Nearly Full (>85%)

**Symptom:** Kubectl describe pvc shows usage near limit, disk space warning  
**Impact:** If reaches 100%, new metrics/logs lost - **SEV 2**

**Quick Diagnosis (2 min):**
```bash
# Check all PVCs
kubectl get pvc -n monitoring

# Check usage estimate
kubectl exec -it <pod> -n monitoring -- du -sh /path/to/mount

# Check retention settings
kubectl get prometheus -n monitoring -o yaml | grep retention
kubectl get loki configmap loki-config -n monitoring -o yaml | grep retention_period
```

**Quick Fixes (pick one):**

| Fix | Time | Impact |
|-----|------|--------|
| **Reduce retention:** Prometheus 15→7 days | 5 min | Lose 8 days history |
| **Reduce retention:** Loki 30→14 days | 5 min | Lose 16 days history |
| **Expand PVC:** +50GB storage | 15 min | Increase costs ~$25/month |
| **Archive to S3:** (future feature) | N/A | Keep full history cheaper |

**Example - Reduce Prometheus retention:**
```bash
kubectl patch prometheus prometheus-kube-prom-prometheus -n monitoring \
  --type merge \
  -p '{"spec":{"retention":"168h"}}'  # 7 days instead of 15
```

**Monitor growth:** Check again in 24 hours to see if reducing retention helped

---

### Alerts Going to Wrong Channel

**Symptom:** Critical alerts going to #monitoring-alerts instead of #critical-alerts or PagerDuty  
**Impact:** Wrong team doesn't know about critical issues - **SEV 2**

**Quick Diagnosis (3 min):**
```bash
# Check AlertManager config
kubectl get configmap alertmanager-config -n monitoring -o yaml | grep -A 30 "routes:"

# Check alert labels (which route applies?)
# Prometheus UI → Alerts → click alert → see labels
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Route rule wrong | Edit: `kubectl edit configmap alertmanager-config -n monitoring` | 5 min |
| Alert label wrong | Check: Rule should add label `severity: critical` | 3 min |
| Slack config wrong | Verify webhook in different channel | 3 min |
| PagerDuty key expired | Update secret: `alertmanager/README.md#pagerduty-setup` | 3 min |

**Test routing:**
1. Trigger a test alert
2. Check AlertManager UI: http://localhost:9093
3. Verify it routes to expected channel
4. Document if routing correct

---

## 🟡 MEDIUM Priority Issues (Within 4 hours)

### High Query Latency (>2 seconds)

**Symptom:** Prometheus queries slow, dashboard panels take >5 seconds to render  
**Impact:** Slow troubleshooting, poor user experience  

**Quick Diagnosis (3 min):**
```bash
# Test simple query
kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring
# Visit: http://localhost:9090
# Enter metric: router_requests_total
# Check response time in browser DevTools

# Test complex query
# Try: rate(router_requests_total[5m]) / rate(router_requests_total[5m] offset 1h)
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Large time range | Reduce range: 30d → 7d, 7d → 24h | 2 min |
| Expensive query (no index) | Add recording rule: See `prometheus/README.md#recording-rules` | 20 min |
| Prometheus underpowered | Increase replicas or CPU limit | 10 min |
| Network latency | Check cluster network health | 5 min |
| TSDB fragmentation | Restart Prometheus (rolling): `kubectl rollout restart` | 5 min |

**Optimization steps:**
1. Check if query needs range (can use point query?)
2. Check if query uses recording rule (pre-calculated metrics)
3. If neither, consider adding recording rule for expensive queries

---

### Pod Restart Loop

**Symptom:** Pod keeps restarting (RestartCount increasing), status Pending/CrashLoopBackOff  
**Impact:** Service degraded (reduced capacity), potential outage if all pods fail

**Quick Diagnosis (2 min):**
```bash
# Check pod status
kubectl get pod <pod-name> -n monitoring -o wide

# Check logs
kubectl logs <pod-name> -n monitoring
# or for previous restart:
kubectl logs <pod-name> -n monitoring --previous

# Check events
kubectl describe pod <pod-name> -n monitoring | tail -20
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| OOM (out of memory) | Increase memory limit in values.yaml | 10 min |
| Liveness probe failing | Check probe config: `kubectl describe pod` | 5 min |
| Storage mount failing | Check PVC status: `kubectl get pvc -n monitoring` | 3 min |
| Config invalid | Check configmap: `kubectl get configmap -n monitoring` | 5 min |
| Image pull failing | Check image: `kubectl get pod <pod> -n monitoring -o yaml` | 5 min |

**Immediate action if all pods failing:**
```bash
# Scale up replacement pod
kubectl scale deployment <component> --replicas=1 -n monitoring
# Investigate root cause in logs
# Fix issue
# Scale back up
```

---

### Certificate Expiration Soon

**Symptom:** Certificate expires in <7 days, warning in logs  
**Impact:** TLS connections will fail after expiration date

**Quick Diagnosis (2 min):**
```bash
# Check certificates
kubectl get certificate -n monitoring

# Check specific cert
kubectl describe certificate <cert-name> -n monitoring | grep -i expir

# Manual check via openssl (if using ingress)
openssl s_client -connect grafana.your-domain.com:443 | grep -i dates
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Auto-renewal disabled | Enable: `kubectl get certificate -n monitoring -o yaml` | 5 min |
| cert-manager not running | Check: `kubectl get pod -n cert-manager` | 3 min |
| Certificate issuer down | Check issuer status: `kubectl describe issuer -n monitoring` | 3 min |
| Manual certificate expiring | Renew: Use cert-manager to auto-renew | 10 min |

**Prevent future incidents:**
- Set cert-manager to auto-renew at 30 days before expiry
- Monitor certificate expiry metric daily

---

## 🟢 LOW Priority Issues (Can wait, schedule fix)

### Dashboard Panel Showing Wrong Data

**Symptom:** Panel shows unexpected values, metric looks incorrect, data seems stale  
**Impact:** Visibility issue, might not reflect actual state

**Quick Diagnosis (3 min):**
```bash
# Verify metric directly
kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring
# Visit: http://localhost:9090
# Query same metric the panel uses
# Compare values

# Check panel query
# Grafana → Dashboard → Edit panel → inspect query
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Stale cache | Refresh panel: Press F5 or refresh button | 1 min |
| Wrong query | Check panel query against Prometheus | 5 min |
| Wrong time range | Check dashboard time range selector | 2 min |
| Metric label mismatch | Verify query filter labels exist | 5 min |
| Data retention expired | Data >15 days old (Prometheus) won't exist | N/A |

**Note:** If metric truly missing, check if data exists:
```bash
# At Prometheus UI, query: {__name__="router_requests_total"}
# Should return all instances
```

---

### Slow Log Ingestion

**Symptom:** Logs take >1 minute to appear in Grafana after emission  
**Impact:** Delayed troubleshooting, stale logs visible

**Quick Diagnosis (3 min):**
```bash
# Check Promtail queue
kubectl logs -n monitoring -l app=promtail | grep -i "queue\|backlog"

# Check Loki ingestion rate
kubectl port-forward svc/loki 3100:3100 -n monitoring
# Query: rate(loki_distributor_bytes_received_total[5m])

# Check network latency
kubectl exec loki-0 -n monitoring -- ping promtail-node1 -c 3
```

**Common Causes & Fixes:**

| Cause | Fix | Time |
|-------|-----|------|
| Network latency | Check cluster network | 5 min |
| Loki overloaded | Scale up replicas | 10 min |
| Large log volume | Implement log sampling (future) | N/A |
| Slow disks | Check I/O performance | 10 min |

---

### Grafana Admin Password Forgotten

**Symptom:** Can't log in to Grafana, password lost or reset needed  
**Impact:** Can't access dashboards, need to reset

**Quick Diagnosis (1 min):**
```bash
# Password is in Kubernetes secret
kubectl get secret grafana-admin-password -n monitoring -o jsonpath='{.data.password}' | base64 -d
```

**Fix (2 min):**
```bash
# Login credentials are in secret
# Default user: admin
# Default password: (from above secret)
# On first login, Grafana will prompt to change password
```

**If secret missing:**
```bash
# Regenerate admin secret
kubectl create secret generic grafana-admin-password --from-literal=password=newpassword -n monitoring --dry-run=client -o yaml | kubectl apply -f -

# Restart Grafana to pick up new password
kubectl rollout restart deployment/grafana -n monitoring
```

---

## 📋 Escalation Path

**If issue not resolved in allotted time, escalate:**

| Issue | Time Limit | Escalate To | Info Needed |
|-------|-----------|------------|-------------|
| Critical (SEV 1) | 5 min | Engineering on-call | Logs, kubectl describe, symptoms |
| High (SEV 2) | 30 min | Engineering lead | Same as above |
| Medium (SEV 3) | 4 hours | Team Slack | Screenshots, reproduction steps |
| Low (SEV 4) | Next day | Backlog | Description, when noticed |

**Escalation Contact:**
- Engineering on-call: ________________ (Phone: ____________)
- Engineering lead: ________________ (Slack: ____________)
- Team channel: #monitoring-team (Slack)

---

## 🛠️ Troubleshooting Toolkit

**Essential commands (bookmark/alias these):**

```bash
# Monitoring pods
alias mon-pods='kubectl get pods -n monitoring -o wide'
alias mon-logs='kubectl logs -n monitoring'
alias mon-events='kubectl get events -n monitoring --sort-by=".lastTimestamp" | tail -20'

# Port forwards (run in background)
alias prom='kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring &'
alias grafana='kubectl port-forward svc/grafana 3000:3000 -n monitoring &'
alias alert='kubectl port-forward svc/alertmanager 9093:9093 -n monitoring &'
alias loki='kubectl port-forward svc/loki 3100:3100 -n monitoring &'

# Health checks
alias mon-health='kubectl get all -n monitoring'
alias mon-pvc='kubectl get pvc -n monitoring'
alias mon-secrets='kubectl get secrets -n monitoring'
```

**Common one-liners:**
```bash
# Check all pod statuses (green/red)
kubectl get pods -n monitoring --no-headers | awk '{print $1, $3}'

# Tail all monitoring logs
kubectl logs -n monitoring -l app=prometheus -f

# Watch pod count
watch 'kubectl get pods -n monitoring | wc -l'

# Check PVC capacity
kubectl get pvc -n monitoring -o custom-columns=NAME:.metadata.name,SIZE:.spec.resources.requests.storage

# List all alerts
kubectl get prometheusrule -n monitoring -o custom-columns=NAME:.metadata.name,ALERTS:.spec.groups[0].rules[*].alert
```

---

## 📚 Full Documentation References

- **Prometheus troubleshooting:** [`prometheus/README.md#troubleshooting`](prometheus/README.md)
- **Grafana troubleshooting:** [`grafana/README.md#troubleshooting`](grafana/README.md)
- **Loki troubleshooting:** [`loki/README.md#troubleshooting`](loki/README.md)
- **AlertManager troubleshooting:** [`alertmanager/README.md#troubleshooting`](alertmanager/README.md)
- **Performance tuning:** [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md)
- **Disaster recovery:** [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)
- **Full runbooks:** [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)

---

**Keep this guide bookmarked for quick reference!**
