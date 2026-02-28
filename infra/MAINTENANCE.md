# Maintenance & Upgrades Guide - ClarityRouter Observability Stack

## Overview

This document outlines procedures for maintaining, upgrading, and patching the production observability stack to ensure security, stability, and feature availability.

**Maintenance Window:** Monthly (typically first Sunday of month, 2-4 AM UTC)  
**Upgrade Testing:** All upgrades tested in staging before production deployment

---

## Table of Contents

1. [Helm Chart Upgrades](#helm-chart-upgrades)
2. [Kubernetes Version Upgrades](#kubernetes-version-upgrades)
3. [Certificate Management](#certificate-management)
4. [Node Maintenance](#node-maintenance)
5. [Dependency Updates](#dependency-updates)
6. [Security Patching](#security-patching)
7. [Maintenance Checklist](#maintenance-checklist)

---

## Helm Chart Upgrades

### Check for Available Updates

```bash
# Update Helm repositories
helm repo update

# Check for updates to installed charts
helm search repo prometheus-community/kube-prometheus-stack --versions | head -20
helm search repo grafana/grafana --versions | head -20
helm search repo loki/loki --versions | head -20

# List currently installed versions
helm list -n observability
```

Example output:
```
NAME        NAMESPACE       REVISION  UPDATED             STATUS    CHART                             APP VERSION
prometheus  observability   1         2026-02-01          deployed  kube-prometheus-stack-54.1.0     v1.26.0
loki        observability   1         2026-02-01          deployed  loki-stack-2.11.0                v3.4.0
grafana     observability   1         2026-02-01          deployed  grafana-6.43.5                   v9.3.1
```

### Review Release Notes

Before upgrading, review what's changing:

```bash
# Check chart difference
helm diff upgrade prometheus \
  prometheus-community/kube-prometheus-stack \
  -n observability \
  -f prometheus/values-prod.yaml

# Check what changed in specific release
# Visit GitHub release page:
# https://github.com/prometheus-community/helm-charts/releases
# https://github.com/grafana/helm-charts/releases
# https://github.com/grafana/loki/releases

# Look for:
# - Breaking changes (rare in minor updates)
# - Security fixes (urgent)
# - Performance improvements
# - New features (optional)
```

### Test Upgrade in Staging

Before touching production, test in staging environment:

```bash
# In staging cluster
helm upgrade prometheus \
  prometheus-community/kube-prometheus-stack \
  --namespace observability \
  -f prometheus/values-staging.yaml \
  --wait \
  --timeout 10m

# Verify staging health
kubectl get pods -n observability
kubectl get statefulset -n observability

# Run staging tests
./verify-production.sh  # Modify for staging

# Check for any errors or warnings
kubectl logs -n observability -l app.kubernetes.io/name=prometheus --since=5m | grep -i error
```

### Production Upgrade Procedure

```bash
#!/bin/bash
# Production Helm Upgrade Script

set -euo pipefail

# Configuration
NAMESPACE="observability"
CHART="prometheus"
TIMEOUT="10m"

# Pre-upgrade checks
echo "=== Pre-Upgrade Checks ==="
kubectl get pods -n $NAMESPACE
kubectl top pods -n $NAMESPACE
kubectl get pvc -n $NAMESPACE

# Create backup
echo "=== Creating Backup ==="
kubectl get configmap -n $NAMESPACE -o yaml > configmap-backup-$(date +%Y%m%d).yaml
helm get values $CHART -n $NAMESPACE > helm-values-backup-$(date +%Y%m%d).yaml

# Announce maintenance
echo "=== Announcing Maintenance ==="
# Post to Slack: "Maintenance window starting - Prometheus upgrading"

# Perform upgrade
echo "=== Upgrading $CHART ==="
helm upgrade $CHART \
  prometheus-community/kube-prometheus-stack \
  --namespace $NAMESPACE \
  -f prometheus/values-prod.yaml \
  --wait \
  --timeout $TIMEOUT \
  --atomic  # Rollback on failure

# Verify upgrade
echo "=== Post-Upgrade Verification ==="
kubectl get pods -n $NAMESPACE
kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=prometheus --tail=20

# Test connectivity
kubectl port-forward -n $NAMESPACE svc/prometheus-kube-prom-prometheus 9090:9090 &
sleep 2
curl -s http://localhost:9090/-/healthy || echo "Health check failed"
kill %1

# Confirm completion
echo "=== Upgrade Complete ==="
echo "Announce to team: Upgrade complete and verified"

# Document upgrade
cat > upgrade-record-$(date +%Y%m%d).txt << EOF
Upgrade Date: $(date)
Component: $CHART
From Version: $(helm history $CHART -n $NAMESPACE | tail -2 | head -1 | awk '{print $9}')
To Version: $(helm list -n $NAMESPACE | grep $CHART | awk '{print $9}')
Status: Successful
Duration: [X minutes]
Issues: None
EOF
```

### Safe Upgrade with Helm Hooks

Helm provides hooks for lifecycle management:

```yaml
# Pre-upgrade: Backup data
apiVersion: batch/v1
kind: Job
metadata:
  name: prometheus-backup
  annotations:
    helm.sh/hook: pre-upgrade
    helm.sh/hook-weight: "-5"
spec:
  template:
    spec:
      containers:
      - name: backup
        image: busybox
        command: ['sh', '-c', 'tar -czf /tmp/prometheus-backup.tar.gz /prometheus/']
      restartPolicy: Never
```

### Rollback if Issues Found

If upgrade causes problems:

```bash
# Immediate rollback (fast)
helm rollback prometheus 1 -n observability --wait

# Verify rollback
kubectl get pods -n observability
kubectl logs -n observability -l app.kubernetes.io/name=prometheus --tail=20

# Document issue
cat > upgrade-issue-$(date +%Y%m%d).txt << EOF
Issue: [Description]
Prometheus Version: [Version that caused issue]
Action: Rolled back to previous version
Root Cause: [Investigate and document]
Resolution: [Fix or workaround]
EOF
```

---

## Kubernetes Version Upgrades

### EKS Cluster Upgrades

Amazon EKS handles control plane updates automatically. Node upgrades require manual action.

### Pre-Upgrade Assessment

```bash
# Check current cluster version
kubectl version --short

# Check available upgrade path
aws eks describe-cluster \
  --name clarity-router-prod \
  --region us-east-1 \
  --query 'cluster.version'

# Review Kubernetes changelog
# https://github.com/kubernetes/kubernetes/releases
```

### Test in Staging Cluster

```bash
# Create staging cluster with target Kubernetes version
aws eks create-cluster \
  --name clarity-router-prod-staging \
  --version 1.28 \
  --role-arn arn:aws:iam::ACCOUNT:role/eks-service-role \
  --resources-vpc-config subnetIds=subnet-xxxxx,securityGroupIds=sg-xxxxx

# Deploy observability stack
helm upgrade --install prometheus ... -n observability

# Run full test suite
./verify-production.sh

# Test workload functionality
# Ensure all components work with new K8s version
```

### Production Upgrade Steps

```bash
#!/bin/bash
# Kubernetes cluster upgrade

# Step 1: Update control plane (done by AWS)
echo "Control plane upgrade scheduled automatically"
echo "Check: aws eks describe-cluster --name clarity-router-prod"

# Step 2: Wait for control plane (30 min - 2 hours)
aws eks wait cluster-active --name clarity-router-prod

# Step 3: Update node groups (rolling update, no downtime)
# Option A: Using eksctl
eksctl upgrade nodegroup \
  --cluster=clarity-router-prod \
  --name=nodegroup-primary \
  --kubernetes-version=1.28

# Option B: Using AWS console or AWS CLI

# Step 4: Verify all nodes upgraded
kubectl get nodes -o wide

# Step 5: Verify pod health
kubectl get pods -n observability

# Step 6: Run smoke tests
kubectl run test-pod --image=curlimages/curl -n observability --rm -it -- \
  curl http://prometheus-kube-prom-prometheus:9090/-/healthy
```

### Compatibility Notes

The observability stack uses standard Kubernetes APIs (no alpha/beta), so upgrades are usually safe. However:

1. **EFS CSI Driver** - Verify compatibility with new K8s version
2. **Helm Charts** - May require update if they depend on deprecated APIs
3. **RBAC** - Review for any changes to role/binding APIs

---

## Certificate Management

### TLS Certificate Lifecycle

Certificates are auto-renewed by cert-manager (if enabled):

```bash
# Check if cert-manager installed
kubectl get deployment -n cert-manager

# List certificates
kubectl get certificates -n observability -o wide

# Check certificate expiry
kubectl get certificate -n observability -o json | \
  jq '.items[] | {name: .metadata.name, expires: .status.renewalTime}'

# Monitor certificate in Prometheus
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=certmanager_certificate_expiration_timestamp_seconds' | jq .
```

### Alert on Certificate Expiry

```yaml
# Alert rule
alert: CertificateExpiring
expr: (certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 7
for: 1h
annotations:
  summary: "Certificate expiring in {{ $value | humanize }} days"
```

### Manual Certificate Rotation (if needed)

```bash
# Delete existing certificate (triggers renewal)
kubectl delete certificate <cert-name> -n observability

# cert-manager will automatically recreate and renew

# Verify renewal
kubectl get certificate <cert-name> -n observability -w
```

### Self-Signed Certificates (for Internal Use)

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=prometheus.observability.svc.cluster.local"

# Create secret
kubectl create secret tls prometheus-tls \
  --cert=cert.pem \
  --key=key.pem \
  -n observability

# Use in ingress
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prometheus
  namespace: observability
spec:
  tls:
  - hosts:
    - prometheus.observability.svc.cluster.local
    secretName: prometheus-tls
  rules:
  - host: prometheus.observability.svc.cluster.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: prometheus-kube-prom-prometheus
            port:
              number: 9090
EOF
```

---

## Node Maintenance

### Safe Node Drain (PodDisruptionBudgets)

The observability stack uses PDB to ensure availability during node maintenance:

```bash
# Check PDB configuration
kubectl get poddisruptionbudget -n observability

# Example output:
# NAME                                MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# prometheus-kube-prom-prometheus     1               <none>            1                     30d
# loki                                1               <none>            1                     30d
```

### Drain a Node (Safe)

```bash
# Cordon the node (stop new pods)
kubectl cordon <node-name>

# Drain the node (evict existing pods)
# PDB ensures observability pods don't all evict at once
kubectl drain <node-name> \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=300

# Verify observability pods moved to other nodes
kubectl get pods -n observability -o wide | grep -v <node-name>

# Perform maintenance (e.g., updates, patches)

# Uncordon when done
kubectl uncordon <node-name>

# Verify node rejoins cluster
kubectl get nodes
```

### Monitor During Node Maintenance

```bash
# Watch pod scheduling
kubectl get pods -n observability -w

# Check node capacity
kubectl describe node <node-name>

# Verify all replicas restarted
kubectl get statefulset -n observability
kubectl get deployment -n observability
```

---

## Dependency Updates

### Update External Dependencies

```bash
# Check for vulnerabilities in container images
# Using a container scanning tool (Snyk, Trivy, etc.)

trivy image prometheus:latest
trivy image grafana/grafana:latest
trivy image grafana/loki:latest

# If vulnerabilities found:
# 1. Note the CVE
# 2. Check when it's fixed in next release
# 3. Upgrade chart version with fixed image

# Verify no breaking changes
# Check release notes before upgrading
```

### Update Helm Chart Dependencies

```bash
# Some Helm charts have sub-chart dependencies
# Update them with:

helm dependency update ./prometheus
helm dependency update ./grafana
helm dependency update ./loki

# This updates Chart.lock file
git add Chart.lock
git commit -m "Update Helm dependencies"
```

---

## Security Patching

### Regular Security Updates

**Frequency:** Monthly (or immediately for critical CVEs)

```bash
# Check for security advisories
# Subscribe to:
# - Kubernetes security mailing list
# - Prometheus security mailing list
# - Grafana security mailing list
# - Loki security mailing list

# When critical CVE announced:
# 1. Determine if it affects your deployment
# 2. Check if newer chart version fixes it
# 3. Test in staging
# 4. Deploy to production immediately
```

### RBAC Review

Review permissions quarterly:

```bash
# Check RBAC rules
kubectl get clusterrole -l app.kubernetes.io/name=prometheus
kubectl get clusterrolebinding | grep observability
kubectl get role -n observability
kubectl get rolebinding -n observability

# Verify principle of least privilege
# Remove any overly broad permissions
# Example: avoid wildcard "*" in verbs/resources
```

### Secret Rotation

```bash
# Rotate Slack webhook (every 90 days)
# Update in Secrets Manager
aws secretsmanager update-secret \
  --secret-id slack-webhook-prod \
  --secret-string "https://hooks.slack.com/services/NEW/WEBHOOK"

# Update in Kubernetes
kubectl delete secret slack-webhook -n observability
# Then re-create or use External Secrets Operator

# Rotate PagerDuty key (every 90 days)
# Same process as Slack webhook

# Rotate Grafana admin password (every 90 days)
kubectl delete secret grafana-admin -n observability
# Recreate with new password
```

---

## Maintenance Checklist

### Weekly Maintenance (15 minutes)

- [ ] Check for pod restarts: `kubectl get pods -n observability`
- [ ] Review logs for errors: `kubectl logs -n observability --since=7d | grep -i error | wc -l`
- [ ] Verify storage usage: `kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- df -h /prometheus`
- [ ] Check active alerts: `curl -s http://alertmanager:9093/api/v1/alerts | jq '.data | length'`

### Monthly Maintenance (2 hours)

- [ ] Check for Helm chart updates: `helm search repo --updated`
- [ ] Test upgrade in staging
- [ ] Review and apply security patches
- [ ] Rotate secrets (if due)
- [ ] Review RBAC policies
- [ ] Run DR drill or backup verification
- [ ] Update documentation

### Quarterly Maintenance (4 hours)

- [ ] Review all logs for patterns/issues
- [ ] Plan capacity for next quarter
- [ ] Update runbooks based on incidents
- [ ] Review and optimize alert rules
- [ ] Perform full disaster recovery drill
- [ ] Update SLA/SLO metrics

### Annual Maintenance (8 hours)

- [ ] Complete security audit
- [ ] Review all policies and procedures
- [ ] Plan major upgrades (K8s version, etc.)
- [ ] Evaluate alternative solutions (if needed)
- [ ] Review cost and efficiency
- [ ] Comprehensive documentation review

---

## Maintenance Template

```markdown
## Maintenance Performed - [Date]

### Type
- [ ] Routine maintenance
- [ ] Security patch
- [ ] Helm upgrade
- [ ] Kubernetes upgrade
- [ ] Certificate renewal
- [ ] Node maintenance

### Components Affected
[List: Prometheus, Grafana, Loki, AlertManager, Promtail]

### Changes Made
[Detailed description]

### Duration
Start: [Time] | End: [Time] | Duration: [X minutes]

### Impact
- [ ] No impact (verified zero downtime)
- [ ] Minimal impact (<1 min)
- [ ] Brief outage ([X min])
- [ ] Planned maintenance window

### Verification
- [ ] All pods running
- [ ] Metrics flowing
- [ ] Logs ingesting
- [ ] Dashboards accessible
- [ ] Alerts working

### Issues Encountered
[If any: Description and resolution]

### Notes
[Any additional information]

### Approved By
Engineer: _________________ | Manager: _________________

### Rollback Plan (if needed)
[Steps to rollback if maintenance caused issues]
```

---

## Emergency Maintenance (Out-of-Window)

For critical security issues requiring immediate patching:

```bash
# Declare emergency maintenance
message="
:warning: EMERGENCY MAINTENANCE

Type: Critical security patch
Component: [Component]
Reason: [CVE or issue]
Estimated Duration: [X minutes]

Will update every 5 minutes.
"

# Execute upgrade/patch
# Follow normal upgrade procedure but without staging test

# Post completion
message="
:white_check_mark: Emergency Maintenance Complete

Issue: [Issue fixed]
Duration: [X minutes]
Verification: [Status]

Normal operations resumed.
"

# Document thoroughly
# Schedule post-incident review
```

---

**Related Documentation:**
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - SLOs and incident response
- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - Data protection during maintenance
- [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md) - Optimization after upgrades
