# MEMORY-BRIDGE-THRESHOLD-009 — ID 103 Threshold Exclusion Diagnosis

**Date:** 2026-06-23 11:52 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟢 Auto (사전 승인 불필요, 사후 보고)

## Summary

Diagnose why canonical_memories ID 103 (`truth_confidence=1000`) is excluded from the Jinhee memory bridge context block, and determine whether to adjust the DB value or the bridge threshold logic.

---

## ID 103 Row (Read-Only)

| Field            |                                                                                                                                                                      Value |
| :--------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| ID               |                                                                                                                                                                        103 |
| truth_confidence |                                                                                                                                                                   **1000** |
| source_count     |                                                                                                                                                                          1 |
| memory_type      |                                                                            `{"sourceCandidateId":"CAND-IDE-423","kind":"identity","sourceLogIds":[1667],"importance":0.9}` |
| content          | _"The current runtime environment is OpenClaw Gateway. 진희 is the identity; JinheeOS is the operating-system body; OpenClaw is the execution environment and tool-hand."_ |

Content is legitimate, non-test, identity-critical canonical memory.

---

## Bridge Filter Condition (Source Confirmed)

```typescript
// src/agents/jinhee-memory-bridge.ts:70
const LOW_TRUST_THRESHOLD = 1000;

// src/agents/jinhee-memory-bridge.ts:134-135
// Skip low-trust items (truth_confidence >= 1000)
if (row.truthConfidence >= LOW_TRUST_THRESHOLD) continue;
```

- **Operator:** `>=` (greater than or equal)
- **Design intent:** Filter out test/low-quality rows (IDs 30–55 have conf 5000–7000)
- **Side effect:** Exact-1000 rows (ID 103, ID 55) also excluded

---

## Exclusion Cause

**ID 103 is excluded because `1000 >= 1000` is true.**

The threshold uses `>=` not `>`. This was intentional for test rows at high confidences, but it also catches ID 103 which is a legitimate, curated canonical memory with confidence 1000.

---

## Boundary Comparison

| Confidence |              Behavior |                               Example IDs |
| :--------- | --------------------: | ----------------------------------------: |
| 950        |    ✅ Allowed through |                           98–102, 104–107 |
| 999        |    ✅ Allowed through |                                    (none) |
| **1000**   | ❌ **Blocked** (`>=`) | **103 (legitimate)**, 55 (test: "테스트") |
| 5000       |            ❌ Blocked |                      30–36 (test entries) |
| 7000       |            ❌ Blocked |                      25–26 (test entries) |

---

## Recommendation

### Option A: ✅ **Lower ID 103's confidence to 950** (Recommended)

- **Risk:** Low — ID 55 ("테스트") at 1000 stays blocked, threshold stays unchanged
- **Impact:** ID 103 enters context block immediately
- **Operation:** Single `UPDATE canonical_memories SET truth_confidence=950 WHERE id=103` (🔴 Heavy, requires 형 approval)
- **Consistency:** Matches other identity/operational_rule entries (all 950)

### Option B: Change threshold to `>` (Not recommended)

- Would admit ID 55 ("테스트") into agent context — undesirable
- Everything with conf > 1000 stays blocked
- Requires source code change + gateway restart

### Option C: Do nothing

- ID 103 stays excluded from context
- Identity unification principle not reinforced at runtime
- Minor, but suboptimal

**→ Option A is cleanest. Single DB value change, no code change, no restart, no test admission.**

---

## Test Suite

| Test File                      |  Status | Count |
| :----------------------------- | ------: | ----: |
| `jinhee-memory-bridge.test.ts` | ✅ PASS | 14/14 |

All 14 tests pass — including the threshold filter test. Note: existing test uses confidences 100/5000/7000; no exact-1000 boundary test case exists.

---

## DB Safety

| Table              | Count | Changed? |
| :----------------- | ----: | -------: |
| canonical_memories |    30 | ❌ No ✅ |
| memories           |   214 | ❌ No ✅ |

No DB writes performed (read-only diagnosis).

---

## Forbidden Changes

| Check                             |           Result |
| :-------------------------------- | ---------------: |
| DB write                          |         ❌ No ✅ |
| MEMORY.md                         |    No changes ✅ |
| package/lock/config/secrets/model |          none ✅ |
| git diff --check                  |         clean ✅ |
| gateway build/restart             | Not performed ✅ |

---

## Verdict

```
MEMORY-BRIDGE-THRESHOLD-009: ✅ COMPLETE

ID 103 조회 결과:     ID 103 / conf 1000 / content: identity unification
제외 원인:            truth_confidence=1000 >= LOW_TRUST_THRESHOLD=1000
bridge 필터 조건:     if (row.truthConfidence >= LOW_TRUST_THRESHOLD) continue;
DB 값 수정 vs 코드 수정: DB 값 수정 (1000→950)이 안전
추천 다음 티켓:       MEMORY-BRIDGE-THRESHOLD-010 — ID 103 confidence 1000→950 UPDATE
                      (🔴 Heavy, 형 사전 승인 필요)
DB write 여부:        없음 (read-only)
report 위치:          docs/audits/MEMORY-BRIDGE-THRESHOLD-009.md
```
