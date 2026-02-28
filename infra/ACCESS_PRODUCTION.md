# Production Component Access - ClarityRouter Observability Stack

## Overview

This document provides multiple methods to access production observability components. All methods require appropriate AWS and Kubernetes credentials.

**Production Cluster:** `clarity-router-prod` (us-east-1)  
**Namespace:** `observability`

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Grafana Access](#grafana-access)
3. [Prometheus Access](#prometheus-access)
4. [Loki Access](#loki-access)
5. [AlertManager Access](#alertmanager-access)
6. [Kibana Access (Optional)](#kibana-access-optional)
7. [Command-Line Access](#command-line-access)
8. [SSH Access to Nodes](#ssh-access-to-nodes)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools

```bash
# Verify tools installed
kubectl version --client
aws --version
helm version
```

### AWS Credentials

Ensure AWS credentials configured for production:

```bash
# Check current AWS identity
aws sts get-caller-identity

# Output should show production account
# {
#   "UserId": "...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/..."
# }
```

### Kubernetes Context

```bash
# Verify kubectl context points to production cluster
kubectl config current-context

# Should output: arn:aws:eks:us-east-1:123456789012:cluster/clarity-router-prod

# If not, update context
aws eks update-kubeconfig --name clarity-router-prod --region us-east-1
```

### Required Credentials

Retrieve credentials needed for each component:

```bash
# Grafana admin password
GRAFANA_ADMIN=$(kubectl get secret grafana-admin -n observability \
  -o jsonpath='{.data.admin-password}' | base64 -d)
echo "Grafana admin password: $GRAFANA_ADMIN"

# Slack webhook (for testing alerts)
SLACK_WEBHOOK=$(kubectl get secret slack-webhook -n observability \
  -o jsonpath='{.data.webhook-url}' | base64 -d)
echo "Slack webhook URL: ${SLACK_WEBHOOK:0:50}..."
```

---

## Grafana Access

### Method 1: Port-Forward (Recommended for Development)

Easiest method for local access, requires no firewall changes.

```bash
# Start port forward in background
kubectl port-forward -n observability svc/grafana 3000:80 &

# Note the job number, e.g., [1] 12345

# Access in browser
# http://localhost:3000

# Stop port forward when done
kill %1
```

**Login credentials:**
- Username: `admin`
- Password: Retrieved from secret (see Prerequisites)

### Method 2: Kubernetes Service (Internal Only)

For access from within the cluster:

```bash
# Get service details
kubectl get svc grafana -n observability

# Service endpoint: grafana.observability.svc.cluster.local:80
# Internal URL: http://grafana.observability.svc.cluster.local
```

### Method 3: LoadBalancer (If Configured)

For external access without port-forwarding:

```bash
# Check if LoadBalancer service exists
kubectl get svc -n observability -o wide

# If LoadBalancer service found, get external IP
GRAFANA_LB=$(kubectl get svc grafana-lb -n observability -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)

if [[ -z "$GRAFANA_LB" ]]; then
    echo "No LoadBalancer service configured. Use port-forward method."
else
    echo "Access Grafana at: http://$GRAFANA_LB"
fi
```

### Method 4: AWS ALB (If Configured)

For enterprise deployments with Application Load Balancer:

```bash
# Get ALB address
GRAFANA_ALB=$(kubectl get ingress -n observability grafana-ingress \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)

if [[ -n "$GRAFANA_ALB" ]]; then
    echo "Access Grafana at: https://$GRAFANA_ALB"
else
    echo "No ALB ingress configured"
fi
```

### Grafana Features Available

Once logged in:

- **Dashboards**: Pre-configured boards showing router and infrastructure metrics
- **Data Sources**: Prometheus and Loki configured and ready
- **Alerts**: View alert rules and history
- **Notifications**: Manage alert notification channels
- **Users**: Manage team members and permissions (admin only)

---

## Prometheus Access

### Method 1: Port-Forward

```bash
# Start port forward
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &

# Access in browser
# http://localhost:9090

# Key URLs:
# - Targets: http://localhost:9090/targets
# - Alerts: http://localhost:9090/alerts
# - Graph: http://localhost:9090/graph
# - ServiceMonitors: http://localhost:9090/service-discovery
```

### Method 2: Kubernetes Service

```bash
# Service details
kubectl get svc prometheus-kube-prom-prometheus -n observability

# Service endpoint: prometheus-kube-prom-prometheus.observability.svc.cluster.local:9090
```

### Method 3: HTTP API

```bash
# Query Prometheus API
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &

# Test health endpoint
curl -s http://localhost:9090/-/healthy

# Query metrics
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq .

# Query range (last 1 hour)
curl -s 'http://localhost:9090/api/v1/query_range?query=up&start=1677700800&end=1677704400&step=60' | jq .
```

### Prometheus Key Pages

- **Targets** (`/targets`): Status of monitored targets
- **Alerts** (`/alerts`): Current alerts and rules
- **Rules** (`/rules`): Configured alert and recording rules
- **Configuration** (`/config`): Prometheus configuration (YAML)
- **Flags** (`/flags`): Command-line flags used

---

## Loki Access

### Method 1: Port-Forward (for API testing)

```bash
# Start port forward
kubectl port-forward -n observability svc/loki 3100:3100 &

# Test health endpoint
curl -s http://localhost:3100/ready

# Query logs via API
curl -s 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="kubernetes-pods"}' \
  --data-urlencode 'start=1677700800' \
  --data-urlencode 'end=1677704400' | jq .
```

### Method 2: Grafana Explore

Preferred method for log exploration:

1. Open Grafana (see Grafana Access section)
2. Click **Explore** (left sidebar)
3. Select **Loki** data source
4. Write LogQL query: `{job="kubernetes-pods"} | json`
5. Click **Run Query**

### Example LogQL Queries

```logql
# All logs from all pods
{job="kubernetes-pods"}

# Logs from specific pod
{pod_name="prometheus-0"}

# Error logs only
{job="kubernetes-pods"} | json | level="error"

# Logs from specific namespace
{namespace="observability"}

# Parse JSON and filter
{job="kubernetes-pods"} | json | level="warn"

# Pattern matching
{job="kubernetes-pods"} | "ERROR"

# Metrics from logs (count errors per pod)
sum(rate({job="kubernetes-pods"} | json | level="error" [5m])) by (pod_name)
```

---

## AlertManager Access

### Method 1: Port-Forward

```bash
# Start port forward
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &

# Access in browser
# http://localhost:9093

# Key sections:
# - Alerts: Shows fired alerts
# - Silences: Manage alert silences
# - Configuration: View current routing rules
```

### Method 2: API Access

```bash
# Port forward to AlertManager
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &

# Get all alerts
curl -s http://localhost:9093/api/v1/alerts | jq .

# Get alerts for specific group
curl -s 'http://localhost:9093/api/v1/alerts?receiver=slack' | jq .

# Create silence (prevent notifications for 1 hour)
curl -X POST http://localhost:9093/api/v1/silences \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [
      {"name": "alertname", "value": "PrometheusDown", "isRegex": false}
    ],
    "startsAt": "'$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')'",
    "endsAt": "'$(date -u -d '+1 hour' +'%Y-%m-%dT%H:%M:%S.000Z')'",
    "createdBy": "on-call-engineer",
    "comment": "Maintenance window"
  }'
```

### AlertManager Configuration

View the current routing configuration:

```bash
# View ConfigMap
kubectl get configmap alertmanager-config -n observability -o yaml

# Check routing rules
kubectl get configmap alertmanager-config -n observability \
  -o jsonpath='{.data.alertmanager\.yml}' | grep -A 20 "routes:"
```

---

## Kibana Access (Optional)

If Elasticsearch and Kibana are deployed alongside the stack:

```bash
# Check if Kibana service exists
kubectl get svc kibana -n observability 2>/dev/null

# If present, port forward
kubectl port-forward -n observability svc/kibana 5601:5601 &

# Access at http://localhost:5601
```

---

## Command-Line Access

### Direct Pod Access (Debugging)

```bash
# Get shell access to Prometheus pod
kubectl exec -it -n observability prometheus-kube-prom-prometheus-0 -- /bin/sh

# Get shell access to Loki pod
kubectl exec -it -n observability loki-0 -- /bin/sh

# Get shell access to Grafana pod
kubectl exec -it -n observability grafana-7d8f5c9b8-2n9m9 -- /bin/sh

# View logs of pod
kubectl logs -n observability prometheus-kube-prom-prometheus-0 --tail=100

# View logs in real-time
kubectl logs -n observability prometheus-kube-prom-prometheus-0 -f
```

### Kubernetes API Access

```bash
# Get pod details
kubectl describe pod -n observability prometheus-kube-prom-prometheus-0

# Get pod resource usage
kubectl top pods -n observability

# Get events
kubectl get events -n observability --sort-by='.lastTimestamp'

# Export pod YAML
kubectl get pod -n observability prometheus-kube-prom-prometheus-0 -o yaml
```

### Helm Release Information

```bash
# Get Helm release status
helm status prometheus -n observability
helm status loki -n observability
helm status grafana -n observability

# Get Helm values used
helm get values prometheus -n observability

# Get Helm history
helm history prometheus -n observability
```

---

## SSH Access to Nodes

### Get Node Details

```bash
# List nodes
kubectl get nodes -o wide

# Get node information
kubectl describe node <node-name>

# SSH to node (from bastion or with proper security group)
ssh ec2-user@<node-ip>

# View node system logs
kubectl logs --tail=50 <pod-name> -n observability

# Or inspect at node level
ssh ec2-user@<node-ip>
sudo journalctl -u kubelet -n 100
```

### AWS Systems Manager Session Manager (Recommended)

More secure than direct SSH:

```bash
# List instances in production cluster
aws ec2 describe-instances \
  --filters "Name=tag:kubernetes.io/cluster/clarity-router-prod,Values=owned" \
  --region us-east-1 \
  --query 'Reservations[*].Instances[*].[InstanceId,PrivateIpAddress]' \
  --output table

# Start session manager session
aws ssm start-session --target i-0123456789abcdef --region us-east-1

# Now connected to node shell:
sudo systemctl status kubelet
sudo journalctl -u kubelet -n 50 -f
```

---

## Access Control & Security

### RBAC Verification

```bash
# View current user permissions
kubectl auth can-i get pods --namespace observability
kubectl auth can-i get pods --namespace default

# View all RBAC rules
kubectl get clusterrolebindings -l app.kubernetes.io/name=prometheus
kubectl get rolebindings -n observability

# View permissions for specific service account
kubectl describe rolebinding <binding-name> -n observability
```

### IP Whitelist (If Configured)

For LoadBalancer/ALB access:

```bash
# Check security group rules
aws ec2 describe-security-groups \
  --filters "Name=tag:Environment,Values=production" \
  --region us-east-1 \
  --query 'SecurityGroups[*].[GroupId,GroupName,IpPermissions[*]]' \
  --output table
```

### Network Policy Review

```bash
# Check network policies
kubectl get networkpolicy -n observability -o wide

# View network policy details
kubectl describe networkpolicy <policy-name> -n observability
```

---

## Access Methods Matrix

| Component | Port | Method 1 | Method 2 | Method 3 | Auth Required |
|-----------|------|----------|----------|----------|---------------|
| **Grafana** | 3000 | Port-Forward | Service | LoadBalancer | Yes (admin) |
| **Prometheus** | 9090 | Port-Forward | Service | ALB | No |
| **Loki** | 3100 | Port-Forward | Service | API | No |
| **AlertManager** | 9093 | Port-Forward | Service | API | No |
| **Pod Shell** | N/A | kubectl exec | SSH (SSH) | SSM Session | Yes (auth) |

---

## Common Access Patterns

### Daily Operations Access

```bash
# 1. Port forward to Grafana (dashboard monitoring)
kubectl port-forward -n observability svc/grafana 3000:80 &

# 2. Port forward to Prometheus (metric querying)
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &

# 3. Port forward to AlertManager (alert review)
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &

# Now open:
# - http://localhost:3000 (Grafana)
# - http://localhost:9090 (Prometheus)
# - http://localhost:9093 (AlertManager)
```

### Incident Response Access

```bash
# 1. Check pod status
kubectl get pods -n observability

# 2. View recent logs
kubectl logs -n observability <pod-name> --tail=50

# 3. Port forward to relevant service
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &

# 4. Query metrics
curl -s 'http://localhost:9090/api/v1/query?query=up'

# 5. Access AlertManager for silence/routing
kubectl port-forward -n observability svc/prometheus-kube-prom-alertmanager 9093:9093 &
```

### Database/Storage Troubleshooting

```bash
# Check storage usage
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- df -h /prometheus

# Check logs for storage errors
kubectl logs -n observability prometheus-kube-prom-prometheus-0 | grep -i "storage\|disk\|space"

# View PVC details
kubectl describe pvc prometheus-storage -n observability
```

---

## Troubleshooting Access Issues

### Port-Forward Not Working

```bash
# Error: "error: unable to forward port because pod is not running"
# Solution: Check pod status
kubectl get pods -n observability

# Error: "bind: Address already in use"
# Solution: Use different port or kill existing process
lsof -i :3000
kill -9 <PID>
```

### Kubernetes Context Issues

```bash
# Error: "Unable to connect to the server: dial tcp..."
# Solution: Verify context and credentials
kubectl config current-context
kubectl config use-context arn:aws:eks:us-east-1:...:cluster/clarity-router-prod

# Refresh credentials
aws sso login
aws eks update-kubeconfig --name clarity-router-prod --region us-east-1
```

### Service Not Accessible

```bash
# Check if service exists
kubectl get svc -n observability

# Check if pods are running
kubectl get pods -n observability

# Check service endpoints
kubectl get endpoints -n observability

# Test connectivity within cluster
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl http://grafana:80
```

---

## Secure Access Best Practices

1. **Never share credentials** - Use IAM roles and RBAC
2. **Use temporary sessions** - Port-forward only when needed
3. **Enable MFA** - For AWS API access
4. **Audit access** - Review CloudTrail logs for accessed resources
5. **Minimize permissions** - Only grant necessary RBAC roles
6. **Rotate credentials** - Regularly update service account tokens
7. **Use VPN/Bastion** - For off-office access, use corporate VPN
8. **Enable TLS** - For external access, use certificate-based authentication

---

**Related Documentation:**
- [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) - Deployment checklist
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - On-call procedures
- [`VERIFY_PRODUCTION.md`](VERIFY_PRODUCTION.md) - Post-deployment verification
