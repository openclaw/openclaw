# Router Service Production Deployment Architecture

**Document Version:** 1.0  
**Date:** February 15, 2026  
**Status:** Architecture Planning Phase (Phase 1)  
**Target Rollout:** Phase 5 Production (2026 Q1)

---

## Executive Summary

The ClarityBurst Router Service is transitioning from localhost-only (localhost:3001) development deployment to a production-grade, highly available, globally distributed infrastructure. This document defines the complete architecture required to support OpenClaw's Phase 5 production rollout with strict SLO targets: **<200ms p99 latency** and **99.95% uptime**.

### Current State (Baseline)
- **Location:** C:\Users\rob_m\NLP-Translation-Engine (local development)
- **Endpoint:** http://localhost:3001
- **Topology:** Single process, no HA
- **Clients:** OpenClaw gateway (hardcoded localhost)
- **Scale:** <10 req/s (development only)

### Target State (Production)
- **Topology:** Kubernetes (EKS/GKE), multi-zone HA
- **Endpoint:** https://clarity-router.example.com
- **Replicas:** 3+ (primary + standby + canary)
- **Scale:** <100 req/s sustained, burst to 200 req/s
- **SLO:** p99 latency <200ms, 99.95% uptime
- **Staging:** Mirror of production for pre-release validation

---

## 1. Architecture Overview

### 1.1 Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Clients                         │
│  (Gateway, CLI, Web UI - Dynamic endpoint discovery)        │
└────────────────┬────────────────────────────────────────────┘
                 │ CLARITYBURST_ROUTER_URL env var
                 │ (e.g., https://clarity-router.example.com)
                 │
        ┌────────▼────────────────────────────────┐
        │       DNS + Ingress Controller            │
        │  (TLS termination, rate limiting)         │
        │  clarity-router.example.com               │
        └────────┬────────────────────────────────┘
                 │
    ┌────────────┼────────────────┐
    │            │                │
    ▼            ▼                ▼
┌─────────┐ ┌─────────┐      ┌──────────┐
│  Primary│ │Standby  │      │ Canary   │
│ Router  │ │ Router  │      │ Router   │
│ Pod #1  │ │ Pod #2  │      │ Pod #3   │
│ (us-e1) │ │ (us-e2) │      │ (staging)│
└────┬────┘ └────┬────┘      └──────────┘
     │           │
     └───────────┴───────────────────────┐
                                         │
        ┌────────────────────────────────▼──────────┐
        │    Prometheus → Metrics Scraping           │
        │    Loki → Log Aggregation                  │
        │    Grafana → Dashboards & Alerting         │
        │    OpenTelemetry → Distributed Tracing     │
        └───────────────────────────────────────────┘
```

### 1.2 Infrastructure Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Compute** | Kubernetes (EKS/GKE) | Container orchestration |
| **Networking** | Ingress NGINX + cert-manager | TLS termination, routing |
| **Service Discovery** | Kubernetes DNS (CoreDNS) | Pod-to-pod discovery |
| **Load Balancing** | Kubernetes Service (LoadBalancer) | External traffic distribution |
| **Storage** | ConfigMap (ontology packs) | Persistent config |
| **Observability** | Prometheus + Grafana + Loki | Metrics, logs, alerts |
| **Tracing** | OpenTelemetry + Jaeger | Distributed tracing |
| **Registry** | ECR (AWS) or GCR (GCP) | Container image storage |
| **CI/CD** | GitHub Actions + ArgoCD | Build, test, deploy pipeline |

---

## 2. Infrastructure Requirements

### 2.1 Kubernetes Cluster Specifications

#### Master Node (Managed by EKS/GKE)
- **Region:** us-east-1 (primary), us-west-2 (secondary failover)
- **Availability Zones:** Minimum 3 AZs for high availability
- **Cluster Version:** Latest stable (1.28+ recommended)
- **Networking:** VPC with CIDR 10.0.0.0/16

#### Worker Nodes
```yaml
Primary Cluster (Production):
  - Node Type: t3.medium (2 vCPU, 4GB RAM)
  - Desired: 3 nodes (1 per AZ)
  - Min: 2, Max: 6 (auto-scaling)
  - Disk: 50GB gp3 (EBS)
  - Security Group: Ingress on 443 (HTTPS), 9090 (Prometheus)

Staging Cluster (Mirror):
  - Node Type: t3.small (2 vCPU, 2GB RAM)
  - Desired: 2 nodes
  - Min: 1, Max: 3
  - Disk: 30GB gp3
```

#### Networking
- **Ingress CIDR Blocks:** 
  - OpenClaw gateway subnet: 10.0.1.0/24
  - Admin management: 0.0.0.0/0 (restricted by firewall rules)
- **Egress:** Unrestricted (outbound NLP-Translation-Engine access)
- **Service-to-Service:** mTLS via Istio ServiceEntry (future)

### 2.2 TLS/HTTPS Certificate Management

#### Strategy: Automated Certificate Provisioning

```
cert-manager (v1.12+)
├── ClusterIssuer: Let's Encrypt (Production)
│   └── DNS-01 Challenge (Route53/Cloud DNS)
├── Certificate Resource: clarity-router.example.com
│   ├── Subject: clarity-router.example.com
│   ├── SubjectAltNames: *.clarity-router.example.com
│   ├── Validity: 90 days
│   └── Auto-renewal: 30 days before expiry
└── Secret: router-tls (stored in Kubernetes)
    ├── Key: tls.key (rotated automatically)
    └── Cert: tls.crt
```

#### Implementation Details

**Installation:**
```bash
# Add cert-manager Helm chart
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true
```

**ClusterIssuer for Let's Encrypt:**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: operations@clarity-router.io
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          accessKeyID: $AWS_ACCESS_KEY
          secretAccessRef:
            name: route53-credentials
            key: secret-access-key
```

**Certificate Resource:**
```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: clarity-router-cert
  namespace: clarity-router
spec:
  secretName: router-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - clarity-router.example.com
  - clarity-router-staging.example.com
```

#### Certificate Rotation & Renewal
- **Automatic:** cert-manager handles renewal 30 days before expiry
- **Manual Override:** `kubectl rollout restart deployment/router -n clarity-router`
- **Backup Strategy:** Certificate backups stored in encrypted S3 bucket
- **Monitoring:** Prometheus alert if cert expires in <14 days

### 2.3 Service Discovery & DNS

#### DNS Configuration

```
clarity-router.example.com
  ├─ Type: A (Route53)
  ├─ Alias: AWS Application Load Balancer (ALB)
  │   └─ Target: Kubernetes Ingress
  ├─ TTL: 60 seconds (fast failover)
  ├─ Health Checks: Enabled
  │   └─ Endpoint: https://clarity-router.example.com/health
  │   └─ Interval: 10 seconds
  │   └─ Failure threshold: 3
  └─ Failover: Route to standby on health check failure

clarity-router-staging.example.com
  ├─ Type: A (Route53)
  └─ Alias: Staging ALB (separate stack)
```

#### Kubernetes Service Discovery

**Internal (Pod-to-Pod):**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: router
  namespace: clarity-router
spec:
  type: ClusterIP
  selector:
    app: router
  ports:
  - port: 3001
    targetPort: 3001
    name: http
  - port: 9090
    targetPort: 9090
    name: metrics
```

**External (Load Balancer):**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: router-external
  namespace: clarity-router
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
    external-dns.alpha.kubernetes.io/hostname: clarity-router.example.com
spec:
  type: LoadBalancer
  loadBalancerSourceRanges:
  - 0.0.0.0/0  # OpenClaw clients
  selector:
    app: router
  ports:
  - port: 443
    targetPort: 3001
    protocol: TCP
```

---

## 3. High Availability & Failover Architecture

### 3.1 Active-Passive Configuration

```
┌─────────────────────────────────────────────┐
│         Primary Router (Active)              │
│   Pod: router-primary-abc123                │
│   Zone: us-east-1a                          │
│   Status: Healthy (health check every 10s)  │
│   Traffic: 100% of requests                 │
└─────────────────────────────────────────────┘
         ▲
         │ Health check OK
         │ DNS: clarity-router.example.com
         │
    ┌────┴────────────────────────────────┐
    │    Route53 with Failover Policy      │
    │    Health Check: /health endpoint    │
    │    Failure Detection: 30 seconds     │
    └────┬────────────────────────────────┘
         │
         │ On primary failure, Route53 detects
         │ and switches to standby
         │
┌────────▼──────────────────────────────────┐
│      Standby Router (Warm Backup)          │
│   Pod: router-standby-xyz789              │
│   Zone: us-east-1b                        │
│   Status: Synced (read-only mode)         │
│   Traffic: 0% (warm standby)              │
└────────────────────────────────────────────┘
```

### 3.2 Failover Mechanism

#### Health Check Configuration

**Kubernetes Liveness Probe:**
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3001
    scheme: HTTPS
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
  # Pod restarted if 3 consecutive failures (30 seconds total)
```

**Readiness Probe:**
```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 3001
    scheme: HTTPS
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
  # Pod removed from load balancer if fails
```

#### Route53 Failover

```yaml
# Primary Record (Active)
Type: A (Weighted, weight: 100)
Name: clarity-router.example.com
Value: 203.0.113.1 (ALB IP)
SetID: primary-router
HealthCheck: /health endpoint
  - Protocol: HTTPS
  - Port: 443
  - Path: /health
  - Interval: 10 seconds
  - Failure threshold: 3 (30 seconds to detect failure)

# Secondary Record (Standby)
Type: A (Weighted, weight: 0 normally)
Name: clarity-router.example.com
Value: 203.0.113.2 (Standby ALB IP)
SetID: standby-router
HealthCheck: /health endpoint
Failover Policy: PRIMARY → SECONDARY on health check failure
```

#### Automatic Failover Timeline

| Time | Event | Action |
|------|-------|--------|
| T+0s | Primary pod crashes | Kubernetes detects (liveness probe) |
| T+10s | Pod not responding | Readiness probe fails, removed from LB |
| T+30s | Route53 health check fails | Route53 initiates failover |
| T+40s | DNS TTL expires (60s) | Clients resolve to standby IP |
| T+60s | Standby becomes active | Requests routing to standby router |
| **Total:** ~30-60 seconds failover (within SLO) |

### 3.3 Pod Anti-Affinity & Disruption Budget

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: router
  namespace: clarity-router
spec:
  replicas: 3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - router
        topologyKey: kubernetes.io/hostname
  # Ensures no two router pods on same node
  # Guarantees at least 2 pods survive node failure

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: router-pdb
  namespace: clarity-router
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: router
  # Ensures at least 2 pods available during maintenance
  # Prevents drain of all pods during node updates
```

---

## 4. Monitoring & Observability

### 4.1 Prometheus Metrics

**Router Application Metrics:**
```yaml
# In Router application (instrumentation)
clarityrouter_request_latency_ms{stage, outcome}
  - Histogram: p50, p95, p99 latency
  - Target: p99 < 200ms

clarityrouter_requests_total{stage, status}
  - Counter: total requests by stage and status
  - Target: <100 req/s sustained

clarityrouter_errors_total{stage, reason}
  - Counter: errors by stage (router_outage, pack_incomplete, etc.)
  - Target: <0.1% error rate (99.9% success)

clarityrouter_router_availability{} = 1.0 | 0.5 | 0.0
  - Gauge: 1.0 = fully available, 0.5 = degraded, 0.0 = down
  - Used for uptime calculation
```

**Kubernetes Metrics:**
```yaml
# Pod metrics (kubelet)
container_cpu_usage_seconds_total{pod, namespace}
  - Target: <500m CPU per pod (2 vCPU available)

container_memory_usage_bytes{pod, namespace}
  - Target: <800MB per pod (4GB available)

kubelet_pod_restart_total{pod, namespace}
  - Alert if unexpected restarts
```

**Ingress/Load Balancer Metrics:**
```yaml
# AWS ALB metrics (CloudWatch → Prometheus)
aws_alb_target_response_time_seconds
  - Target: <200ms p99 (includes network latency)

aws_alb_request_count_total
  - Monitor traffic patterns

aws_alb_unhealthy_host_count
  - Alert if >0 unhealthy targets
```

### 4.2 Grafana Dashboards

**Dashboard 1: Router Health Overview**
```
┌─────────────────────────────────────────┐
│  ClarityBurst Router - Production Status │
├─────────────────────────────────────────┤
│ Availability: 99.98% (4h window)        │
│ p99 Latency: 187ms (up from 165ms)      │
│ Error Rate: 0.02%                       │
│ Throughput: 42 req/s (peak: 68 req/s)   │
├─────────────────────────────────────────┤
│ [Line Graph] Latency Trend (p50/p95/p99)│
│ [Gauge] CPU Usage (18% avg, 35% peak)   │
│ [Table] Pod Status (3/3 healthy)        │
│ [Heatmap] Request Distribution by Stage │
└─────────────────────────────────────────┘
```

**Dashboard 2: Detailed Performance**
```
- Request latency percentiles (p50/p95/p99/p99.9)
- Error rate by stage (TOOL_DISPATCH_GATE, NETWORK_IO, etc.)
- Pod resource usage (CPU, memory, network)
- Failover detection frequency
- Certificate expiry warnings
```

**Dashboard 3: Infrastructure Health**
```
- Node status (CPU, memory, disk)
- Network I/O (ingress/egress)
- Persistent volume usage
- Ingress/ALB health
- DNS resolution metrics
```

### 4.3 Loki Log Aggregation

```yaml
# Log streams indexed by
labels:
  - job: clarity-router
  - pod: router-xyz
  - namespace: clarity-router
  - environment: production
  - stage: TOOL_DISPATCH_GATE|NETWORK_IO|...

# Query examples:
{job="clarity-router", environment="production"} | json | status="ABSTAIN_CLARIFY"
# Shows all clarify abstain operations

{job="clarity-router"} | latency > 300
# Find requests exceeding latency SLO
```

### 4.4 Alerting Rules

**Critical Alerts (Page on-call immediately):**
```yaml
- Router Unavailable (3+ health check failures in 2 min)
  Action: Page on-call, auto-failover to standby

- P99 Latency Exceeds 250ms (over 5 min)
  Action: Page on-call, investigate performance

- Error Rate > 1% (over 2 min)
  Action: Page on-call, check logs for pack/router issues

- Certificate Expires in <7 Days
  Action: Page ops, manual renewal if auto fails

- All Pods Down (replica count = 0)
  Action: Critical alert, immediate investigation
```

**Warning Alerts (Slack notification):**
```yaml
- P99 Latency > 200ms (SLO breach, over 10 min)
- Error Rate > 0.1% (over 5 min)
- Node CPU > 80% (scale up if sustained)
- Memory > 2GB (potential memory leak)
- Pod Restart Loops (>2 restarts in 1h)
```

---

## 5. Staging Environment Strategy

### 5.1 Staging Cluster Design

| Aspect | Production | Staging |
|--------|-----------|---------|
| **Cluster** | us-east-1 (3 AZ) | us-west-2 (2 AZ) |
| **Node Count** | 3 | 2 |
| **Node Type** | t3.medium | t3.small |
| **Replicas** | 3 | 2 |
| **Load Balancer** | ALB (prod) | ALB (staging) |
| **Certificate** | *.example.com | *.staging.example.com |
| **Data Sync** | N/A | Manual (packs from prod) |

### 5.2 Promotion Pipeline

```
┌──────────────┐
│ Feature      │
│ Branch       │
└───────┬──────┘
        │ PR submitted
        ▼
┌──────────────┐
│ Unit Tests   │
│ Lint/Format  │
└───────┬──────┘
        │ Pass
        ▼
┌──────────────┐
│ Build Image  │
│ Tag: SHA     │
└───────┬──────┘
        │ Push to ECR
        ▼
┌──────────────┐
│ Deploy to    │
│ Staging      │
└───────┬──────┘
        │ Smoke tests pass
        ▼
┌──────────────┐
│ Load Test    │
│ SLO Validate │
└───────┬──────┘
        │ Manual approval
        ▼
┌──────────────┐
│ Canary (5%)  │
│ Production   │
└───────┬──────┘
        │ 30 min, no errors
        ▼
┌──────────────┐
│ Gradual      │
│ Rollout:     │
│ 25→50→100%   │
└──────────────┘
```

### 5.3 Pre-Production Validation Checklist

```
Staging Deployment:
  ✓ Image builds without errors
  ✓ Pod starts and reaches Ready state
  ✓ Health check passes (/health, /ready)
  ✓ Certificate is valid (TLS handshake)
  ✓ Prometheus scrape succeeds
  ✓ Loki receives logs

Functional Testing:
  ✓ Route operation with test payloads
  ✓ All stages return expected outcomes
  ✓ Pack loading works for all ontologies
  ✓ Confidence scoring produces reasonable results
  ✓ Error handling (router unavailable, pack incomplete)

Performance Testing:
  ✓ Load test: 50 req/s for 5 minutes
  ✓ p99 latency < 200ms baseline
  ✓ No memory leaks (memory stable over 10 min)
  ✓ CPU utilization < 70% at baseline load
  ✓ Connection pool: no leaks, proper cleanup

Failover Testing:
  ✓ Kill primary pod → traffic routes to standby
  ✓ Kill standby pod → traffic stays on primary
  ✓ Restore primary pod → traffic does not re-balance
  ✓ Node drain → pods reschedule immediately
  ✓ Failover detection time: <60 seconds

Security:
  ✓ TLS 1.2+ enforced
  ✓ No unencrypted traffic
  ✓ Rate limiting active (per IP/client)
  ✓ Request logging sanitized (no sensitive data)
  ✓ Health check endpoint exposed only to LB
```

---

## 6. Container Deployment Specification

### 6.1 Docker Image

```dockerfile
# Dockerfile (in NLP-Translation-Engine repo)
FROM node:22-alpine AS base
WORKDIR /app

# Install security updates
RUN apk add --no-cache dumb-init

# Build stage
FROM base AS builder
COPY package*.json ./
RUN npm ci --only=production

# Runtime stage
FROM base
COPY --from=builder /app/node_modules /app/node_modules
COPY src/ /app/src/
COPY dist/ /app/dist/  # Pre-built TypeScript

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('https://localhost:3001/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

EXPOSE 3001 9090
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

**Image Tagging Strategy:**
```
# Staging builds (pre-release)
clarity-router:v1.2.0-rc.1.sha-a1b2c3d4
clarity-router:v1.2.0-rc.1.latest

# Production releases (stable)
clarity-router:v1.2.0
clarity-router:v1.2.0.sha-e5f6g7h8
clarity-router:latest (pinned to latest released version)
```

### 6.2 Kubernetes Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: router
  namespace: clarity-router
  labels:
    app: router
    version: v1.2.0
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Zero downtime deployment
  selector:
    matchLabels:
      app: router
  template:
    metadata:
      labels:
        app: router
        version: v1.2.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: router
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      
      containers:
      - name: router
        image: clarity-router:v1.2.0.sha-abc123
        imagePullPolicy: IfNotPresent
        
        ports:
        - containerPort: 3001
          name: http
          protocol: TCP
        - containerPort: 9090
          name: metrics
          protocol: TCP
        
        env:
        - name: NODE_ENV
          value: "production"
        - name: LOG_LEVEL
          value: "info"
        - name: PORT
          value: "3001"
        - name: METRICS_PORT
          value: "9090"
        - name: NLP_ENGINE_URL
          value: "http://nlp-engine:5000"  # Internal service discovery
        
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
            scheme: HTTPS
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        readinessProbe:
          httpGet:
            path: /ready
            port: 3001
            scheme: HTTPS
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 1Gi
        
        volumeMounts:
        - name: config
          mountPath: /app/config
          readOnly: true
        - name: cache
          mountPath: /app/cache
      
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - router
            topologyKey: kubernetes.io/hostname
      
      volumes:
      - name: config
        configMap:
          name: router-config
      - name: cache
        emptyDir: {}
```

---

## 7. SLO/SLA Targets

### 7.1 Service Level Objectives (SLO)

| Metric | Target | Measurement Window | Alert Threshold |
|--------|--------|-------------------|-----------------|
| **Latency (p99)** | <200ms | 5 minute | >250ms for 5 min |
| **Latency (p95)** | <150ms | 5 minute | >180ms for 5 min |
| **Availability** | 99.95% | Monthly (720 hours) | <99.9% for 1 hour |
| **Error Rate** | <0.1% | 5 minute | >0.5% for 2 min |
| **Throughput** | <100 req/s (sustained) | Per minute | N/A (informational) |

### 7.2 SLA Commitment

```
Service Level Agreement (SLA) for Router Service
Valid Period: [Effective Date] - [Termination Date]
Uptime Target: 99.95% per calendar month

Calculation:
  Available Minutes = Total Minutes - Downtime Minutes
  Uptime % = (Available Minutes / Total Minutes) × 100

Downtime Definition:
  - External to customer (network, infrastructure)
  - Not counted: Scheduled maintenance (1 per month, 4 hours max)
  - Not counted: Customer misconfiguration
  - Not counted: DDoS attacks (>1000x normal traffic)

Monthly Allowance:
  99.95% uptime = max 21.6 minutes downtime per month

Service Credit (if SLA not met):
  ≥99.0%:   10% refund
  ≥95.0%:   25% refund
  <95.0%:   50% refund
```

---

## 8. Security Architecture

### 8.1 Network Security

**Ingress:**
```yaml
# Only HTTPS (443) exposed
# HTTP (80) redirects to HTTPS
Allowed Sources:
  - OpenClaw gateway subnet (10.0.1.0/24)
  - Admin management IPs (via SSH bastion)
  - Prometheus scraper (pod in same cluster)

Blocked:
  - All other sources (default deny)
```

**Pod-to-Pod:**
```yaml
# Network Policy: only router-to-NLP-engine
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: router-egress
spec:
  podSelector:
    matchLabels:
      app: router
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: nlp-engine
    ports:
    - protocol: TCP
      port: 5000
```

### 8.2 Data Encryption

- **In Transit:** TLS 1.2+ (cert-manager + ingress)
- **At Rest:** etcd encryption (AWS EKS default)
- **Credentials:** Kubernetes Secrets with RBAC

### 8.3 RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: router-pod-role
  namespace: clarity-router
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]
  resourceNames: ["router-config"]  # Read-only config

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: router-pod-binding
  namespace: clarity-router
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: router-pod-role
subjects:
- kind: ServiceAccount
  name: router
  namespace: clarity-router
```

---

## 9. Cost Estimation

### 9.1 Monthly Infrastructure Costs (AWS EKS)

| Component | Unit | Qty | Unit Cost | Total |
|-----------|------|-----|-----------|-------|
| **EKS Control Plane** | per cluster | 2 | $73.00 | $146.00 |
| **EC2 t3.medium (primary)** | per instance-hour | 3 | $0.0416 | ~$90/month |
| **EC2 t3.small (staging)** | per instance-hour | 2 | $0.0208 | ~$30/month |
| **Elastic Load Balancer** | per ALB-month | 2 | $16.00 | $32.00 |
| **Data Transfer** | per GB out | 50GB | $0.02 | $1.00 |
| **S3 (logs, backups)** | per GB | 10GB | $0.023 | $0.23 |
| **Monitoring (Prometheus)** | per GB ingested | 0.5GB | $0.50 | $0.25 |
| **Certificates** | per cert | 2 | $0.00 | $0.00 (Let's Encrypt free) |
| **Contingency (15%)** | | | | ~$35 |
| | | | **Total:** | ~$335/month |

---

## 10. Deployment Checklist (Phase 1 → 7)

### Pre-Deployment (Phase 1-3)
- [ ] Kubernetes cluster provisioned (3 nodes, 3 AZs)
- [ ] cert-manager installed with Let's Encrypt issuer
- [ ] Ingress NGINX controller configured
- [ ] Prometheus + Grafana + Loki stack deployed
- [ ] ECR/GCR registry created and authenticated
- [ ] GitHub Actions workflows defined
- [ ] ArgoCD (or Flux) GitOps pipeline set up
- [ ] Secrets management (AWS Secrets Manager or Sealed Secrets) configured

### Staging Testing (Phase 4)
- [ ] Router image built and pushed to registry
- [ ] Deployment manifests created and tested
- [ ] Service discovery configured for staging
- [ ] TLS certificates validated for staging domain
- [ ] Load test (50 req/s for 5 min) passes
- [ ] Failover test (primary → standby) succeeds
- [ ] All alerting rules triggered and verified
- [ ] Grafana dashboards accessible and populated

### Production Cutover (Phase 5-7)
- [ ] Production Kubernetes cluster ready
- [ ] Production ALB and DNS entries created
- [ ] Production cert-manager issuer configured
- [ ] Canary deployment to production (5% traffic)
- [ ] Monitor for 30 min, verify no errors
- [ ] Gradual rollout: 5% → 25% → 50% → 100%
- [ ] Update OpenClaw client config (CLARITYBURST_ROUTER_URL)
- [ ] Monitor for 48 hours post-rollout
- [ ] Document any production issues and resolutions

---

## 11. Rollback Plan

### 11.1 Automatic Rollback Triggers

```
Trigger: P99 latency > 300ms for 2 minutes
  Action: kubectl rollout undo deployment/router -n clarity-router

Trigger: Error rate > 5% for 2 minutes
  Action: kubectl rollout undo deployment/router -n clarity-router

Trigger: Pod crash loop (>5 restarts in 5 min)
  Action: Freeze deployment, manual investigation

Trigger: Health check failures on all replicas
  Action: Immediate rollback to previous version
```

### 11.2 Manual Rollback Steps

```bash
# Check current revision
kubectl rollout history deployment/router -n clarity-router

# Undo to previous revision
kubectl rollout undo deployment/router -n clarity-router --to-revision=5

# Verify rollback
kubectl rollout status deployment/router -n clarity-router
kubectl get pods -n clarity-router -w

# Validate restored service
curl -k https://clarity-router.example.com/health
```

---

## 12. Knowledge Transfer & Documentation

### 12.1 Runbooks to Create

1. **Operational Runbooks:**
   - [ ] Deploy new version (with canary)
   - [ ] Rollback procedure
   - [ ] Manual failover (if auto-failover fails)
   - [ ] Certificate renewal (manual override)
   - [ ] Scaling up/down manually
   - [ ] Node replacement
   - [ ] Database backup/restore (if applicable)

2. **Troubleshooting Guides:**
   - [ ] High latency diagnosis
   - [ ] High error rate diagnosis
   - [ ] Pod crashes/restarts
   - [ ] Memory leaks detection
   - [ ] DNS resolution issues
   - [ ] TLS certificate issues
   - [ ] Load balancer health check failures

3. **Incident Response:**
   - [ ] Alert triggered → investigation steps
   - [ ] Escalation matrix (who to contact)
   - [ ] Customer communication templates
   - [ ] Post-incident review template

### 12.2 Monitoring Access & Credentials

- [ ] Prometheus dashboard: `http://prometheus.clarity-router.local:9090`
- [ ] Grafana dashboard: `https://grafana.clarity-router.io`
- [ ] Kubernetes API: `https://k8s.clarity-router.local:6443`
- [ ] AWS Console access: IAM role-based
- [ ] GitHub Actions logs: Public CI workflow runs

---

## 13. Post-Deployment Optimization (Phase 8+)

After production stabilization, consider:

1. **Service Mesh** (Istio/Linkerd): Advanced traffic management, mutual TLS
2. **Autoscaling**: HPA based on request latency (scale to 6 pods at peak)
3. **Multi-Region**: Replicate to us-west-2 for geographic redundancy
4. **Caching Layer**: Redis for frequently accessed contract matches
5. **Database**: Persistent state for ontology pack versioning
6. **Observability**: Custom dashboards, alerting rules refinement

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-15 | Architecture Team | Initial creation |
| | | | |

**Next Review:** After Phase 4 (Staging validation)  
**Stakeholders:** DevOps, SRE, Product, Engineering  
**Distribution:** Slack #clarity-router-deploy, Confluence wiki
