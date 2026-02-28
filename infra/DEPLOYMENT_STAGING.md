# Observability Stack Deployment to Staging Cluster
## Pre-Flight Checklist & Prerequisites

**Document Version:** 1.0  
**Date:** February 15, 2026  
**Target Cluster:** `clarity-router-staging` (us-west-2)  
**Status:** Ready for Review & Approval  

---

## Overview

This document outlines all prerequisites and verification steps required before deploying the complete observability stack (Prometheus, Grafana, Loki, AlertManager) to the staging Kubernetes cluster.

**Critical:** Complete all checklist items before proceeding to [`deploy-staging.sh`](deploy-staging.sh).

---

## Pre-Flight Checklist

### 1. Cluster Access & Configuration

- [ ] **Verify EKS cluster is running**
  ```bash
  aws eks describe-cluster --name clarity-router-staging --region us-west-2
  # Expected: ClusterStatus = ACTIVE
  ```

- [ ] **Update kubectl context for staging cluster**
  ```bash
  aws eks update-kubeconfig --region us-west-2 --name clarity-router-staging
  kubectl config use-context arn:aws:eks:us-west-2:ACCOUNT_ID:cluster/clarity-router-staging
  ```

- [ ] **Verify cluster connectivity**
  ```bash
  kubectl cluster-info
  kubectl get nodes -o wide
  # Expected: 2-3 nodes in Ready state
  ```

- [ ] **Verify current context is staging**
  ```bash
  kubectl config current-context
  # Expected output: arn:aws:eks:us-west-2:...:cluster/clarity-router-staging
  ```

### 2. Helm Repository Setup

- [ ] **Verify Helm 3.12+ is installed**
  ```bash
  helm version --short
  # Expected: v3.12.0 or higher
  ```

- [ ] **Add Prometheus Community Helm repository**
  ```bash
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo list | grep prometheus-community
  # Expected: prometheus-community https://prometheus-community.github.io/helm-charts
  ```

- [ ] **Add Grafana Helm repository**
  ```bash
  helm repo add grafana https://grafana.github.io/helm-charts
  helm repo list | grep grafana
  # Expected: grafana https://grafana.github.io/helm-charts
  ```

- [ ] **Add Jetstack Helm repository (cert-manager)**
  ```bash
  helm repo add jetstack https://charts.jetstack.io
  helm repo list | grep jetstack
  # Expected: jetstack https://charts.jetstack.io
  ```

- [ ] **Update all Helm repositories**
  ```bash
  helm repo update
  # Expected: Successfully got an update from ... (3+ repos)
  ```

### 3. AWS Infrastructure Verification

- [ ] **Verify EFS FileSystem exists in us-west-2**
  ```bash
  aws efs describe-file-systems --region us-west-2 \
    --query 'FileSystems[*].[Name,FileSystemId,PerformanceMode,LifeCycleState]' \
    --output table
  # Expected: At least 1 EFS with LifeCycleState=available
  ```

- [ ] **Verify EFS mount targets are created (1 per AZ)**
  ```bash
  EFS_ID=$(aws efs describe-file-systems --region us-west-2 \
    --query 'FileSystems[0].FileSystemId' --output text)
  
  aws efs describe-mount-targets --file-system-id $EFS_ID --region us-west-2 \
    --query 'MountTargets[*].[MountTargetId,AvailabilityZone,LifeCycleState]' \
    --output table
  # Expected: 2-3 mount targets (one per AZ), all available
  ```

- [ ] **Verify staging VPC and subnets**
  ```bash
  aws ec2 describe-vpcs --filters Name=tag:Name,Values=clarity-router-staging --region us-west-2
  aws ec2 describe-subnets --region us-west-2 --query 'Subnets[*].[SubnetId,AvailabilityZone,AvailableIpAddressCount]' --output table
  # Expected: 3+ subnets across different AZs with available IPs
  ```

### 4. Kubernetes Storage & CSI Driver

- [ ] **Verify EFS CSI driver is installed**
  ```bash
  kubectl get pods -n kube-system | grep efs-csi
  # Expected: efs-csi-controller-* (1 pod) and efs-csi-node-* (2-3 pods, one per node)
  ```

- [ ] **Verify EFS CSI driver pod status (all Running)**
  ```bash
  kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-efs-csi-driver --no-headers
  # Expected: All pods in Running state, Ready 1/1 or 2/2
  ```

- [ ] **Verify StorageClass efs-sc exists**
  ```bash
  kubectl get storageclass efs-sc
  # Expected: efs-sc (default storageclass may not be used, that's ok)
  ```

- [ ] **Verify StorageClass provisioner**
  ```bash
  kubectl get storageclass efs-sc -o jsonpath='{.provisioner}'
  # Expected: efs.csi.aws.com
  ```

### 5. Kubernetes Namespace

- [ ] **Verify monitoring namespace exists or will be created**
  ```bash
  kubectl get namespace monitoring 2>/dev/null || echo "Namespace does not exist (will be created)"
  # Expected: Either existing namespace or confirmation it will be created
  ```

- [ ] **Verify no conflicting resources in monitoring namespace**
  ```bash
  kubectl get all -n monitoring 2>/dev/null || echo "Namespace ready for deployment"
  # Expected: Empty or only showing existing monitoring stack
  ```

### 6. External Integrations

- [ ] **Obtain Slack webhook URL for AlertManager**
  - Get from: Slack workspace → Settings → Apps & integrations → Incoming webhooks
  - Format: `https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX`
  - Store securely (1Password, AWS Secrets Manager, etc.)
  - [ ] Webhook URL obtained and verified

- [ ] **Test Slack webhook connectivity** (optional but recommended)
  ```bash
  SLACK_WEBHOOK="https://hooks.slack.com/services/..."
  
  curl -X POST $SLACK_WEBHOOK \
    -H 'Content-type: application/json' \
    -d '{"text":"Observability stack deployment test"}'
  # Expected: HTTP 200 with text "ok"
  ```

- [ ] **Prepare PagerDuty integration key** (optional for staging)
  - If not using: Use placeholder `PLACEHOLDER_PAGERDUTY_SERVICE_KEY`
  - Format: `https://events.pagerduty.com/v2/enqueue` endpoint with service key

### 7. Network & Security Verification

- [ ] **Verify security groups allow pod communication**
  ```bash
  # Get staging cluster security group
  SG_ID=$(aws eks describe-cluster --name clarity-router-staging --region us-west-2 \
    --query 'cluster.resourcesVpcConfig.securityGroupIds[0]' --output text)
  
  aws ec2 describe-security-groups --group-ids $SG_ID --region us-west-2 \
    --query 'SecurityGroups[0].IpPermissions' --output table
  # Expected: Ingress rules allowing pod-to-pod communication (usually 0.0.0.0/0 for internal)
  ```

- [ ] **Verify DNS resolution in cluster**
  ```bash
  kubectl run -it --rm --restart=Never --image=alpine:latest dns-test -- \
    nslookup kubernetes.default
  # Expected: Successful DNS resolution to kubernetes.default.svc.cluster.local
  ```

- [ ] **Verify outbound internet connectivity from pods** (for pulling images)
  ```bash
  kubectl run -it --rm --restart=Never --image=alpine:latest internet-test -- \
    wget -O - https://www.google.com --timeout=5
  # Expected: HTTP 200 or connectivity to external hosts
  ```

### 8. Node Resources & Capacity

- [ ] **Verify node capacity for observability stack**
  ```bash
  kubectl top nodes
  # Expected: 
  # - Nodes showing CPU and Memory available
  # - Sufficient headroom for ~1.8 CPU and 5.5GB memory observability stack
  # - Staging (2 nodes t3.small): 4vCPU/4GB available
  # - Observability needs: 1.8 CPU (45% of available) / 5.5GB (137% - tight but acceptable)
  ```

- [ ] **Verify available disk space on nodes**
  ```bash
  kubectl describe nodes | grep -A 5 "Allocatable\|Allocated resources"
  # Expected: Nodes have allocatable disk space
  ```

- [ ] **Check PVC storage availability**
  ```bash
  kubectl get pv 2>/dev/null | head -20
  # Expected: If PVs exist, they should have available capacity
  ```

### 9. Existing Deployments Verification

- [ ] **Verify no existing prometheus installation**
  ```bash
  kubectl get statefulset -n monitoring 2>/dev/null | grep prometheus || echo "No existing Prometheus"
  helm list -n monitoring | grep prometheus || echo "No existing Prometheus Helm release"
  ```

- [ ] **Verify no existing grafana installation**
  ```bash
  kubectl get deployment -n monitoring 2>/dev/null | grep grafana || echo "No existing Grafana"
  helm list -n monitoring | grep grafana || echo "No existing Grafana Helm release"
  ```

- [ ] **Verify no existing loki installation**
  ```bash
  kubectl get statefulset -n monitoring 2>/dev/null | grep loki || echo "No existing Loki"
  helm list -n monitoring | grep loki || echo "No existing Loki Helm release"
  ```

### 10. Configuration Files Verification

- [ ] **Verify all required Helm values files exist**
  ```bash
  ls -lh infra/prometheus/values-*.yaml
  ls -lh infra/grafana/values-*.yaml
  ls -lh infra/loki/values-*.yaml
  ls -lh infra/alertmanager/values-*.yaml
  # Expected: Each shows values-common.yaml, values-prod.yaml, values-staging.yaml
  ```

- [ ] **Verify ConfigMap and YAML resource files exist**
  ```bash
  ls -lh infra/prometheus/prometheusrule-*.yaml
  ls -lh infra/prometheus/servicemonitor-*.yaml
  ls -lh infra/alertmanager/*.yaml
  ls -lh infra/loki/*.yaml
  # Expected: All referenced configuration files present
  ```

- [ ] **Verify dashboard files exist**
  ```bash
  ls -lh infra/grafana/dashboards/
  # Expected: dashboard-router-health.json, dashboard-performance-details.json, dashboard-infrastructure-health.json
  ```

### 11. Local Tools Verification

- [ ] **Verify kubectl is in PATH**
  ```bash
  which kubectl
  kubectl version --short
  # Expected: /usr/local/bin/kubectl or similar, version output shown
  ```

- [ ] **Verify jq is installed** (for JSON parsing in scripts)
  ```bash
  which jq
  jq --version
  # Expected: /usr/local/bin/jq or similar
  ```

- [ ] **Verify openssl is available** (for generating passwords)
  ```bash
  which openssl
  openssl version
  # Expected: /usr/bin/openssl or similar
  ```

- [ ] **Verify shell script execution permissions**
  ```bash
  ls -lh infra/deploy-staging.sh infra/status-staging.sh
  # Expected: Files exist with executable permissions (x flag)
  ```

---

## Resource Requirements Summary

### Cluster Capacity Needed

| Component | CPU | Memory | Storage | Notes |
|-----------|-----|--------|---------|-------|
| **Prometheus** | 500m × 2 | 2Gi × 2 | 100Gi EFS | Time-series DB, 15-day retention |
| **Grafana** | 100m × 2 | 512Mi × 2 | 10Gi EFS | Dashboards & config |
| **Loki** | 250m × 2 | 1Gi × 2 | 150Gi EFS | Log aggregation, 30-day retention |
| **AlertManager** | 50m × 2 | 128Mi × 2 | 10Gi local | Alert routing & dedup |
| **Promtail** | 50m × 2 | 64Mi × 2 | None | Log shipper (DaemonSet) |
| **kube-state-metrics** | 100m | 128Mi | None | Kubernetes metrics |
| **Total** | **1.8 CPU** | **5.5Gi Memory** | **270Gi EFS** | |

### Staging Cluster (us-west-2)

- **2 nodes** (t3.small, 2vCPU/2GB each)
- **Available:** 4vCPU, 4GB memory
- **Observability overhead:** 1.8 CPU (45%), 5.5GB RAM (137%)
- **Status:** ⚠️ **Tight but acceptable** - EFS storage separate from node capacity

---

## Approval Sign-Off

Before executing [`deploy-staging.sh`](deploy-staging.sh), ensure:

### Deployment Team
- [ ] All checklist items above verified and passed
- [ ] Slack webhook URL obtained and stored securely
- [ ] AWS credentials configured with access to us-west-2
- [ ] kubectl context confirmed as staging cluster
- [ ] No other deployments scheduled during this maintenance window

### Operations Lead
- [ ] Reviewed architecture design: [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- [ ] Approved Slack notification channel for alerts
- [ ] Confirmed no conflicting monitoring infrastructure
- [ ] Authorized 30-60 minute deployment window

### Approval Record
```
Date: ________________
Approved By: ________________
Operations Lead Signature: ________________
```

---

## Next Steps (Upon Approval)

1. **Execute deployment script:**
   ```bash
   bash infra/deploy-staging.sh
   ```
   Expected duration: 30-45 minutes

2. **Verify deployment success:**
   ```bash
   bash infra/status-staging.sh
   ```

3. **Review verification checklist:**
   See [`VERIFY_STAGING.md`](VERIFY_STAGING.md)

4. **Access components:**
   See [`ACCESS_STAGING.md`](ACCESS_STAGING.md)

---

## Troubleshooting Checklist

If prerequisites fail, check:

| Issue | Resolution |
|-------|-----------|
| EKS cluster not found | Verify cluster name and region: `aws eks list-clusters --region us-west-2` |
| kubectl context error | Run: `aws eks update-kubeconfig --region us-west-2 --name clarity-router-staging` |
| Helm repos not found | Run: `helm repo add ...` commands above and `helm repo update` |
| EFS not found | Create EFS: `aws efs create-file-system --region us-west-2 ...` |
| EFS CSI driver missing | Install: `helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver -n kube-system` |
| StorageClass missing | See infra architecture document for StorageClass YAML |
| Network connectivity | Check security groups allow EFS mount (NFS port 2049) and pod communication |

---

## Security Checklist

- [ ] Slack webhook URL stored in secure vault (not in Git)
- [ ] PagerDuty key (if used) stored securely
- [ ] Staging cluster network policies reviewed
- [ ] RBAC permissions verified for deployment user
- [ ] No hardcoded secrets in configuration files
- [ ] All external integrations using HTTPS endpoints

---

## References

- **Architecture:** [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
- **Prometheus README:** [`infra/prometheus/README.md`](prometheus/README.md)
- **Grafana README:** [`infra/grafana/README.md`](grafana/README.md)
- **Deployment Script:** [`deploy-staging.sh`](deploy-staging.sh)
- **Verification Guide:** [`VERIFY_STAGING.md`](VERIFY_STAGING.md)
