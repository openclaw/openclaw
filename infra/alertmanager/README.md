# AlertManager Configuration and Deployment Guide

## Overview

This directory contains complete AlertManager configuration for the OpenClaw observability stack. AlertManager handles intelligent alert routing, grouping, deduplication, and delivery to multiple notification channels (Slack, PagerDuty) across production and staging Kubernetes clusters.

**Key Features:**
- 2-replica high-availability setup with pod anti-affinity
- Hierarchical alert routing by severity and cluster
- Alert grouping and deduplication (10s batching, 5m re-evaluation)
- Production: PagerDuty integration with escalation policies
- Staging: Slack-only routing for non-production testing
- Automatic alert silencing for maintenance windows
- Inhibition rules to suppress cascading child alerts

## File Structure

```
infra/alertmanager/
├── values-common.yaml              # Shared Helm config (both clusters)
├── values-prod.yaml                # Production overrides + PagerDuty
├── values-staging.yaml             # Staging overrides + Slack only
├── alertmanager-config.yaml        # ConfigMap: routing rules, receivers, inhibitions
├── silences-configmap.yaml         # Pre-configured silence rules
├── slack-integration.yaml          # Slack webhook setup guide + templates
├── pagerduty-integration.yaml      # PagerDuty service setup guide
├── service.yaml                    # Kubernetes Service, RBAC, NetworkPolicy
├── test-alert.yaml                 # Example test alerts (Jobs)
└── README.md                       # This file
```

## Quick Start

### 1. Prerequisites

- Kubernetes 1.28+ cluster (EKS production and staging)
- Helm 3.12+
- Slack workspace admin access
- PagerDuty account (production only)
- kubectl configured with cluster context

### 2. Create Slack Webhooks

**Production cluster:**

1. Go to: https://api.slack.com/apps
2. Create new app: "OpenClaw AlertManager"
3. Enable Incoming Webhooks
4. Create webhooks for:
   - `#monitoring-general` → `SLACK_WEBHOOK_URL`
   - `#monitoring-alerts` → `SLACK_WEBHOOK_URL_ALERTS` (optional)

**Staging cluster:**

Create webhooks for:
- `#monitoring-staging-alerts` → `SLACK_WEBHOOK_URL_STAGING`
- `#monitoring-staging-critical` → `SLACK_WEBHOOK_URL_STAGING_CRITICAL` (optional)

### 3. Create PagerDuty Service (Production Only)

1. Go to: https://subdomain.pagerduty.com
2. Services → New Service
   - Name: "ClarityRouter Production"
   - Integration: Events API v2
   - Copy **Integration Key**
3. Configure escalation policy:
   - Level 1: Primary on-call (5 min)
   - Level 2: Team lead (10 min)
   - Level 3: Manager (15 min)

### 4. Create Kubernetes Secrets

```bash
# Production - Slack
kubectl create secret generic alertmanager-slack-prod \
  --from-literal=webhook-url="https://hooks.slack.com/services/T.../B.../XXX" \
  -n monitoring

# Production - PagerDuty
kubectl create secret generic alertmanager-pagerduty \
  --from-literal=service-key="<integration-key-from-pagerduty>" \
  -n monitoring

# Staging - Slack
kubectl create secret generic alertmanager-slack-staging \
  --from-literal=webhook-url-staging="https://hooks.slack.com/services/T.../B.../YYY" \
  -n monitoring
```

### 5. Deploy to Cluster

```bash
# Add Helm repository
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Production deployment
kubectl config use-context clarity-router-prod
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f values-common.yaml \
  -f values-prod.yaml \
  --wait

# Staging deployment
kubectl config use-context clarity-router-staging
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f values-common.yaml \
  -f values-staging.yaml \
  --wait
```

## Alert Routing Logic

### Route Hierarchy

```
Root (group_by: cluster, severity, alertname)
├── severity: critical → pagerduty-critical (PagerDuty)
│   group_wait: 10s, repeat: 1h
├── severity: warning → slack-warnings (Slack #monitoring-alerts)
│   group_wait: 30s, repeat: 6h
├── cluster: clarity-router-prod → pagerduty-prod-critical
│   group_wait: 10s, repeat: 1h
├── cluster: clarity-router-staging → slack-staging-all
│   group_wait: 10s, repeat: 4h
└── severity: info → slack-info (Slack #monitoring-general)
    group_wait: 1m, repeat: 12h
```

### Alert Grouping Strategy

**Key parameters (in alertmanager-config.yaml):**

```yaml
group_by:        # Alerts with identical labels are grouped
  - cluster      # Separate prod vs staging
  - severity     # Separate critical from warnings
  - alertname    # Group by alert type
  - job          # Further subdivide by job

group_wait: 10s        # Wait before first notification (batch multiple alerts)
group_interval: 5m     # Re-evaluate grouping every 5 minutes
repeat_interval: 4h    # Repeat unresolved alerts every 4 hours
```

**Example:** If 5 router pods trigger `HighCPUUsage` simultaneously:
- All 5 alerts grouped into 1 notification (by alert name)
- Single Slack message: "HighCPUUsage - 5 alerts firing"
- Much less noisy than 5 separate notifications

### Inhibition Rules

Suppresses "noisy" child alerts when parent alert is firing:

1. **NodeDown → Suppress pod alerts**
   - If node is critical down, don't alert on pod-level issues
   
2. **AllPodsDown → Suppress resource metrics**
   - If all pods are down, don't alert on CPU/memory usage
   
3. **PodEvicted → Suppress resource pressure**
   - If pod is evicted, don't alert on resource pressure
   
4. **RouterUnavailable → Suppress latency/error alerts**
   - If router is down, latency/error spikes are expected

## Deployment Details

### High Availability Configuration

**AlertManager Replicas:**
- 2 replicas per cluster
- Pod anti-affinity: spread across different nodes
- Headless service for pod-to-pod clustering
- Automatic deduplication across replicas

**Storage:**
- 10GB PVC per cluster (alert history)
- 7-day retention (configurable)
- EFS-backed (shared across cluster)

**Pod Disruption Budget:**
- `minAvailable: 1` - at least 1 pod must stay alive
- Allows node maintenance without service disruption

### Resource Allocation

```yaml
requests:
  cpu: 100m
  memory: 128Mi

limits:
  cpu: 200m
  memory: 256Mi
```

Typical production load: <50m CPU, <50Mi memory

### Networking

**Service Types:**
- ClusterIP `alertmanager:9093` - HTTP API/UI (internal)
- Headless `alertmanager-headless:9093` - Pod clustering

**Network Policies:**
- Ingress: Allow Prometheus scraping, cluster communication
- Egress: Allow DNS, API server, external webhooks (HTTPS)

## Slack Integration

### Message Format

```
Title: "🔔 RouterUnavailable"
Status: firing | resolved (green/red)
Severity: critical | warning | info
Cluster: clarity-router-prod
Alerts: 3 firing

Affected instances:
• router-0 - Pod not responding
• router-1 - Pod not responding
• router-2 - Pod not responding

[View in Grafana] [View Logs] [Runbook]
```

### Webhook Testing

```bash
# Get webhook URL
WEBHOOK=$(kubectl get secret alertmanager-slack-prod \
  -o jsonpath='{.data.webhook-url}' -n monitoring | base64 -d)

# Send test message
curl -X POST "$WEBHOOK" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "Test message from AlertManager",
    "attachments": [{
      "color": "good",
      "title": "Integration Working ✅"
    }]
  }'
```

### Customizing Templates

Edit `slack_configs` section in `values-prod.yaml`:

```yaml
slack_configs:
- api_url: ${SLACK_WEBHOOK_URL}
  channel: "#monitoring-alerts"
  title: "⚠️ {{ .GroupLabels.alertname }}"
  text: |
    *Severity:* {{ .GroupLabels.severity }}
    *Cluster:* {{ .GroupLabels.cluster }}
    {{ range .Alerts }}
    • {{ .Labels.instance }} - {{ .Annotations.description }}
    {{ end }}
  color: '{{ if eq .Status "firing" }}danger{{ else }}good{{ end }}'
```

Available variables:
- `.Status` - "firing" or "resolved"
- `.GroupLabels.<label>` - Alert label (cluster, severity, alertname)
- `.Alerts` - Array of alerts in group
- `.Annotations.<annotation>` - Alert annotation (summary, description, runbook_url)

## PagerDuty Integration

### Incident Flow

```
Alert fires → AlertManager routes to pagerduty-critical
           → Creates incident in PagerDuty
           → Triggers escalation policy
           → Pages on-call engineer
           
Engineer acknowledges → Escalation pauses, waiting for resolution

Alert resolves → AlertManager sends "resolved" status
              → PagerDuty incident auto-closes
              → Updates on-call status
```

### Testing Integration

```bash
# Port-forward AlertManager
kubectl port-forward -n monitoring svc/alertmanager 9093:9093 &

# Send test alert
curl -X POST http://localhost:9093/api/v1/alerts \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestCriticalAlert",
      "severity": "critical",
      "cluster": "clarity-router-prod"
    },
    "annotations": {
      "summary": "Test critical alert"
    }
  }]'
```

**Expected result:** Incident appears in PagerDuty dashboard within 10 seconds

### Severity Mapping

| Alert Severity | PagerDuty Action | Auto-Page | Escalation |
|---|---|---|---|
| critical | Create incident | Yes | Enabled |
| warning | Create alert | No | No |
| info | Log only | No | No |

### Tuning Escalation

Edit escalation policy in PagerDuty:

1. Go to: Services → ClarityRouter Production → Escalation Policy
2. Adjust level delays:
   - Level 1: 5 minutes (initial page)
   - Level 2: 10 minutes (escalate to team lead)
   - Level 3: 15 minutes (escalate to manager)

## Alert Silencing

### Pre-configured Silences

Defined in `silences-configmap.yaml`:

1. **maintenance-window-weekly** - Suppress all alerts during maintenance
2. **staging-dev-tests** - Suppress staging environment alerts long-term
3. **false-positive-cert-expiry** - Ignore self-signed test certs
4. **e2e-test-alerts** - Silence test alerts during testing window
5. **known-issue-high-memory** - Suppress known router-0 memory leak

### Creating Silences

**Via AlertManager API:**

```bash
curl -X POST http://localhost:9093/api/v1/silences \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [
      {"name": "alertname", "value": "HighMemoryUsage"}
    ],
    "startsAt": "2026-02-15T00:00:00Z",
    "endsAt": "2026-02-20T00:00:00Z",
    "comment": "Known issue - under investigation"
  }'
```

**Via AlertManager UI:**

1. Port-forward: `kubectl port-forward svc/alertmanager 9093:9093`
2. Open: http://localhost:9093
3. Click "Silences" → "New Silence"
4. Configure matchers (alert name, labels)
5. Set start/end times
6. Click "Create"

## Testing and Validation

### Test Cases

**Test 1: Critical Alert (PagerDuty)**
```bash
kubectl apply -f test-alert.yaml -l test=critical
# Expected: PagerDuty incident + Slack notification
```

**Test 2: Warning Alert (Slack only)**
```bash
kubectl apply -f test-alert.yaml -l test=warning
# Expected: Slack notification only
```

**Test 3: Alert Grouping**
```bash
kubectl apply -f test-alert.yaml -l test=grouped
# Expected: 3 grouped alerts in single Slack message
```

**Test 4: Alert Resolution**
```bash
kubectl apply -f test-alert.yaml -l test=resolved
# Expected: Firing → Resolved sequence
```

### Verification Checklist

- [ ] AlertManager pods running (2 per cluster)
- [ ] Slack webhook valid and connected
- [ ] PagerDuty service key configured (production)
- [ ] Test alert triggered successfully
- [ ] Slack notification received
- [ ] PagerDuty incident created (production)
- [ ] Alert grouping working (multiple alerts → 1 notification)
- [ ] Inhibition rules suppressing cascading alerts
- [ ] Silences suppressing non-critical alerts

## Operational Procedures

### Accessing AlertManager UI

```bash
# Port-forward to local machine
kubectl port-forward -n monitoring svc/alertmanager 9093:9093 &

# Open in browser
open http://localhost:9093

# View firing alerts
curl http://localhost:9093/api/v1/alerts

# View alert groups
curl http://localhost:9093/api/v1/alerts/groups
```

### Checking Status

```bash
# Pod status
kubectl get pods -n monitoring -l app=alertmanager

# Check logs
kubectl logs -n monitoring alertmanager-0

# Describe pod (events, conditions)
kubectl describe pod -n monitoring alertmanager-0

# View configuration
kubectl get configmap -n monitoring alertmanager-config
```

### Manual Silence Creation

```bash
# Create silence for maintenance
WEBHOOK=$(kubectl get secret alertmanager-pagerduty \
  -o jsonpath='{.data.service-key}' -n monitoring | base64 -d)

curl -X POST http://localhost:9093/api/v1/silences \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [{"name": "alertname", "value": ".*", "isRegex": true}],
    "startsAt": "2026-02-20T02:00:00Z",
    "endsAt": "2026-02-20T04:00:00Z",
    "comment": "Kubernetes cluster upgrade"
  }'
```

### Scaling Alertmanager

```bash
# Increase replicas (if needed)
kubectl scale statefulset -n monitoring alertmanager --replicas=3

# Monitor rollout
kubectl rollout status statefulset/alertmanager -n monitoring
```

## Troubleshooting

### Alerts Not Being Sent

1. **Check AlertManager is running:**
   ```bash
   kubectl get pods -n monitoring -l app=alertmanager
   ```

2. **Check AlertManager logs:**
   ```bash
   kubectl logs -n monitoring alertmanager-0 | grep -i error
   ```

3. **Verify alerts are reaching AlertManager:**
   ```bash
   curl http://localhost:9093/api/v1/alerts | jq '.data | length'
   ```

4. **Check webhook URLs are set:**
   ```bash
   kubectl get secret -n monitoring alertmanager-slack-prod
   kubectl get secret -n monitoring alertmanager-pagerduty
   ```

### Webhook Connection Errors

```bash
# Test webhook manually
WEBHOOK=$(kubectl get secret alertmanager-slack-prod \
  -o jsonpath='{.data.webhook-url}' -n monitoring | base64 -d)

curl -v -X POST "$WEBHOOK" \
  -H 'Content-Type: application/json' \
  -d '{"text": "Test"}'

# Check response (should be "ok")
```

### Duplicate Alerts

**Cause:** Multiple AlertManager replicas sending same notification

**Solution:**
1. Ensure dedup is working: Check `group_by` labels match
2. Verify AlertManager clustering is healthy:
   ```bash
   kubectl logs -n monitoring alertmanager-0 | grep cluster
   ```
3. If issue persists, restart AlertManager:
   ```bash
   kubectl delete pods -n monitoring -l app=alertmanager
   ```

### Alerts Not Grouping

**Cause:** Labels don't match `group_by` criteria

**Solution:**
1. Check alert labels match defined labels:
   ```bash
   curl http://localhost:9093/api/v1/alerts | jq '.data[0].labels'
   ```
2. Verify `group_by` in alertmanager-config.yaml includes those labels
3. Increase `group_wait` to give more time for batching

### PagerDuty Not Receiving Alerts

1. **Check integration key is valid:**
   ```bash
   kubectl get secret alertmanager-pagerduty -o jsonpath='{.data.service-key}' \
     -n monitoring | base64 -d
   ```

2. **Verify service is active in PagerDuty:**
   - PagerDuty → Services → ClarityRouter Production
   - Check status (should not be "Maintenance" or "Disabled")

3. **Check severity routing:**
   - Only `severity: critical` alerts route to PagerDuty
   - Warnings route to Slack only

4. **Test with direct API call:**
   ```bash
   SERVICE_KEY=$(kubectl get secret alertmanager-pagerduty \
     -o jsonpath='{.data.service-key}' -n monitoring | base64 -d)
   
   curl -X POST https://events.pagerduty.com/v2/enqueue \
     -H 'Content-Type: application/json' \
     -d "{
       \"routing_key\": \"$SERVICE_KEY\",
       \"event_action\": \"trigger\",
       \"dedup_key\": \"test-$(date +%s)\",
       \"payload\": {
         \"summary\": \"Test Alert\",
         \"severity\": \"critical\",
         \"source\": \"AlertManager Test\"
       }
     }"
   ```

## Configuration Reference

### Key Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `resolve_timeout` | 5m | Auto-resolve if no update |
| `group_wait` | 10s | Wait before first batch |
| `group_interval` | 5m | Re-evaluate grouping |
| `repeat_interval` | 4h | Repeat unresolved (root) |
| `group_by` | [cluster, severity, alertname] | Grouping dimensions |
| Slack `send_resolved` | true | Send resolution notifications |
| PagerDuty `severity` | critical/resolved | Incident severity |
| Storage size | 10Gi | Alert history PVC |
| Retention | 168h (7 days) | Keep alert data |

### Alert Payload Structure

```json
{
  "status": "firing",
  "labels": {
    "alertname": "HighErrorRate",
    "severity": "critical",
    "cluster": "clarity-router-prod",
    "job": "clarityrouter"
  },
  "annotations": {
    "summary": "High error rate detected",
    "description": "Error rate > 1% for 5 minutes",
    "runbook_url": "https://docs.example.com/runbooks/high-error-rate"
  },
  "startsAt": "2026-02-15T12:34:56Z",
  "endsAt": "0001-01-01T00:00:00Z"
}
```

## Cost Estimation

**Monthly Infrastructure Costs:**
- AlertManager pods: ~5m CPU overhead (shared with other monitoring)
- AlertManager storage: ~$2-5/month (10GB EFS)
- Slack: $0 (webhooks free)
- PagerDuty: $29+/month depending on tier

**Total AlertManager impact: <$10/month** (mostly storage)

## Related Documentation

- [AlertManager Official Docs](https://prometheus.io/docs/alerting/latest/overview/)
- [AlertManager Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Slack Integration](slack-integration.yaml)
- [PagerDuty Integration](pagerduty-integration.yaml)
- [Observability Architecture](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)

## Support and Issues

For issues or questions:
1. Check AlertManager logs: `kubectl logs -n monitoring alertmanager-0`
2. Review configuration: `kubectl get configmap -n monitoring alertmanager-config`
3. Test with curl: `curl http://alertmanager:9093/api/v1/alerts`
4. Access UI: `kubectl port-forward svc/alertmanager 9093:9093` → http://localhost:9093
