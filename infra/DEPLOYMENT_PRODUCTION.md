# Production Observability Stack Deployment - Pre-Flight Checklist

## Overview
This document contains the comprehensive pre-deployment checklist for deploying the ClarityRouter observability stack to the production Kubernetes cluster (`clarity-router-prod` in `us-east-1`).

**Production SLA Target:** 99.5% availability with PagerDuty incident escalation.

## Pre-Deployment Approval Gates

### Stakeholder Sign-Off
- [ ] **Infrastructure Lead** - Approves cluster capacity and network configuration
- [ ] **Platform Owner** - Approves SLO targets and incident escalation procedures
- [ ] **Security Team** - Reviews RBAC, secrets management, and data encryption
- [ ] **Finance** - Confirms cost estimate (~$351/month for 2-cluster setup)

**Approval Date:** _______________  
**Approved By:** _______________

## Environment Verification

### Kubernetes Cluster
- [ ] Production EKS cluster exists: `clarity-router-prod`
- [ ] Cluster region: `us-east-1` (verified with `aws eks describe-cluster --name clarity-router-prod`)
- [ ] Cluster version: 1.27+ (checked: `kubectl version --short`)
- [ ] Node count: 3+ nodes (high availability requirement)
- [ ] Node capacity: 4GB RAM minimum per node
- [ ] EFS CSI driver installed and working (`kubectl get pods -n kube-system | grep efs-csi`)

### Network & Storage
- [ ] VPC has EFS mount targets in all 3 AZs
- [ ] EFS provisioned in region `us-east-1`
- [ ] Security groups allow NFS (port 2049) to EFS
- [ ] Kubernetes API reachable from deployment host
- [ ] kubectl context set to production cluster (`kubectl config current-context`)

### Secrets & Credentials
- [ ] Slack webhook URL stored in AWS Secrets Manager
- [ ] PagerDuty integration key stored in AWS Secrets Manager
- [ ] Grafana admin password generated and stored
- [ ] Docker pull secrets configured (if using private registries)

```bash
# Verify secrets exist
aws secretsmanager list-secrets --region us-east-1 | grep -i observability
kubectl get secrets -n observability 2>/dev/null || echo "Namespace not created yet"
```

### DNS & Load Balancing
- [ ] Route53 DNS zone configured for `observability.production.internal` (if internal)
- [ ] Or public domain configured for external access
- [ ] Load balancer type decided (ALB/NLB) and limits checked with AWS
- [ ] Certificate ready for TLS (self-signed or ACM)

## Capacity Planning

### Storage Requirements
| Component | Retention | Size | Notes |
|-----------|-----------|------|-------|
| Prometheus | 15 days | 30 GB | Time-series data |
| Loki | 30 days | 150 GB | Log storage |
| Grafana | N/A | 2 GB | Dashboard configs |
| **Total EFS** | - | **182 GB** | Plan for 250GB allocation (80% rule) |

- [ ] EFS size provisioned: **200 GB minimum**
- [ ] StorageClass configured with dynamic provisioning
- [ ] PVCs pre-created or auto-created by Helm

### Compute Resources

#### Prometheus
- [ ] Memory: 2 Gi per pod (production vs 1 Gi in staging)
- [ ] CPU: 500m per pod
- [ ] Replicas: **3 (production HA)**

#### Grafana
- [ ] Memory: 512 Mi per pod
- [ ] CPU: 250m per pod
- [ ] Replicas: **2 (minimum for HA)**

#### Loki
- [ ] Memory: 1 Gi per pod
- [ ] CPU: 250m per pod
- [ ] Replicas: **3 (production HA)**

#### Promtail (DaemonSet)
- [ ] Memory: 256 Mi per pod
- [ ] CPU: 100m per pod
- [ ] Runs on all nodes

- [ ] Node capacity verified: `kubectl top nodes` shows sufficient headroom
- [ ] Pod disruption budgets will be enforced (no more than 1 pod down at a time)

## Network Configuration

### Kubernetes Network Policies
```bash
# Enable network policies for namespace isolation
kubectl get networkpolicies -n observability || echo "Will be created by Helm"

# Check ingress rules
kubectl get ingress -n observability || echo "Will be created by Helm"
```

- [ ] Network policies deployed for inter-pod communication
- [ ] External ingress restricted to approved IPs
- [ ] Service mesh (if enabled) compatible with monitoring stack

### Firewall & Security Groups

#### Inbound Rules (to observability pods)
- [ ] Prometheus scrape port 9090 (internal)
- [ ] Grafana UI port 3000 (from approved networks)
- [ ] Loki distributor port 3100 (from Promtail nodes)
- [ ] AlertManager port 9093 (internal)

#### Outbound Rules (from observability pods)
- [ ] HTTPS port 443 to Slack (webhook)
- [ ] HTTPS port 443 to PagerDuty (events)
- [ ] NFS port 2049 to EFS
- [ ] DNS port 53 to internal DNS

```bash
# Verify security group rules
aws ec2 describe-security-groups --filters "Name=tag:Environment,Values=production" --region us-east-1
```

## AlertManager Configuration

### Slack Integration
- [ ] Slack workspace: `openclawdemo`
- [ ] Channel: `#observability-alerts`
- [ ] Webhook URL stored as `slack-webhook-prod` in Secrets Manager
- [ ] Test message sent and verified: `curl -X POST -H 'Content-type: application/json' --data '{"text":"Test alert"}' $SLACK_WEBHOOK_URL`

### PagerDuty Integration (Production Only)
- [ ] PagerDuty account and integration key obtained
- [ ] Service created in PagerDuty: "ClarityRouter Observability"
- [ ] On-call schedules configured
- [ ] Escalation policies set:
  - MINOR → On-call engineer
  - MAJOR → On-call + team lead
  - CRITICAL → All three (on-call + lead + manager)
- [ ] PagerDuty API key stored as `pagerduty-integration-prod` in Secrets Manager

```bash
# Verify PagerDuty integration key
aws secretsmanager get-secret-value --secret-id pagerduty-integration-prod --region us-east-1
```

## Backup & Disaster Recovery Setup

### EFS Snapshot Policy
- [ ] AWS Backup configured with daily snapshots
- [ ] Snapshot retention: 7 days minimum
- [ ] Cross-region replication: enabled for compliance
- [ ] Snapshot lifecycle tested: restore to non-prod cluster monthly

```bash
# Check backup schedule
aws backup list-backup-vaults --region us-east-1
aws backup describe-backup-vault --backup-vault-name prometheus-daily-backups-prod
```

### Backup Location
- [ ] Primary: EFS snapshots in `us-east-1`
- [ ] Secondary: S3 bucket for exported Grafana dashboards
- [ ] Tertiary: Git repository for dashboard versions (weekly exports)

- [ ] Backup validation procedure documented: [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)
- [ ] Monthly restore drill scheduled (next: ____________)

## Monitoring & Observability

### Prometheus as Source of Truth
- [ ] Prometheus scrape configuration includes 100+ metrics
- [ ] Router metrics exposed on `:8089/metrics`
- [ ] Node exporter deployed on all nodes
- [ ] Loki promtail deployed as DaemonSet

### Dashboard Setup
- [ ] Grafana dashboards pre-created (see [`grafana/dashboards/`](grafana/dashboards/))
- [ ] Dashboard export files in JSON format stored
- [ ] Alert rules installed for:
  - Prometheus down
  - Grafana down
  - Loki down
  - AlertManager down
  - PVC almost full (>80%)
  - Query latency high (p99 >2s)

### Incident Notification
- [ ] Slack channel `#observability-incidents` created
- [ ] AlertManager routing rules configured
- [ ] PagerDuty services created with correct escalation
- [ ] On-call rotation calendar shared with team

## Change Control & Testing

### Staging Validation Completed
- [ ] All tests passed in staging: `TEST_REPORT_STAGING.md`
- [ ] Performance testing completed (queries <2s p99)
- [ ] Failover testing completed (kill 1 pod, verify recovery)
- [ ] Storage expansion testing completed
- [ ] Log ingestion under load verified

### Change Management

**Change Request ID:** _________________  
**Change Type:** Major Infrastructure  
**Impact Level:** Critical (affects observability for all services)  
**Rollback Risk:** Low (non-breaking, can rollback within 15 minutes)  

- [ ] Change ticket created in ticketing system
- [ ] Change review board approval obtained
- [ ] Maintenance window scheduled: _________________ (recommend off-peak hours)
- [ ] Stakeholders notified of deployment window
- [ ] Communication plan activated (post updates every 15 min during deployment)

## Rollback Decision Tree

**Complete the following before proceeding:**

1. **What is your exit strategy if deployment fails?**
   - [ ] We will rollback using stored Helm release history
   - [ ] We have a previous backup from staging to restore
   - [ ] We understand the `ROLLBACK_PRODUCTION.md` procedures

2. **What is the recovery time objective (RTO)?**
   - [ ] RTO <30 minutes for rollback
   - [ ] RTO <2 hours for full recovery from backup

3. **Do you have a break-glass contact for escalation?**
   - [ ] Infrastructure manager contact: _________________
   - [ ] On-call engineer contact: _________________
   - [ ] PagerDuty incident created when issues detected

## Deployment Procedure

### Deployment Steps Overview
(Detailed steps in [`INSTALL_PRODUCTION.md`](INSTALL_PRODUCTION.md))

1. **Pre-deployment (30 min before)**
   - Backup Prometheus and Loki data
   - Create EFS snapshots
   - Notify team in Slack

2. **Deployment (assumes 45-60 minutes)**
   - Create namespace and RBAC
   - Create secrets from AWS Secrets Manager
   - Deploy Prometheus (3 replicas)
   - Deploy Loki (3 replicas)
   - Deploy Grafana (2 replicas)
   - Deploy AlertManager
   - Deploy Promtail DaemonSet

3. **Verification (15-20 minutes)**
   - All pods running (see [`VERIFY_PRODUCTION.md`](VERIFY_PRODUCTION.md))
   - Prometheus scraping targets
   - Grafana dashboards loading
   - Test alerts firing

4. **Post-deployment (ongoing)**
   - Monitor for 24 hours
   - Review logs and metrics
   - Verify no customer impact
   - Update oncall rotation

## Deployment Command

```bash
# Dry-run first (shows what WOULD be deployed)
./deploy-production.sh --dry-run

# Actual deployment (interactive prompts before executing)
./deploy-production.sh --cluster=clarity-router-prod --region=us-east-1 --apply
```

## Sign-Off & Approval

**Pre-Flight Checklist Completed By:** _________________  
**Date & Time:** _________________  

**Approved for Production Deployment:**

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Infrastructure Lead | | | |
| Platform Owner | | | |
| Security Reviewer | | | |

## Post-Deployment Activities

- [ ] Schedule follow-up review for 24 hours after deployment
- [ ] Schedule first monthly disaster recovery drill
- [ ] Schedule quarterly capacity planning review
- [ ] Update runbook with production-specific endpoints
- [ ] Complete [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) on-call training

---

**Next Steps:**
1. Review [`INSTALL_PRODUCTION.md`](INSTALL_PRODUCTION.md) for step-by-step deployment guide
2. Run `./deploy-production.sh --dry-run` to see exactly what will be deployed
3. Return to this checklist after all verifications are complete
4. Proceed with deployment after all sign-offs obtained
