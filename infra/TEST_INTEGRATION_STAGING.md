# Staging Observability Stack - Cross-Component Integration Testing

## Overview
This guide tests interactions and communication between observability components to ensure they work together correctly.

**Prerequisites:**
- All components deployed and healthy
- All single-component tests passing
- Network connectivity verified between components
- kubectl configured for staging cluster

---

## Prometheus → AlertManager Integration

### Alert Rule Evaluation and Routing

**Verify Alerting Rules Are Active:**

```bash
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &

# List active alert rules
curl -s 'http://localhost:9090/api/v1/rules?type=alert' | \
  jq '.data.groups[] | {name, rules: (.rules | length), state: .rules[0].state}'
# Expected: Multiple rule groups with state="ok"
```

**Test Rule Firing:**

```bash
# Manually trigger an alert condition by creating metrics that violate rules
# Verify alert appears in AlertManager within evaluation interval

# Example: If you have a rule like "up == 0", stop a target and verify alert fires
# Check Prometheus alerts page: http://localhost:9090/alerts
```

### Verify Prometheus Sends to AlertManager

```bash
# Check AlertManager configuration in Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=prometheus_notifications_total' | \
  jq '.data.result[] | {alertmanager: .metric.alertmanager, notifications: .value}'
```

Expected output shows successful notifications to AlertManager.

**Test End-to-End Alert Flow:**

```bash
# 1. Query a metric that would trigger an alert
curl -s 'http://localhost:9090/api/v1/query?query=up{job="test"}' > /dev/null

# 2. Verify alert appears in Prometheus UI
curl -s 'http://localhost:9090/api/v1/alerts' | jq '.data[] | select(.state=="firing")'

# 3. Verify alert propagated to AlertManager
kubectl -n monitoring port-forward svc/alertmanager 9093:9093 &
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname | startswith("Test"))'

# 4. Verify notification sent to Slack
# Check #monitoring-staging-critical or appropriate channel
```

**Success Criteria:**
- Alert rules evaluate correctly
- Prometheus sends notifications to AlertManager
- AlertManager receives and processes alerts
- Alerts appear in expected Slack channels

---

## Prometheus → Grafana Integration

### Prometheus Datasource Connectivity

```bash
kubectl -n monitoring port-forward svc/grafana 3000:3000 &

# Verify Prometheus datasource is configured
curl -s 'http://localhost:3000/api/datasources' -u admin:admin | \
  jq '.[] | select(.type=="prometheus") | {name, url, health}'
# Expected: Datasource healthy and pointing to Prometheus
```

### Dashboard Query Execution

**Test Simple Dashboard Query:**

```bash
# Execute query from dashboard
curl -s 'http://localhost:3000/api/datasources/proxy/1/api/v1/query?query=up' -u admin:admin | \
  jq '.data.result | length'
# Expected: >50 (number of targets)
```

**Test Dashboard Rendering:**

```bash
# Get dashboard and verify queries return data
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | \
  jq '.dashboard.panels[] | {title, targets: .targets} | select(.targets | length > 0)' | head -20

# All panels should have targets that return data
```

### Variable Selector Integration

```bash
# Test dashboard variables work with Prometheus
curl -s 'http://localhost:3000/api/dashboards/uid/router-overview' -u admin:admin | \
  jq '.dashboard.templating.list[]'

# Expected: Variables for cluster, namespace, pod that query Prometheus for options
```

**Test Variable Query:**

```bash
# Simulate variable option query from dashboard
curl -s 'http://localhost:3000/api/datasources/proxy/1/api/v1/label/cluster/values' -u admin:admin | \
  jq '.data'
# Expected: List of unique cluster values
```

**Success Criteria:**
- Prometheus datasource healthy and connected
- Dashboard queries execute and return data
- Variable selectors query Prometheus successfully
- Dashboards update when variables change
- No query errors in panel responses

---

## Loki → Grafana Integration

### Loki Datasource Connectivity

```bash
# Verify Loki datasource is configured
curl -s 'http://localhost:3000/api/datasources' -u admin:admin | \
  jq '.[] | select(.type=="loki") | {name, url, health}'
# Expected: Loki datasource healthy and pointing to Loki
```

### Log Panel Rendering

```bash
# Get dashboard with log panels
curl -s 'http://localhost:3000/api/dashboards/uid/performance-details' -u admin:admin | \
  jq '.dashboard.panels[] | select(.type | contains("logs")) | {title, targets}'

# All log panels should have valid LogQL targets
```

### Explore Tab Integration

**Test Loki Label Query from Explore:**

```bash
# Simulate Explore label query
curl -s 'http://localhost:3000/api/datasources/proxy/2/loki/api/v1/labels' -u admin:admin | \
  jq '.values | length'
# Expected: >10 (multiple label names)
```

**Test Loki Log Query from Explore:**

```bash
# Simulate Explore log query
curl -s 'http://localhost:3000/api/datasources/proxy/2/loki/api/v1/query?query={cluster="staging"}' -u admin:admin | \
  jq '.data.result | length'
# Expected: >0 (logs matched)
```

**Success Criteria:**
- Loki datasource healthy and connected
- Log panels execute and display logs
- Explore tab queries Loki successfully
- Label selectors work correctly
- Log parsing and display correct

---

## AlertManager → Slack Integration

### Webhook Delivery Verification

```bash
# Check AlertManager webhook configuration
kubectl -n monitoring get configmap alertmanager-config -o yaml | grep -A 5 "slack_configs"

# Expected: Slack webhook URL configured
```

### Alert Notification Delivery

**Test End-to-End Notification:**

```bash
# 1. Send alert to AlertManager
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "IntegrationTest", "severity": "critical", "cluster": "staging"},
    "annotations": {"summary": "Integration test alert"},
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# 2. Verify alert in AlertManager
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname=="IntegrationTest")'

# 3. Wait 30-60 seconds and check Slack
# Expected: Message in #monitoring-staging-critical
```

### Message Formatting Validation

```bash
# Check that Slack messages include all expected fields
# From Slack: verify messages contain:
# - Severity emoji (🔴)
# - Alert name
# - Summary and description
# - Labels (cluster, instance, etc.)
# - Action buttons (Silence, View, etc.)
```

**Success Criteria:**
- Webhook successfully delivers alerts to Slack
- Message formatting correct
- Severity and routing accurate
- Action buttons functional
- Notification latency <2 minutes

---

## Promtail → Loki Integration

### Log Collection Verification

```bash
# Verify Promtail is sending logs to Loki
kubectl -n monitoring logs -f daemonset/promtail --tail=20 | grep -i "sending"

# Expected: Log output showing successful sends to Loki
```

### Verify Logs Are Ingested

```bash
# Check Loki is receiving logs from Promtail
kubectl -n monitoring port-forward svc/loki 3100:3100 &

curl -s 'http://localhost:3100/loki/api/v1/label/job/values' | jq '.values'
# Expected: "promtail" in the list
```

**Test Log Stream:**

```bash
# Query Promtail logs in Loki
curl -s 'http://localhost:3100/loki/api/v1/query?query={job="promtail"}' | \
  jq '.data.result | length'
# Expected: >0 (logs from Promtail)
```

**Success Criteria:**
- Promtail successfully connects to Loki
- Logs ingested and searchable
- Log labels correctly applied (cluster, namespace, pod)
- No ingestion lag
- Consistent log flow

---

## Node-Exporter → Prometheus Integration

### Node Metrics Collection

```bash
# Verify node-exporter metrics in Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=node_up' | \
  jq '.data.result | length'
# Expected: Number of nodes in cluster
```

**Check Node Metrics:**

```bash
# Query specific node metrics
curl -s 'http://localhost:9090/api/v1/query?query=node_cpu_seconds_total' | \
  jq '.data.result | length'
# Expected: Multiple CPU metrics from all nodes

curl -s 'http://localhost:9090/api/v1/query?query=node_memory_MemTotal_bytes' | \
  jq '.data.result | length'
# Expected: Memory metrics from all nodes
```

**Success Criteria:**
- Node-exporter metrics collected from all nodes
- Scrape targets in "UP" state
- Metrics available and queryable
- No missing node metrics

---

## Kube-State-Metrics → Prometheus Integration

### Kubernetes State Metrics

```bash
# Verify kube-state-metrics in Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=kube_pod_info' | \
  jq '.data.result | length'
# Expected: Number of pods in cluster
```

**Check Pod Metrics:**

```bash
# Query pod-related metrics
curl -s 'http://localhost:9090/api/v1/query?query=kube_pod_status_phase' | \
  jq '.data.result | length'
# Expected: All pods represented

curl -s 'http://localhost:9090/api/v1/query?query=kube_deployment_status_replicas_available' | \
  jq '.data.result | length'
# Expected: All deployments tracked
```

**Success Criteria:**
- Kube-state-metrics target UP
- Pod and deployment metrics collected
- Metrics reflect actual cluster state
- No stale or missing metrics

---

## Kubernetes Kubelet → Prometheus Integration

### Container Metrics Collection

```bash
# Verify kubelet metrics in Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=container_cpu_usage_seconds_total' | \
  jq '.data.result | length'
# Expected: >100 (containers from all pods)
```

**Check Container Metrics:**

```bash
# Query container-specific metrics
curl -s 'http://localhost:9090/api/v1/query?query=container_memory_usage_bytes' | \
  jq '.data.result | length'
# Expected: Memory metrics from all containers

curl -s 'http://localhost:9090/api/v1/query?query=container_network_receive_bytes_total' | \
  jq '.data.result | length'
# Expected: Network metrics from all pods
```

**Success Criteria:**
- Kubelet metrics collected from all nodes
- Container CPU/memory metrics available
- Network I/O metrics collected
- Metrics labeled with pod/container info

---

## Prometheus High Availability Integration

### Replica Data Consistency

```bash
# Query both Prometheus replicas and verify same data

# Replica 0
kubectl -n monitoring port-forward pod/prometheus-0 9090:9090 &
PROM0=$(curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length')

# Replica 1
pkill -f "port-forward pod/prometheus-0"
kubectl -n monitoring port-forward pod/prometheus-1 9090:9090 &
PROM1=$(curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result | length')

echo "Prometheus-0: $PROM0 targets"
echo "Prometheus-1: $PROM1 targets"
# Expected: Same or within 1 target difference
```

### Grafana Datasource Failover

```bash
# Test that Grafana can query both Prometheus replicas

# Get datasource configuration
curl -s 'http://localhost:3000/api/datasources' -u admin:admin | \
  jq '.[] | select(.type=="prometheus") | {name, url, jsonData}'

# Expected: Load balancer URL or service discovery configured
```

**Success Criteria:**
- Both replicas have consistent metric data
- Grafana can query through load balancer
- Failover transparent to Grafana
- No data loss on replica failure

---

## AlertManager High Availability Integration

### Replica Deduplication

```bash
# Verify AlertManager replicas deduplicate alerts

# Send alert with timestamp
ALERT_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname": "ReplicaTest", "severity": "critical"},
    "annotations": {"summary": "Testing replica deduplication"},
    "startsAt": "'$ALERT_TIME'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Monitor Slack for single notification (not duplicated from both replicas)
# Expected: 1 message (not 2)
```

**Success Criteria:**
- Alerts from both replicas deduplicated
- Single Slack notification sent
- Cluster-aware deduplication working
- No duplicate notifications

---

## Loki High Availability Integration

### Replica Log Consistency

```bash
# Query both Loki replicas and verify same logs

# Replica 0
kubectl -n monitoring port-forward pod/loki-0 3100:3100 &
LOKI0=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

# Replica 1
pkill -f "port-forward pod/loki-0"
kubectl -n monitoring port-forward pod/loki-1 3100:3100 &
LOKI1=$(curl -s 'http://localhost:3100/loki/api/v1/labels' | jq '.values | length')

echo "Loki-0 labels: $LOKI0"
echo "Loki-1 labels: $LOKI1"
# Expected: Same label count
```

**Success Criteria:**
- Both replicas have same log indices
- Log queries return consistent results
- Grafana can query both replicas
- No log loss on replica failure

---

## End-to-End Alert Flow

### Complete Alert Path

**Setup:**

```bash
# 1. Create a condition that would trigger alert
# 2. Monitor all hops in the chain

# Expected flow:
# Metric change → Prometheus evaluation → AlertManager → Slack
```

**Monitor Each Component:**

```bash
# 1. Verify metric exists
curl -s 'http://localhost:9090/api/v1/query?query=clarityrouter_errors_total' | \
  jq '.data.result[0].value'

# 2. Verify alert rule fires
curl -s 'http://localhost:9090/api/v1/alerts' | \
  jq '.data[] | select(.state=="firing")'

# 3. Verify alert in AlertManager
curl -s 'http://localhost:9093/api/v1/alerts' | \
  jq '.data | length'

# 4. Verify Slack notification
# Check channel: #monitoring-staging-alerts
```

**Success Criteria:**
- Metric change detected
- Alert rule evaluates and fires
- AlertManager receives alert
- Slack notification delivered
- Total latency <2 minutes

---

## DNS and Service Discovery

### Verify Service DNS Resolution

```bash
# Test DNS resolution from components
kubectl -n monitoring exec -it prometheus-0 -- nslookup grafana
kubectl -n monitoring exec -it grafana-0 -- nslookup prometheus
kubectl -n monitoring exec -it alertmanager-0 -- nslookup loki

# Expected: All services resolve correctly
# IP addresses should be service ClusterIPs
```

### Verify Kubernetes Service Discovery

```bash
# Verify Prometheus discovers targets via Kubernetes API
curl -s 'http://localhost:9090/api/v1/targets?state=active' | \
  jq '.data.activeTargets[] | {job, target: .lastScrapeTime}' | head -10

# All targets should be discovered through Kubernetes SD
```

**Success Criteria:**
- All services resolve via DNS
- Kubernetes SD working
- No "connection refused" errors
- Service mesh (if present) not interfering

---

## RBAC and Permissions

### Verify Service Account Permissions

```bash
# Check Prometheus RBAC
kubectl -n monitoring get rolebinding -l app=prometheus

# Expected: Binding allows pod discovery, node metrics, etc.
kubectl -n monitoring get clusterrole prometheus -o yaml | jq '.rules[]'
```

### Test API Access

```bash
# Verify components can access required APIs
kubectl -n monitoring exec prometheus-0 -- \
  curl -s --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  https://kubernetes.default.svc/api/v1/nodes

# Expected: Returns node list (RBAC allows access)
```

**Success Criteria:**
- Service accounts have necessary permissions
- Pod discovery working
- No RBAC denial errors
- All required APIs accessible

---

## Network Policies

### Verify Traffic Allowed

```bash
# Test connectivity between components
kubectl -n monitoring exec -it prometheus-0 -- \
  nc -zv alertmanager 9093

kubectl -n monitoring exec -it grafana-0 -- \
  nc -zv prometheus 9090

# Expected: All connections succeed
```

**Success Criteria:**
- All inter-component traffic allowed
- No connection timeouts
- Network policies (if present) not blocking necessary traffic
- External traffic to Grafana/AlertManager accessible

---

## Success Checklist

- [ ] Prometheus rules evaluate and fire
- [ ] Alerts flow from Prometheus to AlertManager
- [ ] AlertManager routes to Slack successfully
- [ ] Grafana queries Prometheus for dashboard data
- [ ] Grafana queries Loki for logs
- [ ] Promtail sends logs to Loki
- [ ] Node-exporter metrics collected
- [ ] Kube-state-metrics collected
- [ ] Kubelet metrics collected
- [ ] Prometheus replicas have consistent data
- [ ] AlertManager replicas deduplicate alerts
- [ ] Loki replicas have consistent logs
- [ ] Service DNS resolution working
- [ ] Kubernetes service discovery working
- [ ] RBAC allows necessary permissions
- [ ] Network policies allow required traffic
- [ ] End-to-end alert flow <2 minutes
