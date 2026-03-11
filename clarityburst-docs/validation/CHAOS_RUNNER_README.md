# ClarityBurst Chaos Test Runner (Async Concurrency)

**Purpose:** Real async execution of 10,000+ agents with shared global concurrency limiter, queue depth tracking, and starvation detection.

**Status:** Async routing with concurrency control (no fault injection yet)

---

## Quick Start

### Run Default Chaos Test (10k agents, 200 max in-flight)

```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --scenarioMix "approve:50,deny:30,ratelimit:15,authfail:5" \
  --output compliance-artifacts/chaos
```

**Output:** `compliance-artifacts/chaos/CHAOS_RUN_<runId>.json`

---

## CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--agents` | 10000 | Number of agents to simulate |
| `--seed` | `Date.now()` | RNG seed for determinism |
| `--maxInFlight` | 200 | Max concurrent router requests (global limiter) |
| `--scenarioMix` | `approve:50,deny:30,ratelimit:15,authfail:5` | Scenario distribution (percentages must sum to 100) |
| `--output` | `compliance-artifacts/chaos` | Output directory for JSON artifact |

---

## What's New: Async Concurrency

### Global Concurrency Limiter (Promise Pool)

- **Single shared semaphore** across all 10k agents
- **Limits concurrent router requests** to `--maxInFlight` (default 200)
- **Queue discipline:** FIFO (first agent to request gets slot)
- **Tracks queue depth** and in-flight peaks in real time

### Latency Breakdown

**Before:** Only routing latency (time inside router)  
**Now:** Two separate metrics:

1. **Queue Wait Time** — How long agent waited for router slot
   - p50: Median wait time
   - p95: 95th percentile (95% waited less than this)

2. **Routing Latency** — Time spent in router (unchanged)
   - p50/p95/p99: Percentiles
   - max: Maximum observed latency

3. **Total Latency** — Queue wait + routing (sum)
   - p50/p95/p99/max: Percentiles

### Starvation Detection

- **Threshold:** 5000ms wait time
- **Count:** Number of agents that waited > 5000ms
- **Percentage:** (starvationCount / agentsTotal) * 100

**Interpretation:**
- 0% starvation: Good (no agent blocked excessively)
- > 1% starvation: Yellow flag (some agents stuck waiting)
- > 5% starvation: Red flag (unfair queuing, possible deadlock)

---

## Output Artifact (Updated)

**File:** `compliance-artifacts/chaos/CHAOS_RUN_<runId>.json`

```json
{
  "runId": "chaos_1709652000123_a1b2c3d4",
  "timestamp": "2026-03-05T18:54:00.000Z",
  "config": {
    "agentsTotal": 10000,
    "seed": 42,
    "scenarioMix": {
      "approve": 50,
      "deny": 30,
      "ratelimit": 15,
      "authfail": 5
    },
    "maxInFlight": 200
  },
  "execution": {
    "routerCallsTotal": 10000,
    "executedOpsTotal": 6500,
    "blockedOpsTotal": 3500,
    "retriesTotal": 0
  },
  "concurrency": {
    "inFlightMaxObserved": 199,
    "queueDepthMaxObserved": 9842
  },
  "queueWaitTime": {
    "p50Ms": 2156,
    "p95Ms": 8923
  },
  "routingLatency": {
    "p50Ms": 24,
    "p95Ms": 48,
    "p99Ms": 50,
    "maxMs": 50
  },
  "totalLatency": {
    "p50Ms": 2180,
    "p95Ms": 8971,
    "p99Ms": 10045,
    "maxMs": 12340
  },
  "starvation": {
    "count": 28,
    "threshold": 5000
  },
  "perStageCounts": {
    "TOOL_DISPATCH_GATE": {
      "routed": 833,
      "approved": 541,
      "denied": 292
    }
  },
  "scenarios": {
    "approve": 5000,
    "deny": 3000,
    "ratelimit": 1500,
    "authfail": 500
  }
}
```

---

## Key Metrics Explained

### `concurrency.inFlightMaxObserved`
- **What:** Peak number of concurrent router requests
- **Range:** 0 to `maxInFlight`
- **Expected:** Close to `maxInFlight` if load is high
- **Red flag:** Much less than `maxInFlight` (underutilization)

### `concurrency.queueDepthMaxObserved`
- **What:** Maximum agents waiting in queue for router slot
- **Range:** 0 to `agentsTotal - maxInFlight`
- **Expected:** (agentsTotal / maxInFlight) - 1 under heavy load
- **Example:** 10k agents, 200 in-flight → ~49 agents in queue on average

### `queueWaitTime.p50Ms` / `p95Ms`
- **What:** How long agents waited for router slot
- **p50 = 2156ms:** Median agent waited ~2 seconds
- **p95 = 8923ms:** 95% of agents waited < 9 seconds
- **Red flag:** p95 > 30000ms (queue is slow)

### `starvation.count`
- **What:** Number of agents that waited > 5000ms
- **Example:** 28 agents out of 10k (0.28%)
- **Good:** < 1%
- **Bad:** > 5% (queue scheduling issue)

---

## Scenario Types

### Approve (approve:50)
- 100% of routing calls succeed
- **Throughput test:** All agents get approved quickly

### Deny (deny:30)
- ~50% of routing calls denied
- **Fail-closed test:** Queue still fills even with denials

### RateLimit (ratelimit:15)
- ~70% of routing calls succeed (30% rate-limited)
- **Degradation test:** Some agents skip (not wait forever)

### AuthFail (authfail:5)
- ~30% of routing calls succeed (70% auth failures)
- **Auth gating test:** Early failures don't block queue

---

## Example Runs

### Baseline: Low Contention (200 max in-flight, 10k agents)
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200
```

**Expected Results:**
- inFlightMaxObserved: ~199
- queueDepthMaxObserved: ~9800
- queueWaitTime.p50: ~2000ms
- queueWaitTime.p95: ~8000ms
- starvationCount: < 50

### High Contention: Tight Limiter (50 max in-flight, 10k agents)
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 50
```

**Expected Results:**
- inFlightMaxObserved: ~49
- queueDepthMaxObserved: ~9950
- queueWaitTime.p50: ~9000ms
- queueWaitTime.p95: ~19000ms
- starvationCount: > 500 (many agents starved)

### Low Contention: Generous Limiter (1000 max in-flight, 10k agents)
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 1000
```

**Expected Results:**
- inFlightMaxObserved: ~1000
- queueDepthMaxObserved: ~9000
- queueWaitTime.p50: ~400ms
- queueWaitTime.p95: ~1500ms
- starvationCount: ~0

### Large Scale (100k agents, 500 in-flight)
```bash
tsx scripts/run-clarityburst-chaos.ts \
  --agents 100000 \
  --seed 42 \
  --maxInFlight 500
```

**Expected Results:**
- 100x more agents → 100x longer queue wait times
- starvationCount likely > 1000 (some agents wait > 5000ms)
- totalLatency.p95 will be high

---

## Interpreting Results

### Queue Wait Time is HIGH (p95 > 10000ms)

**Possible Causes:**
1. `maxInFlight` is too low for agent volume
2. Router is slow (routing latency too high)
3. Queue is not FIFO (scheduling unfair)

**Solutions:**
1. Increase `--maxInFlight` (if router can handle it)
2. Optimize router (faster decision logic)
3. Add priority queue (CRITICAL contracts first)

---

### Starvation Count is HIGH (> 5%)

**Possible Causes:**
1. `maxInFlight` is way too low
2. Some agents permanently blocked (deadlock)
3. Router rejecting all requests (all deny scenario)

**Solutions:**
1. Increase `--maxInFlight` significantly
2. Add timeout for stuck agents (interrupt, retry)
3. Review routing logic (why so many denials?)

---

### inFlightMaxObserved < maxInFlight

**Possible Causes:**
1. Not enough agents to saturate limiter
2. Agent tasks completing very fast (less contention)

**Solutions:**
1. Increase `--agents` (more load)
2. Add artificial routing latency (stress test)
3. This is actually a good sign (no bottleneck)

---

## Adding to package.json

Add to `scripts` section:

```json
{
  "scripts": {
    "clarityburst:chaos": "tsx scripts/run-clarityburst-chaos.ts",
    "clarityburst:chaos:10k": "tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 200",
    "clarityburst:chaos:100k": "tsx scripts/run-clarityburst-chaos.ts --agents 100000 --seed 42 --maxInFlight 500",
    "clarityburst:chaos:tight": "tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 50"
  }
}
```

Then run:

```bash
pnpm run clarityburst:chaos:10k
pnpm run clarityburst:chaos:100k
pnpm run clarityburst:chaos:tight
```

---

## Phase 2 Progression

### What's New (Phase 2)
✅ Real async execution (not simulation)
✅ Shared global concurrency limiter
✅ Queue wait time tracking
✅ Starvation detection (> 5000ms)
✅ Concurrency metrics (in-flight, queue depth)

### What's Still Missing (Phase 3+)
- [ ] Fault injection (router down, partition, corruption)
- [ ] Multi-agent fairness (priority queues)
- [ ] Rate limit pool sharing (quota arbitration)
- [ ] Agent restart/recovery semantics
- [ ] Cascading failure detection

---

## Key Design Decisions

1. **Global Semaphore:** All agents share one concurrency limit
   - Simpler than per-agent quotas
   - Tests total system capacity
   - Reveals queue bottlenecks

2. **FIFO Queue:** Agents get slots in request order
   - Fair by default
   - No starvation within 5000ms threshold
   - Easy to reason about

3. **Queue Wait Time as Starvation:** 5000ms threshold
   - Agents that wait > 5s are considered "starved"
   - Indicates scheduling problems
   - Useful for detecting deadlocks

4. **Separate Metrics:** Queue wait ≠ Routing latency
   - Lets you identify bottleneck (queue vs router)
   - Routing latency measures router speed
   - Queue wait measures limiter efficiency

---

## Determinism & Reproducibility

**Key Property:** Same seed = same results (deterministic queue ordering)

```bash
# Run 1
tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 200

# Run 2 (identical results)
tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 42 --maxInFlight 200

# Run 3 (different results)
tsx scripts/run-clarityburst-chaos.ts --agents 10000 --seed 99 --maxInFlight 200
```

Seeded RNG ensures:
- Agent scenario assignments are reproducible
- Routing decisions are deterministic
- Queue depth is the only variable (timing is real)

---

## CI/CD Integration

Store results and track over time:

```bash
# Generate baseline
pnpm run clarityburst:chaos:10k > baseline.json

# After optimization
pnpm run clarityburst:chaos:10k > after.json

# Compare queue wait times
jq '.queueWaitTime,.starvation' baseline.json after.json
```

Track for regression:

```bash
git add compliance-artifacts/chaos/CHAOS_RUN_*.json
git commit -m "chaos: async 10k-agent baseline (p95 queue wait: 8923ms)"
```

---

## Troubleshooting

### All agents in "approve" scenario but starvationCount > 0

**This is normal!** Approval/denial doesn't affect queue wait. Starvation is purely based on concurrency limits, not routing outcome.

### Queue wait time grows linearly with agent count

**Expected!** More agents → longer queue. If you have 10k agents and 200 max in-flight:
- Average position in queue: (10000 - 200) / 2 = 4900
- Average wait = position × routing latency
- Example: 4900 × 25ms = 122500ms wait ✅ Normal

### max totalLatency is 50x higher than routing latency

**Expected!** Total = queue wait + routing latency. With 10k agents and 200 in-flight:
- Max queue depth: 9800 agents
- Each waits for ~200 agent routings
- 200 × 25ms = 5000ms queue wait alone ✅ Normal

---

## Current Status

**Phase 2: Async Concurrency with Limiter** ✅
- Real async agent execution
- Shared global concurrency control
- Queue depth and wait time tracking
- Starvation detection

**Next: Phase 3 (Chaos Testing)**
- Fault injection (router failures)
- Recovery semantics
- Multi-agent fairness guarantees

---

**Script:** scripts/run-clarityburst-chaos.ts  
**Documentation:** scripts/CHAOS_RUNNER_README.md  
**Artifacts:** compliance-artifacts/chaos/CHAOS_RUN_*.json  

**Latest Update:** Phase 2 - Async concurrency control with contention metrics
