# Observability Stack - Architecture Summary

**Version:** 1.0  
**Status:** Production Ready  
**Deployment:** Staging + Production  
**Last Updated:** ________________  

---

## 📋 What This System Does

The OpenClaw Observability Stack is an integrated metrics, logging, dashboarding, and alerting system for the ClarityRouter and underlying Kubernetes infrastructure.

**Core Functions:**
1. **Collects 100+ metrics** from ClarityRouter and Kubernetes nodes every 30 seconds
2. **Aggregates logs** from all containers and applications (30-day retention)
3. **Displays real-time dashboards** with 3 operational views for status and performance
4. **Routes alerts** to Slack (staging) and PagerDuty (production) based on severity thresholds
5. **Maintains >99.5% availability** through redundant replicas and shared storage

**Who uses it:**
- Operations team: Daily monitoring and incident response
- Engineering: Debugging and performance analysis
- Product/Leadership: SLO tracking and business metrics

---

## 🏗️ Architecture Overview

### Four Main Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ClarityRouter Pods  │  Kubernetes Nodes  │  Pod Containers      │
│  (metrics on :8080)  │  (kubelet :10250)  │  (container logs)    │
│                                                                     │
└────────────────────┬──────────────────────┬────────────────────────┘
                     │                      │
                     │ (metrics)            │ (logs)
                     ↓                      ↓
        ┌────────────────────┐  ┌─────────────────────┐
        │    Prometheus      │  │      Promtail       │
        │                    │  │   (DaemonSet)       │
        │ - Scrapes every    │  │                     │
        │   30 seconds       │  │ - Runs on all nodes │
        │ - 2-3 replicas     │  │ - Reads /var/log    │
        │ - 100GB storage    │  │ - Parses JSON       │
        │ - 15-day retention │  │                     │
        └────┬───────────────┘  └────────┬────────────┘
             │                           │
             │ (metrics)                 │ (logs)
             └──────────────┬────────────┘
                            │
                    ┌───────▼────────┐
                    │      Loki      │
                    │                │
                    │ - Log index    │
                    │ - 150GB storage│
                    │ - 30-day ret.  │
                    │ - JSON parsing │
                    └────┬──────────┘
                         │
                         │ (log queries)
          ┌──────────────────────────────┐
          │                              │
          ▼                              ▼
    ┌──────────────┐          ┌──────────────────┐
    │   Grafana    │          │   AlertManager   │
    │              │          │                  │
    │ - 3 dashbds  │          │ - Alert eval     │
    │ - Real-time  │          │ - Grouping       │
    │ - 2 replicas │          │ - Silencing      │
    │              │          │ - Routing        │
    └────┬─────────┘          └────┬─────────────┘
         │                         │
         │ (visualization)         │ (notifications)
         │                         │
    ┌────▼─────────────────────────▼──────┐
    │         Users & Channels             │
    ├──────────────────────────────────────┤
    │ Grafana UI │ AlertManager UI │ Slack │
    └──────────────────────────────────────┘
```

### Component Details

| Component | Purpose | Replicas | Storage | Retention |
|-----------|---------|----------|---------|-----------|
| **Prometheus** | Time-series metrics database | 2/3 | 100GB EFS | 15 days |
| **Grafana** | Dashboard visualization | 2 | 10GB EFS | N/A (config) |
| **Loki** | Log aggregation | 2/3 | 150GB EFS | 30 days |
| **AlertManager** | Alert routing & deduplication | 2 | 1GB EFS | N/A (stateless) |
| **Promtail** | Log collector (DaemonSet) | 1 per node | Minimal | N/A (streaming) |

---

## 📊 Data Flow Diagram

### Metrics Path
```
ClarityRouter (metrics endpoint :8080)
         ↓ HTTP GET (ServiceMonitor)
  Prometheus scraper
         ↓ (store time-series)
  Prometheus TSDB (EFS)
         ↓ (query)
  Grafana panels
         ↓ (visualize)
  Dashboard in browser
```

**Frequency:** Every 30 seconds  
**Retention:** 15 days (auto-delete after)  
**Query latency:** <2 seconds for complex queries

### Alerts Path
```
Prometheus alert rule evaluation
         ↓ (every 15 seconds)
  Condition check: value > threshold?
         ↓ (YES → alert fires)
  AlertManager receives alert
         ↓ (grouping: 5 min wait)
  Group similar alerts together
         ↓ (routing rules)
  ┌──────────┬───────────┐
  │ Severity │ Channel   │
  ├──────────┼───────────┤
  │ Warning  │ Slack     │
  │ Critical │ PagerDuty │
  └──────────┴───────────┘
         ↓ (webhook)
  Slack channel or PagerDuty
         ↓ (mobile notification)
  Engineer receives page
```

**Latency:** <2 minutes from metric spike to notification  
**Grouping:** Multiple similar alerts → single notification  
**Deduplication:** AlertManager clustering prevents duplicate pages

### Logs Path
```
Container logs (STDOUT/STDERR)
         ↓ (kubelet captures)
  /var/log/containers/
         ↓ (Promtail scrapes)
  Promtail on node
         ↓ (push protocol)
  Loki distributor
         ↓ (index + store)
  Loki TSDB + EFS storage
         ↓ (query)
  Grafana Explore
         ↓ (LogQL)
  Logs displayed with filters
```

**Frequency:** Real-time (ingestion lag <30s)  
**Retention:** 30 days  
**Query latency:** <2 seconds for 1-week range

---

## 🔌 Integration Points

### Prometheus Integrations
- **Source 1:** ClarityRouter pods via ServiceMonitor
- **Source 2:** Kubernetes kubelet and kube-state-metrics
- **Destination 1:** Grafana (queries for dashboards)
- **Destination 2:** AlertManager (alert evaluation)
- **Storage:** EFS volume with ReadWriteMany access

### Grafana Integrations
- **Datasource 1:** Prometheus (metrics queries)
- **Datasource 2:** Loki (log queries)
- **Users:** Ops team, engineers, leadership
- **Authentication:** Admin credentials in Kubernetes secret
- **Storage:** Dashboard configs in EFS volume

### Loki Integrations
- **Input 1:** Promtail (log shipping via gRPC)
- **Input 2:** Kubernetes cluster logs via DaemonSet
- **Output 1:** Grafana Explore (log queries)
- **Output 2:** Metrics via Prometheus (log-based metrics)
- **Storage:** EFS with JSON log parsing

### AlertManager Integrations
- **Input:** Prometheus alert rules
- **Output 1:** Slack webhook (staging & prod)
- **Output 2:** PagerDuty integration key (prod only)
- **Clustering:** Internal gossip protocol (multi-replica coordination)
- **Silencing:** In-memory + persistent storage on EFS

---

## 🎯 Metrics Collected

### Router Metrics (Custom)
- `router_request_latency_ms` - Request processing time (percentiles: p50, p95, p99)
- `router_requests_total` - Total requests processed (counter)
- `router_requests_failed_total` - Failed requests (counter)
- `router_request_size_bytes` - Request body size distribution
- `router_response_time_ms` - Response time percentiles
- `router_availability_percent` - Service availability calculation
- `router_errors_by_type` - Error breakdown by type

**Collection:** Via ServiceMonitor on :8080/metrics  
**Scrape Interval:** 30 seconds  
**Targets:** All router pod replicas

### Kubernetes Metrics (Via kube-prometheus-stack)
- **Node Metrics:** CPU, memory, disk I/O, network
- **Pod Metrics:** Resource requests/limits, memory/CPU usage
- **Container Metrics:** Restart count, state
- **PVC Metrics:** Storage capacity, usage, growth
- **Kubelet Metrics:** API server latency, scheduler queue

**Collection:** kubelet, kube-state-metrics, node-exporter  
**Scrape Interval:** 30 seconds  
**Total targets:** 50+

### Recording Rules
Pre-calculated metrics for common queries:

| Rule | Query | Interval | Use |
|------|-------|----------|-----|
| `router:latency:p95` | p95(router_latency) | 5m | Dashboard |
| `router:error_rate` | rate(errors_total)[5m] | 1m | Alerting |
| `router:availability` | availability percent | 5m | Dashboard |
| `node:cpu_utilization` | CPU % per node | 1m | Alerting |
| `pvc:usage_percent` | Storage % per PVC | 5m | Dashboard |

---

## 📈 Dashboard Structure

### Dashboard 1: Router Health Overview
**Purpose:** Real-time system status  
**Update Frequency:** 15 seconds  
**Key Panels:**
- Request rate (requests/sec, graph)
- P95 latency (milliseconds, gauge)
- Error rate (percentage, stat)
- Availability (%, gauge)
- Top errors (table, sorted by frequency)
- Request distribution by type (pie chart)

**Typical Use:** First dashboard to check in morning

### Dashboard 2: Performance Details
**Purpose:** Drill-down investigation  
**Update Frequency:** 30 seconds  
**Key Panels:**
- Latency heatmap (p50/p95/p99 over time)
- Error rate timeline (errors/sec over time)
- Error type breakdown (pie/bar chart)
- Resource utilization (CPU, memory, network)
- Top slow requests (table)
- Performance trends (24-hour history)

**Typical Use:** When investigating performance complaints

### Dashboard 3: Infrastructure Health
**Purpose:** Capacity and reliability monitoring  
**Update Frequency:** 30 seconds  
**Key Panels:**
- Node CPU utilization (% per node)
- Node memory utilization (% per node)
- Node disk utilization (% per node)
- PVC usage (% for prometheus, loki, grafana)
- Certificate expiry (days until expiration)
- Pod restart count (by pod)
- Network I/O (bytes/sec per node)

**Typical Use:** When planning capacity or investigating node issues

---

## 🔐 Security Architecture

### Role-Based Access Control (RBAC)
- **prometheus** service account: Read pods, nodes, services
- **grafana** service account: Read secrets, configmaps
- **loki** service account: Read pod logs
- **alertmanager** service account: Read/write silences
- **promtail** service account: Read logs, nodes

**Principle:** Minimal permissions, no cluster-admin

### Network Policies
- **Ingress:** Only from Grafana → Prometheus/Loki
- **Egress:** Prometheus → scrape targets only
- **Egress:** AlertManager → Slack/PagerDuty only
- **Pod-to-pod:** Via Kubernetes DNS

### Secrets Management
- **Slack webhook URL:** Kubernetes secret `alertmanager-slack-webhook`
- **PagerDuty key:** Kubernetes secret `alertmanager-pagerduty`
- **Grafana admin password:** Kubernetes secret `grafana-admin`
- **Certificates:** Managed via cert-manager (auto-renewing)

**Protection:** Secrets never logged, never in ConfigMaps

---

## 💾 Storage & Retention Strategy

### EFS Storage Allocation
```
Total: 260GB (both Prometheus + Loki + Grafana)
├─ Prometheus: 100GB (15-day retention)
├─ Loki: 150GB (30-day retention)
└─ Grafana: 10GB (configs, plugins, sessions)
```

### Growth Rates (Typical)
| Component | Growth Rate | Full PVC | Risk |
|-----------|------------|----------|------|
| Prometheus | 100-500MB/day | ~200 days | Low |
| Loki | 500MB-1GB/day | ~150 days | Medium |
| Grafana | 10MB/day | ~1000 days | None |

**Action thresholds:**
- **85% full:** Plan capacity increase
- **90% full:** Reduce retention or expand storage
- **95% full:** Emergency situation - reduce retention immediately

### Backup Strategy
- **Daily EFS snapshots** via AWS Backup (if on AWS)
- **Retention:** 7-day rolling window
- **Recovery:** Can restore from snapshot
- **RTO:** <1 hour restore to new PVC
- **RPO:** 1 day maximum data loss

### Data Lifecycle
```
Day 1-15 (Prometheus):
  Metrics collected in hot storage (high performance)
  
Day 15+ (Prometheus):
  Auto-deleted by retention policy
  
Day 1-30 (Loki):
  Logs collected and indexed
  Full LogQL search available
  
Day 30+ (Loki):
  Auto-deleted by retention policy
  
Backup lifecycle:
  Daily snapshots retained 7 days
  Older snapshots auto-deleted
```

---

## 🚀 High Availability Design

### Redundancy
- **Prometheus:** 2 replicas (staging) / 3 replicas (production)
- **Grafana:** 2 replicas (both environments)
- **Loki:** 2 replicas (staging) / 3 replicas (production)
- **AlertManager:** 2 replicas (both environments)

### Pod Anti-Affinity
Each replica scheduled on different node:
```yaml
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 100
    podAffinityTerm:
      labelSelector:
        matchExpressions:
        - key: app.kubernetes.io/name
          operator: In
          values:
          - prometheus
```

**Effect:** Pod failure only affects 1/2 or 1/3 of capacity

### Pod Disruption Budget (PDB)
```yaml
minAvailable: 1
```

**Effect:** Kubernetes won't evict pods during node drain if it would violate PDB

### Storage Resilience
- **ReadWriteMany** access mode: Any pod can read/write
- **EFS backing:** No single point of failure
- **Stateless replicas:** Can restart without data loss
- **Shared database:** AlertManager clusters via gossip protocol

**Effect:** Any pod can restart and recover instantly

### Failover Behavior
| Scenario | Effect | Recovery |
|----------|--------|----------|
| 1 pod down | 50% capacity (staging) | <1 min (auto-restart) |
| 2 of 3 pods down (prod) | 33% capacity | Other pod handles load |
| Node down | All pods on node restarted | <5 min (PDB, scheduling) |
| Storage unavailable | All pods fail to start | <5 min when storage back |
| Webhook timeout | Alert buffered, retried | Auto-retry (exponential) |

---

## 📊 Performance Characteristics

### Query Performance
| Query Type | Complexity | Latency Target | Actual |
|------------|-----------|-----------------|--------|
| Single metric | Simple | <200ms | 50-100ms |
| Rate calculation | Medium | <500ms | 100-300ms |
| Multi-metric join | Complex | <2s | 500-1500ms |
| 30-day range query | Heavy | <5s | 2-4s |

### Dashboard Performance
- **Page load:** <5 seconds (all panels rendered)
- **Panel refresh:** 15-30 seconds (auto-refresh)
- **Zoom/pan response:** <500ms (interactive)
- **Query execution:** Parallel (multiple panels at once)

### Alert Latency
- **Rule evaluation:** Every 15 seconds (Prometheus)
- **Alert→AlertManager:** <1 second
- **Grouping delay:** 5 minutes (to batch similar alerts)
- **Slack delivery:** <30 seconds after grouping
- **PagerDuty escalation:** <2 minutes
- **Total latency:** <2-3 minutes from metric violation to page

### Log Ingestion
- **Ingest rate:** 1000-5000 logs/second (typical)
- **Ingestion lag:** <30 seconds (time to appear in Grafana)
- **Index latency:** <5 seconds
- **Query response:** <2 seconds for 1-week range

---

## 💰 Cost Breakdown (~$351/month for both clusters)

### Infrastructure Costs
| Component | Cost/Month | Notes |
|-----------|-----------|-------|
| EKS control planes (2 clusters) | $146 | $73 per cluster |
| EFS storage (260GB) | $150 | ~$0.58 per GB |
| EFS throughput | N/A | Bursting (free tier) |
| Data transfer (cross-AZ) | $8 | Inter-node communication |
| EBS snapshots (7-day backup) | $15 | Daily snapshots |
| Network Load Balancer | $32 | Shared with other services |
| **Total** | **~$351** | **Both clusters** |

### Cost Optimization Opportunities
- **Use S3 + Elasticsearch:** 30-40% reduction (future)
- **Log sampling:** 50% reduction for logs (future)
- **Time-based storage tiers:** Move old data to cheaper tier

---

## 🔄 Deployment Architecture

### Staging Environment
- **Kubernetes cluster:** AWS EKS (single cluster)
- **Nodes:** 3 nodes (t3.xlarge or similar)
- **Replicas:** 2 per component (1 can fail safely)
- **Storage:** 260GB EFS
- **Network:** VPC with private subnets

### Production Environment
- **Kubernetes cluster:** AWS EKS (single cluster, separate from staging)
- **Nodes:** 5+ nodes (c5.2xlarge or similar)
- **Replicas:** 3 per component (2 can fail safely)
- **Storage:** 260GB EFS (separate from staging)
- **Network:** VPC with private subnets, multi-AZ

### Kubernetes Namespace
- **Namespace:** `monitoring`
- **RBAC:** Service accounts per component
- **Network policies:** Enabled
- **Pod security policy:** Restricted

---

## 🛠️ Operations Model

### Daily Operations
- **Monitoring:** Passive (alerts fire, dashboards refresh)
- **Time commitment:** <30 minutes/day
- **Frequency:** Continuous checks, alert response on-demand

### Incident Response
1. Alert fires (automated)
2. Operations team investigates (<5 min)
3. Follow runbook or escalate to engineering
4. Implement fix (mitigate immediately)
5. Verify resolution (metric returns normal)
6. Document findings

### Scaling Events
- **When:** PVC >85% full or traffic increases
- **What:** Increase replicas or expand storage
- **How:** `kubectl scale` or `kubectl patch pvc`
- **Time:** 5-10 minutes

### Maintenance Windows
- **Frequency:** Monthly (updates) + as-needed (fixes)
- **Downtime:** Zero (rolling updates)
- **Notice:** 24 hours advance via #operational-changes

---

## 📚 Related Documentation

**For more details, see:**
- [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../plans/OBSERVABILITY_STACK_ARCHITECTURE.md) - Complete technical specification
- [`prometheus/README.md`](prometheus/README.md) - Prometheus-specific setup
- [`grafana/README.md`](grafana/README.md) - Grafana-specific setup
- [`loki/README.md`](loki/README.md) - Loki-specific setup
- [`alertmanager/README.md`](alertmanager/README.md) - AlertManager-specific setup
- [`RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md) - Operational procedures
- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) - Backup and recovery

---

## 🎯 SLO Targets

| Metric | Target | Current |
|--------|--------|---------|
| Availability | 99.5% | _____ |
| Latency (p95) | <1000ms | _____ |
| Error rate | <0.1% | _____ |
| Alert latency | <2 min | _____ |
| Data retention | Per policy | ✓ |

---

**Version:** 1.0  
**Approved by:**
- Engineering Lead: _________________ Date: _________
- Operations Lead: _________________ Date: _________
