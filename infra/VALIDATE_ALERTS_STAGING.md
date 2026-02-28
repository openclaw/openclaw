# Staging Observability Stack - Alert Routing & Notification Testing

## Overview
This guide tests alert routing from Prometheus through AlertManager to Slack notifications.

**Prerequisites:**
- AlertManager deployed and healthy
- Prometheus sending alerts to AlertManager
- Slack webhook URL configured in AlertManager secrets
- Test Slack channel created: `#monitoring-staging-test`
- port-forwards configured for AlertManager (9093) and Prometheus (9090)

---

## Setup

### Slack Configuration

Create test channels in Slack workspace:

```bash
# Create these channels:
# - #monitoring-staging-test (for manual testing)
# - #monitoring-staging-critical (critical alerts)
# - #monitoring-staging-alerts (warning alerts)
# - #monitoring-staging-general (info alerts)
```

### Get Slack Webhook URL

```bash
# Retrieve configured webhook from AlertManager secrets
kubectl -n monitoring get secret alertmanager-secrets -o yaml | grep slack_webhook

# Or check AlertManager config
kubectl -n monitoring get configmap alertmanager-config -o yaml | grep -A 5 "slack_configs"
```

### Port-Forwards

```bash
kubectl -n monitoring port-forward svc/alertmanager 9093:9093 &
kubectl -n monitoring port-forward svc/prometheus 9090:9090 &
```

---

## Alert Routing Configuration

### Verify AlertManager Configuration

```bash
# Check routing tree
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.route'
# Expected output shows routing hierarchy
```

Expected routing structure:

```yaml
route:
  receiver: 'slack-general'
  group_by: ['alertname', 'cluster', 'severity']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 4h
  routes:
    - match:
        severity: 'critical'
      receiver: 'slack-critical'
    - match:
        severity: 'warning'
      receiver: 'slack-alerts'
    - match:
        severity: 'info'
      receiver: 'slack-general'
```

### Verify Receivers Configuration

```bash
# List all configured receivers
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.receivers'
# Expected: slack-critical, slack-alerts, slack-general receivers
```

---

## Test 1: Critical Alert Routing

### Send Test Critical Alert

```bash
# Create test critical alert
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestCriticalAlert",
      "severity": "critical",
      "cluster": "staging",
      "instance": "test-instance"
    },
    "annotations": {
      "summary": "This is a test critical alert",
      "description": "Testing critical alert routing to #monitoring-staging-critical",
      "runbook_url": "https://example.com/runbooks/test"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
# Expected: HTTP 202 Accepted
```

### Verify in AlertManager UI

```bash
# Check alert appears in AlertManager
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname=="TestCriticalAlert")'
# Expected: Alert visible within 5 seconds
```

### Verify Slack Notification

**Expected behavior:**
- Alert appears in `#monitoring-staging-critical` within 1 minute
- Message format:
  ```
  🔴 CRITICAL (1 alert)
  TestCriticalAlert
  This is a test critical alert
  cluster: staging
  instance: test-instance
  [View in Grafana] [Acknowledge] [Silence]
  ```

**Check in Slack:**
```bash
# Or check via Slack API (if configured)
slack --app-id YOUR_APP_ID --token YOUR_TOKEN \
  --channel monitoring-staging-critical --query "TestCriticalAlert"
```

**Success Criteria:**
- Alert appears in AlertManager within 5 seconds
- Slack notification in #monitoring-staging-critical within 1 minute
- Message contains alert name, summary, and cluster
- Severity emoji (🔴) visible
- Links to Grafana work

---

## Test 2: Warning Alert Routing

### Send Test Warning Alert

```bash
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestWarningAlert",
      "severity": "warning",
      "cluster": "staging",
      "pod": "test-pod"
    },
    "annotations": {
      "summary": "This is a test warning alert",
      "description": "Testing warning alert routing to #monitoring-staging-alerts"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
# Expected: HTTP 202 Accepted
```

### Verify in Slack

**Expected:**
- Alert in `#monitoring-staging-alerts` (not #critical)
- Message with yellow/orange emoji: 🟠
- Same format as critical but different channel

**Success Criteria:**
- Alert routes to #monitoring-staging-alerts (not critical)
- Slack notification within 1 minute
- Proper formatting and links

---

## Test 3: Info Alert Routing

### Send Test Info Alert

```bash
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestInfoAlert",
      "severity": "info",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "This is a test info alert",
      "description": "Testing info alert routing to #monitoring-staging-general"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

### Verify in Slack

**Expected:**
- Alert in `#monitoring-staging-general` (default receiver)
- Message with blue emoji: 🔵
- Lower priority than critical/warning

**Success Criteria:**
- Alert routes to #monitoring-staging-general
- Slack notification within 1 minute
- Proper formatting

---

## Test 4: Alert Grouping

### Send Multiple Similar Alerts

```bash
# Send 5 critical alerts with same alertname but different instances
for i in {1..5}; do
  curl -X POST 'http://localhost:9093/api/v1/alerts' \
    -H 'Content-Type: application/json' \
    -d '[{
      "labels": {
        "alertname": "TestGrouping",
        "severity": "critical",
        "cluster": "staging",
        "instance": "instance-'$i'"
      },
      "annotations": {
        "summary": "Test alert instance '$i'",
        "description": "Testing alert grouping"
      },
      "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
      "endsAt": "0001-01-01T00:00:00Z"
    }]'
  sleep 2
done
```

### Verify Grouping in AlertManager

```bash
# Query alerts - should show 5 separate alerts
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname=="TestGrouping")'
# Expected: 5 alerts visible
```

### Verify Grouped Slack Message

**Expected:**
- Single Slack message (not 5 separate messages)
- Message shows "5 alerts" in header
- Lists all instances in message body:
  ```
  🔴 CRITICAL (5 alerts) TestGrouping
  
  instance-1: Test alert instance 1
  instance-2: Test alert instance 2
  instance-3: Test alert instance 3
  instance-4: Test alert instance 4
  instance-5: Test alert instance 5
  ```

**Success Criteria:**
- 5 alerts generate 1 Slack message (not 5)
- All instances listed in single message
- Count shows "5 alerts"
- Grouping reduces notification noise

---

## Test 5: Alert Deduplication Across Replicas

### Setup: Verify Two AlertManager Replicas

```bash
# Check AlertManager replicas
kubectl -n monitoring get pods -l app=alertmanager
# Expected: 2 pods (alertmanager-0, alertmanager-1)
```

### Send Alert to Both Replicas

```bash
# Port-forward to AlertManager pod 0
kubectl -n monitoring port-forward pod/alertmanager-0 9093:9093 &

# Send alert to first replica
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestDeduplication",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "Deduplication test",
      "description": "Testing deduplication across replicas"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Also send to second replica
# Kill first port-forward, start new one to pod 1
pkill -f "port-forward pod/alertmanager-0"
kubectl -n monitoring port-forward pod/alertmanager-1 9093:9093 &
# ... same curl request
```

### Verify Single Slack Notification

**Expected:**
- Despite sending to both replicas, only 1 Slack message
- Deduplication cluster-aware
- No duplicate notifications

**Success Criteria:**
- Single Slack notification (not 2)
- AlertManager deduplication working
- Cluster-wide alert status consistent

---

## Test 6: Alert Resolution

### Fire Test Alert

```bash
# Send initial alert
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestResolution",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "Test alert for resolution testing",
      "description": "This alert will be resolved to test state transitions"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

Wait 10 seconds, then verify in Slack:
- Initial message shows "firing" status
- Emoji: 🔴 (red)

### Resolve Alert

```bash
# Send alert with resolution timestamp
CURRENT_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
PAST_TIME=$(date -u -d '1 hour ago' +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestResolution",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "Test alert for resolution testing",
      "description": "This alert will be resolved to test state transitions"
    },
    "startsAt": "'$PAST_TIME'",
    "endsAt": "'$CURRENT_TIME'"
  }]'
```

### Verify Resolution Notification in Slack

**Expected Behavior:**
- First message: "🔴 CRITICAL (1 alert) TestResolution" (firing)
- Second message: "🟢 RESOLVED (0 alerts) TestResolution" (resolved)
- Or: Original message updated with "RESOLVED" status

**Slack Message Format (Resolved):**
```
🟢 RESOLVED (0 alerts)
TestResolution
Resolved at 2024-01-01 12:30:00 UTC
Firing since: 2024-01-01 11:30:00 UTC
Duration: 1 hour
```

**Success Criteria:**
- Alert state transitions fire→resolved
- Slack shows both firing and resolved messages
- Resolution timestamp visible
- Green emoji 🟢 for resolved

---

## Test 7: Silence Functionality

### Create Test Silence

```bash
# Create 10-minute silence for test alert
START_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
END_TIME=$(date -u -d '+10 minutes' +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST 'http://localhost:9093/api/v1/silences' \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [
      {"name": "alertname", "value": "TestSilence", "isRegex": false}
    ],
    "startsAt": "'$START_TIME'",
    "endsAt": "'$END_TIME'",
    "comment": "Testing silence functionality"
  }' | jq '.silenceID'
# Save silenceID for later
```

### Verify Silence is Active

```bash
# List active silences
curl -s 'http://localhost:9093/api/v1/silences' | jq '.data[] | select(.comment=="Testing silence functionality")'
# Expected: Silence visible with correct time range
```

### Fire Alert During Silence

```bash
# Send alert that matches silence matcher
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "TestSilence",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "This alert should be silenced",
      "description": "Testing silence suppression"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

### Verify No Slack Notification

**Expected:**
- Alert appears in AlertManager (still tracked)
- **NO** Slack notification sent
- Silence prevents external notification

Check in Slack:
```bash
# No message should appear in #monitoring-staging-critical
# Alert visible in AlertManager UI but marked as "silenced"
curl -s 'http://localhost:9093/api/v1/alerts' | jq '.data[] | select(.labels.alertname=="TestSilence")'
# Note the "silenced" property should be true
```

**Success Criteria:**
- Alert in AlertManager but silenced (no Slack)
- Silence duration respected
- Can verify in AlertManager UI

### Delete Silence

```bash
# Delete the silence
curl -X DELETE 'http://localhost:9093/api/v1/silences/{silenceID}'
# Expected: HTTP 200
```

Verify silence removed:

```bash
curl -s 'http://localhost:9093/api/v1/silences' | jq '.data | length'
# Should be one less than before
```

---

## Test 8: Alert Inhibition

### Setup Inhibition Rule

Verify inhibition rules are configured in AlertManager:

```bash
# Check for inhibition rules
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.inhibit_rules'
# Expected: Inhibition rules for cascading alerts
```

Example inhibition rule (NodeDown inhibits PodDown):

```yaml
inhibit_rules:
  - source_match:
      severity: 'critical'
      alertname: 'NodeDown'
    target_match:
      severity: 'warning'
      alertname: 'PodDown'
    equal: ['node']
```

### Fire Node Alert

```bash
# Send critical node down alert
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "NodeDown",
      "severity": "critical",
      "cluster": "staging",
      "node": "node-1"
    },
    "annotations": {
      "summary": "Node down",
      "description": "Node node-1 is down"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

### Fire Pod Alert

```bash
# Send pod down alert for pod on same node
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "PodDown",
      "severity": "warning",
      "cluster": "staging",
      "node": "node-1",
      "pod": "test-pod"
    },
    "annotations": {
      "summary": "Pod down",
      "description": "Pod test-pod is down"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

### Verify Only Node Alert in Slack

**Expected:**
- Slack notification for NodeDown (critical)
- **NO** notification for PodDown (inhibited by NodeDown on same node)
- PodDown visible in AlertManager but marked "silenced by inhibition rule"

**Success Criteria:**
- Only critical NodeDown alert in Slack
- PodDown inhibited (visible in AlertManager but suppressed)
- Prevents alert noise when parent problem exists

---

## Test 9: Alert Notification Format

### Verify Message Structure

Send a test alert and check Slack message format:

```bash
curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "FormatTest",
      "severity": "critical",
      "cluster": "staging",
      "service": "router",
      "instance": "10.0.1.5:8080"
    },
    "annotations": {
      "summary": "High error rate detected",
      "description": "Error rate exceeds 5% threshold",
      "dashboard": "https://grafana.example.com/d/router-overview",
      "runbook": "https://wiki.example.com/runbooks/error-rate"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'
```

**Expected Slack Message:**

```
🔴 CRITICAL (1 alert) FormatTest
High error rate detected

cluster: staging
service: router
instance: 10.0.1.5:8080

Description: Error rate exceeds 5% threshold

[View in Grafana] [Runbook] [Silence]
```

**Success Criteria:**
- Severity emoji (🔴🟠🟢) present
- Alert count shown
- All labels included
- Summary and description displayed
- Annotations (dashboard, runbook) as links
- Action buttons present (Silence, Acknowledge)

---

## Test 10: Slack Link Validation

### Verify Grafana Links Work

```bash
# Check that dashboard links in Slack messages are correct
# Click links in Slack messages and verify:
# 1. Links are not 404
# 2. Dashboard loads with correct filters applied
# 3. Alert context visible in Grafana
```

---

## Alert Performance Baselines

### Measure Alert Detection Latency

```bash
# Time from metric change to Slack notification
# Send alert and note exact time
START_TIME=$(date +%s%N)

curl -X POST 'http://localhost:9093/api/v1/alerts' \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {
      "alertname": "LatencyTest",
      "severity": "critical",
      "cluster": "staging"
    },
    "annotations": {
      "summary": "Latency test"
    },
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'",
    "endsAt": "0001-01-01T00:00:00Z"
  }]'

# Monitor Slack and note when message appears
# Typical latency: <2 minutes
# Expected: <120 seconds from alert to notification
```

**Success Criteria:**
- Alert detection <2 minutes
- Typical latency <60 seconds
- Consistent performance

---

## Troubleshooting

### Alerts Not Appearing in AlertManager

```bash
# Check AlertManager logs
kubectl -n monitoring logs -f deployment/alertmanager --tail=50

# Verify webhook is accessible
curl -s 'http://localhost:9093/-/healthy'

# Check configuration
kubectl -n monitoring get configmap alertmanager-config -o yaml
```

### Alerts Not Reaching Slack

```bash
# Check AlertManager logs for webhook failures
kubectl -n monitoring logs deployment/alertmanager | grep -i slack

# Verify Slack webhook URL
kubectl -n monitoring get secret alertmanager-secrets -o yaml | grep slack_webhook

# Test webhook URL directly
WEBHOOK_URL="$(kubectl -n monitoring get secret alertmanager-secrets -o jsonpath='{.data.slack_webhook}' | base64 -d)"
curl -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Test message"}'
```

### Messages Not Grouped

```bash
# Check grouping configuration
curl -s 'http://localhost:9093/api/v1/status' | jq '.config.route.group_by'

# Verify group_wait and group_interval
# Too long wait/interval → no grouping
# Too short → messages sent before more alerts arrive
```

---

## Success Checklist

- [ ] Critical alerts route to #monitoring-staging-critical
- [ ] Warning alerts route to #monitoring-staging-alerts
- [ ] Info alerts route to #monitoring-staging-general
- [ ] Alert grouping: 5 alerts → 1 message
- [ ] Deduplication: same alert from 2 replicas → 1 message
- [ ] Alert resolution: firing→resolved state shown
- [ ] Silences: silenced alerts don't notify Slack
- [ ] Inhibition: parent alerts suppress child alerts
- [ ] Message format includes severity emoji, labels, description
- [ ] Grafana/Runbook links in Slack messages work
- [ ] Alert detection latency <2 minutes
- [ ] No missing or duplicate notifications
