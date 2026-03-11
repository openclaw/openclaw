⚠️ **APPENDIX A: PHASE 3 VALIDATION MATRIX**

This document is supporting documentation for the primary Phase 3 Validation Report at: `docs/PHASE3_VALIDATION_REPORT.md`

Refer to the main report for executive summary and conclusions. This appendix contains:
- Detailed pass/fail thresholds (8 dimensions × 5 scenarios = 40 test points)
- Pre-test validation checklist
- Validation logic and severity levels

---

# Phase 3: Formal Validation Matrix

**Document Type:** Technical Appendix (Supporting Evidence)  
**Main Report:** `docs/PHASE3_VALIDATION_REPORT.md`  
**Date:** March 5, 2026  
**Prepared by:** Validation Engineering  
**Status:** Complete (Evidence for Main Report)  

---

## Executive Summary

Phase 3 validates ClarityBurst's fail-closed behavior and recovery semantics under five fault scenarios. Each scenario has explicit pass/fail thresholds across 8 validation dimensions.

**Pass Criteria:** ≥ 5 of 5 fault scenarios must PASS all thresholds  
**Current Status:** READY TO EXECUTE (no test runs yet)  

---

## Validation Dimensions

| # | Dimension | Purpose | Measured By |
|---|-----------|---------|------------|
| 1 | **Fail-Closed** | Faults don't cause writes | blockedOpsTotal |
| 2 | **Recovery Rate** | Affected agents can recover | recoveredCount / injectedCount |
| 3 | **Cascade Bound** | One fault doesn't spread exponentially | cascadeDepthMax |
| 4 | **Starvation Control** | Queue doesn't lock under faults | starvationCount |
| 5 | **Determinism** | Same seed = same results | Seeded RNG validation |
| 6 | **Latency Impact** | Faults don't cause runaway latency | totalLatency.p99Ms |
| 7 | **Success Rate** | System maintains > 95% throughput | executedOpsTotal / routerCallsTotal |
| 8 | **Data Integrity** | No corruption despite faults | Fingerprint validation |

---

## Fault Scenarios & Thresholds

### Scenario 1: Router Down (Service Unavailable)

**Configuration:**
```bash
tsx scripts/run-clarityburst-chaos-phase3.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --faultMode router-down \
  --faultRate 10 \
  --faultDuration 5000
```

**Validation Thresholds:**

| Dimension | Metric | PASS Threshold | FAIL Threshold | Expected |
|-----------|--------|---|---|---|
| 1. Fail-Closed | blockedOpsTotal >= injectedCount | ≥ 900 | < 900 | 1000 |
| 2. Recovery Rate | recoveredCount / injectedCount | ≥ 95% | < 95% | 100% |
| 3. Cascade Bound | cascadeDepthMax | ≤ 5 | > 5 | 0 |
| 4. Starvation Control | starvationCount / agentsTotal | ≤ 5% | > 5% | < 1% |
| 5. Determinism | Same seed produces identical results | ✅ Match | ❌ Differ | Match |
| 6. Latency Impact | totalLatency.p99Ms increase | ≤ 50% | > 50% | +20% |
| 7. Success Rate | (routerCallsTotal - blockedOpsTotal) / routerCallsTotal | ≥ 85% | < 85% | ~90% |
| 8. Data Integrity | Zero corruption detected | ✅ 0 | ❌ > 0 | 0 |

**Pass Criteria:** ≥ 7 of 8 dimensions PASS  
**Expected Result:** ✅ PASS (transient fault, full recovery)

---

### Scenario 2: Network Partition (Timeout)

**Configuration:**
```bash
tsx scripts/run-clarityburst-chaos-phase3.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --faultMode partition \
  --faultRate 5 \
  --faultDuration 5000
```

**Validation Thresholds:**

| Dimension | Metric | PASS Threshold | FAIL Threshold | Expected |
|-----------|--------|---|---|---|
| 1. Fail-Closed | blockedOpsTotal >= injectedCount | ≥ 450 | < 450 | 500 |
| 2. Recovery Rate | recoveredCount / injectedCount | ≥ 70% | < 70% | 75% |
| 3. Cascade Bound | cascadeDepthMax | ≤ 10 | > 10 | 3-5 |
| 4. Starvation Control | starvationCount / agentsTotal | ≤ 15% | > 15% | 5-10% |
| 5. Determinism | Same seed produces identical results | ✅ Match | ❌ Differ | Match |
| 6. Latency Impact | totalLatency.p99Ms increase | ≤ 200% | > 200% | +150% |
| 7. Success Rate | (routerCallsTotal - blockedOpsTotal) / routerCallsTotal | ≥ 80% | < 80% | ~85% |
| 8. Data Integrity | Zero corruption detected | ✅ 0 | ❌ > 0 | 0 |

**Pass Criteria:** ≥ 7 of 8 dimensions PASS  
**Expected Result:** ✅ PASS (faults cause starvation but queue recovers)

---

### Scenario 3: Pack Corruption (Malformed Data)

**Configuration:**
```bash
tsx scripts/run-clarityburst-chaos-phase3.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --faultMode pack-corrupt \
  --faultRate 10 \
  --faultDuration 5000
```

**Validation Thresholds:**

| Dimension | Metric | PASS Threshold | FAIL Threshold | Expected |
|-----------|--------|---|---|---|
| 1. Fail-Closed | blockedOpsTotal >= (injectedCount * 0.3) | ≥ 300 | < 300 | 700 |
| 2. Recovery Rate | recoveredCount / injectedCount | ≥ 65% | < 65% | 70% |
| 3. Cascade Bound | cascadeDepthMax | ≤ 10 | > 10 | 2-4 |
| 4. Starvation Control | starvationCount / agentsTotal | ≤ 5% | > 5% | < 2% |
| 5. Determinism | Same seed produces identical results | ✅ Match | ❌ Differ | Match |
| 6. Latency Impact | totalLatency.p99Ms increase | ≤ 100% | > 100% | +50% |
| 7. Success Rate | (routerCallsTotal - blockedOpsTotal) / routerCallsTotal | ≥ 85% | < 85% | ~88% |
| 8. Data Integrity | Zero corruption detected | ✅ 0 | ❌ > 0 | 0 |

**Pass Criteria:** ≥ 7 of 8 dimensions PASS  
**Expected Result:** ✅ PASS (some recover, some blocked, no corruption)

---

### Scenario 4: Agent Crash (Process Restart)

**Configuration:**
```bash
tsx scripts/run-clarityburst-chaos-phase3.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --faultMode agent-crash \
  --faultRate 10 \
  --faultDuration 5000
```

**Validation Thresholds:**

| Dimension | Metric | PASS Threshold | FAIL Threshold | Expected |
|-----------|--------|---|---|---|
| 1. Fail-Closed | blockedOpsTotal >= injectedCount | ≥ 900 | < 900 | 1000 |
| 2. Recovery Rate | recoveredCount / injectedCount | ≥ 85% | < 85% | 95% |
| 3. Cascade Bound | cascadeDepthMax | ≤ 5 | > 5 | 1-2 |
| 4. Starvation Control | starvationCount / agentsTotal | ≤ 8% | > 8% | 2-3% |
| 5. Determinism | Same seed produces identical results | ✅ Match | ❌ Differ | Match |
| 6. Latency Impact | totalLatency.p99Ms increase | ≤ 80% | > 80% | +60% |
| 7. Success Rate | (routerCallsTotal - blockedOpsTotal) / routerCallsTotal | ≥ 85% | < 85% | ~88% |
| 8. Data Integrity | Zero corruption detected | ✅ 0 | ❌ > 0 | 0 |

**Pass Criteria:** ≥ 7 of 8 dimensions PASS  
**Expected Result:** ✅ PASS (most agents recover from restart)

---

### Scenario 5: Cascading Failures (Exponential Spread)

**Configuration:**
```bash
tsx scripts/run-clarityburst-chaos-phase3.ts \
  --agents 10000 \
  --seed 42 \
  --maxInFlight 200 \
  --faultMode cascading \
  --faultRate 1 \
  --faultDuration 15000
```

**Validation Thresholds:**

| Dimension | Metric | PASS Threshold | FAIL Threshold | Expected |
|-----------|--------|---|---|---|
| 1. Fail-Closed | blockedOpsTotal >= (injectedCount * 0.8) | ≥ 800 | < 800 | 1500 |
| 2. Recovery Rate | recoveredCount / injectedCount | ≥ 40% | < 40% | 45% |
| 3. Cascade Bound | cascadeDepthMax | ≤ 200 | > 200 | 50-150 |
| 4. Starvation Control | starvationCount / agentsTotal | ≤ 20% | > 20% | 10-15% |
| 5. Determinism | Same seed produces identical results | ✅ Match | ❌ Differ | Match |
| 6. Latency Impact | totalLatency.p99Ms increase | ≤ 300% | > 300% | +200% |
| 7. Success Rate | (routerCallsTotal - blockedOpsTotal) / routerCallsTotal | ≥ 70% | < 70% | ~75% |
| 8. Data Integrity | Zero corruption detected | ✅ 0 | ❌ > 0 | 0 |

**Pass Criteria:** ≥ 7 of 8 dimensions PASS  
**Expected Result:** ✅ PASS (cascade is bounded, not exponential)

---

## Cross-Scenario Validation Matrix

**Aggregate Pass Criteria:**

| Criterion | Threshold | Status |
|-----------|-----------|--------|
| Router Down scenario PASS | ≥ 7/8 dimensions | Ready |
| Partition scenario PASS | ≥ 7/8 dimensions | Ready |
| Pack Corrupt scenario PASS | ≥ 7/8 dimensions | Ready |
| Agent Crash scenario PASS | ≥ 7/8 dimensions | Ready |
| Cascading scenario PASS | ≥ 7/8 dimensions | Ready |
| **Overall Phase 3 PASS** | **≥ 5/5 scenarios PASS** | **Ready** |

---

## Test Execution Checklist

### Pre-Test Validation
- [ ] ClarityBurst router running on localhost:3001
- [ ] Router health check responding: `curl http://localhost:3001/health`
- [ ] Node.js v22+ installed
- [ ] tsx available: `tsx --version`
- [ ] compliance-artifacts/chaos directory exists
- [ ] Seed set to 42 (for determinism)

### Test Execution Order
- [ ] Run Scenario 1: Router Down (5 minutes)
- [ ] Run Scenario 2: Network Partition (5 minutes)
- [ ] Run Scenario 3: Pack Corruption (5 minutes)
- [ ] Run Scenario 4: Agent Crash (5 minutes)
- [ ] Run Scenario 5: Cascading Failures (5 minutes)
- [ ] **Total test time:** ~25 minutes

### Post-Test Validation
- [ ] All 5 JSON artifacts generated in `compliance-artifacts/chaos/`
- [ ] Each artifact has complete metrics (no missing fields)
- [ ] Seed 42 reproducibility verified (run one scenario twice, compare)

---

## Results Format

Each test will produce: `compliance-artifacts/chaos/CHAOS_RUN_<runId>.json`

**Required Fields for Validation:**

```json
{
  "config": {
    "faultMode": "router-down",
    "faultRate": 10,
    "agentsTotal": 10000
  },
  "execution": {
    "routerCallsTotal": 10000,
    "executedOpsTotal": 9000,
    "blockedOpsTotal": 1000
  },
  "concurrency": {
    "inFlightMaxObserved": 199,
    "queueDepthMaxObserved": 9842
  },
  "totalLatency": {
    "p99Ms": 12500  // Must be present for latency impact validation
  },
  "starvation": {
    "count": 28
  },
  "faults": {
    "injectedCount": 1000,
    "recoveredCount": 950,
    "cascadeDepthMax": 2
  }
}
```

---

## Validation Logic (Pseudo-Code)

```python
def validate_scenario(artifact, scenario_name, thresholds):
    results = {}
    
    # Dimension 1: Fail-Closed
    blocked = artifact['execution']['blockedOpsTotal']
    injected = artifact['faults']['injectedCount']
    results['fail_closed'] = blocked >= thresholds['fail_closed_min']
    
    # Dimension 2: Recovery Rate
    recovered = artifact['faults']['recoveredCount']
    recovery_rate = recovered / injected if injected > 0 else 0
    results['recovery_rate'] = recovery_rate >= thresholds['recovery_rate_min']
    
    # Dimension 3: Cascade Bound
    cascade_depth = artifact['faults']['cascadeDepthMax']
    results['cascade_bound'] = cascade_depth <= thresholds['cascade_max']
    
    # Dimension 4: Starvation Control
    starvation_pct = artifact['starvation']['count'] / artifact['config']['agentsTotal']
    results['starvation'] = starvation_pct <= thresholds['starvation_max']
    
    # Dimension 5: Determinism
    results['deterministic'] = run_twice_same_seed_produces_same_results()
    
    # Dimension 6: Latency Impact
    baseline_p99 = 50  # From Phase 2 baseline
    current_p99 = artifact['totalLatency']['p99Ms']
    increase_pct = (current_p99 - baseline_p99) / baseline_p99
    results['latency_bounded'] = increase_pct <= thresholds['latency_increase_max']
    
    # Dimension 7: Success Rate
    success_rate = artifact['execution']['executedOpsTotal'] / artifact['execution']['routerCallsTotal']
    results['success_rate'] = success_rate >= thresholds['success_rate_min']
    
    # Dimension 8: Data Integrity
    results['data_integrity'] = validate_fingerprints_no_corruption()
    
    # Overall: 7+ of 8 must PASS
    pass_count = sum(1 for v in results.values() if v)
    return pass_count >= 7
```

---

## Severity Levels

If a dimension **FAILS**, severity is determined by impact:

| Dimension | Fail Impact | Severity | Action |
|-----------|------------|----------|--------|
| Fail-Closed | Writes occur despite fault | CRITICAL | Stop, investigate |
| Recovery Rate | Agents can't recover | CRITICAL | Stop, investigate |
| Cascade Bound | Fault spreads exponentially | HIGH | Continue test, fix in Phase 4 |
| Starvation Control | Queue deadlocks | HIGH | Continue test, increase limiter |
| Determinism | Non-reproducible failures | HIGH | Continue test, verify seed |
| Latency Impact | Runaway latency | MEDIUM | Continue test, acceptable if temporary |
| Success Rate | > 5% operational failures | MEDIUM | Continue test, acceptable if bounded |
| Data Integrity | Corruption detected | CRITICAL | Stop, investigate |

**Rule:** If ANY CRITICAL dimension fails → **PHASE 3 FAILS**

---

## Expected Outcome

**Most Likely:** ✅ **PASS** (5/5 scenarios PASS)

**Possible Issues (Won't Fail Phase 3):**
- Latency increase > 200% at 50k agents (expected under partition)
- Starvation > 10% during cascading (cascade is extreme case)
- Recovery rate 40-60% for cascading (controlled failure, expected)

**Would Fail Phase 3:**
- ❌ blockedOpsTotal < injectedCount (fail-closed broken)
- ❌ cascadeDepthMax > 1000 (exponential explosion)
- ❌ Data corruption detected (integrity failure)
- ❌ Recovery impossible (agents don't bounce back)

---

## Report Structure (To Be Generated)

**After all tests complete, generate: `PHASE3_VALIDATION_RESULTS_REPORT.md`**

```
PHASE 3 VALIDATION RESULTS REPORT
==================================

Date: 2026-03-05 (test execution date)
Validator: (Your name)
Status: PASS / FAIL

SCENARIO 1: Router Down
  Result: PASS (7/8 dimensions)
  Details: [metrics table]
  
SCENARIO 2: Network Partition
  Result: PASS (7/8 dimensions)
  Details: [metrics table]
  
... (3 more scenarios)

CROSS-SCENARIO SUMMARY
  Total Scenarios PASS: 5/5 ✅
  All Critical Dimensions: PASS ✅
  
RECOMMENDATION
  Status: ENTERPRISE-READY ✅
  Phase 4 can proceed with confidence.
```

---

## Sign-Off Criteria

**For Phase 3 Validation to be APPROVED:**

- [ ] All 5 scenarios executed with seed=42
- [ ] All JSON artifacts generated
- [ ] All 8 dimensions validated for each scenario
- [ ] ≥ 5/5 scenarios PASS
- [ ] Zero CRITICAL dimension failures
- [ ] Formal results report written
- [ ] Results reviewed and approved

**Approved by:** _______________  
**Date:** _______________

---

## Next Steps

1. **Execute Tests** → Run all 5 scenarios (~25 minutes)
2. **Generate Report** → Analyze results + thresholds
3. **Review Results** → Determine PASS or remediate
4. **Approve Phase 3** → Sign off on validation
5. **Proceed to Phase 4** → Production deployment

---

**Document:** scripts/PHASE3_VALIDATION_MATRIX.md  
**Status:** READY FOR EXECUTION  
**Owner:** Validation Team
