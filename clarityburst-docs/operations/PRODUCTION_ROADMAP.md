# ClarityBurst Phase 4: Production Proof Roadmap

**Goal:** Deploy ClarityBurst + Parker Chrysler agents to production, measure real MTBF, validate SLA compliance.

**Status:** Planning (not yet started)

---

## Phase 4 Overview

| Aspect | Phase 3 (Simulation) | Phase 4 (Production) |
|--------|---|---|
| **Environment** | Laptop (local) | Fly.io (cloud) |
| **Load** | 10k simulated agents | Real workload (scraper, generator, publisher) |
| **Duration** | Minutes | Days/weeks (MTBF measurement) |
| **Failures** | Injected | Real infrastructure failures |
| **Recovery** | Measured latency | Measured availability % |
| **Metrics** | Latency p50/p95/p99 | SLA: p99 < 100ms, availability 99.9% |

---

## What Phase 4 Requires

### A. Deploy to Fly.io (Infrastructure)

#### A1. ClarityBurst Router Deployment
```bash
# Currently running on localhost:3001
# Need: Deploy to Fly.io with persistent storage

# Tasks:
- [ ] Create Fly.io app for ClarityBurst router
- [ ] Set up PostgreSQL (contract persistence)
- [ ] Configure environment variables (API keys, logging)
- [ ] Set up monitoring (healthcheck endpoint, metrics)
- [ ] Deploy to Fly.io production region (US or nearest)
- [ ] Verify router responding on production domain
- [ ] Set up log aggregation (Datadog/Grafana)
```

**CLI:**
```bash
cd customer_service_agent
flyctl apps create clarityburst-router
flyctl deploy
```

#### A2. Parker Chrysler Agents Deployment
```bash
# Currently running on desktop
# Need: Deploy to Fly.io with persistent Excel storage

# Tasks:
- [ ] Create Fly.io app for agent runner
- [ ] Set up shared storage (Fly Volumes or S3) for Excel workbook
- [ ] Configure environment variables (router URL, dealer URLs, Facebook token)
- [ ] Set up cron jobs (daily scraper, reconciliation)
- [ ] Deploy agents to Fly.io
- [ ] Verify agents connecting to router via production URL
- [ ] Test end-to-end (scraper → generator → publisher → reconciler)
```

**File Structure on Fly.io:**
```
/app/
  ├── scraper_agent.py
  ├── ad_generator.py
  ├── publisher_agent.py
  ├── reconciler.py
  ├── clarityburst_client.py
  └── /mnt/storage/
      └── Dealership_Agent_GoogleSheets_Template.xlsx  # Persistent volume
```

#### A3. Monitoring & Observability
```bash
# Tasks:
- [ ] Set up Prometheus metrics export (router)
- [ ] Configure Grafana dashboards
  - Router latency (p50/p95/p99)
  - Agent success/failure rates
  - Queue depth and starvation
  - Fault event tracking
- [ ] Set up Datadog logs (agent execution logs)
- [ ] Configure PagerDuty alerts for:
  - Router unavailable (p99 > 500ms)
  - Agent failure rate > 5%
  - Starvation count > 1%
  - Cascade depth > 10
```

---

### B. Scale Testing (10k → 100k+ Agents)

#### B1. Preparation
```bash
# Tasks:
- [ ] Increase Parker Chrysler inventory to 100k vehicles (synthetic for testing)
- [ ] Validate Excel workbook can handle 100k rows (openpyxl limits?)
- [ ] Test router throughput at 100k ops/min
- [ ] Adjust maxInFlight limiter for production scale
- [ ] Benchmark: How many agents can 1 Fly.io machine handle?
```

#### B2. Load Ramp Test
```bash
# Gradually increase load to find breaking point

# Phase 4a: 10k agents (baseline from Phase 3)
tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 200

# Phase 4b: 50k agents
tsx scripts/run-clarityburst-chaos.ts --agents 50000 --seed 42 --maxInFlight 500

# Phase 4c: 100k agents
tsx scripts/run-clarityburst-chaos.ts --agents 100000 --seed 42 --maxInFlight 1000

# Phase 4d: Find breaking point (150k? 200k?)
# Monitor latency p99, starvation, queue depth
```

**Expected Findings:**
```
10k agents:   p99 latency 10ms,   starvation 0%,   queue depth 0
50k agents:   p99 latency 50ms,   starvation 2%,   queue depth 500
100k agents:  p99 latency 200ms,  starvation 5%,   queue depth 2000
150k agents:  p99 latency 500ms,  starvation 10%,  queue depth 4000  ← Alert threshold
```

#### B3. Concurrency Limiter Tuning
```bash
# Current default: 200 in-flight
# For 100k agents, may need 1000+ in-flight

# Test configurations:
--maxInFlight 200   # Conservative (high queue wait)
--maxInFlight 500   # Balanced
--maxInFlight 1000  # Aggressive (risk of router overload)

# Find sweet spot: p99 < 100ms, starvation < 1%
```

---

### C. Long-Running Stability Test (MTBF Measurement)

#### C1. Baseline Stability (No Faults)
```bash
# Run agents for 7 days continuously
# Measure: How often do they fail?

# Tasks:
- [ ] Set up 24/7 agent execution on Fly.io
- [ ] Log all routing decisions + outcomes
- [ ] Track unplanned failures (crashes, timeouts)
- [ ] Calculate MTBF = total runtime / number of failures

# Example target:
# MTBF > 30 days (failure every 30 days maximum)
```

**Monitoring Dashboard:**
```
Uptime:           99.9% (21.6 hours/week downtime acceptable)
Failures:         Should see < 2 failures in 7 days
MTBF calculated:  runtime / failure_count
Success rate:     Should remain 99%+
```

#### C2. Production Fault Injection (Controlled)
```bash
# After 7 days baseline, inject faults to test recovery

# Week 2: Router maintenance window (simulated outage)
- [ ] Kill router for 5 minutes
- [ ] Verify agents fail-closed (no writes)
- [ ] Verify agents recover when router comes back
- [ ] Measure: Recovery time < 60 seconds

# Week 3: Network partition simulation
- [ ] Use Fly proxy to add 5s latency to router
- [ ] Run for 2 hours
- [ ] Monitor: Queue depth, starvation, success rate
- [ ] Verify: Bounded failure window (not cascading)

# Week 4: Ontology pack corruption
- [ ] Corrupt contract data in router
- [ ] Run agents
- [ ] Monitor: Error rates, recovery mechanism
- [ ] Verify: Fail-closed (no writes)
```

#### C3. Data Integrity Validation
```bash
# Ensure no silent corruption under production load

# Tasks:
- [ ] Fingerprint every write (SHA256 of vehicle data)
- [ ] Track fingerprints in separate log
- [ ] After 7 days, audit for:
  - Duplicate vehicles (same fingerprint, different timestamp)
  - Partial writes (fingerprint mismatch)
  - Orphaned records (vehicle in database but not in workbook)
  
# Expected:
- Zero duplicates
- Zero partial writes
- Zero orphaned records

# If found: Investigate root cause, fix, re-test
```

---

### D. SLA Compliance Validation

#### D1. Define Production SLA
```
Latency:
  - p50: < 50ms
  - p95: < 500ms
  - p99: < 1000ms (alert if > 100ms)

Availability:
  - 99.9% uptime (8.6 hours/month downtime max)
  - < 5% failure rate on routing calls

Fairness:
  - No agent starved > 5000ms (< 1%)
  - Queue wait p95 < 1000ms

Recovery:
  - Router outage recovery: < 60 seconds
  - Transient failure recovery: < 5 seconds
```

#### D2. Production Metrics Collection
```bash
# Tasks:
- [ ] Instrument router to emit metrics:
  - latency histogram (all percentiles)
  - success/failure rate counter
  - queue depth gauge
  - starvation count

- [ ] Instrument agents to track:
  - routing call count (approve/deny/rate-limit/auth-fail)
  - end-to-end execution time
  - retry count
  - data corruption checks

- [ ] Export to Prometheus/Datadog
```

#### D3. Weekly SLA Report
```bash
# Every Friday, generate automated report:

SLA Compliance Report (Week of 2026-03-09)
==========================================

Latency:
  p50:  45ms   ✅ (target < 50ms)
  p95:  480ms  ✅ (target < 500ms)
  p99:  980ms  ✅ (target < 1000ms)

Availability:
  Success rate: 99.2%   ✅ (target > 99%)
  Failures:     2 (both transient, recovered)
  MTBF:         3.5 days

Fairness:
  Starvation:   0.3%    ✅ (target < 1%)
  Queue p95:    450ms   ✅ (target < 1000ms)

Recovery:
  Transient failures:  2 (avg recovery: 2.3s)  ✅
  Faults injected:     0
  
Incidents:
  None

Data Integrity:
  Duplicates:       0    ✅
  Partial writes:   0    ✅
  Orphaned records: 0    ✅

Status: PASS (all SLA targets met)
```

---

### E. Production Runbook & Operational Procedures

#### E1. Deployment Runbook
```bash
# File: docs/PHASE4_DEPLOYMENT_RUNBOOK.md

## Prerequisites
- Fly.io account with credit
- PostgreSQL database ready
- S3 bucket for Excel backups
- Datadog account for monitoring

## Deployment Steps

### 1. Deploy ClarityBurst Router
flyctl apps create clarityburst-router
flyctl secrets set ROUTER_PORT=3000 ROUTER_DB_URL=...
flyctl deploy

### 2. Deploy Parker Chrysler Agents
flyctl apps create parker-agents
flyctl volumes create agent-storage -s 10GB
flyctl secrets set ROUTER_URL=https://clarityburst-router.fly.dev
flyctl deploy

### 3. Verify Production Connectivity
curl https://clarityburst-router.fly.dev/health
# Should respond: { ok: true, contracts: 127 }

### 4. Smoke Test (10 vehicles)
python scraper_agent.py --agents 10 --dry-run
# Should print: Scraped 10 vehicles, routing approved

### 5. Enable Production Cron Jobs
flyctl cron create --help
# Schedule scraper: daily 6:00 AM
# Schedule reconciler: daily 6:00 PM
```

#### E2. Incident Response Runbook
```bash
# File: docs/PHASE4_INCIDENT_RESPONSE.md

## Incident: Router Latency Spike (p99 > 1000ms)

### Diagnosis
1. Check router logs
   flyctl logs -a clarityburst-router | grep "latency"
   
2. Check queue depth
   curl https://clarityburst-router.fly.dev/metrics | grep queue_depth
   
3. Check upstream (database)
   SELECT COUNT(*) FROM routing_calls WHERE timestamp > now() - interval '1 hour';

### Recovery
1. If queue depth > 5000:
   - Increase maxInFlight limiter (temporarily)
   - Monitor starvation count
   
2. If database slow:
   - Check index performance
   - Consider sharding if > 100k ops/min
   
3. If memory spike:
   - Restart router (Fly.io handles gracefully)
   - Monitor for memory leak in logs

### Verification
- Latency returns to < 100ms p99
- Success rate > 99%
- Queue depth drains to normal
- No data corruption (verify checksums)
```

#### E3. Disaster Recovery Runbook
```bash
# File: docs/PHASE4_DISASTER_RECOVERY.md

## Scenario: Database Corruption

### Prevention
- Daily backups to S3
- Verification checksums on every write
- Read-after-write confirmation

### Detection
- Integrity check daemon (runs hourly)
- Detects: orphaned records, duplicates, partial writes
- Alert if any found

### Recovery Steps
1. Stop agents (flyctl scale cmd=0)
2. Restore database from last clean backup
3. Replay transaction log (if available)
4. Verify checksums match
5. Resume agents

### Verification
- Zero corruption in restored data
- MTBF counter resets
- All SLA metrics normal
```

---

### F. Competitive Proof (vs Other Frameworks)

#### F1. Benchmark Against Competitors
```bash
# Compare ClarityBurst to other agentic frameworks:
# - Anthropic Claude (no deterministic routing)
# - LangChain (probabilistic agent selection)
# - CrewAI (simple sequential execution)

# Metrics to track:
- Routing latency: ClarityBurst (5-50ms) vs competitors (100-1000ms)
- Failure rate: ClarityBurst fail-closed (0% corruption) vs competitors (0.1-1% silent failures)
- Recovery time: ClarityBurst (< 60s) vs competitors (manual intervention needed)
- Audit trail: ClarityBurst (127 contracts enumerated) vs competitors (none)
```

#### F2. Production Proof Document
```bash
# File: docs/PHASE4_PRODUCTION_PROOF.md

## ClarityBurst in Production: Parker Chrysler Case Study

### Deployment Details
- Location: Fly.io (US-East)
- Agents: 4 (scraper, generator, publisher, reconciler)
- Load: 10k-100k vehicles/day
- Duration: 30 days
- MTBF: 14.5 days (2 planned failures)

### SLA Metrics
- Latency p99: 45ms (target 1000ms) ← 22x better
- Success rate: 99.95% (target 99%) ← better
- Recovery time: 3.2s average (target < 60s)
- Data corruption: 0 (target 0)

### Cost
- Fly.io: ~$40/month (2 shared-cpu machines)
- Database: ~$20/month (PostgreSQL)
- Monitoring: ~$50/month (Datadog)
- Total: ~$110/month for production-grade reliability

### Conclusion
ClarityBurst enables enterprise-safe autonomous agent deployment without sacrificing cost or performance.
```

---

## Phase 4 Checklist

### Infrastructure
- [ ] Fly.io account created
- [ ] PostgreSQL provisioned
- [ ] S3 bucket for backups
- [ ] Monitoring/alerting configured (Datadog/Grafana)
- [ ] ClarityBurst router deployed
- [ ] Parker Chrysler agents deployed
- [ ] End-to-end smoke test passing

### Scaling
- [ ] Load test: 10k agents → p99 < 10ms
- [ ] Load test: 50k agents → p99 < 50ms
- [ ] Load test: 100k agents → p99 < 200ms
- [ ] Find breaking point (at what load does SLA break?)
- [ ] Tune maxInFlight for optimal performance

### Stability (7-Day Test)
- [ ] Run baseline (no faults) for 7 days
- [ ] Calculate MTBF (should be > 7 days for this scale)
- [ ] Zero data corruption detected
- [ ] Success rate > 99%
- [ ] Automated daily integrity checks pass

### Fault Recovery
- [ ] Simulate router outage → verify recovery
- [ ] Simulate network partition → verify starvation handling
- [ ] Simulate database corruption → verify fail-closed
- [ ] Simulate agent crash → verify idempotent restart

### SLA Compliance
- [ ] All latency targets met (p50/p95/p99)
- [ ] Availability > 99.9% (measured over 30 days)
- [ ] Starvation < 1%
- [ ] Recovery time < 60s from any transient fault
- [ ] Weekly SLA report automated

### Documentation
- [ ] Deployment runbook (how to deploy to Fly.io)
- [ ] Incident response runbook (how to handle failures)
- [ ] Disaster recovery runbook (how to restore from backup)
- [ ] Operational dashboard (Grafana)
- [ ] Production proof document (results, cost, learnings)

---

## Phase 4 Timeline

### Week 1: Infrastructure Setup
- Deploy router to Fly.io
- Deploy agents to Fly.io
- Set up monitoring
- Run smoke tests

### Week 2: Scale Testing
- 10k agents baseline
- 50k agents stress test
- 100k agents breaking point
- Tune limiter

### Week 3-4: Stability Testing
- 7+ days of continuous operation
- Fault injection (controlled)
- Data integrity audits
- SLA compliance measurement

### Week 5+: Optimization & Hardening
- Performance tuning (if needed)
- Circuit breaker implementation
- Multi-region failover
- Cost optimization

---

## Success Criteria for Phase 4

✅ **Production Deployed:** ClarityBurst router + agents running 24/7 on Fly.io  
✅ **Scales to 100k agents:** p99 latency < 200ms, starvation < 1%  
✅ **MTBF > 7 days:** Only planned failures, no unplanned crashes  
✅ **Zero corruption:** Integrity checks pass daily  
✅ **SLA compliant:** p99 < 100ms, availability 99.9%+  
✅ **Documented:** Full runbooks for deployment, incidents, recovery  

If all criteria met → **ClarityBurst is enterprise-production-ready**

---

## Estimated Effort

| Task | Effort | Critical |
|------|--------|----------|
| Deploy router to Fly.io | 4 hours | ✅ |
| Deploy agents to Fly.io | 6 hours | ✅ |
| Set up monitoring | 4 hours | ✅ |
| Scale testing (10k→100k) | 8 hours | ✅ |
| 7-day stability run | 168 hours (passive) | ✅ |
| Fault injection tests | 8 hours | ✅ |
| Document runbooks | 4 hours | ⚠️ |
| **Total** | **~40 hours active** | |

---

## Current Status

**Phase 3:** Complete (fault injection validated)  
**Phase 4:** Ready to start

**Next Steps:**
1. [ ] Create Fly.io account
2. [ ] Provision PostgreSQL database
3. [ ] Deploy router (should take < 1 hour)
4. [ ] Deploy agents (should take < 2 hours)
5. [ ] Run smoke test (should take 30 minutes)

---

**Document:** scripts/PHASE4_PRODUCTION_ROADMAP.md  
**Status:** Ready for execution  
**Owner:** Production engineering team
