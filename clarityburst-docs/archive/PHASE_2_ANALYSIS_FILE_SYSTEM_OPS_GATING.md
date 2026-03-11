# Phase 2: FILE_SYSTEM_OPS Gating Infrastructure Analysis

**Analysis Date**: 2026-02-15  
**Status**: Complete  
**Scope**: applyFileSystemOverrides() implementation, FILE_SYSTEM_OPS.json pack, integration status, and comparison with existing gating patterns

---

## 2.1 applyFileSystemOverrides() Implementation

**Location**: [`src/clarityburst/decision-override.ts:556-601`](src/clarityburst/decision-override.ts:556)

### Function Signature
```typescript
export async function applyFileSystemOverrides(
  context: FileSystemContext
): Promise<OverrideOutcome>
```

### Input Interface (FileSystemContext)
Defined at [`src/clarityburst/decision-override.ts:387-395`](src/clarityburst/decision-override.ts:387):
- `stageId?: string` – Stage identifier (optional guard); expects `"FILE_SYSTEM_OPS"`
- `userConfirmed?: boolean` – User confirmation flag for operations requiring approval
- `operation?: string` – File operation type (e.g., "read", "write", "delete", "mkdir", "chmod")
- `path?: string` – Target file or directory path
- `[key: string]: unknown` – Extensible for future fields

### Return Type (OverrideOutcome)
Union of three possible outcomes (defined at [`src/clarityburst/decision-override.ts:74`](src/clarityburst/decision-override.ts:74)):

1. **PROCEED** – Operation should proceed without confirmation
   - `{ outcome: "PROCEED", contractId: string | null }`
   
2. **ABSTAIN_CONFIRM** – User confirmation required (HIGH/CRITICAL risk or needs_confirmation flag)
   - `{ outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: string }`
   
3. **ABSTAIN_CLARIFY** – Operation blocked due to uncertainty or missing policy
   - `{ outcome: "ABSTAIN_CLARIFY", reason: string, contractId: string | null }`
   - Possible reasons: "LOW_DOMINANCE_OR_CONFIDENCE" | "PACK_POLICY_INCOMPLETE" | "router_outage"

### How It Works (Flow)

1. **Stage Guard** (line 560): Validates `context.stageId` matches `"FILE_SYSTEM_OPS"` constant; rejects mismatches with ABSTAIN_CLARIFY

2. **Pack Loading** (line 572): Calls `loadPackOrAbstain("FILE_SYSTEM_OPS")` to load the ontology pack

3. **Contract Derivation** (lines 573–575):
   - Creates full runtime capabilities
   - Derives allowed contract IDs based on capabilities
   - Asserts list is non-empty (fails if no contracts allowed)

4. **Router Call** (lines 580–597): Routes through ClarityBurst with:
   - `stageId: "FILE_SYSTEM_OPS"`
   - `packId` and `packVersion` from loaded pack
   - `allowedContractIds` derived above
   - `context`: `{ operation, path }` extracted from input
   - **On router outage**: Returns ABSTAIN_CLARIFY with reason: "router_outage"

5. **Local Override Application** (line 600): Delegates to internal `applyFileSystemOverridesImpl()` which:
   - **Fails open** if router result is not ok (returns PROCEED, contractId: null)
   - **Extracts** top1/top2 contracts and scores from router result
   - **Checks uncertainty thresholds** (min_confidence_T, dominance_margin_Delta) against router scores
   - **Returns ABSTAIN_CLARIFY** if confidence or dominance too low
   - **Looks up contract** in pack.contracts
   - **Returns ABSTAIN_CONFIRM** if contract requires confirmation and `userConfirmed !== true`
   - **Otherwise returns PROCEED** with the contract ID

### Threshold Handling
The implementation strictly enforces pack-driven thresholds:
- `min_confidence_T`: Minimum confidence score for top1 contract
- `dominance_margin_Delta`: Minimum gap between top1 and top2 scores
- **If either is undefined**: Returns ABSTAIN_CLARIFY with reason "PACK_POLICY_INCOMPLETE"
- No hardcoded defaults; pack config is the single source of truth

---

## 2.2 FILE_SYSTEM_OPS.json Pack Review

**Location**: [`ontology-packs/FILE_SYSTEM_OPS.json`](ontology-packs/FILE_SYSTEM_OPS.json)

### Pack Metadata
```json
{
  "pack_id": "openclawd.FILE_SYSTEM_OPS",
  "pack_version": "1.0.0",
  "stage_id": "FILE_SYSTEM_OPS",
  "thresholds": {
    "min_confidence_T": 0,
    "dominance_margin_Delta": 0
  }
}
```

### Risk Classes & Contracts
| Contract ID | Risk Class | needs_confirmation | deny_by_default | Coverage |
|---|---|---|---|---|
| FS_READ_FILE | LOW | false | false | Read-only operations |
| FS_LIST_DIRECTORY | LOW | false | false | Directory listing |
| FS_GET_METADATA | LOW | false | false | File metadata queries |
| FS_WRITE_WORKSPACE | MEDIUM | false | false | Write within workspace scope |
| FS_CREATE_DIRECTORY | MEDIUM | false | false | Directory creation with depth limits |
| FS_COPY_FILE | MEDIUM | false | false | File copying with size limits |
| FS_MOVE_FILE | MEDIUM | false | false | Cross-directory moves (same scope only) |
| FS_DELETE_FILE | HIGH | **true** | false | File deletion (requires confirmation) |
| FS_DELETE_DIRECTORY | HIGH | **true** | false | Directory deletion with recursion |
| FS_WRITE_OUTSIDE_WORKSPACE | HIGH | **true** | false | External path writes (sensitive) |
| FS_MODIFY_PERMISSIONS | CRITICAL | **true** | **true** | Permission changes (deny by default) |
| FS_ACCESS_SYSTEM_FILES | CRITICAL | **true** | **true** | System file access (deny by default) |

### Thresholds
- `min_confidence_T: 0` – No confidence threshold (all scores pass)
- `dominance_margin_Delta: 0` – No dominance margin required (single top1 suffices)
- **Impact**: Gating is driven primarily by contract risk_class and needs_confirmation flags, not router uncertainty

### Field Schema (Comprehensive)
The pack defines a detailed JSON Schema with:
- **Path fields**: `path`, `source_path`, `dest_path` (string)
- **Operation field**: Enum of 11 values: read, write, append, delete, copy, move, mkdir, rmdir, list, stat, chmod
- **Scope field**: Enum of 4 values: workspace, project, user, system
- **Content/encoding**: File write content and encoding support (utf8, binary, base64, hex)
- **Permissions field**: Unix-style mode pattern (e.g., "755")
- **System scope categories**: config, logs, temp, binaries
- **Boolean flags**: recursive, create_parents, overwrite, backup
- **Justification & authorization**: For sensitive operations

### Per-Contract Limits
Each contract has type-specific constraints:
- **FS_WRITE_WORKSPACE**: max_file_size_mb: 10
- **FS_CREATE_DIRECTORY**: max_depth: 10
- **FS_COPY_FILE**: max_file_size_mb: 100
- **FS_MOVE_FILE**: same_scope_only: true
- **FS_DELETE_FILE**: requires_backup: true
- **FS_DELETE_DIRECTORY**: max_items: 1000
- **FS_WRITE_OUTSIDE_WORKSPACE**: allowed_external_paths: [] (empty list = deny by default)
- **FS_MODIFY_PERMISSIONS**: requires_audit: true
- **FS_ACCESS_SYSTEM_FILES**: allowed_system_paths: [] (empty), requires_approval: true

### Assessment: Coverage & Completeness
✅ **Comprehensive**: Covers read, write, delete, mkdir, move, copy, chmod operations (11 distinct contracts)  
✅ **Scope-aware**: Distinguishes between workspace, project, user, and system scopes  
✅ **Risk-stratified**: Low (3 contracts) → Medium (4 contracts) → High (3 contracts) → Critical (2 contracts)  
✅ **Limits-enforced**: Per-contract size, depth, and item limits  
✅ **Schema-defined**: Detailed JSON Schema for field validation  
⚠️ **Thresholds minimal**: Zero thresholds mean pack is not gating on router confidence; relying on contract attributes

---

## 2.3 Current Integration Status

### Where applyFileSystemOverrides() IS Used

**Primary Call Site**: [`src/agents/pi-tools.read.ts:268-290`](src/agents/pi-tools.read.ts:268)

Context: File system operation wrapper for Pi agent tools. Flow:
1. Builds `FileSystemContext` with operation, path, and userConfirmed flag
2. Calls `await applyFileSystemOverrides(fileSystemContext)` (async entrypoint)
3. **On ABSTAIN_CONFIRM**: Throws `ClarityBurstAbstainError` with outcome and contract ID; triggers user confirmation workflow
4. **On ABSTAIN_CLARIFY**: Throws `ClarityBurstAbstainError` with instructions; blocks operation
5. **On PROCEED**: Executes the actual file system operation via `tool.execute()`

### Where It's NOT Yet Used

**Three Primary Wrappers Found** (Phase 1 discovery):
- [`src/utils.ts:7`](src/utils.ts:7) – `ensureDir(dir)` – Creates directories recursively; **NO gating**
- [`src/config/config.ts`](src/config/config.ts) – `writeConfigFile()` – Writes config YAML; **NO gating**
- [`src/config/sessions/store.ts:347`](src/config/sessions/store.ts:347) – `saveSessionStore()` – Persists session JSON; **NO gating** (but has tripwire test pattern)

**Impact**: Core file operations in config persistence and session management bypass gating. Gating is only active in Pi agent tools layer.

### Test Pattern Established

**Test File**: [`src/clarityburst/__tests__/file_system_ops.router_outage.fail_closed.tripwire.test.ts`](src/clarityburst/__tests__/file_system_ops.router_outage.fail_closed.tripwire.test.ts)

Verifies:
- Router outage blocks operations (fail-closed mechanism)
- ABSTAIN_CLARIFY outcome with reason: "router_outage"
- Conversion to blocked response payload
- Follows same fail-closed pattern as NETWORK_IO and MEMORY_MODIFY stages

---

## 2.4 Comparison with Existing Patterns

### Pattern Analysis Across All Stages

| Stage | Function | Export | Context Type | Outcomes | Pack | Router Call | Tests |
|---|---|---|---|---|---|---|---|
| **TOOL_DISPATCH_GATE** | `applyToolDispatchOverrides()` | sync (impl only) | `DispatchContext` | PROCEED/ABSTAIN_CONFIRM | TOOL_DISPATCH_GATE.json | Yes | Yes (router_outage) |
| **SHELL_EXEC** | `applyShellOverrides()` | async (exported) | `ShellContext` | PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY | SHELL_EXEC.json | Yes | Yes (confirmation token) |
| **MEMORY_MODIFY** | `applyMemoryModifyOverrides()` | async (exported) | `MemoryModifyContext` | PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY | MEMORY_MODIFY.json | Yes | Yes (router_outage, pack_incomplete) |
| **NETWORK_IO** | `applyNetworkOverrides()` | async (exported) | `NetworkIOContext` | PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY | NETWORK_IO.json | Yes | Yes (router_outage) |
| **FILE_SYSTEM_OPS** | `applyFileSystemOverrides()` | async (exported) | `FileSystemContext` | PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY | FILE_SYSTEM_OPS.json | Yes | Yes (router_outage) |

### Integration Pattern for FILE_SYSTEM_OPS

**Pattern used in MEMORY_MODIFY** (at [`src/config/sessions/store.ts`](src/config/sessions/store.ts)):
- Commit point hook: Before `JSON.stringify()` and file write
- Calls `applyMemoryModifyOverrides()` with session context
- **On ABSTAIN_***: Throws error; session store mutation blocked
- **On PROCEED**: Proceeds with write

**Pattern used in SHELL_EXEC** (in shell invocation):
- Call point: Before spawning subprocess
- Calls `applyShellOverrides()` with command context
- **On ABSTAIN_***: Throws error; command not executed
- **On PROCEED**: Spawns process

**Pattern used in FILE_SYSTEM_OPS** (in Pi tools):
- Call point: Before tool execution
- Calls `applyFileSystemOverrides()` with operation context
- **On ABSTAIN_***: Throws error; operation not executed
- **On PROCEED**: Executes tool

### Key Architectural Insights

1. **Gating is committed per-stage**: Each stage has its own override function, pack, and thresholds.

2. **Failure modes are consistent**:
   - Router outage → ABSTAIN_CLARIFY (fail-closed)
   - Pack incomplete → ABSTAIN_CLARIFY (fail-closed)
   - Low confidence/dominance → ABSTAIN_CLARIFY (router uncertainty)
   - Confirmation missing → ABSTAIN_CONFIRM (requires user confirmation)

3. **Pack thresholds are pack-driven**: No hardcoded defaults in code; all values must come from pack config or function returns ABSTAIN_CLARIFY.

4. **Async entrypoint pattern**:
   ```typescript
   export async function applyFileSystemOverrides(context: FileSystemContext): Promise<OverrideOutcome>
   ```
   - Loads pack internally
   - Routes to ClarityBurst
   - Applies local overrides
   - Single "commit point" entry

5. **Context extensibility**: All context types use `[key: string]: unknown` to allow future fields without breaking changes.

---

## Summary: Gaps & Phase 3 Integration Work

### Current Gaps

| Gap | Severity | Location | Impact |
|---|---|---|---|
| **ensureDir() ungatted** | MEDIUM | `src/utils.ts:7` | Directory creation bypasses all checks |
| **writeConfigFile() ungatted** | MEDIUM | `src/config/config.ts` | Config persistence has no gating |
| **saveSessionStore() ungatted** | HIGH | `src/config/sessions/store.ts:347` | Session persistence (commit point) not gated |
| **Zero thresholds** | LOW | `ontology-packs/FILE_SYSTEM_OPS.json` | Router confidence not influencing decisions (contract-driven only) |
| **No per-caller mapping** | LOW | `src/agents/pi-tools.read.ts` | Only Pi tools layer gates; gateway operations bypass |

### Phase 3 Integration Tasks

**Task 1: Wrap saveSessionStore()**
- Add call to `applyFileSystemOverrides()` before `JSON.stringify()`
- Context: `{ operation: "write", path: storePath, scope: "session" }`
- On ABSTAIN_*: Throw error; session not persisted (fail-closed)
- Test: Use pattern from `memory_modify.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts`

**Task 2: Wrap writeConfigFile()**
- Add call before file write in `src/config/io.ts:490`
- Context: `{ operation: "write", path: configPath, scope: "config" }`
- On ABSTAIN_*: Throw error; config not written (fail-closed)
- Test: Similar fail-closed pattern

**Task 3: Wrap ensureDir()**
- Add call before `fs.promises.mkdir()` in `src/utils.ts:8`
- Context: `{ operation: "mkdir", path: dir, scope: "project" }`
- On ABSTAIN_*: Throw error; directory not created (fail-closed)
- Test: Verify tripwire behavior for directory creation

**Task 4: Increase Router Confidence Thresholds** (optional)
- Update `ontology-packs/FILE_SYSTEM_OPS.json` thresholds if router becomes primary gating mechanism
- Current: `min_confidence_T: 0, dominance_margin_Delta: 0` (contract-driven)
- Recommended for Phase 4+: `min_confidence_T: 0.55, dominance_margin_Delta: 0.10`

**Task 5: Add Integration Tests**
- Router outage fail-closed (already exists)
- Pack incomplete fail-closed (new for ensureDir, writeConfigFile, saveSessionStore)
- Confirmation required for DELETE/MODIFY contracts (new)
- Scope boundary enforcement (new)

---

## Conclusion

**applyFileSystemOverrides()** is a fully-implemented, async-exported gating function that:
- Routes through ClarityBurst to classify file operations
- Applies per-contract risk-based confirmation requirements
- Enforces pack-driven uncertainty thresholds (currently set to 0)
- Returns structured outcomes (PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY)

**FILE_SYSTEM_OPS.json** is comprehensive with 11 contracts covering all discovered operation types, risk-stratified from LOW to CRITICAL, with per-contract limits.

**Current integration** is partial: only Pi agent tools use the gating function. Core file operations (config write, session persist, directory creation) bypass gating. Phase 3 should wire these three wrappers into the gating system following the established fail-closed commit-point pattern.
