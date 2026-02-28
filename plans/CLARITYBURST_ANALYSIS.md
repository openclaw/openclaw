# ClarityBurst Implementation Analysis & Next Task Recommendation

**Analysis Date**: 2026-02-18  
**Status**: Complete investigation of architecture, test coverage, and implementation gaps

---

## 1. ARCHITECTURE SUMMARY

### 1.1 System Overview

ClarityBurst is a multi-stage gating system that controls risky operations through deterministic policy enforcement. The system follows a **fail-closed** safety model with explicit override and confirmation mechanisms.

### 1.2 Core Components

#### **Stages (12 defined in `stages.ts`)**
- `TOOL_DISPATCH_GATE` - Controls which tools can be invoked
- `SHELL_EXEC` - Requires confirmation for high-risk commands
- `FILE_SYSTEM_OPS` - Gates file operations (read/write/delete)
- `NETWORK_IO` - Gates network requests (fetch/connect)
- `MEMORY_MODIFY` - Gates memory mutations (store/delete)
- `SUBAGENT_SPAWN` - Controls subagent spawning
- `NODE_INVOKE` - Gates Node.js code invocation
- `BROWSER_AUTOMATE` - Controls browser automation actions
- `CRON_SCHEDULE` - Gates scheduled task creation
- `MESSAGE_EMIT` - Controls message emission to channels
- `MEDIA_GENERATE` - Gates media generation requests
- `CANVAS_UI` - Controls canvas UI rendering

**Ontology Packs**: One JSON pack per stage in `ontology-packs/`. All 12 packs exist and load successfully.

#### **Router Client (`router-client.ts`)**
- Sends routing requests to `http://localhost:3001/api/route` (configurable)
- Validates `allowedContractIds` for completeness (no duplicates, no empty strings)
- Returns `top1` and `top2` contract matches with confidence scores
- Handles timeouts, JSON parsing errors, and malformed responses
- Configuration via environment variables:
  - `CLARITYBURST_ENABLED` (default: true)
  - `CLARITYBURST_ROUTER_URL` (default: http://localhost:3001)
  - `CLARITYBURST_ROUTER_TIMEOUT_MS` (default: 1200ms, range: 100-5000)
  - `CLARITYBURST_LOG_LEVEL` (debug|info|warn|error)

#### **Pack Registry (`pack-registry.ts`)**
- Loads all packs at module startup
- **Fail-closed policy**: No silent defaults; validation failures throw `PackPolicyIncompleteError`
- Contract field validation:
  - Required: `contract_id`, `risk_class`, `required_fields`, `limits`, `needs_confirmation`, `deny_by_default`, `capability_requirements`
  - Optional: `thresholds`, `field_schema`, `description`
- Runtime validation on each lookup via `getPackForStage(stageId)`

#### **Allowed Contracts (`allowed-contracts.ts`)**
- **`deriveAllowedContracts(stageId, pack, caps)`**: Filters contracts based on:
  - Risk class (CRITICAL + deny_by_default requires `explicitlyAllowCritical` capability)
  - Capability requirements matching (`browser`, `shell`, `network`, `fs_write`, `critical_opt_in`, `sensitive_access`)
  - Special logic for TOOL_DISPATCH_GATE: includes capability filtering
  - Default logic for other stages: excludes CRITICAL deny_by_default unless opt-in
- **`assertNonEmptyAllowedContracts(stageId, allowedContractIds)`**: Throws `ClarityBurstAbstainError` if empty

#### **Decision Override Implementations**

**Synchronous (no routing)**:
- `applyToolDispatchOverrides(pack, routeResult, context)` - Fail-open on router failure
- `applyShellExecOverrides(pack, routeResult, context)` - Fail-open on router failure

**Async with full commit-point flow (load pack → derive allowed → route → override)**:
1. `applyFileSystemOverrides(context)` - **Fail-closed** on router outage / missing thresholds
2. `applyNetworkOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
3. `applyMemoryModifyOverrides(context)` - **Fail-closed** on router outage
4. `applySubagentSpawnOverrides(context)` - **Fail-closed** on router outage; fail-open on mismatch
5. `applyNodeInvokeOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
6. `applyBrowserAutomateOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
7. `applyCronScheduleOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
8. `applyMessageEmitOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
9. `applyMediaGenerateOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch
10. `applyCanvasUiOverrides(context)` - **Fail-closed** on router outage / missing thresholds; fail-open on mismatch

**Outcome Types**:
- `PROCEED` - Allow operation with optional contractId
- `ABSTAIN_CONFIRM` - Require user confirmation token (instructions provided)
- `ABSTAIN_CLARIFY` - Require clarification due to:
  - `LOW_DOMINANCE_OR_CONFIDENCE` - Router uncertainty (top1 score below threshold, insufficient gap vs top2)
  - `PACK_POLICY_INCOMPLETE` - Missing/invalid pack fields or thresholds
  - `router_outage` - Router unavailable or failed

---

## 2. TEST COVERAGE ASSESSMENT

### 2.1 Tripwire Test Suite Organization

**Pattern**: `src/clarityburst/__tests__/<stage>.<scenario>.<behavior>.tripwire.test.ts`

Excellent naming convention that documents:
- **Stage**: Which gating stage is being tested
- **Scenario**: The failure condition (router_outage, empty_allowlist, pack_incomplete, router_mismatch, confirmation)
- **Behavior**: Expected outcome (fail_closed, fail_open_only, abstain_clarify, exact_token)

### 2.2 Current Test Coverage

#### **TOOL_DISPATCH_GATE** (3 tripwire tests)
✓ `tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts`
- Verifies fail-closed behavior when router is unavailable
- Confirms operation is blocked with nonRetryable=true

✓ `tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts`
- Tests when router returns contractId NOT in pack
- Confirms fail-open (proceed without gating enforcement)

✓ `tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts`
- When capabilities deny all contracts, returns ABSTAIN_CLARIFY

#### **SHELL_EXEC** (1 tripwire test)
✓ `shell_exec.confirmation.exact_token.tripwire.test.ts`
- Verifies confirmation token must be exact match (not substring)
- Prevents bypassing confirmation with token + extra text

#### **SUBAGENT_SPAWN** (4 tripwire tests)
✓ `subagent_spawn.router_outage.fail_closed.tripwire.test.ts`
- Fails closed when router unavailable

✓ `subagent_spawn.pack_incomplete.fail_closed.tripwire.test.ts`
- Blocks when pack is malformed/incomplete

✓ `subagent_spawn.empty_allowlist.abstain_clarify.tripwire.test.ts`
- Returns ABSTAIN_CLARIFY when no contracts are allowed

✓ `subagent_spawn.router_mismatch.fail_open_only.tripwire.test.ts`
- Fails open when router returns unknown contractId

#### **MEMORY_MODIFY** (5 tripwire tests)
✓ `memory_modify.router_outage.fail_closed.tripwire.test.ts`
- Tests fail-closed behavior on router outage

✓ `memory_modify.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts`
- Blocks at commit point when pack is incomplete

✓ `memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts`
- Tests router outage handling in hook context

✓ `memory_modify.hook_handler.pack_incomplete.fail_closed.tripwire.test.ts`
- Tests pack validation failure in hook context

✓ `memory_modify.hook_handler.empty_allowlist.fail_closed.tripwire.test.ts`
- Tests empty allowlist rejection in hook context

#### **FILE_SYSTEM_OPS** (4 tripwire tests visible in file list)
- `file_system_ops.ensure_dir.pack_incomplete.fail_closed.tripwire.test.ts`
- `file_system_ops.router_outage.fail_closed.tripwire.test.ts`
- `file_system_ops.save_session_store.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts`
- `file_system_ops.write_config_file.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts`

#### **NETWORK_IO** (1 tripwire test visible)
- `network_io.router_outage.fail_closed.tripwire.test.ts`

#### **Other Test Files** (support infrastructure)
✓ `stages.packs.test.ts` - Validates all 12 packs load correctly
✓ `pack-load.test.ts` - Tests pack loading and error conversion
✓ `router-client.duplicate-ids.test.ts` - Validates duplicate ID rejection
✓ `decision-override.test.ts` - Core decision logic tests
✓ `deps.test.ts` - Dependency integrity checks
✓ `pack-load.test.ts` - Pack loading edge cases

### 2.3 Edge Cases Covered

| Scenario | Coverage | Evidence |
|----------|----------|----------|
| Router outage (network failure) | ✓ EXCELLENT | 5+ tests across stages |
| Pack validation failure | ✓ EXCELLENT | 8+ tests for incomplete/malformed packs |
| Empty allowlist (capability denial) | ✓ GOOD | 3+ tests |
| Router mismatch (contractId not in pack) | ✓ GOOD | 2 tests (TOOL_DISPATCH_GATE, SUBAGENT_SPAWN) |
| Low confidence/dominance scores | ✓ PARTIAL | Tested in decision-override logic |
| Duplicate contract IDs in allowlist | ✓ GOOD | router-client.duplicate-ids test |
| Missing thresholds | ✓ GOOD | Tested in FILE_SYSTEM_OPS, NETWORK_IO |
| Confirmation token exact matching | ✓ GOOD | shell_exec.confirmation test |
| Hook handler failures | ✓ GOOD | memory_modify.hook_handler tests |

### 2.4 Test Quality Assessment

**Strengths**:
1. **Excellent naming convention** - Test names clearly document what's being tested and expected outcome
2. **Deterministic behavior** - Tests verify specific outcomes (nonRetryable, stageId, reason, contractId)
3. **Mock patterns** - Consistent use of vi.spyOn() for mocking router, pack loading, allowed contracts
4. **Failure mode focus** - Tests specifically target error paths, not happy paths
5. **Real production paths** - Some tests (e.g., subagent_spawn.router_mismatch) invoke actual production code

**Areas for Enhancement**:
1. **Threshold edge cases** - Limited testing of boundary conditions (score = T, score - top2 = Δ)
2. **Hook integration** - Only MEMORY_MODIFY tests hook handlers; other stages may lack hook tests
3. **Capability filtering** - Limited coverage of capability_requirements filtering logic
4. **Stage-to-pack wiring** - No tests verifying stage integrity guards (stageId mismatch detection)
5. **Newer stages** - MEDIA_GENERATE, CANVAS_UI have override functions but may lack comprehensive test coverage

---

## 3. CURRENT IMPLEMENTATION GAPS

### 3.1 Missing or Incomplete Ontology Packs

**Status**: ✓ All 12 packs exist and are valid

All packs load successfully:
- BROWSER_AUTOMATE.json ✓
- CANVAS_UI.json ✓
- CRON_SCHEDULE.json ✓
- FILE_SYSTEM_OPS.json ✓
- MEDIA_GENERATE.json ✓
- MEMORY_MODIFY.json ✓
- MESSAGE_EMIT.json ✓
- NETWORK_IO.json ✓
- NODE_INVOKE.json ✓
- SHELL_EXEC.json ✓
- SUBAGENT_SPAWN.json ✓
- TOOL_DISPATCH_GATE.json ✓

### 3.2 Incomplete Stage Implementations

**MEMORY_MODIFY Integration**:
- Override function `applyMemoryModifyOverrides()` exists in decision-override.ts
- Test indicates "NO REACHABLE GATING PATH" - suggesting the function is not yet wired into actual memory mutation execution
- Comment in test: "This test will FAIL until applyMemoryModifyOverrides is implemented and wired into the memory mutation executor's commit-point path"
- **Action Required**: Verify and complete integration in memory mutation executor

**Hook Handler Integration**:
- MEMORY_MODIFY has hook handler tripwire tests (router outage, pack incomplete, empty allowlist)
- But main commit-point wiring may be incomplete
- Other stages (FILE_SYSTEM_OPS, NETWORK_IO) may have similar hook-based wiring gaps

### 3.3 Untested Code Paths

#### **Configuration Edge Cases**
- Invalid CLARITYBURST_ROUTER_URL format (partially tested)
- Router timeout boundary values (100ms, 5000ms)
- Missing environment variables (uses defaults)

#### **Router Response Validation**
- Malformed JSON responses (partially tested)
- Missing top1/top2 in response
- Invalid score types (non-numeric)
- Router version field variations

#### **Threshold Evaluation**
- Boundary conditions (score exactly at T, dominance exactly at Δ)
- Missing thresholds in pack (tested for FILE_SYSTEM_OPS, need broader coverage)
- Undefined vs. null vs. missing fields

#### **Capability Requirement Filtering**
- Unknown capability strings (unsupported requirements)
- Complex multi-requirement scenarios
- Mixed enabled/disabled capabilities per contract

#### **Stage Integrity Guards**
- Stage ID mismatch detection (wired in pack-load.ts but not directly tested)
- Invocation of override function with wrong stageId
- Cross-stage confusion in execution paths

### 3.4 Error Handling & Recovery

**Well-Handled**:
- ✓ Router timeouts (AbortController)
- ✓ Pack validation failures (PackPolicyIncompleteError → ClarityBurstAbstainError)
- ✓ Duplicate contract IDs in allowlist
- ✓ Empty allowlist scenarios

**Needs Testing**:
- [ ] Router returning partial responses (top1 without top2, or vice versa)
- [ ] Concurrent routing requests (stress testing)
- [ ] Memory/cleanup on failed routing attempts
- [ ] Configuration reload during runtime

### 3.5 Deployment & Operational Concerns

**Configuration**:
- ✓ Environment-based configuration
- ✓ Validation on module load
- ✓ HTTPS warning in production

**Monitoring**:
- Configuration logging at startup
- Limited observability into routing decision flow
- No metrics/instrumentation for decision outcomes
- No logging of blocked operations (nonRetryable outcomes)

**Docker/Integration**:
- Assumes router service is available at startup
- No graceful degradation if router service is unavailable initially
- Configuration expects hardcoded port (3001) by default

---

## 4. RECOMMENDED NEXT TASK

### **Priority 1: Complete MEMORY_MODIFY Integration (BLOCKING)**

**Rationale**:
1. Test file explicitly states "NO REACHABLE GATING PATH"
2. Override function exists but is not wired into execution
3. Hook handler tests exist but may not be invoked during actual memory mutations
4. This is a **fail-open gap** - memory mutations currently bypass gating entirely

**Specific Actions**:
1. **Identify memory mutation executor** - Find all locations where memory is modified (session store, persistent memory, etc.)
2. **Wire applyMemoryModifyOverrides()** - Add commit-point evaluation before each mutation
3. **Verify hook handler integration** - Ensure hook handlers call applyMemoryModifyOverrides() at appropriate points
4. **Run tripwire tests** - Verify memory_modify.* tests pass with wiring complete
5. **Integration testing** - Test end-to-end: router outage → memory mutation blocked

**Expected Outcome**:
- All MEMORY_MODIFY tripwire tests pass
- Router outage blocks memory mutations (nonRetryable=true)
- Pack validation failures block mutations
- Empty allowlist blocks mutations

**Time Estimate**: High confidence fix (integration wiring only, logic already complete)

---

## 5. SECONDARY PRIORITIES

### **Priority 2: Expand Hook Handler Test Coverage**

**Current State**:
- Only MEMORY_MODIFY has hook handler tripwire tests
- FILE_SYSTEM_OPS, NETWORK_IO, SUBAGENT_SPAWN may have hooks but lack explicit test coverage

**Action**:
1. Audit all hook definitions in codebase
2. Identify which stages use hook handlers
3. Create tripwire tests for each hook stage combination (router_outage, pack_incomplete, empty_allowlist)

### **Priority 3: Test Newer Stages (MEDIA_GENERATE, CANVAS_UI)**

**Current State**:
- Override functions exist for all 12 stages
- Newer stages (MEDIA_GENERATE, CANVAS_UI) lack explicit tripwire test files

**Action**:
1. Create media_generate.* and canvas_ui.* tripwire tests
2. Test router outage, empty allowlist, pack incomplete scenarios
3. Verify threshold enforcement (min_confidence_T, dominance_margin_Delta)

### **Priority 4: Router Response Robustness**

**Current State**:
- Router client validates JSON shape
- Limited testing of edge cases (malformed responses, partial data)

**Action**:
1. Add tests for router returning missing top1/top2
2. Test non-numeric scores
3. Test router version field variations
4. Add stress test for concurrent routing requests

### **Priority 5: Threshold Boundary Testing**

**Current State**:
- Threshold logic implemented
- Limited testing of boundary conditions (score exactly at T)

**Action**:
1. Create threshold_boundary tripwire tests
2. Test score exactly at min_confidence_T
3. Test dominance margin exactly at Δ
4. Verify rounding behavior

---

## 6. ARCHITECTURE RECOMMENDATIONS

### **Short-Term** (Next sprint)
1. **Complete MEMORY_MODIFY wiring** (Priority 1)
2. **Add hook handler tests** for all stages
3. **Document override function conventions** - Link each stage to its override function location

### **Medium-Term** (Next quarter)
1. **Add observability** - Log decision outcomes (blocked/proceeded) with stage/reason
2. **Add metrics** - Track confirmation rates, clarification rates by stage
3. **Enhance configuration** - Allow dynamic router URL/timeout changes without restart
4. **Stress testing** - Test with high-volume routing requests, slow router responses

### **Long-Term** (Strategic)
1. **Router SLA tracking** - Monitor router availability and response times
2. **Policy audit logs** - Maintain immutable record of gating decisions for compliance
3. **Capability negotiation** - Dynamic capability setup based on deployment environment
4. **Pack versioning strategy** - Support multi-version packs with gradual rollout

---

## CONCLUSION

ClarityBurst is a **well-architected, comprehensive gating system** with:
- ✓ Solid foundation (stages, packs, router client, override logic)
- ✓ Strong test infrastructure (tripwire pattern, mock consistency)
- ✓ Clear fail-closed vs. fail-open policies
- ✓ Deterministic error handling

**Key Action**: Complete MEMORY_MODIFY integration to close the final fail-open gap and achieve full gating coverage across all 12 stages.

**Next Task Recommendation**: See "Priority 1: Complete MEMORY_MODIFY Integration" above.

