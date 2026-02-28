# Router Service Production Deployment: Execution Strategy

**Document Date:** February 15, 2026  
**Planning Phase Status:** ✅ COMPLETE  
**Next Action:** Phase 1 → Implementation phase (begin Phase 2-3 preparation)

---

## Executive Summary

The Router Service production deployment plan has been finalized with a **Kubernetes-based, active-passive HA architecture** targeting:
- **<200ms p99 latency**
- **99.95% uptime** (max 21.6 min downtime/month)
- **Automated failover** (primary → standby in <60 seconds)
- **Mirror staging environment** (dev → staging → production promotion pipeline)

---

## Planning Results Summary

### ✅ Deliverables Completed (Phase 1: Architecture Design)

| Item | Status | Document |
|------|--------|----------|
| **1.1 Deployment Architecture** | ✅ | `ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md` |
| **1.2 TLS/HTTPS Strategy** | ✅ | cert-manager + Let's Encrypt (auto-renewal) |
| **1.3 Kubernetes Manifests** | ✅ | Deployment, Service, ConfigMap, PDB specs |
| **1.4 Service Discovery & DNS** | ✅ | Route53 failover + CoreDNS (K8s internal) |
| **1.5 HA/Failover Procedures** | ✅ | Active-passive with health check monitoring |
| **1.6 SLO/SLA Targets** | ✅ | 99.95% uptime, <200ms p99, <0.1% error rate |

### Key Architecture Decisions

```
Infrastructure:   Kubernetes (EKS/GKE) with 3 nodes (3 AZs)
Compute:          t3.medium (2 vCPU, 4GB) × 3 (prod), t3.small × 2 (staging)
High Availability: Active-passive (primary + standby replica)
Failover:         Route53 health checks + DNS failover (<60 seconds)
TLS:              cert-manager + Let's Encrypt (90-day, auto-renew)
Monitoring:       Prometheus + Grafana + Loki (open-source stack)
Load Balancer:    AWS Application Load Balancer (ALB)
Service Mesh:     Not required for Phase 5 (future: Istio)
Cost Estimate:    ~$335/month (prod + staging)
```

---

## Recommended Work Stream Strategy

### ⚠️ Important: Sequential Phases with Parallel Workstreams

Based on your recommendation to balance **agent operation protection** (OPTION 1) with **router deployment** (OPTION 3), here's the suggested sequence:

```
Timeline Overview:
───────────────────────────────────────────────────────────────

NOW (Week 1)          OPTION 1: NETWORK_IO Wiring (Phase 1)
                      └─ Wire 6 fetch commit points
                      └─ ~2-3 days

                      OPTION 2: CRON_SCHEDULE Gating (Phase 2)
                      └─ Complete Phase 2 ClarityBurst work
                      └─ ~1-2 days after OPTION 1

Phase 2 (Week 2-3)    OPTION 3: Router Deployment (PARALLEL)
                      ├─ Phase 1: Architecture planning ✅ COMPLETE
                      ├─ Phase 2: Infrastructure provisioning (→ EKS cluster)
                      ├─ Phase 3: CI/CD pipeline setup
                      └─ ~1-2 weeks, non-blocking OpenClaw work

Phase 3 (Week 4-5)    CONVERGENCE: Staging + Production
                      ├─ Phase 4: Staging validation (load test, failover)
                      ├─ Phase 5: Active-passive HA setup
                      ├─ Phase 6: Monitoring & observability
                      └─ ~1 week

Phase 4 (Week 6+)     PRODUCTION ROLLOUT (Phase 7)
                      ├─ 5% canary → 25% → 50% → 100%
                      ├─ Monitor 48 hours
                      └─ ~3-5 days
```

### Rationale: Why This Sequence Works

1. **OPTION 1 (NETWORK_IO)** is the most critical blocker for Phase 5 OpenClaw operation protection. Wire it first while Router deployment can proceed in parallel.

2. **OPTION 2 (CRON_SCHEDULE)** completes Phase 2 ClarityBurst. This is a prerequisite for Phase 3 rollout (router depends on complete gating framework).

3. **OPTION 3 (Router Deployment)** starts NOW but doesn't block OpenClaw. Infrastructure setup is parallel work that needs 2 weeks minimum. The gateway can continue using localhost:3001 until production cutover (Phase 7).

---

## Phase-by-Phase Breakdown for Implementation

### Phase 1: Architecture Planning ✅ DONE
**Status:** Complete  
**Deliverable:** `ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md` (48 KB, comprehensive)

---

### Phase 2: Infrastructure Provisioning (2-3 weeks)
**Owner:** DevOps / SRE  
**Start Condition:** After Phase 1 approval  
**Completion Gate:** Staging cluster ready, all monitoring deployed

#### Subtasks:
- [ ] **2.1** Provision Kubernetes cluster (EKS or GKE)
  - Create cluster with 3 AZs, t3.medium nodes
  - Configure VPC, security groups, IAM roles
  - Install metrics-server, auto-scaler
  
- [ ] **2.2** Install observability stack
  - Prometheus (with ServiceMonitor for router)
  - Grafana (dashboards for SLO tracking)
  - Loki (log aggregation)
  - Jaeger (optional: distributed tracing)
  
- [ ] **2.3** Configure Ingress + TLS
  - Install ingress-nginx controller
  - Install cert-manager + ClusterIssuer (Let's Encrypt)
  - Create Ingress resource with TLS
  
- [ ] **2.4** Set up container registry
  - ECR (AWS) or GCR (GCP) with image retention policy
  - Configure repository scanning (CVE checks)
  - Set up image tagging strategy (v1.2.0, latest, SHA)
  
- [ ] **2.5** Network & security
  - VPC CIDR planning (10.0.0.0/16)
  - Network policies (ingress for router, egress to NLP-engine)
  - Security groups (ingress 443, 9090)
  
- [ ] **2.6** Namespace isolation
  - Create namespaces: clarity-router (prod), clarity-router-staging
  - Set resource quotas per namespace
  - RBAC ServiceAccounts

**Estimated Duration:** 2-3 weeks  
**Dependencies:** AWS/GCP account setup, domain registration (clarity-router.example.com)

---

### Phase 3: CI/CD Pipeline & GitOps (1-2 weeks)
**Owner:** DevOps / Platform Engineering  
**Start Condition:** Phase 2 infrastructure ready  
**Completion Gate:** Automated build & deploy working end-to-end

#### Subtasks:
- [ ] **3.1** GitHub Actions workflow
  - Build Docker image on push to main
  - Run tests (unit, integration)
  - Push to ECR/GCR with tag (SHA, version)
  - Notify deployment pipeline
  
- [ ] **3.2** Image tagging & versioning
  - Semantic versioning (v1.2.0)
  - Git SHA tagging (v1.2.0-sha-abc123)
  - `latest` pinned to last stable release
  
- [ ] **3.3** GitOps pipeline (ArgoCD or Flux)
  - Repository structure: `/k8s/base`, `/k8s/overlays/{dev,staging,prod}`
  - Automatic sync to staging on every push to main
  - Manual approval gate for production
  
- [ ] **3.4** Promotion gates
  - Staging must pass smoke tests before prod approval
  - Manual approval in GitHub (CODEOWNERS check)
  - Slack notification on approval
  
- [ ] **3.5** Canary/blue-green deployment
  - RollingUpdate strategy (maxSurge=1, maxUnavailable=0)
  - Prometheus PrometheusRule for auto-rollback
  - Manual canary promotion (5% → 25% → 50% → 100%)
  
- [ ] **3.6** Auto-rollback on SLO violation
  - If p99 latency > 300ms for 2 min → rollback
  - If error rate > 5% for 2 min → rollback
  - If all pods crash → alert + freeze deployment

**Estimated Duration:** 1-2 weeks  
**Dependencies:** Docker image ready (from NLP-Translation-Engine), GitHub Actions available

---

### Phase 4: Staging Environment Validation (1 week)
**Owner:** QA / SRE  
**Start Condition:** Phase 2-3 complete (staging cluster + CI/CD)  
**Completion Gate:** All validation tests pass, latency baseline established

#### Subtasks:
- [ ] **4.1** Provision staging K8s cluster
  - Deploy to secondary region/zone (us-west-2)
  - Mirror production (same manifests, smaller nodes)
  
- [ ] **4.2** Deploy monitoring
  - Prometheus scrape configs for staging router
  - Grafana dashboards (replicate from prod)
  
- [ ] **4.3** Load testing
  - 50 req/s for 5 minutes (baseline)
  - Measure latency distribution (p50/p95/p99)
  - Monitor memory/CPU during test
  
- [ ] **4.4** SLO validation
  - Verify p99 latency < 200ms baseline
  - Verify error rate < 0.1%
  - Document baseline metrics
  
- [ ] **4.5** Failover testing
  - Kill primary pod → traffic routes to standby
  - Kill standby pod → traffic stays on primary
  - Restore pod → no re-balancing
  - Failover detection time < 60 seconds
  
- [ ] **4.6** Runbook validation
  - Deploy new version manually (test promotion flow)
  - Rollback manually
  - Scale up/down manually
  - Validate all runbook steps work

**Estimated Duration:** 1 week  
**Dependencies:** Phase 2-3 complete, NLP-Engine staging endpoint available

---

### Phase 5: Active-Passive HA Configuration (3-5 days)
**Owner:** SRE  
**Start Condition:** Phase 4 staging validated  
**Completion Gate:** Primary + standby both healthy, failover mechanism tested

#### Subtasks:
- [ ] **5.1** Configure primary router instance
  - Deploy router-primary pod (set replica=1 initially)
  - Verify health checks pass
  - Configure Route53 weighted record (weight=100)
  
- [ ] **5.2** Configure standby/replica instance
  - Deploy router-standby pod (replica=1)
  - Sync config from primary (ConfigMap)
  - Configure Route53 secondary record (weight=0)
  
- [ ] **5.3** Health check monitoring
  - HTTP health check: /health (responds 200)
  - Check interval: 10 seconds
  - Failure threshold: 3 consecutive failures
  
- [ ] **5.4** DNS failover mechanism
  - Route53 evaluates health check every 10 seconds
  - TTL: 60 seconds (for fast propagation)
  - Test: Simulate primary failure → DNS switches to standby
  
- [ ] **5.5** Failover detection & activation
  - Prometheus alert: "Router primary down"
  - SRE manual: Verify standby health, confirm switch
  - Automate: kubectl patch to promote standby to primary
  
- [ ] **5.6** Failover testing (production-like)
  - Kill primary pod in staging (monitor failover time)
  - Synthetic traffic test (client hitting standby)
  - Measure failover detection latency

**Estimated Duration:** 3-5 days  
**Dependencies:** Phase 4 staging validated, production infrastructure ready

---

### Phase 6: Monitoring & Observability (1 week)
**Owner:** SRE / Monitoring Team  
**Start Condition:** Phase 5 HA configured  
**Completion Gate:** All dashboards, alerts, runbooks functional

#### Subtasks:
- [ ] **6.1** Prometheus metrics
  - Install ServiceMonitor for router (scrape metrics port 9090)
  - Add recording rules (latency percentiles, error rates)
  - Verify metrics flowing into Prometheus
  
- [ ] **6.2** Grafana dashboards
  - Router Health Overview (availability, latency, throughput)
  - Detailed Performance (errors by stage, latency heatmap)
  - Infrastructure Health (node CPU/memory, network I/O)
  - Failover detection frequency
  
- [ ] **6.3** Alerting rules
  - Critical: Router unavailable (3 failures)
  - Warning: P99 latency > 200ms (SLO breach)
  - Warning: Error rate > 0.1%
  - Info: Certificate expires in <7 days
  
- [ ] **6.4** Distributed tracing
  - OpenTelemetry instrumentation in router
  - Jaeger backend (optional for Phase 5)
  - Trace collection for high-latency requests
  
- [ ] **6.5** Log aggregation
  - Loki labels: job, pod, namespace, environment, stage
  - Query examples: router outages, high latency requests
  - Retention: 30 days (prod), 7 days (staging)
  
- [ ] **6.6** Incident response playbooks
  - How to diagnose high latency
  - How to diagnose high error rate
  - How to manually trigger failover
  - Escalation matrix (who to contact)

**Estimated Duration:** 1 week  
**Dependencies:** Phase 5 HA infrastructure, router instrumentation

---

### Phase 7: Production Rollout (5-7 days)
**Owner:** DevOps + SRE + Engineering  
**Start Condition:** Phase 4-6 complete, staging fully validated  
**Completion Gate:** 100% traffic on production, 48-hour monitoring clean

#### Subtasks:
- [ ] **7.1** Pre-flight checks
  - Image builds successfully
  - All tests pass (unit, integration, load)
  - Staging latency baseline: p99 < 200ms
  - Staging uptime: 99.95%+
  - Production infrastructure ready (health checks OK)
  
- [ ] **7.2** Cut over from localhost:3001 to production
  - Update openclaw client: `CLARITYBURST_ROUTER_URL=https://clarity-router.example.com`
  - Rollout to 10% of gateway instances first
  - Monitor for errors (should be none)
  
- [ ] **7.3** Update openclaw client config
  - Environment variable injection in deployment manifests
  - Config file updates for static deployments
  - Documentation updated
  
- [ ] **7.4** Monitor production metrics (48 hours)
  - Dashboard: Latency, error rate, throughput
  - Alert threshold: P99 < 250ms (5 min)
  - Alert threshold: Error rate < 1%
  - No pod restarts/crashes
  
- [ ] **7.5** Gradual traffic migration (canary)
  - 5% traffic (monitor 30 min)
  - 25% traffic (monitor 30 min)
  - 50% traffic (monitor 30 min)
  - 100% traffic (full production)
  - Automatic rollback if SLO violated
  
- [ ] **7.6** Post-rollout validation
  - Document actual latency vs baseline
  - Verify failover detection works in prod
  - Update runbooks with production findings
  - Schedule post-incident review

**Estimated Duration:** 5-7 days  
**Dependencies:** Phases 1-6 complete, OpenClaw gateway updated

---

### Phase 8: Documentation & Knowledge Transfer (1 week)
**Owner:** SRE + Engineering  
**Start Condition:** Phase 7 production stabilized (48+ hours)  
**Completion Gate:** All runbooks, playbooks, video walkthroughs complete

#### Subtasks:
- [ ] **8.1** Operational runbooks
  - Deploy new version (with canary)
  - Rollback procedure
  - Manual failover (if health checks fail)
  - Certificate renewal (manual override)
  - Scaling up/down
  - Node replacement
  
- [ ] **8.2** Disaster recovery
  - Cluster recovery (from cluster backup)
  - Data recovery (if applicable)
  - Cross-region failover (future)
  
- [ ] **8.3** Scaling policies
  - HPA rules (scale to 6 pods at >80% CPU)
  - Manual scaling steps
  - Cost implications of scaling
  
- [ ] **8.4** On-call guide
  - Alert response flowchart
  - Escalation matrix
  - Communication templates
  - SLA breach handling
  
- [ ] **8.5** Architecture walkthrough
  - Record 30-min video walkthrough
  - Kubernetes manifests explained
  - Failover mechanism demo
  - Monitoring dashboard tour
  
- [ ] **8.6** Archive & audit trail
  - Production manifests version-controlled
  - Deployment logs archived
  - Configuration backups in S3
  - Changelog updated

**Estimated Duration:** 1 week  
**Dependencies:** Phase 7 production stabilized

---

## Critical Path & Dependencies

```
Phase 1: Architecture ✅
    ↓
Phase 2: Infrastructure (EKS, Monitoring, TLS) [2-3 weeks]
    ↓
Phase 3: CI/CD + GitOps [1-2 weeks] (parallel with Phase 2)
    ↓
Phase 4: Staging Validation [1 week]
    ↓
Phase 5: HA Configuration [3-5 days] (parallel with Phase 4)
    ↓
Phase 6: Monitoring & Observability [1 week]
    ↓
Phase 7: Production Rollout [5-7 days]
    ↓
Phase 8: Documentation [1 week]

Critical Path Duration: ~6-8 weeks (consecutive)
Parallel Opportunities: Phase 2 + Phase 3, Phase 4 + Phase 5
```

---

## Concurrent Work Streams (Recommended)

### Workstream A: OpenClaw Phase 5 Preparation (NOW)
**Owner:** Core Engineering Team  
**Timeline:** Week 1-2

1. **OPTION 1: NETWORK_IO Gating Wiring** (~2-3 days)
   - Wire 6 fetch commit points
   - Run NETWORK_IO tests
   - Validation: `pnpm test -- network_io` passes

2. **OPTION 2: CRON_SCHEDULE Gating** (~1-2 days after OPTION 1)
   - Complete Phase 2 ClarityBurst gating
   - Validation: All gating tests pass

3. **Impact on Router Deployment:** None—these are independent workstreams

### Workstream B: Router Infrastructure Deployment (NOW, PARALLEL)
**Owner:** DevOps / SRE Team  
**Timeline:** Week 1-8 (concurrent with OpenClaw work)

1. **Phases 2-3:** Infrastructure + CI/CD (Weeks 1-3)
2. **Phase 4-6:** Staging + HA + Monitoring (Weeks 4-6)
3. **Phase 7:** Production Rollout (Weeks 7-8)

**Non-Blocking:** The gateway can continue using `http://localhost:3001` while router deployment proceeds. Cutover happens only in Phase 7 (Week 7-8).

---

## Risk Mitigation

### High-Risk Items & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| **Certificate auto-renewal fails** | Medium | High | Manual override procedure, 30-day alert window |
| **Latency SLO violation at scale** | Medium | High | Load test staging first, canary rollout (5%) |
| **Failover takes >60 sec** | Low | High | Health check interval: 10 sec, TTL: 60 sec |
| **Pod crashes in production** | Low | Medium | Resource limits, readiness/liveness probes |
| **Data loss on node failure** | Low | High | Kubernetes handles (stateless pods, ConfigMaps) |
| **DNS propagation delays** | Low | Medium | TTL: 60 sec, manual verification before/after |

---

## Success Criteria for Phase 1 ✅

- [x] Comprehensive architecture document (48 KB) created
- [x] Kubernetes topology designed (3 nodes, 3 AZs)
- [x] TLS strategy documented (cert-manager + Let's Encrypt)
- [x] Service discovery + DNS failover specified
- [x] Active-passive HA mechanism detailed
- [x] SLO/SLA targets defined (99.95% uptime, <200ms p99)
- [x] Monitoring stack selected (Prometheus + Grafana + Loki)
- [x] Cost estimation provided (~$335/month)
- [x] 8-phase deployment roadmap created
- [x] Phase-by-phase task breakdowns completed

---

## Success Criteria for Phase 7 (Production Rollout)

Upon completion of Phase 7, the router should be:

- ✅ **Available:** 99.95% uptime verified over 48+ hours
- ✅ **Fast:** p99 latency consistently <200ms
- ✅ **Reliable:** Error rate <0.1%, no unexpected pod restarts
- ✅ **Observable:** Prometheus metrics flowing, Grafana dashboards populated
- ✅ **Resilient:** Failover mechanism tested and working
- ✅ **Documented:** Runbooks, playbooks, and architecture walkthroughs complete
- ✅ **Secure:** TLS enforced, RBAC configured, network policies active

---

## Next Steps for Approval

**Questions for Stakeholder Review:**

1. **Timeline:** Are 6-8 weeks (Phases 1-8) acceptable for production readiness?
2. **Infrastructure:** Confirm EKS (AWS) vs GKE (GCP) preference?
3. **Domain:** What domain should be used for `clarity-router.example.com`?
4. **On-Call:** Who will be primary/secondary on-call for router incidents?
5. **Budget:** Approve ~$335/month infrastructure cost?
6. **Rollout Window:** Preferred production cutover window (Phase 7)?

---

## Document References

- **Architecture:** [`plans/ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md`](ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md) (48 KB, comprehensive)
- **Phase 1 Completed:** Architecture, TLS, Kubernetes, DNS, HA, SLO/SLA
- **Phase 2-8 Roadmap:** Task breakdowns, dependencies, timelines

---

## Approval & Sign-Off

**Document Status:** Ready for Review  
**Prepared By:** Architecture Team  
**Date:** February 15, 2026  

**Required Approvals:**
- [ ] Engineering Lead
- [ ] DevOps/SRE Lead
- [ ] Product/Operations Manager
- [ ] Security/Compliance Officer

**Approval Signatures:**
- [ ] ___________________________ Date: ______
- [ ] ___________________________ Date: ______
- [ ] ___________________________ Date: ______
- [ ] ___________________________ Date: ______

---

**Next Meeting:** Upon approval, schedule Phase 2 kickoff (Infrastructure provisioning)  
**Questions:** Refer to architecture document or contact Architecture Team
