# Rollback Procedure - Observability Stack
## Staging Cluster (`clarity-router-staging`, us-west-2)

**Document Version:** 1.0  
**Date:** February 15, 2026  

---

## Overview

This document provides step-by-step procedures for safely uninstalling and rolling back the observability stack from the staging cluster, from both automated and manual approaches.

**⚠️ WARNING:** These procedures are destructive. Ensure you have:
- Approved the rollback decision with operations team
- Backed up any custom configurations
- Documented any issues requiring rollback
- Confirmed target environment before executing

---

## Quick Rollback (Automated Script)

For rapid rollback with all prompts disabled:

```bash
# Automated rollback (uninstall all, keep secrets)
bash infra/rollback-staging.sh --auto

# Automated rollback with full cleanup (remove secrets too)
bash infra/rollback-staging.sh --auto --full-cleanup
```

---

## Step-by-Step Rollback Procedure

### Phase 1: Pre-Rollback Checklist

#### Document Current State (Optional)

Before uninstalling, optionally capture current state for investigation:

```bash
# Export Grafana dashboards
kubectl port-forward -n monitoring svc/grafana 3000:3000 &
GRAFANA_PASS=$(kubectl get secret grafana-admin-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d)

for uid in $(curl -s -u admin:$GRAFANA_PASS http://localhost:3000/api/search | jq -r '.[].uid' 2>/dev/null); do
  curl -s -u admin:$GRAFANA_PASS http://localhost:3000/api/dashboards/uid/$uid | jq '.' > dashboard-$uid.json
done

# Export Prometheus configuration
kubectl get prometheus -n monitoring -o yaml > prometheus-backup.yaml
kubectl get prometheusrule -n monitoring -o yaml > prometheusrule-backup.yaml
kubectl get servicemonitor -n monitoring -o yaml > servicemonitor-backup.yaml

# Export AlertManager configuration
kubectl get alertmanagerconfig -n monitoring -o yaml > alertmanager-config-backup.yaml
```

#### Verify Target Environment

```bash
# Confirm correct context
kubectl config current-context
# Expected: arn:aws:eks:us-west-2:...:cluster/clarity-router-staging

# Verify cluster name matches
kubectl config view | grep "name: clarity-router-staging"
# Expected: Should find the cluster name

# Double-check namespace to delete
kubectl get namespace monitoring
# Expected: Should show monitoring namespace exists
```

#### Check for Active Workloads

```bash
# Verify no critical workloads depend on observability stack
kubectl get pods -n clarity-router 2>/dev/null | grep -i prometheus || echo "No router dependencies"
kubectl get pods -n clarity-router 2>/dev/null | grep -i grafana || echo "No router dependencies"

# Expected: No dependents found
```

### Phase 2: Uninstall Helm Releases

#### Option A: Uninstall in Reverse Dependency Order

```bash
# Step 1: Uninstall Grafana
helm uninstall grafana -n monitoring --wait
echo "✓ Grafana uninstalled"

# Verify uninstall
kubectl get deployment -n monitoring -l app.kubernetes.io/name=grafana 2>/dev/null || echo "Grafana pods removed"
```

```bash
# Step 2: Uninstall Loki Stack
helm uninstall loki -n monitoring --wait
echo "✓ Loki uninstalled"

# Verify uninstall
kubectl get statefulset -n monitoring -l app=loki 2>/dev/null || echo "Loki pods removed"
kubectl get daemonset -n monitoring -l app=promtail 2>/dev/null || echo "Promtail pods removed"
```

```bash
# Step 3: Uninstall Prometheus Stack
helm uninstall prometheus-stack -n monitoring --wait
echo "✓ Prometheus Stack uninstalled"

# Verify uninstall
kubectl get statefulset -n monitoring -l app.kubernetes.io/name=prometheus 2>/dev/null || echo "Prometheus pods removed"
kubectl get statefulset -n monitoring -l app.kubernetes.io/name=alertmanager 2>/dev/null || echo "AlertManager pods removed"
```

```bash
# Step 4: (Optional) Uninstall cert-manager
helm uninstall cert-manager -n cert-manager --wait
kubectl delete namespace cert-manager --ignore-not-found
echo "✓ cert-manager uninstalled"
```

#### Option B: Uninstall All at Once

```bash
# Uninstall all Helm releases in monitoring namespace
helm uninstall -n monitoring $(helm list -n monitoring -q)

# Uninstall cert-manager if installed
helm uninstall cert-manager -n cert-manager --wait 2>/dev/null || true

# Wait for pods to terminate
kubectl wait --for=delete pod -l app.kubernetes.io/name=prometheus -n monitoring --timeout=60s 2>/dev/null || true
kubectl wait --for=delete pod -l app.kubernetes.io/name=grafana -n monitoring --timeout=60s 2>/dev/null || true

echo "✓ All Helm releases uninstalled"
```

### Phase 3: Clean Up Kubernetes Resources

#### Delete Secrets

```bash
# Remove AlertManager secrets
kubectl delete secret alertmanager-webhooks -n monitoring --ignore-not-found
echo "✓ AlertManager secrets deleted"

# Remove Grafana secrets
kubectl delete secret grafana-admin-secret -n monitoring --ignore-not-found
echo "✓ Grafana secrets deleted"
```

#### Delete Custom Resources

```bash
# Delete ServiceMonitors
kubectl delete servicemonitor -n monitoring --all
echo "✓ ServiceMonitors deleted"

# Delete PrometheusRules
kubectl delete prometheusrule -n monitoring --all
echo "✓ PrometheusRules deleted"

# Delete Prometheus objects
kubectl delete prometheus -n monitoring --all --ignore-not-found
echo "✓ Prometheus objects deleted"

# Delete AlertManager objects
kubectl delete alertmanager -n monitoring --all --ignore-not-found
echo "✓ AlertManager objects deleted"
```

#### Delete ConfigMaps

```bash
# Delete Grafana datasources ConfigMap
kubectl delete configmap grafana-datasources -n monitoring --ignore-not-found

# Delete Grafana dashboards ConfigMap
kubectl delete configmap grafana-dashboards -n monitoring --ignore-not-found

# Delete AlertManager configuration ConfigMap
kubectl delete configmap alertmanager -n monitoring --ignore-not-found

echo "✓ ConfigMaps deleted"
```

#### Delete PersistentVolumeClaims (Data Deletion)

⚠️ **WARNING:** This deletes all collected metrics, logs, and dashboard configurations.

```bash
# Verify PVCs to delete
kubectl get pvc -n monitoring

# Delete PVCs
kubectl delete pvc -n monitoring --all --ignore-not-found

echo "⚠️  All PersistentVolumeClaims deleted (data lost)"
```

#### Delete Service Accounts and RBAC

```bash
# Delete service accounts created by Helm
kubectl delete sa -n monitoring -l app.kubernetes.io/name=prometheus --ignore-not-found
kubectl delete sa -n monitoring -l app.kubernetes.io/name=grafana --ignore-not-found
kubectl delete sa -n monitoring -l app.kubernetes.io/name=loki --ignore-not-found

# Delete cluster roles and bindings
kubectl delete clusterrole -l app.kubernetes.io/name=prometheus --ignore-not-found
kubectl delete clusterrolebinding -l app.kubernetes.io/name=prometheus --ignore-not-found

echo "✓ Service accounts and RBAC cleaned up"
```

### Phase 4: Delete Namespace (Optional - Complete Cleanup)

⚠️ **CAUTION:** Deletes all resources in namespace, not just monitoring stack.

```bash
# Verify namespace only contains observability stack
kubectl get all -n monitoring
# Should show empty or only stack-related resources

# Delete entire namespace (complete cleanup)
kubectl delete namespace monitoring --ignore-not-found
echo "✓ Monitoring namespace deleted (COMPLETE CLEANUP)"

# Verify deletion (namespace may take 30-60 seconds to fully delete)
kubectl get namespace monitoring 2>/dev/null || echo "Namespace successfully removed"
```

### Phase 5: Verify Rollback Complete

#### Check Helm Releases Removed

```bash
# Verify no releases in monitoring namespace
helm list -n monitoring
# Expected: No releases listed (or "Error: release: not found in: monitoring")

# Check all namespaces for observability stack
helm list --all-namespaces | grep -E "prometheus|grafana|loki" || echo "No observability Helm releases found"
```

#### Check Pods Removed

```bash
# Verify pods deleted
kubectl get pods -n monitoring 2>/dev/null || echo "Monitoring namespace removed or empty"

# Check other namespaces for orphaned pods
kubectl get pods -A | grep -E "prometheus|grafana|loki" || echo "No orphaned observability pods"
```

#### Verify Storage Cleanup

```bash
# Check for remaining PVCs
kubectl get pvc -n monitoring 2>/dev/null || echo "No PVCs in monitoring namespace"

# Check for remaining PVs associated with monitoring
kubectl get pv | grep monitoring || echo "No PVs associated with monitoring"
```

#### Check for Remaining Resources

```bash
# Final verification of all custom resources
kubectl get prometheus -A 2>/dev/null || echo "No Prometheus CRs"
kubectl get alertmanager -A 2>/dev/null || echo "No AlertManager CRs"
kubectl get servicemonitor -A 2>/dev/null || echo "No ServiceMonitors"
kubectl get prometheusrule -A 2>/dev/null || echo "No PrometheusRules"
```

---

## Selective Rollback (Component-Specific)

If you only need to rollback specific components:

### Rollback Grafana Only

```bash
# Uninstall Grafana
helm uninstall grafana -n monitoring

# Delete Grafana secrets and ConfigMaps
kubectl delete secret grafana-admin-secret -n monitoring --ignore-not-found
kubectl delete configmap grafana-datasources grafana-dashboards -n monitoring --ignore-not-found

# Delete Grafana PVC (optional - keeps config if skipped)
kubectl delete pvc grafana -n monitoring --ignore-not-found

echo "✓ Grafana rollback complete"
```

### Rollback Loki Only

```bash
# Uninstall Loki
helm uninstall loki -n monitoring

# Delete Loki PVC (optional)
kubectl delete pvc loki -n monitoring --ignore-not-found

echo "✓ Loki rollback complete"
```

### Rollback Prometheus Only

```bash
# Uninstall Prometheus Stack
helm uninstall prometheus-stack -n monitoring

# Delete Prometheus PVCs (optional)
kubectl delete pvc prometheus-stack-kube-prom-prometheus -n monitoring --ignore-not-found

# Delete custom resources
kubectl delete prometheusrule servicemonitor -n monitoring --all --ignore-not-found

echo "✓ Prometheus rollback complete"
```

---

## Partial Cleanup (Keep Data, Remove Stack)

To keep collected data for investigation while removing components:

```bash
# Uninstall all Helm releases (pods removed, PVCs kept)
helm uninstall -n monitoring $(helm list -n monitoring -q)

# Remove only components, keep all data
kubectl delete pod -n monitoring -l app.kubernetes.io/name=prometheus
kubectl delete pod -n monitoring -l app.kubernetes.io/name=grafana
kubectl delete pod -n monitoring -l app.kubernetes.io/name=alertmanager
kubectl delete pod -n monitoring -l app=loki
kubectl delete pod -n monitoring -l app=promtail

echo "✓ Pods removed, data preserved in PVCs"

# To re-access data later:
# 1. Reinstall via deploy-staging.sh
# 2. PVCs will be reused (existing data available)
```

---

## Recovery Procedures

### Restore from Backed-Up Dashboards

If you exported dashboards in Phase 1:

```bash
# Install Grafana only
helm install grafana grafana/grafana \
  -n monitoring \
  --values infra/grafana/values-staging.yaml \
  --wait

# Re-import dashboards
GRAFANA_PASS=$(kubectl get secret grafana-admin-secret -n monitoring -o jsonpath='{.data.password}' | base64 -d)

for dashboard in dashboard-*.json; do
  curl -X POST \
    -H "Authorization: Bearer ${GRAFANA_PASS}" \
    -H "Content-Type: application/json" \
    -d @$dashboard \
    http://localhost:3000/api/dashboards/db
done

echo "✓ Dashboards restored"
```

### Restore EFS Data from AWS Snapshots

If EFS data was backed up via AWS snapshots:

```bash
# 1. Get latest EFS snapshot
SNAPSHOT_ID=$(aws ec2 describe-snapshots \
  --region us-west-2 \
  --owner-ids self \
  --filters "Name=tag:Purpose,Values=clarity-router-monitoring-staging" \
  --query 'Snapshots | sort_by(@, &StartTime) | [-1].SnapshotId' \
  --output text)

# 2. Create new volume from snapshot
NEW_VOLUME=$(aws ec2 create-volume \
  --region us-west-2 \
  --availability-zone us-west-2a \
  --snapshot-id $SNAPSHOT_ID \
  --query 'VolumeId' \
  --output text)

echo "New volume created: $NEW_VOLUME"

# 3. Create new EFS from restored volume (complex, requires AWS console)
# Follow AWS documentation for EFS restoration
```

---

## Troubleshooting Rollback Issues

### Issue: Pod Stuck in Terminating State

```bash
# Force delete stuck pods
kubectl delete pods -n monitoring --grace-period=0 --force

# Or delete specific pod
kubectl delete pod <pod-name> -n monitoring --grace-period=0 --force
```

### Issue: PVC Stuck in Releasing

```bash
# Check PVC status
kubectl describe pvc <pvc-name> -n monitoring

# If stuck, try deleting PVC
kubectl patch pvc <pvc-name> -n monitoring -p '{"metadata":{"finalizers":null}}'
kubectl delete pvc <pvc-name> -n monitoring
```

### Issue: Helm Uninstall Hangs

```bash
# Kill hanging helm process
pkill -f "helm uninstall"

# Manually delete Helm release secret
kubectl delete secret sh.helm.release.v1.grafana.v1 -n monitoring
kubectl delete secret sh.helm.release.v1.prometheus-stack.v1 -n monitoring
kubectl delete secret sh.helm.release.v1.loki.v1 -n monitoring
```

### Issue: Namespace Stuck in Terminating

```bash
# Check what resources are blocking deletion
kubectl api-resources --verbs=list --namespaced=true | while read api kind; do
  echo "Checking $kind..."
  kubectl get $kind -n monitoring 2>/dev/null | grep -v NAME || true
done

# Remove finalizers from namespace
kubectl get namespace monitoring -o json | \
  jq '.spec.finalizers = []' | \
  kubectl replace --raw /api/v1/namespaces/monitoring/finalize -f -
```

---

## Post-Rollback Verification

### Confirm Complete Removal

```bash
# All pods should be gone
kubectl get pods -n monitoring 2>&1 | grep -i "no resources" || echo "⚠️  Pods still present"

# No services should exist
kubectl get svc -n monitoring 2>&1 | grep -i "no resources" || echo "⚠️  Services still present"

# No PVCs should exist (if --full-cleanup)
kubectl get pvc -n monitoring 2>&1 | grep -i "no resources" || echo "⚠️  PVCs still present"

# Namespace should be empty or removed
kubectl get all -n monitoring 2>&1 || echo "✓ Namespace removed or empty"
```

### Verify Cluster Health

```bash
# Check other namespaces unaffected
kubectl get namespaces

# Check node status
kubectl get nodes

# Verify no orphaned resources
kubectl get all -A | grep -E "prometheus|grafana|loki" || echo "✓ No orphaned resources"
```

### Check EFS Disk Space (If Kept)

```bash
# If keeping EFS, verify it's available for re-deployment
aws efs describe-file-systems --region us-west-2 \
  --query 'FileSystems[*].[Name,SizeInBytes,LifeCycleState]' \
  --output table

# Expected: EFS marked as "available", SizeInBytes shows available capacity
```

---

## Document Post-Rollback Status

Record rollback completion:

```
Rollback Completion Report
═════════════════════════════════════════════════════════════
Cluster: clarity-router-staging
Date: ____________________
Performed By: ____________________

Rollback Procedure:
☐ Phase 1: Pre-rollback checklist completed
☐ Phase 2: Helm releases uninstalled
☐ Phase 3: Kubernetes resources cleaned up
☐ Phase 4: Namespace deleted (if full cleanup)
☐ Phase 5: Rollback verified complete

Components Removed:
☐ Prometheus (metrics collection)
☐ AlertManager (alert routing)
☐ Grafana (dashboards & visualization)
☐ Loki (log aggregation)
☐ Promtail (log shipping)
☐ cert-manager (TLS management)

Data Cleanup:
☐ PVCs retained (can re-use for re-deployment)
☐ PVCs deleted (full cleanup)
☐ Secrets deleted
☐ ConfigMaps deleted
☐ Custom resources deleted

Post-Rollback Verification:
☐ All pods removed
☐ All services removed
☐ All PVCs removed (if applicable)
☐ Namespace removed or empty
☐ No orphaned resources

Issues Encountered:
═════════════════════════════════════════════════════════════
<describe any issues and resolutions>

Notes:
═════════════════════════════════════════════════════════════
<any additional notes for records>
```

---

## Re-Deployment After Rollback

To re-deploy after rollback:

1. Review any issues documented above
2. Fix identified problems (configuration, prerequisites, etc.)
3. Return to [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md) and complete pre-flight checklist
4. Execute [`deploy-staging.sh`](deploy-staging.sh) to re-deploy

If PVCs were kept, metrics and logs from before rollback will be available to new deployment.

---

## Emergency Contact & Escalation

If rollback issues persist:

1. **Document error state:**
   ```bash
   kubectl describe node -A > node-state.txt
   kubectl describe pod -n monitoring > pod-state.txt
   kubectl get events -n monitoring > events.txt
   ```

2. **Contact AWS Support** (if infrastructure issues)
3. **Reference:** OpenClaw deployment team
4. **Repository:** https://github.com/openclaw/openclaw

---

## References

- **Deployment Checklist:** [`DEPLOYMENT_STAGING.md`](DEPLOYMENT_STAGING.md)
- **Installation Guide:** [`INSTALL_STAGING.md`](INSTALL_STAGING.md)
- **Verification Checklist:** [`VERIFY_STAGING.md`](VERIFY_STAGING.md)
- **Architecture Design:** [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- **Helm Documentation:** https://helm.sh/docs/
- **Kubernetes Documentation:** https://kubernetes.io/docs/
- **AWS EFS Documentation:** https://docs.aws.amazon.com/efs/
