# Phase 4: Quick Start Guide

**Goal:** Move from simulation (laptop) to production (Fly.io) → prove ClarityBurst works at scale.

---

## What Phase 4 Actually Means

### NOT:
❌ More chaos tests  
❌ More simulation on laptop  
❌ More code changes  

### YES:
✅ Real cloud deployment  
✅ Real workload (actual scraper, generator, publisher)  
✅ Real infrastructure failures  
✅ Real measurement (MTBF, SLA, uptime %)  

---

## The 3-Week Plan

### Week 1: Get It Running in the Cloud (4 days)

**Day 1: Set Up Infrastructure**
```bash
# Create Fly.io account
# Create PostgreSQL database
# Create S3 bucket for backups
# ~30 minutes
```

**Day 2: Deploy Router**
```bash
cd customer_service_agent
flyctl deploy

# Verify:
curl https://clarityburst-router.fly.dev/health
# Should return: { ok: true, contracts: 127 }

# ~1 hour
```

**Day 3: Deploy Agents**
```bash
cd listing agent
flyctl deploy

# Verify:
python scraper_agent.py --agents 10 --dry-run
# Should print: Successfully routed 10 vehicles

# ~2 hours
```

**Day 4: Smoke Test**
```bash
# Run a small Parker Chrysler cycle:
# 1. Scrape 100 vehicles
# 2. Generate 50 ads
# 3. Publish 10 ads (mock)
# 4. Reconcile

# Expected: All succeed, no errors, audit trail recorded

# ~1 hour
```

**Week 1 Total: ~4 hours active time**

---

### Week 2: Prove It Scales (3 days)

**Day 5-6: Load Ramp Testing**

**First:** 10k agents (baseline from Phase 3)
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --output compliance-artifacts/chaos

# Expected: p99 < 50ms, starvation < 1%
```

**Second:** 50k agents
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 50000 \
  --seed 42 \
  --maxInFlight 500

# Expected: p99 < 100ms, starvation < 5%
```

**Third:** 100k agents
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 100000 \
  --seed 42 \
  --maxInFlight 1000

# Expected: p99 < 200ms, starvation < 10%
# If worse, increase machine size or limiter
```

**Day 7: Analyze Results**
```bash
# Compare three runs:
# 10k vs 50k vs 100k

# Key metric: Does p99 latency grow linearly or exponentially?
# Linear = good scaling (p99 doubles when load 10x)
# Exponential = bad scaling (need bigger machine)
```

**Week 2 Total: ~8 hours**

---

### Week 3-4: Prove It's Stable (Passive)

**Days 8-14: 7-Day Continuous Run**

Set agents to run 24/7:
```bash
# Scraper: Every 6 hours
# Publisher: Every 8 hours
# Reconciler: Every 12 hours
# Monitoring: Check every 15 min

# Watch for:
- Any crashes? (should be 0)
- Any data corruption? (should be 0)
- Any timeout errors? (should be < 1%)
- Success rate holds above 99%?

# Calculate:
- MTBF = total runtime / number of failures
- Target: MTBF > 7 days (so 0-2 failures in this test)
```

**Daily Checks (5 min each):**
```bash
# Check uptime
flyctl status -a clarityburst-router
# Should say: "deployed"

# Check logs for errors
flyctl logs -a clarityburst-router | grep ERROR
# Should be empty

# Check metrics
curl https://clarityburst-router.fly.dev/metrics | grep success_rate
# Should be > 0.99
```

**Days 15-21: Controlled Fault Injection**

**Monday (Day 15):** Simulate router restart
```bash
# Kill router for 2 minutes
# Agents should:
# - Fail-closed (no writes)
# - Queue up
# - Resume when router comes back
# - Catch up within 5 minutes

# Check: Recovery time < 60s ✅
```

**Wednesday (Day 17):** Simulate network partition
```bash
# Add 5s latency to all router calls for 1 hour
# Monitor:
# - Queue depth (should spike)
# - Starvation count (acceptable < 5%)
# - Success rate (should stay > 95%)

# Check: System stays stable under load ✅
```

**Friday (Day 19):** Simulate data corruption
```bash
# Corrupt one contract in ontology pack
# Agents should:
# - Detect invalid contract
# - Fail-closed (no writes)
# - Alert ops
# - Use fallback strategy

# Check: Zero data corruption ✅
```

**Week 3-4 Total: ~1 hour active (rest is passive monitoring)**

---

## What "Passed Phase 4" Looks Like

```
┌─────────────────────────────────────────────────┐
│ ClarityBurst Production Proof (7-Day Test)     │
├─────────────────────────────────────────────────┤
│ Deployment:        ✅ Fly.io + agents running  │
│ Scale:             ✅ 100k agents, p99 < 200ms │
│ Uptime:            ✅ 99.95% (1 planned restart)│
│ Data Integrity:    ✅ Zero corruption          │
│ MTBF:              ✅ 14 days                  │
│ Transient Recovery:✅ < 5s                     │
│ SLA Compliance:    ✅ All metrics met          │
│ Operational Docs:  ✅ Complete                 │
├─────────────────────────────────────────────────┤
│ Conclusion: ENTERPRISE-READY ✅               │
└─────────────────────────────────────────────────┘
```

---

## The One-Sentence Summary

**Phase 4:** Prove ClarityBurst works reliably at 100k+ agents in production, with zero corruption, measurable SLA, and documented operations.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Router crashes in production | High | Keep backup router, auto-restart |
| Database goes down | High | Daily backups, S3 snapshot |
| Latency p99 > 1000ms at 100k | High | Increase machine size or limiter |
| Silent data corruption | Critical | Daily integrity checks + checksums |
| Agents stuck in queue | Medium | Timeout on queue wait, fail-fast |

---

## Cost Estimate

| Service | Cost | Notes |
|---------|------|-------|
| Fly.io (2 shared machines) | $40/month | 0.5 shared CPU each |
| PostgreSQL (managed) | $20/month | 1 GB storage |
| S3 backup | $5/month | < 1 GB/day |
| Datadog monitoring | $50/month | Basic plan |
| **Total** | **~$115/month** | Production-grade |

---

## Next Actions (In Order)

- [ ] **This week:** Create Fly.io account + deploy router
- [ ] **Next week:** Deploy agents + run smoke test
- [ ] **Week after:** Load ramp (10k → 50k → 100k)
- [ ] **Following 2 weeks:** 7-day stability run + controlled faults
- [ ] **After that:** Write final "Production Proof" document

---

## Questions You Might Have

**Q: Why not just simulate on laptop?**  
A: Simulations don't reveal real infrastructure issues (network latency, database contention, storage limits). Production testing is the only proof.

**Q: What if something breaks?**  
A: That's the point. Phase 4 is designed to break things safely (under control) so we can fix them before trusting it with real data.

**Q: How long until we can say "production-ready"?**  
A: ~3 weeks of active work + 2 weeks of passive monitoring = 5 weeks total.

**Q: What if latency at 100k agents is terrible?**  
A: That's useful data. We'll document the breaking point (e.g., "works great up to 50k agents, starts struggling at 100k"). Then decide: upgrade machines, shard database, or adjust maxInFlight limiter.

**Q: Can we go live before Phase 4 is done?**  
A: Not recommended. Phase 4 is the final proof that it's safe. Without it, you're gambling with production data.

---

**Status:** Ready to execute  
**Next Step:** Create Fly.io account  
**Expected Duration:** 5 weeks (40 hours active time)
