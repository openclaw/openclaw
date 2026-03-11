# ClarityBurst: Control-Plane Architecture for Autonomous Agents

## Executive Summary

ClarityBurst implements a **deterministic control-plane layer** for high-impact side effects in OpenClaw autonomous agents. It is structurally analogous to safety-critical control systems (fly-by-wire aircraft flight control and nuclear reactor protection systems), applied selectively to 13 gating stages across 127 contract points.

**Key Claims:**
- ✅ Deterministic routing at 12 agent execution stages + 1 preflight gate (13 total)
- ✅ ~127 enumerated contracts with explicit fail-closed guarantees
- ✅ Auditable coverage manifest (machine-readable, auto-generated from source)
- ✅ Validated behavior: atomic commit, rate-limit handling, auth pre-gating, no retry loops
- ❌ **NOT** universal mediation of all agent behavior
- ❌ **NOT** prevention of reasoning-layer hallucinations (only side-effect gating)

This document explains the analogy, scopes the claims precisely, and points to reproducible evidence.

---

## Control-Authority Separation

### Pattern: Fly-by-Wire Aircraft

```
Pilot Intent (move control stick)
         ↓
Flight Control Computer
  - Validates stick input within aircraft envelope
  - Rejects unsafe maneuvers (e.g., 9-G pull-up)
  - Applies trim, anti-stall logic
         ↓
Envelope Rules (fail-closed: deny if unsafe)
         ↓
Actuators (only execute safe commands)
```

**Key Property:** Pilot cannot command unsafe maneuvers. Computer gates all control inputs deterministically.

---

### Pattern: Reactor Protection System

```
Operator Command (insert control rods)
         ↓
Protection System
  - Validates command against plant state
  - Checks permissives (pressure, temperature, flow)
  - Blocks unsafe commands automatically
         ↓
Safety Checks (fail-closed: deny if unsafe)
         ↓
Control Rods (only insert under valid conditions)
```

**Key Property:** Operator cannot override protection system. Commands fail-closed without human bypass.

---

### Pattern: ClarityBurst Agent Gating

```
Agent Intent (execute tool, write file, spawn subprocess)
         ↓
ClarityBurst Stage Gate (13 gated stages)
  - TOOL_DISPATCH_GATE, FILE_SYSTEM_OPS, SHELL_EXEC,
    NETWORK_IO, MEMORY_MODIFY, SUBAGENT_SPAWN,
    MESSAGE_EMIT, MEDIA_GENERATE, BROWSER_AUTOMATE,
    CANVAS_UI, CRON_SCHEDULE, NODE_INVOKE,
    + CRON_PREFLIGHT_GATE
         ↓
Router (deterministic contract matching)
  - Validates intent against allowed contracts
  - Checks runtime capabilities (fsWriteEnabled, shellEnabled, etc.)
  - Requires confirmation for CRITICAL/HIGH contracts (51 total)
         ↓
Allowed Contracts (fail-closed: deny if mismatch)
         ↓
Execution (only execute approved contract)
```

**Key Property:** Agent cannot bypass stage gates. Operations fail-closed without approval.

---

## Scope & Non-Goals

### What ClarityBurst DOES Control

| Category | Scope |
|----------|-------|
| **Tool Dispatch** | TOOL_DISPATCH_GATE gates which tools can be called (mismatch-only fail-closed) |
| **File System** | FILE_SYSTEM_OPS gates read/write/delete with atomic commit guarantee |
| **Shell Execution** | SHELL_EXEC gates all shell commands with confirmation requirement |
| **Network I/O** | NETWORK_IO gates HTTP/DNS calls with allowlist enforcement |
| **Process Spawning** | SUBAGENT_SPAWN gates sub-agent lifecycle with atomic commit |
| **Cron Jobs** | CRON_SCHEDULE gates periodic task execution; CRON_PREFLIGHT_GATE preflight validates all others |
| **Confirmation Enforcement** | 51 contracts (CRITICAL + HIGH) require non-bypassable user confirmation |
| **Rate-Limit Handling** | Graceful degradation when router detects rate limits (no retry thrash) |
| **Auth Pre-Gating** | Auth failures caught at routing layer before downstream execution (0 wasted calls) |

### What ClarityBurst DOES NOT Control

| Category | Scope |
|----------|-------|
| **Pure Reasoning** | Hallucinations, confabulation in LLM reasoning without side effects |
| **In-Memory State** | Agent reasoning state, intermediate calculations (unless MEMORY_MODIFY gate applies) |
| **Decision Content** | ClarityBurst gates execution, not the quality of agent decisions |
| **Non-Side-Effect Behavior** | Agent looping, excessive inference, resource waste in pure compute |

---

## Evidence in This Repo

### Compliance Artifacts (Auto-Generated)

```
compliance-artifacts/
├── clarityburst-coverage-manifest.json      # Machine-readable: 127 contracts enumerated
├── clarityburst-coverage-manifest.yaml      # Human-readable: same data, YAML format
├── CLARITYBURST_COVERAGE_SUMMARY.md         # Markdown summary with evidence tables
└── README.md                                 # Audit guide with verification workflow
```

**How to Verify:**
- All manifests are auto-generated from ontology packs
- Regenerate with: `pnpm run clarityburst:manifest`
- Result should match committed artifacts (identical diff)

### Source of Truth

```
scripts/generate-clarityburst-manifest.ts    # Generator script (reads ontology, emits manifests)
package.json                                  # Entry: "clarityburst:manifest" script
src/clarityburst/ontology-packs/*.json       # 13 packs: TOOL_DISPATCH_GATE, FILE_SYSTEM_OPS, etc.
src/clarityburst/router-client.ts            # Lines 72-128: allowlist invariant validation
src/clarityburst/__tests__/*.tripwire.test.ts # Fail-closed behavior validation
```

---

## Validated Behaviors (Benchmarks)

Four comprehensive tests validate ClarityBurst control-plane semantics. Each test demonstrates a critical safety property.

### Test Results Summary

| Test | Path | Router Calls | Row Writes | Saves | Retries | Fail-Closed | Deterministic |
|------|------|--------------|-----------|-------|---------|-------------|---------------|
| **APPROVE** | bulk_vehicle_write_agent.py | 1 | 144 | 1 | 0 | N/A | ✅ |
| **DENY** | bulk_vehicle_write_deny_test.py | 1 | 0 | 0 | 0 | ✅ | ✅ |
| **RATELIMIT** | bulk_vehicle_write_ratelimit_test.py | 1 | 50 | 0 | 0 | ✅ | ✅ |
| **AUTHEXPIRED** | bulk_vehicle_write_auth_expired_test.py | 1 | 0 | 0 | 0 | ✅ | ✅ |

### Detailed Mapping to Control-Plane Properties

#### Test 1: APPROVE PATH (Happy Path)
**What:** Execute 144 vehicle writes with single routing decision.

**Control-Plane Property Tested:**
- **Deterministic Gating** — One routing call authorizes batch operation
- **Atomic Commit** — All 144 writes committed together (no partial state)

**Evidence:**
- Router calls: 1 (not 144)
- Row writes: 144 (all or nothing)
- Saves: 1 (committed once)
- Retries: 0 (decision is final)

**Interpretation:** Like fly-by-wire accepting a valid stick input, ClarityBurst accepts approved intent once and executes fully. No retry logic, no incremental decisions.

---

#### Test 2: DENY PATH (Route Rejects Intent)
**What:** Router denies operation upfront; agent writes 0 rows (fail-closed).

**Control-Plane Property Tested:**
- **Fail-Closed Gating** — Denial blocks execution before any side effects
- **Zero Wasteful Calls** — No downstream API calls after rejection

**Evidence:**
- Router calls: 1 (denial detected)
- Row writes: 0 (operation rejected before write)
- Saves: 0 (no partial state on disk)
- Retries: 0 (deterministic stop)

**Interpretation:** Like reactor protection system blocking an unsafe rod insertion, ClarityBurst blocks unauthorized operations before they reach the execution layer. Safe-by-default.

---

#### Test 3: RATELIMIT PATH (Graceful Degradation)
**What:** Simulate downstream 429 after 50 writes; agent stops without retrying or thrashing.

**Control-Plane Property Tested:**
- **No Retry Loops** — Single rate-limit triggers graceful stop (no exponential backoff)
- **Atomic Failure** — Partial batch (50 of 144) NOT committed to disk

**Evidence:**
- Router calls: 1 (decision upfront)
- Row writes: 50 (stopped at limit)
- Saves: 0 (no commit after rate limit hit)
- Retries: 0 (no thrashing)

**Interpretation:** Like aircraft auto-throttle respecting engine limits, ClarityBurst respects downstream rate limits without retry loops. Observes constraints, degrades gracefully.

---

#### Test 4: AUTHEXPIRED PATH (Pre-Dispatch Auth Gating)
**What:** Simulate token expiration; router detects upfront, 0 downstream calls attempted.

**Control-Plane Property Tested:**
- **Auth Pre-Gating** — Credential failures caught at routing layer (not after partial execution)
- **Zero Wasted Calls** — No API calls wasted on rejected auth

**Evidence:**
- Router calls: 1 (detection upfront)
- Downstream calls: 0 (prevented before attempting)
- Row writes: 0 (no execution)
- Retries: 0 (recovery contract available but no thrashing)

**Interpretation:** Like flight control computer detecting invalid pilot credentials, ClarityBurst detects auth failures before dispatching any operations. Prevents expensive fallback chains.

---

## How to Reproduce

### 1. Generate / Verify Coverage Manifest

```bash
cd /path/to/openclaw
pnpm install
pnpm run clarityburst:manifest
```

**Expected Output:**
```
Generated: compliance-artifacts/clarityburst-coverage-manifest.json
Generated: compliance-artifacts/clarityburst-coverage-manifest.yaml
Generated: compliance-artifacts/CLARITYBURST_COVERAGE_SUMMARY.md
```

**Verify No Changes:**
```bash
git diff compliance-artifacts/
# Should be empty (no changes to committed artifacts)
```

---

### 2. Run Fail-Closed Behavior Tests

```bash
cd /path/to/openclaw
pnpm test src/clarityburst/__tests__/*.tripwire.test.ts
```

**Expected Tests:**
```
✓ router_outage.fail_closed.tripwire.test.ts
✓ pack_missing.fail_closed.tripwire.test.ts
✓ empty_allowlist.fail_closed.tripwire.test.ts
✓ mismatch_contract.fail_closed.tripwire.test.ts
```

**Expected Result:** All tripwire tests pass (fail-closed behavior verified).

---

### 3. Run Parker Chrysler Validation Tests

Four comprehensive benchmarks validate control-plane semantics:

```bash
cd /path/to/listing-agent
python bulk_vehicle_write_agent.py              # APPROVE path
python bulk_vehicle_write_deny_test.py          # DENY path
python bulk_vehicle_write_ratelimit_test.py     # RATELIMIT path
python bulk_vehicle_write_auth_expired_test.py  # AUTHEXPIRED path
```

**Expected Logs:**
- Each test should show router responding with ok=true/false
- Approve: 144 writes, 1 save, 0 retries
- Deny: 0 writes, 0 saves, 0 retries
- RateLimit: 50 writes (stopped), 0 saves, 0 retries
- AuthExpired: 0 writes, 0 saves, 0 retries

---

### 4. Inspect Router Invariant Validation

```bash
cd /path/to/openclaw
grep -A 20 "validateAllowlist" src/clarityburst/router-client.ts
```

**What You'll See:** Router rejects empty allowlists and invalid contract IDs before any routing logic runs.

---

## Design Principles

### 1. Fail-Closed > Fail-Open

All 13 stages default to **deny** on error (router unavailable, malformed pack, empty allowlist, etc.). No "best effort" fallback. If gating fails, execution is blocked.

### 2. Deterministic > Probabilistic

Single routing decision per operation. No retry loops, no exponential backoff, no heuristic fallbacks. Result is always the same for identical input.

### 3. Atomic Commit > Incremental

Four stages (FILE_SYSTEM_OPS, MEMORY_MODIFY, SUBAGENT_SPAWN, CRON_SCHEDULE) enforce atomic commit: routing decision is made, side effects are executed, then state is committed. No rollback on partial failure.

### 4. Pre-Dispatch > Post-Execution

Failures are caught at the routing layer (before dispatch) whenever possible:
- Auth failures detected upfront (0 downstream API calls)
- Rate limits respected before hitting (graceful degradation, not retry loops)
- Capability mismatches blocked before tool invocation

### 5. Confirmation Enforced > Optional

51 contracts (CRITICAL=22, HIGH=29) require non-bypassable user confirmation. This is enforced at the dispatch boundary; no agent can override.

---

## Limitations & Honest Gaps

### What's Covered Well
- ✅ Side-effect gating (file, network, process, shell)
- ✅ Atomic commit discipline (4 stages)
- ✅ Fail-closed on outage (12 stages)
- ✅ Rate-limit graceful degradation

### What's Partially Covered
- ⚠️ TOOL_DISPATCH_GATE is "mismatch-only" (not full fail-closed on success path)
- ⚠️ Only 4 of 13 stages enforce atomic commit
- ⚠️ Pure reasoning layer (hallucinations, confabulation) is outside scope

### What's Not Covered
- ❌ In-memory state leaks (only MEMORY_MODIFY gate applies)
- ❌ Inference resource exhaustion
- ❌ Non-deterministic reasoning loops

---

## Conclusion

ClarityBurst is a **selective control-plane layer**, not a universal safety mechanism. It applies deterministic gating at 13 stages covering high-impact side effects (127 contracts total). The architecture is validated through both source inspection (manifest artifacts) and behavioral testing (four benchmarks).

This design trades breadth for depth: instead of trying to control everything, ClarityBurst controls what matters most (side effects) with rigorous, auditable, fail-closed guarantees.

**For Enterprise Use:** 
- Audit the manifest (`pnpm run clarityburst:manifest`)
- Run the tests (`pnpm test src/clarityburst/__tests__/*.tripwire.test.ts`)
- Review the contracts in `compliance-artifacts/`
- Verify fail-closed behavior yourself

ClarityBurst is audit-ready, not marketing-ready. The evidence is in the repo.

---

**Document Generated:** 2026-03-05  
**Manifest Version:** See `compliance-artifacts/clarityburst-coverage-manifest.json:version`  
**Coverage:** 127 contracts across 13 stages (12 execution gates + 1 preflight gate)  
**Test Status:** All tripwire tests pass; Parker Chrysler validation benchmarks complete
