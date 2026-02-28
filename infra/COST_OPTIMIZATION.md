# Cost Optimization Guide - ClarityRouter Observability Stack

## Overview

This document provides strategies to reduce operational costs while maintaining SLO targets (99.5% availability, <2s query latency).

**Current Monthly Cost:** ~$351 for 2-cluster setup (staging + production)

**Optimization Goal:** Reduce to $250/month without sacrificing reliability

---

## Table of Contents

1. [Cost Breakdown](#cost-breakdown)
2. [Quick Wins (<$20/month savings)](#quick-wins)
3. [Medium-Term Optimizations ($20-50/month savings)](#medium-term-optimizations)
4. [Long-Term Strategies ($50+ month savings)](#long-term-strategies)
5. [Cost Monitoring](#cost-monitoring)
6. [Cost vs Reliability Trade-offs](#cost-vs-reliability-trade-offs)

---

## Cost Breakdown

### Current Production + Staging Setup

| Component | Unit Cost | Qty | Frequency | Monthly Cost |
|-----------|-----------|-----|-----------|--------------|
| **EKS Control Plane** | $73/month | 2 | clusters | $146 |
| **EKS Worker Nodes** | $25 | 3 | nodes/cluster | $150 |
| **EFS Storage** | $0.30/GB | 390 GB | storage | $117 |
| **EFS Throughput** | $6/month | 1 | shared | $6 |
| **EFS Backups (Snapshots)** | $0.05/GB | 390 GB | daily snaps | $58 |
| **Data Transfer** | $0.02/GB | 400 GB | out | $8 |
| **CloudWatch** | $3 | 1 | service | $3 |
| **Elastic IPs** | $0.005/hour | 6 | IPs | $22 |
| **Load Balancer** | $16.20 | 2 | ALB | $32 |
| **VPC Endpoints** | $7/month | 0 | endpoints | $0 |
| **NAT Gateway** | $32 | 1 | gateway | $32 |
| **Route53** | $0.50 | 1 | zone | $0.50 |
| **Miscellaneous (5%)** | - | - | - | $18 |
| | | | **TOTAL** | **$593** |

*Note: Staging cluster adds significant cost. Can this be combined with prod?*

### Cost Per Component (Production Only)

| Component | Monthly Cost | % of Total |
|-----------|--------------|-----------|
| EKS Control Plane | $73 | 20% |
| Compute (EC2 nodes) | $75 | 21% |
| EFS Storage | $117 | 33% |
| EFS Snapshots | $58 | 17% |
| Networking | $53 | 15% |
| Data Transfer | $8 | 2% |
| CloudWatch | $3 | 1% |
| Miscellaneous | $9 | 1% |
| | **$351** | **100%** |

**Key Insight:** Storage (EFS + snapshots) = 50% of cost

---

## Quick Wins (<$20/month savings)

### 1. CloudWatch Cost Optimization (-$2/month)

**Current:** Basic CloudWatch metrics for EKS

**Optimization:** Reduce metric retention, use Prometheus instead

```bash
# Disable unnecessary CloudWatch logs
aws logs describe-log-groups
aws logs delete-log-group --log-group-name /aws/eks/clarity-router-prod

# Cost saved: ~$2-3/month (basic CloudWatch)
```

**Impact:** Minimal (using Prometheus for monitoring anyway)

### 2. Route53 Consolidation (-$0.50/month)

**Current:** Separate DNS zone for observability

**Optimization:** Use shared company DNS zone

```bash
# Delete redundant Route53 zone
aws route53 delete-hosted-zone --id Z123456789ABC

# Add records to existing company zone instead
# Cost saved: $0.50/month (one zone)
```

**Impact:** Minimal, consolidates DNS management

### 3. Remove Unused EIPs (-$18/month)

**Current:** 6 Elastic IPs for various resources

**Optimization:** Remove unused/unneeded IPs

```bash
# List all Elastic IPs
aws ec2 describe-addresses --query 'Addresses[*].[PublicIp,AssociationId,InstanceId]' --output table

# Delete unassociated IPs
aws ec2 release-address --allocation-id eipalloc-xxxxxxxx

# Cost saved: $0.005/hour × 730 hours = $3.65 per unneeded IP
# If 5 unneeded IPs: ~$18/month
```

**Impact:** Remove only truly unused IPs (must verify no integration breaks)

### 4. Reduce Backup Frequency (-$19/month)

**Current:** Daily EFS snapshots (7 day retention)

**Optimization:** Change to weekly snapshots (4 week retention)

```bash
# Modify AWS Backup plan
aws backup update-backup-plan \
  --backup-plan '{
    "BackupPlanName": "observability-daily",
    "Rules": [{
      "RuleName": "WeeklySnapshots",
      "TargetBackupVault": "prometheus-backups",
      "ScheduleExpression": "cron(0 2 ? * SUN *)",
      "StartWindowMinutes": 60,
      "CompletionWindowMinutes": 120,
      "Lifecycle": {
        "DeleteAfterDays": 28
      }
    }]
  }'

# Cost calculation:
# Daily (7d): 7 snapshots × $0.05/GB × 390GB = $136.50/month
# Weekly (4w): 4 snapshots × $0.05/GB × 390GB = $78/month
# Savings: ~$58/month
```

**Impact:** Loss of daily recovery point, but still recover from up to 28 days ago. **NOT RECOMMENDED** - data loss risk too high.

**Better Alternative:** Compress snapshots before storage

```bash
# Enable snapshot compression (if available)
# Note: EFS doesn't support compression, but can optimize elsewhere
```

---

## Medium-Term Optimizations ($20-50/month savings)

### 1. Reduce EFS Storage Size (-$30/month)

**Current:** 390 GB allocation (Prometheus 30GB + Loki 150GB + Grafana 2GB + buffer)

**Analysis:**
```bash
# Check actual usage
kubectl exec -n observability prometheus-kube-prom-prometheus-0 -- du -sh /prometheus
# Typical: 15-20 GB actual

kubectl exec -n observability loki-0 -- du -sh /loki/chunks
# Typical: 60-80 GB actual

# Over-provisioning: 2-3x actual usage
```

**Optimization Options:**

**Option A:** Reduce Prometheus retention (15d → 7d)
```yaml
prometheus:
  prometheusSpec:
    retention: 7d  # Was 15d
    # Cost: 15GB → 7.5GB = saves $2.25/month
```

**Option B:** Reduce Loki retention (30d → 14d)
```yaml
loki:
  config:
    limits_config:
      retention_period: 14d  # Was 30d
      # Cost: 80GB → 37GB = saves $12.90/month
```

**Option C:** Enable more aggressive compression
```yaml
loki:
  config:
    compression: "gzip"  # Instead of snappy
    # Cost: 37GB → 20GB = saves $5.10/month
```

**Combined Savings:** ~$20/month for moderate retention reduction

**Impact:** Shorter historical lookback period (trade-off)

### 2. Downsize EC2 Instances (-$20/month)

**Current:** 3x t3.xlarge nodes (2 vCPU, 8GB RAM) = $75/month

**Analysis:**
```bash
# Check actual node utilization
kubectl top nodes

# Typical: 20-30% CPU usage, 40-50% memory usage
```

**Optimization:** Use smaller instance types

| Instance | CPU | RAM | Cost/month | Utilization |
|----------|-----|-----|-----------|------------|
| t3.xlarge | 4 | 16 GB | $75 | 30% ✓ |
| t3.large | 2 | 8 GB | $37 | 65% ✓ |
| t3.medium | 2 | 4 GB | $19 | 120% ✗ (over-capacity) |

**Recommended:** Downsize to t3.large (2 replicas)

```bash
# Create new node group
aws eks create-nodegroup \
  --cluster-name clarity-router-prod \
  --nodegroup-name observability-large \
  --scaling-config minSize=2,maxSize=3,desiredSize=2 \
  --instance-types t3.large

# Migrate pods (via rolling update)
kubectl drain <old-node> --ignore-daemonsets

# Delete old node group
aws eks delete-nodegroup --cluster-name clarity-router-prod --nodegroup-name observability-xlarge

# Cost saving: $37/month (3 xlarge → 2 large)
# Impact: Reduced capacity, less headroom for spikes
```

**Risk:** Must verify performance remains acceptable with 2 nodes (less redundancy)

### 3. Consolidate Staging & Production (-$75/month)

**Current:** 2 separate EKS clusters ($73 each control plane)

**Optimization:** Use single namespace for both, or deploy staging in prod cluster

```bash
# Option 1: Deploy both in prod cluster (not recommended - blast radius risk)
# Option 2: Use same node pool but separate namespaces
# Option 3: Eliminate staging (test in prod before release - dangerous)

# Realistic middle ground: Share node pool, separate namespaces
kubectl create namespace staging
kubectl create namespace production

# Cost: $73 (one control plane) instead of $146
# Savings: $73/month
# Risk: Blast radius if production affects staging
```

**NOT RECOMMENDED unless separate VPCs or networks**

---

## Long-Term Strategies ($50+ month savings)

### 1. Use EC2 Spot Instances (-$45/month)

**Current:** On-demand t3.xlarge × 3 = $75/month

**Optimization:** Switch to Spot instances (80% discount)

```bash
# Spot pricing: t3.xlarge ~$15/month per instance
# On-demand: t3.xlarge ~$25/month per instance
# Savings: $30/month for 3 instances

# Setup Spot nodes
aws eks create-nodegroup \
  --cluster-name clarity-router-prod \
  --nodegroup-name observability-spot \
  --instance-types t3.large t3a.large t3.medium \
  --capacity-type spot \
  --scaling-config minSize=2,maxSize=5,desiredSize=3

# Deploy Pod Disruption Budgets (already configured)
kubectl get poddisruptionbudget -n observability

# Test with 1 Spot node first
```

**Trade-off:**
- Pros: 80% cheaper, auto-scales up if needed
- Cons: Can be interrupted (2-min warning), need PDB, less predictable

**Recommendation:** Use Spot for non-critical components, on-demand for Prometheus

### 2. Use Local SSD Instead of EFS (-$50/month)

**Current:** EFS NFS shared storage (~$175/month including snapshots)

**Optimization:** Use EC2 instance-attached SSD

```bash
# Cost comparison
# EFS: 390GB × $0.30/GB + snapshots = $117 + $58 = $175/month
# Local SSD: Included in instance cost (already paid) = $0/month additional

# Trade-offs:
# - Local SSD is temporary (deleted when instance terminated)
# - No automatic multi-AZ replication
# - Must backup manually
# - Single node failure = data loss
```

**NOT RECOMMENDED for production** (too risky)

**Better Alternative:** Use smaller EFS, purge old data more aggressively

```yaml
prometheus:
  prometheusSpec:
    retention: 7d  # 7 days instead of 15
    retentionSize: "20GB"  # Stop writing when full

loki:
  config:
    limits_config:
      retention_period: 14d  # 14 days instead of 30
```

**Savings:** ~$40-60/month

### 3. Consolidate to Single Region (-$20/month)

**Current:** 2 regional deployments or multi-AZ spanning

**Optimization:** Single AZ (less resilient but cheaper)

```bash
# Single-AZ deployment: removes NAT gateway redundancy
# Cost savings: ~$16/month (removing 1 NAT gateway)
# Risk: No disaster recovery capability

# Recommended compromise: Keep 2 AZs, consolidate load balancers
# Savings: ~$8/month
```

**NOT RECOMMENDED** - increases blast radius

---

## Cost Monitoring

### Set Up AWS Cost Alerts

```bash
# Create AWS Budget
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{
    "BudgetName": "observability-monthly",
    "BudgetLimit": {"Amount": "400", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {
      "TagKeyValue": ["Project$observability"]
    }
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{
      "SubscriptionType": "EMAIL",
      "Address": "team@example.com"
    }]
  }]'

# Create CloudWatch alarm for forecast
aws cloudwatch put-metric-alarm \
  --alarm-name observability-cost-alert \
  --alarm-description "Alert if observability costs exceed $400" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 400 \
  --comparison-operator GreaterThanThreshold
```

### Track Costs in Prometheus

Create custom dashboard showing daily costs:

```yaml
# Prometheus query
increase(aws_billing_total{service="observability"}[1d])

# Creates alert if costs spike
alert: CostSpike
expr: increase(aws_billing_total[1d]) > avg_over_time(increase(aws_billing_total[7d])[24h:1h]) * 1.5
for: 1h
```

### Monthly Cost Reports

```bash
#!/bin/bash
# Generate monthly cost report

aws ce get-cost-and-usage \
  --time-period Start=$(date -d '30 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics BlendedCost \
  --group-by Type=SERVICE \
  --filter file://filter.json > cost-report-$(date +%Y-%m).json

# Parse and email report
cat cost-report-*.json | jq '.ResultsByTime[].Groups[] | select(.Keys[] == "EC2" or .Keys[] == "EFS" or .Keys[] == "EKS") | {service: .Keys, cost: .Metrics.BlendedCost.Amount}'
```

---

## Cost vs Reliability Trade-offs

### Scenarios

**Scenario 1: Maximum Reliability (Current - $351/month)**
- 3 on-demand node replicas (HA)
- Daily EFS snapshots (7-day retention)
- 15d Prometheus retention, 30d Loki retention
- Multi-AZ deployment
- Dedicated control planes (2 clusters)

**Scenario 2: Balanced (Recommended - $280/month)**
- 2-3 mixed on-demand/spot nodes
- Weekly EFS snapshots (4-week retention)
- 7d Prometheus retention, 14d Loki retention
- Single cluster, 2 AZs
- Smaller instance types (t3.large)

```
Changes:
- Reduce retention: -$20/month
- Downsize nodes: -$20/month
- Consolidate clusters: -$50/month (if safe)
- Reduce snapshots: -$19/month
---
Total Savings: ~$71/month (20% reduction)
```

**Scenario 3: Cost-Optimized (Minimum Viable - $200/month)**
- 2 spot nodes + 1 on-demand
- Monthly full backups only
- 5d Prometheus retention, 7d Loki retention
- Single AZ (risky!)
- Minimal replicas

```
Changes from Baseline:
- Switch to spot: -$30/month
- Minimal backups: -$50/month
- Reduced retention: -$40/month
- Single node: -$25/month
- Single AZ: -$8/month
---
Total Savings: ~$153/month (43% reduction)
Risk: Very high - one failure = complete outage
```

### Recommended Path

**Phase 1 (Month 1): Quick wins**
- Remove unused IPs: -$18/month
- Reduce CloudWatch: -$2/month
- **Total: -$20/month → $331/month**

**Phase 2 (Month 2-3): Medium optimizations**
- Downsize nodes (t3.xlarge → t3.large): -$20/month
- Reduce retention (aggressive): -$25/month
- **Total: -$45/month → $286/month**

**Phase 3 (Month 4+): Spot instances**
- Use Spot for non-critical: -$30/month
- **Total: -$75/month → $256/month (27% savings)**

---

## Cost Optimization Checklist

Monthly review:

- [ ] Check current AWS billing
- [ ] Compare to budget ($300-350 target)
- [ ] Review node utilization (CPU/memory)
- [ ] Review storage usage and growth rate
- [ ] Check for unused resources (IPs, volumes, snapshots)
- [ ] Verify retention policies still appropriate
- [ ] Evaluate new instance types (T4 vs T3)
- [ ] Review Spot savings opportunities
- [ ] Document any changes in this runbook

---

## Cost Optimization Quick Reference

| Optimization | Savings | Risk | Effort |
|--------------|---------|------|--------|
| Remove unused IPs | $18/month | None | Low |
| Reduce CloudWatch | $2/month | None | Low |
| Smaller instances | $20/month | Medium | Medium |
| Reduced retention | $25/month | Low | Low |
| Spot instances | $30/month | Medium | Medium |
| Consolidate clusters | $75/month | High | High |
| Local SSD | $50/month | Critical | High |
| Single AZ | $8/month | Critical | Low |

**Recommended Target:** -$45-75/month savings ($280-310 monthly cost)

---

**Related Documentation:**
- [`DEPLOYMENT_PRODUCTION.md`](DEPLOYMENT_PRODUCTION.md) - Resource allocation details
- [`PERFORMANCE_TUNING.md`](PERFORMANCE_TUNING.md) - Optimizations that improve cost
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - SLO targets (don't compromise for cost)
