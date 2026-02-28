# Final Verification Checklist - Observability Stack Deployment

**Date:** ________________  
**Verified by:** ________________  
**Environment:** Staging ☐ | Production ☐  

---

## Architecture Verification

### Prometheus Configuration
- [ ] **Replicas**: 2 replicas (staging) / 3 replicas (production) deployed
  - Check: `kubectl get deployment prometheus-kube-prom-prometheus -n monitoring`
  - Verify: All pods are Running and Ready (2/2 or 3/3)

- [ ] **Storage**: 100GB EFS PVC allocated
  - Check: `kubectl get pvc prometheus-kube-prom-prometheus -n monitoring`
  - Verify: Status is Bound, capacity is 100Gi

- [ ] **Retention Policy**: 15-day retention configured
  - Check: `kubectl get prometheus -n monitoring -o yaml | grep retention`
  - Verify: Value is "360h" (15 days)

- [ ] **Pod Anti-Affinity**: Each replica on different node
  - Check: `kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus -o wide`
  - Verify: Different nodes in NODE column

- [ ] **Resource Limits**: CPU/memory requests/limits configured
  - Check: `kubectl describe pod prometheus-kube-prom-prometheus-0 -n monitoring | grep -A 5 "Limits"`
  - Verify: CPU limit 2000m, memory limit 4Gi

### Grafana Configuration
- [ ] **Replicas**: 2 replicas deployed
  - Check: `kubectl get deployment grafana -n monitoring`
  - Verify: All pods are Running and Ready (2/2)

- [ ] **Storage**: 10GB PVC for dashboards/config
  - Check: `kubectl get pvc grafana-storage -n monitoring`
  - Verify: Status is Bound, capacity is 10Gi

- [ ] **Datasources**: Prometheus and Loki datasources configured
  - Check: Grafana UI → Configuration → Data Sources
  - Verify: Both datasources show "Green/OK" status

- [ ] **Operational Dashboards**: All 3 dashboards present and accessible
  - [ ] Router Health Overview (real-time metrics)
  - [ ] Performance Details (latency, errors, resources)
  - [ ] Infrastructure Health (nodes, PVC, certs)
  - Check: Grafana UI → Dashboards → Browse
  - Verify: All 3 dashboards listed and load without errors

- [ ] **Dashboard Auto-Refresh**: Set to 15-30 second intervals
  - Check: Each dashboard → refresh settings
  - Verify: Auto-refresh enabled at appropriate interval

### Loki Configuration
- [ ] **Replicas**: 2 replicas (staging) / 3 replicas (production)
  - Check: `kubectl get deployment loki -n monitoring`
  - Verify: All pods are Running and Ready

- [ ] **Storage**: 150GB EFS PVC for log storage
  - Check: `kubectl get pvc loki-storage -n monitoring`
  - Verify: Status is Bound, capacity is 150Gi

- [ ] **Retention Policy**: 30-day retention configured
  - Check: `kubectl get configmap loki-config -n monitoring -o yaml | grep retention_period`
  - Verify: Value is 720h (30 days)

- [ ] **Promtail DaemonSet**: Running on all nodes
  - Check: `kubectl get daemonset promtail -n monitoring`
  - Verify: Desired, Current, Ready all match node count

- [ ] **Log Parsing**: JSON parsing enabled for structured logs
  - Check: `kubectl get configmap loki-config -n monitoring -o yaml | grep -i "json"`
  - Verify: JSON parser configured

### AlertManager Configuration
- [ ] **Replicas**: 2 replicas deployed
  - Check: `kubectl get deployment alertmanager -n monitoring`
  - Verify: All pods are Running and Ready (2/2)

- [ ] **Slack Integration**: Webhook URL configured and encrypted
  - Check: `kubectl get secret alertmanager-slack-webhook -n monitoring`
  - Verify: Secret exists with webhook key

- [ ] **PagerDuty Integration** (production only)
  - Check: `kubectl get secret alertmanager-pagerduty -n monitoring` (if prod)
  - Verify: Secret exists with service key

- [ ] **Alert Routing**: Rules configured for severity-based routing
  - Check: `kubectl get configmap alertmanager-config -n monitoring -o yaml | grep -A 10 "routes:"`
  - Verify: Routes present for warning, critical, prod-only rules

- [ ] **Grouping Configuration**: Alert grouping enabled
  - Check: Config shows group_by, group_wait, group_interval settings
  - Verify: Reasonable values (e.g., 5m wait, 5m interval)

### High Availability Setup
- [ ] **Pod Anti-Affinity Rules**: All components use pod anti-affinity
  - Check: Each deployment/statefulset YAML has `podAntiAffinity`
  - Verify: `preferredDuringSchedulingIgnoredDuringExecution` configured for all

- [ ] **Pod Disruption Budgets**: Created for all components
  - Check: `kubectl get pdb -n monitoring`
  - Verify: minAvailable=1 for each component

- [ ] **Shared Storage (EFS)**: All components use ReadWriteMany access
  - Check: `kubectl get pvc -n monitoring`
  - Verify: All PVCs have accessMode: ReadWriteMany

- [ ] **Service Mesh / Load Balancing**: Services properly configured
  - Check: `kubectl get svc -n monitoring`
  - Verify: All services present and endpoints populated

### Security Configuration
- [ ] **RBAC**: Service accounts with minimal permissions
  - Check: `kubectl get serviceaccount -n monitoring`
  - Verify: One per component with appropriate roles

- [ ] **Network Policies**: Ingress/egress rules configured
  - Check: `kubectl get networkpolicy -n monitoring`
  - Verify: Policies restrict traffic appropriately

- [ ] **Secrets Management**: All credentials in Kubernetes secrets
  - Check: `kubectl get secrets -n monitoring`
  - Verify: Slack webhook, PagerDuty key, etc. are secrets (not ConfigMaps)

- [ ] **TLS Certificates**: Valid and auto-renewing
  - Check: `kubectl get certificate -n monitoring` (if using cert-manager)
  - Verify: All certificates show READY=True

---

## Metrics Verification

### Prometheus Target Collection
- [ ] **50+ targets scraping successfully**
  - Check: `kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090 -n monitoring`
  - Visit: http://localhost:9090/targets
  - Verify: Target count shows 50+ active targets with 0 errors

- [ ] **Router Metrics**: Service monitor correctly targeting router pods
  - Check: http://localhost:9090/targets → search for "router"
  - Verify: All router pods appear as targets with UP status

- [ ] **Kubernetes Metrics**: Node metrics, kubelet metrics collected
  - Check: http://localhost:9090/targets → search for "node" or "kubelet"
  - Verify: All nodes appear as targets with UP status

- [ ] **No Scrape Errors**: All targets reporting successfully
  - Check: http://localhost:9090/targets → look for red "DOWN" targets
  - Verify: No targets in DOWN state

### Custom Metrics Available
- [ ] **Router Latency Metrics**: `router_request_latency_ms` (p50, p95, p99)
  - Check: http://localhost:9090/graph → query `router_request_latency_ms`
  - Verify: Metric returns data for all percentiles

- [ ] **Router Throughput**: `router_requests_total` counter
  - Check: Query `router_requests_total` → should show increasing values
  - Verify: Data points increasing over time

- [ ] **Router Error Rate**: `router_requests_failed_total` counter
  - Check: Query `router_requests_failed_total`
  - Verify: Metric present and tracked

- [ ] **Router Availability**: `router_availability_percent` gauge
  - Check: Query `router_availability_percent`
  - Verify: Shows value between 0-100

- [ ] **Infrastructure Metrics**: CPU, memory, disk, network per node
  - Check: Queries like `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, etc.
  - Verify: All node metrics present and updating

- [ ] **PVC Utilization**: `kubelet_volume_stats_used_bytes`
  - Check: Query `kubelet_volume_stats_used_bytes{persistentvolumeclaim=~"prometheus|loki|grafana"}`
  - Verify: Shows current usage for each component's PVC

### Recording Rules
- [ ] **Latency Recording Rules**: p50/p95/p99 pre-calculated
  - Check: `kubectl get prometheusrule -n monitoring`
  - Verify: Rule group includes latency percentile rules

- [ ] **Error Rate Rules**: Error rate per service pre-calculated
  - Check: PrometheusRule shows `rate(requests_failed_total[5m])`
  - Verify: Recording rules exist for common time windows

- [ ] **Availability Rules**: Service availability percentage
  - Check: Recording rules show availability calculations
  - Verify: Rules use `up` metric to calculate percentage

- [ ] **Rules All Healthy**: No evaluation errors
  - Check: `kubectl port-forward svc/prometheus-kube-prom-prometheus 9090:9090`
  - Visit: http://localhost:9090/rules
  - Verify: All rules show green status, no errors

### Alert Rules
- [ ] **10+ Alert Rules Configured**:
  - [ ] HighLatencyAlert (p95 > 1000ms)
  - [ ] HighErrorRateAlert (>5% errors)
  - [ ] LowAvailabilityAlert (<99.5% availability)
  - [ ] PVCAlmostFullAlert (>85% used)
  - [ ] PrometheusTargetDownAlert
  - [ ] LokiTargetDownAlert
  - [ ] GrafanaDownAlert
  - [ ] AlertManagerDownAlert
  - [ ] NodeMemoryPressureAlert
  - [ ] NodeDiskPressureAlert
  - Check: `kubectl get prometheusrule -n monitoring -o yaml | grep alert:`
  - Verify: All alert rules present

- [ ] **Alert Evaluation**: Rules evaluating without errors
  - Check: http://localhost:9090/alerts
  - Verify: Rules shown with evaluation counts, no errors

---

## Dashboard Verification

### Router Health Overview Dashboard
- [ ] **Page Loads**: Loads in <5 seconds
  - Action: Open Grafana → Dashboards → Router Health Overview
  - Measure: Page load time
  - Verify: Complete render in <5s

- [ ] **Real-Time Data**: All panels showing current data
  - Check: Each panel's title and metrics
  - Verify: Data points current (within last 30s)

- [ ] **All Panels Functional**:
  - [ ] Router Request Rate (graph)
  - [ ] P95 Latency (gauge)
  - [ ] Error Rate (percentage)
  - [ ] Availability % (stat)
  - [ ] Top Errors (table)
  - [ ] Request Distribution (pie chart)
  - Check: Each panel renders without errors
  - Verify: No "Error loading data" messages

- [ ] **Graph Zoom/Pan**: Interactive controls work
  - Action: Click and drag on graph to zoom
  - Verify: Zoom behavior works correctly

### Performance Details Dashboard
- [ ] **Page Loads**: <5s load time
  - Action: Open Performance Details dashboard
  - Verify: Renders fully in <5s

- [ ] **Latency Heatmap**: Shows latency distribution
  - Check: Heatmap panel visible
  - Verify: Shows p50/p95/p99 latencies over time

- [ ] **Error Breakdown**: Shows error types and counts
  - Check: Error breakdown table/pie chart
  - Verify: Shows specific error messages and frequency

- [ ] **Resource Trends**: Memory, CPU trends visible
  - Check: Resource usage panels
  - Verify: Show 24-hour trends

- [ ] **Query Performance**: Queries execute in <2s
  - Action: Open browser DevTools → Network tab
  - Measure: Query response times
  - Verify: All queries <2s

### Infrastructure Health Dashboard
- [ ] **Page Loads**: <5s load time
  - Action: Open Infrastructure Health dashboard
  - Verify: Renders fully in <5s

- [ ] **Node Utilization**: All nodes shown with resource usage
  - Check: Node table/list
  - Verify: CPU%, Memory%, Disk% visible for each node

- [ ] **PVC Usage**: Storage usage shown for all PVCs
  - Check: PVC usage panels
  - Verify: Shows prometheus, loki, grafana PVC usage percentages

- [ ] **Certificate Status**: TLS certificates and expiry shown
  - Check: Certificate status panel
  - Verify: Shows expiry dates, none expired

- [ ] **Pod Status**: Component pod status visible
  - Check: Pod status panels
  - Verify: Shows running/failed count for each component

### Dashboard Cross-Navigation
- [ ] **Links Between Dashboards**: Click dashboard links work
  - Action: On Router Health Overview, click link to Performance Details
  - Verify: Navigation works, preserves time range

- [ ] **Drilldown Links**: Click on metric to drill down
  - Action: Click alert on alert list
  - Verify: Navigates to relevant dashboard/panel

---

## Alert Verification

### Alert Firing & Routing
- [ ] **Test Alert Fires**: Create test alert and verify it appears
  - Action: Set temporary threshold that will fire (e.g., alert on CPU > 0%)
  - Check: Alert appears in http://localhost:9090/alerts
  - Verify: Alert status shown as "Firing"
  - Cleanup: Remove test alert after verification

- [ ] **AlertManager Receives Alert**: Alert appears in AlertManager
  - Check: `kubectl port-forward svc/alertmanager 9093:9093`
  - Visit: http://localhost:9093/#/alerts
  - Verify: Fired alert appears in AlertManager UI

- [ ] **Slack Notification Sent**: Alert posted to Slack
  - Check: #monitoring-alerts channel
  - Verify: Notification appears with alert details

- [ ] **Notification Format**: Slack message readable and useful
  - Check: Alert message contains:
    - [ ] Alert name
    - [ ] Severity level
    - [ ] Affected component/instance
    - [ ] Value/threshold
    - [ ] Link to Grafana

- [ ] **PagerDuty Escalation** (production only):
  - Check: PagerDuty incident created for critical alert
  - Verify: Page sent to on-call engineer

### Alert Grouping
- [ ] **Multiple Alerts Grouped**: 5+ similar alerts → single notification
  - Action: Trigger 5 similar threshold violations (e.g., 5 nodes with high CPU)
  - Check: Slack receives 1 grouped notification (not 5)
  - Verify: "Grouped: 5 alerts" shown in notification

- [ ] **Grouping Parameters**: Group by alert name and severity
  - Check: `kubectl get configmap alertmanager-config -n monitoring -o yaml | grep group_by`
  - Verify: Shows `["alertname", "severity"]` or similar

### Alert Silencing
- [ ] **Silence Creation**: Can create silence in AlertManager UI
  - Action: AlertManager UI → Silences → New silence
  - Verify: Silence creation form appears

- [ ] **Silence Applied**: Silenced alert does not send notification
  - Action: Silence specific alert (e.g., LowAvailabilityAlert)
  - Trigger: Cause condition that fires alert
  - Check: No Slack notification sent
  - Verify: Alert visible in AlertManager with "Silenced" status

- [ ] **Silence Expiry**: Silence expires at specified time
  - Action: Create silence with 10 minute duration
  - Wait: After 10 minutes, trigger alert condition
  - Verify: Notification sent after silence expires

### Alert Inhibition
- [ ] **Child Alert Inhibited**: High-level alert suppresses lower-level alerts
  - Example: NodeDown alert inhibits NodeMemoryHigh alert for same node
  - Action: Simulate node failure
  - Check: Only NodeDown fires, NodeMemoryHigh suppressed
  - Verify: AlertManager UI shows inhibition

- [ ] **Inhibition Rules Configured**: Hierarchical alert structure
  - Check: `kubectl get alertmanagerrule -n monitoring` or config
  - Verify: Parent alerts suppress child alerts appropriately

---

## Data Collection Verification

### Prometheus Data
- [ ] **Metrics Storage Growing**: EFS space increasing with new metrics
  - Check: `du -sh /mnt/efs/prometheus` (or kubectl exec)
  - Measure: At baseline + 10% growth expected
  - Verify: Growth rate approximately 100MB-500MB/day

- [ ] **Retention Working**: Old data deleted automatically
  - Check: Oldest metric timestamp: `kubectl exec -n monitoring prometheus-0 -- promtool tsdb dump | head`
  - Verify: Oldest data is within last 15 days

- [ ] **No Scrape Failures**: All targets scraping successfully
  - Check: `kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus | grep error | wc -l`
  - Verify: Minimal errors (< 0.1% of scrapes)

### Loki Data
- [ ] **Logs Ingestion**: 1000+ logs/second ingested
  - Check: Loki UI or logs dashboard
  - Verify: Ingestion rate visible and consistent

- [ ] **All Namespaces**: Logs from all cluster namespaces collected
  - Action: `kubectl port-forward -n monitoring svc/loki 3100:3100`
  - Check: Grafana Explore → Loki → query `{namespace=""}`
  - Verify: See logs from default, kube-system, monitoring, application namespaces

- [ ] **JSON Parsing**: Structured logs parsed into fields
  - Check: Grafana Explore → Loki → query structured log
  - Verify: JSON fields appear as searchable labels

- [ ] **Retention Working**: Old logs deleted after 30 days
  - Check: Log dates in Grafana → Explore
  - Verify: No logs older than 30 days visible

- [ ] **No Loss**: All container logs reaching Loki
  - Check: Compare pod logs (`kubectl logs`) with Loki logs
  - Verify: Log content matches

### Backup System
- [ ] **EFS Snapshots Created**: Daily snapshots configured
  - Check: AWS console → EFS → Backups / Snapshots
  - Verify: Daily snapshots present for last 7 days

- [ ] **Backup Retention**: 7-day retention configured
  - Check: Snapshot deletion policy
  - Verify: Snapshots older than 7 days auto-deleted

- [ ] **Restore Procedure Tested**: Can restore from snapshot
  - Action: (if safe) Simulate snapshot restore
  - Verify: Data recoverable from backup

---

## Performance Verification

### Query Latency
- [ ] **Simple Queries**: <200ms response time
  - Action: Prometheus UI → query simple metric (e.g., `up`)
  - Measure: Query execution time
  - Verify: <200ms

- [ ] **Complex Queries**: <2s response time
  - Action: Query complex calculation (e.g., `rate(router_requests_total[5m]) / rate(router_requests_total[5m] offset 1h)`)
  - Measure: Query execution time
  - Verify: <2s

- [ ] **Range Queries**: 30-day range queries <5s
  - Action: Query with range `[30d:1d]`
  - Measure: Query execution time
  - Verify: <5s response time

### Dashboard Performance
- [ ] **Dashboard Load Time**: <5s full render
  - Action: Open each dashboard in browser (DevTools → Network tab)
  - Measure: Time to fully loaded
  - Verify: All 3 dashboards <5s

- [ ] **Panel Refresh**: Panels refresh every 15-30s without lag
  - Action: Watch dashboard panels update
  - Verify: Smooth updates, no blank panels or flashing

- [ ] **Zoom/Pan Responsiveness**: <500ms interactive response
  - Action: Click and drag on graph
  - Measure: Time to respond to interaction
  - Verify: Responsive feel, no visible lag

### Alert Latency
- [ ] **Metric to Alert**: <2 minutes from metric spike to alert firing
  - Action: Trigger alert condition
  - Measure: Time from metric violation to Prometheus alert state
  - Verify: <2 minutes

- [ ] **Alert to Notification**: <1 minute from alert fire to Slack
  - Action: Watch alert fire and Slack notification
  - Measure: Time from alert state to Slack post
  - Verify: <1 minute (typically <30s)

### Log Ingestion
- [ ] **Real-Time Availability**: Logs visible in Grafana <30s after emission
  - Action: Generate log entry (e.g., `kubectl logs`)
  - Measure: Time until visible in Loki/Grafana
  - Verify: <30 seconds ingestion lag

- [ ] **Search Performance**: LogQL queries <2s
  - Action: Grafana Explore → Loki → search 1 week of logs
  - Measure: Query response time
  - Verify: <2s response

---

## High Availability Verification

### Pod Failure Handling
- [ ] **Pod Deletion Tolerance**: Component recovers when pod deleted
  - Action: `kubectl delete pod prometheus-0 -n monitoring`
  - Verify: New pod created automatically by StatefulSet
  - Verify: Data still queryable from other replicas during outage

- [ ] **Data Consistency**: No data loss when pod restarts
  - Action: Kill pod, measure metric continuity
  - Verify: Time-series not broken, no gaps

- [ ] **Service Continuity**: Requests served by other replicas
  - Action: Monitor Prometheus queries during pod restart
  - Verify: No query failures or timeouts

### Pod Disruption Budget
- [ ] **PDB Prevents Forced Eviction**: `maxUnavailable` respected
  - Check: `kubectl get pdb -n monitoring`
  - Verify: minAvailable=1 prevents simultaneous pod termination

- [ ] **Node Drain Successful**: Can safely drain node
  - Action: `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` (test cluster)
  - Verify: Pods relocated, minAvailable maintained

### Multi-Replica Failover
- [ ] **2-to-1 Failure**: With 2 replicas, 1 failure = continued service
  - Action: Kill one of two Prometheus replicas
  - Verify: Other replica handles all queries
  - Verify: Metrics still collected and queryable

- [ ] **3-to-2 Failure** (production): With 3 replicas, 2 failures = continued service
  - Action: Kill two of three replicas (if in production)
  - Verify: Remaining replica serves all traffic
  - Verify: Pod anti-affinity preserved

### Storage Availability
- [ ] **EFS Accessible**: All replicas can read/write storage
  - Check: All replica pods have mounted PVC
  - Verify: `kubectl get events -n monitoring | grep "mount\|volume"`

- [ ] **No Split-Brain**: Distributed lock prevents concurrent writes
  - Check: AlertManager clustering configuration
  - Verify: Only one primary writing at a time

---

## Security Verification

### RBAC (Role-Based Access Control)
- [ ] **Service Accounts Minimal**: Each component has own service account
  - Check: `kubectl get serviceaccount -n monitoring`
  - Verify: prometheus, grafana, loki, alertmanager, promtail SAs exist

- [ ] **Role Bindings Restricted**: Each SA bound to minimal permissions
  - Check: `kubectl get rolebinding -n monitoring`
  - Verify: Bindings exist for each SA with specific roles

- [ ] **No Cluster Admin**: Services don't have cluster-admin role
  - Check: `kubectl get clusterrolebinding | grep monitoring`
  - Verify: No monitoring services have cluster-admin role

### Network Policies
- [ ] **Ingress Policy**: Traffic only from allowed sources
  - Check: `kubectl get networkpolicy -n monitoring`
  - Verify: Policies restrict ingress to expected sources

- [ ] **Egress Policy**: Components can only reach required services
  - Check: Network policy rules
  - Verify: Egress limited (e.g., Prometheus → Targets, AlertManager → Slack)

- [ ] **Monitoring to Prometheus**: Grafana can query Prometheus
  - Action: Test Prometheus datasource in Grafana
  - Verify: Network policy allows this traffic

### Secrets Management
- [ ] **Slack Webhook**: Stored as Kubernetes secret
  - Check: `kubectl get secret alertmanager-slack-webhook -n monitoring`
  - Verify: Secret exists, not visible in ConfigMap

- [ ] **PagerDuty Key**: Stored as secret (production)
  - Check: `kubectl get secret alertmanager-pagerduty -n monitoring` (if prod)
  - Verify: Secret exists

- [ ] **No Secrets in Logs**: Webhook URLs not logged
  - Check: `kubectl logs -n monitoring alertmanager-0 | grep "hooks\|pagerduty"`
  - Verify: No webhook URLs visible in logs

### TLS Certificates
- [ ] **Certificates Valid**: All TLS certs have valid dates
  - Check: `kubectl get certificate -n monitoring` (if using cert-manager)
  - Verify: READY=True for all certs, not expired

- [ ] **Auto-Renewal**: Certs configured for auto-renewal
  - Check: Certificate annotations or renewal policies
  - Verify: `cert-manager.io/issue-temporary-certificate=true` or similar

- [ ] **Certificate Chain**: Root, intermediate, leaf certs valid
  - Action: Check certificate details in browser (if accessing UI externally)
  - Verify: Certificate chain valid, no warnings

---

## Integration Verification

### Prometheus ↔ Grafana
- [ ] **Datasource Connection**: Grafana can query Prometheus
  - Check: Grafana → Configuration → Data Sources → Prometheus
  - Verify: Connection shows "Green/Connected"

- [ ] **Metric Availability**: All expected metrics available
  - Check: Grafana → Explore → Prometheus → metric list
  - Verify: 100+ metrics listed and queryable

- [ ] **Dashboard Panels**: Panels fetch and display data
  - Check: Each dashboard panel
  - Verify: No "error loading data" messages

### Prometheus → AlertManager
- [ ] **Alert Rule Evaluation**: Rules evaluate correctly
  - Check: Prometheus UI → Rules
  - Verify: Rules show evaluation count and health

- [ ] **Alert Forwarding**: Prometheus sends alerts to AlertManager
  - Check: Prometheus config shows AlertManager address
  - Verify: Alerts appear in AlertManager when rule fires

### Loki → Grafana
- [ ] **Datasource Connection**: Grafana can query Loki
  - Check: Grafana → Configuration → Data Sources → Loki
  - Verify: Connection shows "Green/Connected"

- [ ] **Log Visibility**: Logs visible in Grafana Explore
  - Action: Grafana → Explore → Loki → query `{namespace="default"}`
  - Verify: Logs return and display

- [ ] **Log Panel**: Logs visible in dashboard panels
  - Check: Log panel on Infrastructure Health dashboard
  - Verify: Recent logs visible

### AlertManager → Slack
- [ ] **Webhook Delivery**: Slack receives notifications
  - Action: Trigger test alert
  - Check: #monitoring-alerts channel
  - Verify: Notification appears with correct format

- [ ] **Routing Accuracy**: Warnings go to #monitoring-alerts, critical goes to #critical-alerts or PagerDuty
  - Action: Trigger warning and critical alerts
  - Verify: Routed to correct channels

### Promtail → Loki
- [ ] **Log Collection**: All node logs reaching Loki
  - Check: Grafana Explore → count logs: `{job="promtail"}`
  - Verify: Logs from all nodes present

- [ ] **Timestamp Accuracy**: Log timestamps match events
  - Action: Create log entry, check timestamp in Loki
  - Verify: Timestamps accurate (within seconds)

---

## Final Checklist

**All Verifications Completed:**
- [ ] Architecture verification ✓
- [ ] Metrics verification ✓
- [ ] Dashboard verification ✓
- [ ] Alert verification ✓
- [ ] Data collection verification ✓
- [ ] Performance verification ✓
- [ ] High availability verification ✓
- [ ] Security verification ✓
- [ ] Integration verification ✓

**Known Limitations (if any):**
- _______________________________________________
- _______________________________________________

**Issues Found & Resolved:**
| Issue | Cause | Resolution | Date |
|-------|-------|-----------|------|
|       |       |           |      |

**Sign-Off:**

Engineering Verification Lead:  
Name: _________________ Signature: _________________ Date: _________

Operations Lead (if present):  
Name: _________________ Signature: _________________ Date: _________

Approved for Handoff: ☐ Yes ☐ No (if No, document blockers above)

---

**Notes:**
- This checklist should be completed before handing off to operations team
- Each check should be performed in both staging and production environments
- Take screenshots of key dashboard panels for documentation
- Document any deviations from expected behavior
- Keep a copy of this checklist for audit trail
