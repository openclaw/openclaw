# CronPreflightGate Architecture Design

## 1. Executive Summary

The **CronPreflightGate** is a new ClarityBurst contract point that runs at the earliest possible moment in the tool dispatch pipeline—**before any tool execution or even TOOL_DISPATCH_GATE routing**. Its dual responsibility is to:

1. **Validate system ledger health** through programmatic invariant checking
2. **Commit to a specific cron task** from a closed enum before proceeding with execution

This design ensures that every cron-driven execution:
- Operates on a verified, consistent ledger state
- Has an immutable, pre-determined task identity attached to its run
- Cannot proceed if either validation fails or task selection is ambiguous

---

## 2. Core Design Principles

### 2.1 Closure Over Ambiguity
- **Closed enum** of allowed cron tasks prevents dynamic, runtime task creation
- Tasks are declared upfront; no guessing or late-binding allowed
- Failure mode: missing task → ESCALATE_CRON_STATE_INVALID (operator intervention)

### 2.2 Fail-Closed Ledger Semantics
- Invalid ledger state → immediate ESCALATE, no retry
- Read-only verification (no mutations during validation)
- Invariants checked are non-negotiable; no fallback logic

### 2.3 Mandatory Decision Record Attachment
- Every cron run must have an immutable `nextCronTask` field in its decision record
- No run proceeds without this field being set
- Once set, immutable for the lifetime of the run

### 2.4 Separation of Concerns
- **Gate responsibility**: Validation + task selection
- **Tool dispatch**: Uses the pre-selected task as context
- **Downstream logic**: Reads task from decision record; cannot override

---

## 3. System Position in Tool Dispatch Pipeline

### 3.1 Execution Order

```
Request → CronPreflightGate (EARLIEST)
         ↓
         [Validate ledger invariants]
         ↓
         [Select nextCronTask from enum]
         ↓
         [Attach to decision record]
         ↓
         [PASS]
         ↓
TOOL_DISPATCH_GATE (routes tool selection)
         ↓
SHELL_EXEC / FILE_SYSTEM_OPS / ... (stage-specific gating)
         ↓
Tool Execution
         ↓
Outcome recorded in ledger
```

### 3.2 Key Insight: Preflight Positioning
- Runs **before** any router invocation
- Runs **before** any tool dispatch decision
- Establishes system preconditions (ledger valid + task committed)
- Subsequent stages can assume valid preconditions

### 3.3 Integration with Existing Stages
- Does NOT replace TOOL_DISPATCH_GATE or other stages
- Complements them by ensuring preconditions
- Downstream stages query `decision_record.nextCronTask` if needed
- Can gate tools based on declared task capabilities

---

## 4. CronTask Closed Enum

### 4.1 Enum Definition Structure

```typescript
/**
 * Closed universe of allowed cron task types.
 * Must be declared upfront; no runtime additions.
 */
export type CronTaskId =
  | "HEARTBEAT_CHECK"       // System health monitoring
  | "MEMORY_MAINTENANCE"    // Garbage collection, cache cleanup
  | "CACHE_REFRESH"         // Update cached data from sources
  | "LOG_ROTATION"          // Archive and compress old logs
  | "BACKUP_EXECUTION"      // Incremental backup operations
  | "SCHEDULED_REPORT"      // Generate and deliver reports
  | "CREDENTIAL_ROTATION"   // Refresh auth tokens, keys
  | "HEALTH_PROBE"          // External service availability checks
  | "INDEX_REBUILD"         // Database/search index maintenance
  | "STATE_SYNC"            // Synchronize distributed state
  | "METRICS_AGGREGATION"   // Collect and summarize metrics
  | "CLEANUP_TEMP_DATA"     // Remove temporary files/records
  | "UPDATE_CONFIG_CACHE"   // Refresh cached configuration;

export const CRON_TASK_IDS = [
  "HEARTBEAT_CHECK",
  "MEMORY_MAINTENANCE",
  "CACHE_REFRESH",
  "LOG_ROTATION",
  "BACKUP_EXECUTION",
  "SCHEDULED_REPORT",
  "CREDENTIAL_ROTATION",
  "HEALTH_PROBE",
  "INDEX_REBUILD",
  "STATE_SYNC",
  "METRICS_AGGREGATION",
  "CLEANUP_TEMP_DATA",
  "UPDATE_CONFIG_CACHE",
] as const;

/**
 * Type guard to validate task IDs at runtime.
 */
export function isValidCronTaskId(value: string): value is CronTaskId {
  return CRON_TASK_IDS.includes(value as CronTaskId);
}
```

### 4.2 Capability Declaration Per Task

Each task declares required capabilities so downstream stages can enforce them:

```typescript
export interface CronTaskDeclaration {
  taskId: CronTaskId;
  description: string;
  /** Capabilities required to execute this task */
  required_capabilities: string[];
  /** Risk class for this task (LOW, MEDIUM, HIGH, CRITICAL) */
  risk_class: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Whether manual confirmation is needed */
  needs_confirmation: boolean;
  /** Max concurrent instances of this task */
  max_concurrency: number;
  /** Timeout in milliseconds */
  timeout_ms: number;
  /** Allowed frequency constraints (e.g., "at_most_hourly") */
  frequency_constraint?: string;
}

export const CRON_TASK_DECLARATIONS: Record<CronTaskId, CronTaskDeclaration> = {
  HEARTBEAT_CHECK: {
    taskId: "HEARTBEAT_CHECK",
    description: "Periodic system health monitoring",
    required_capabilities: ["network"],
    risk_class: "LOW",
    needs_confirmation: false,
    max_concurrency: 1,
    timeout_ms: 30000,
    frequency_constraint: "at_most_hourly",
  },
  MEMORY_MAINTENANCE: {
    taskId: "MEMORY_MAINTENANCE",
    description: "Garbage collection and cache cleanup",
    required_capabilities: ["sensitive_access"],
    risk_class: "MEDIUM",
    needs_confirmation: false,
    max_concurrency: 1,
    timeout_ms: 60000,
  },
  CREDENTIAL_ROTATION: {
    taskId: "CREDENTIAL_ROTATION",
    description: "Refresh authentication tokens and credentials",
    required_capabilities: ["sensitive_access", "critical_opt_in"],
    risk_class: "CRITICAL",
    needs_confirmation: true,
    max_concurrency: 1,
    timeout_ms: 120000,
  },
  // ... rest of tasks
};
```

---

## 5. Programmatic Ledger Verification API

### 5.1 Refactored from CLI Subprocess

**Current state** (in `scripts/verify-usage-ledger-invariants.ts`):
- CLI-only tool
- Returns exit code
- No programmatic API

**New state** (in `src/clarityburst/ledger-verification.ts`):
- Programmatic function-based API
- Returns structured `LedgerVerificationResult`
- Can be called from gating logic, not just CLI

### 5.2 Verification API Structure

```typescript
/**
 * Result of ledger verification with detailed error information.
 */
export interface LedgerVerificationResult {
  /** true if all invariants hold, false if any failed */
  valid: boolean;
  /** Number of entries checked in the verification window */
  entries_checked: number;
  /** Window size (typically 50 entries) */
  window_size: number;
  /** Specific failure reason if valid === false */
  failure_reason?: string;
  /** Detailed error message for operator debugging */
  error_message?: string;
  /** Timestamp of verification */
  verified_at: string;
}

/**
 * Load and verify the clarityburst usage ledger.
 * 
 * Checks:
 * 1. File exists and is readable
 * 2. All entries are valid JSONL
 * 3. Last N entries (window) are checked for invariants:
 *    - Each entry has a non-empty runId
 *    - No duplicate runIds in the window
 *    - If a workloadId appears in both "baseline" and "gated" modes,
 *      they must have different runIds (not the same run)
 * 
 * @param ledgerPath Path to the ledger file (defaults to docs/internal/clarityburst-usage-ledger.jsonl)
 * @param windowSize Number of recent entries to check (defaults to 50)
 * @returns LedgerVerificationResult with detailed status
 */
export async function verifyLedgerInvariants(
  ledgerPath?: string,
  windowSize?: number
): Promise<LedgerVerificationResult>
```

### 5.3 Verification Invariants

1. **Non-empty ledger**: At least one entry must exist in the file
2. **Valid JSONL format**: Every line is valid JSON
3. **Unique runIds**: No duplicate runIds within the window
4. **Baseline/gated coherence**: For any workloadId with both "baseline" and "gated" modes, the runIds must differ
5. **Required fields**: Every entry has `runId`, `workloadId`, `mode` fields (non-empty)

### 5.4 Failure Reasons (Enum)

```typescript
export type LedgerVerificationFailureReason =
  | "FILE_NOT_FOUND"
  | "FILE_READ_ERROR"
  | "INVALID_JSONL_FORMAT"
  | "EMPTY_LEDGER"
  | "DUPLICATE_RUN_IDS"
  | "BASELINE_GATED_MISMATCH"  // Same runId in both baseline and gated for same workloadId
  | "MISSING_REQUIRED_FIELD"
  | "UNKNOWN_ERROR";
```

---

## 6. Decision Record Integration

### 6.1 Decision Record Structure Enhancement

Current `OverrideOutcome` (from `decision-override.ts`):
```typescript
export type OverrideOutcome = 
  | AbstainConfirmOutcome 
  | AbstainClarifyOutcome 
  | ProceedOutcome;
```

**Proposed enhancement** for cron-specific tracking:

```typescript
/**
 * Extended decision record with cron task commitment.
 * Immutable once set; cannot be changed during run lifetime.
 */
export interface CronDecisionRecord {
  /** Unique run identifier */
  runId: string;
  
  /** Cron task selected during preflight gate (MANDATORY) */
  nextCronTask: CronTaskId;
  
  /** When the task was committed */
  task_committed_at: string;
  
  /** Ledger verification result */
  ledger_verification: {
    valid: boolean;
    entries_checked: number;
    verified_at: string;
  };
  
  /** Override outcomes for each stage (populated downstream) */
  stage_outcomes: Record<string, OverrideOutcome>;
  
  /** Final execution outcome */
  execution_outcome?: {
    success: boolean;
    error?: string;
  };
}
```

### 6.2 Mandatory Field Semantics

- **nextCronTask** must be set before TOOL_DISPATCH_GATE runs
- If missing, any downstream stage should detect and ESCALATE
- Once set, cannot be modified (immutable contract)
- Recorded in execution log for audit trail

### 6.3 Immutability Enforcement

```typescript
/**
 * Lock the cron task selection for this run.
 * Once locked, cannot be changed.
 */
export function lockCronTask(
  decisionRecord: CronDecisionRecord,
  taskId: CronTaskId
): void {
  if (decisionRecord.nextCronTask !== undefined) {
    throw new Error(
      `CronTask already locked to ${decisionRecord.nextCronTask}; cannot change to ${taskId}`
    );
  }
  decisionRecord.nextCronTask = taskId;
  decisionRecord.task_committed_at = new Date().toISOString();
}

/**
 * Assert that a cron task has been selected and locked.
 */
export function assertCronTaskLocked(decisionRecord: CronDecisionRecord): CronTaskId {
  if (!decisionRecord.nextCronTask) {
    throw new Error(
      "CronTask not selected; preflight gate must run before tool dispatch"
    );
  }
  return decisionRecord.nextCronTask;
}
```

---

## 7. Failure Paths and Escalation Semantics

### 7.1 Escalation Decision Type

```typescript
/**
 * Escalation outcome: operator intervention required.
 */
export interface EscalateOutcome {
  outcome: "ESCALATE_CRON_STATE_INVALID";
  reason: 
    | "LEDGER_VERIFICATION_FAILED"
    | "LEDGER_FILE_NOT_FOUND"
    | "LEDGER_READ_ERROR"
    | "INVALID_JSONL_FORMAT"
    | "EMPTY_LEDGER"
    | "DUPLICATE_RUN_IDS"
    | "BASELINE_GATED_MISMATCH"
    | "MISSING_REQUIRED_FIELD"
    | "TASK_SELECTION_AMBIGUOUS"
    | "TASK_ENUM_MISMATCH"
    | "UNKNOWN_LEDGER_ERROR";
  
  /** Detailed error message for operator */
  details: string;
  
  /** Suggested remediation */
  remediation: string;
  
  /** Timestamp of escalation */
  escalated_at: string;
}
```

### 7.2 Failure Semantics Decision Tree

```
CronPreflightGate execution:

1. Can ledger file be read?
   NO  → ESCALATE (LEDGER_FILE_NOT_FOUND | LEDGER_READ_ERROR)
   YES → proceed to 2

2. Are all lines valid JSONL?
   NO  → ESCALATE (INVALID_JSONL_FORMAT)
   YES → proceed to 3

3. Are required fields present in all entries?
   NO  → ESCALATE (MISSING_REQUIRED_FIELD)
   YES → proceed to 4

4. Do invariants hold on the verification window?
   NO  → ESCALATE (DUPLICATE_RUN_IDS | BASELINE_GATED_MISMATCH)
   YES → proceed to 5

5. Can task be unambiguously selected?
   - If only one valid task in enum: SELECT it
   - If multiple valid tasks AND runtime context is ambiguous: ESCALATE (TASK_SELECTION_AMBIGUOUS)
   - If selected task not in enum: ESCALATE (TASK_ENUM_MISMATCH)
   YES → proceed to 6

6. Lock task to decision record
   → RETURN {outcome: "PROCEED", nextCronTask}

On any ESCALATE:
   - Operator receives detailed error + remediation
   - No tool dispatch occurs
   - Run is recorded as failed in ledger
   - System waits for manual intervention
```

### 7.3 No Retry Logic

- **Ledger failures are permanent** until operator fixes root cause
- Invalid ledger state cannot be "retried away"
- Ambiguous task selection cannot be resolved by retry
- Escalation is the only response path

### 7.4 Error Messages with Remediation

```typescript
// Example: Duplicate runId
{
  outcome: "ESCALATE_CRON_STATE_INVALID",
  reason: "DUPLICATE_RUN_IDS",
  details: "Duplicate runId found in ledger window: 7c22218b-4982-406c-9193-74308928c6a2 appears 2 times",
  remediation: "Inspect docs/internal/clarityburst-usage-ledger.jsonl for duplicate entries. Remove or rename duplicates, then retry.",
  escalated_at: "2026-02-28T03:45:00Z"
}

// Example: Ambiguous task
{
  outcome: "ESCALATE_CRON_STATE_INVALID",
  reason: "TASK_SELECTION_AMBIGUOUS",
  details: "Runtime context does not map to a unique task. Multiple candidates: HEARTBEAT_CHECK, HEALTH_PROBE. Need explicit operator decision.",
  remediation: "Provide explicit task selection via config or context. Do not allow implicit task selection.",
  escalated_at: "2026-02-28T03:45:30Z"
}
```

---

## 8. Ontology Pack Entry Structure

### 8.1 CRON_PREFLIGHT_GATE.json

```json
{
  "pack_id": "openclawd.CRON_PREFLIGHT_GATE",
  "pack_version": "1.0.0",
  "stage_id": "CRON_PREFLIGHT_GATE",
  "description": "Pre-flight validation gate that runs before any tool dispatch. Verifies ledger health and commits to a specific cron task.",
  "execution_order": "FIRST",
  "precondition_stages": [],
  "blocks_on_failure": ["TOOL_DISPATCH_GATE", "SHELL_EXEC", "FILE_SYSTEM_OPS", "NETWORK_IO", "BROWSER_AUTOMATE", "MEMORY_MODIFY", "CRON_SCHEDULE", "MESSAGE_EMIT", "MEDIA_GENERATE", "NODE_INVOKE", "CANVAS_UI", "SUBAGENT_SPAWN"],
  "ledger_verification_config": {
    "ledger_path": "docs/internal/clarityburst-usage-ledger.jsonl",
    "window_size": 50,
    "required_invariants": [
      "file_exists",
      "valid_jsonl",
      "required_fields_present",
      "unique_run_ids",
      "baseline_gated_coherence"
    ]
  },
  "cron_task_config": {
    "task_enum_location": "src/clarityburst/cron-tasks.ts",
    "allow_dynamic_tasks": false,
    "require_capability_declaration": true
  },
  "decision_record_requirements": {
    "mandatory_fields": ["nextCronTask", "ledger_verification", "task_committed_at"],
    "immutable_fields": ["nextCronTask"],
    "persistence": "permanent"
  },
  "failure_mode": "escalate_on_validation_failure",
  "contracts": [
    {
      "contract_id": "CRON_PREFLIGHT_VALIDATE",
      "risk_class": "CRITICAL",
      "description": "Validate ledger state and select cron task",
      "required_fields": ["ledger_path", "cron_task_id"],
      "limits": {
        "maxRetries": 0,
        "timeoutMs": 10000,
        "maxBatchSize": 1,
        "maxChainDepth": 1
      },
      "needs_confirmation": false,
      "deny_by_default": false,
      "capability_requirements": ["critical_opt_in"],
      "escalation_conditions": [
        "ledger_verification_failed",
        "task_selection_ambiguous",
        "task_not_in_enum"
      ]
    }
  ],
  "field_schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "ledger_path": {
        "type": "string",
        "description": "Path to usage ledger file"
      },
      "cron_task_id": {
        "type": "string",
        "enum": [
          "HEARTBEAT_CHECK",
          "MEMORY_MAINTENANCE",
          "CACHE_REFRESH",
          "LOG_ROTATION",
          "BACKUP_EXECUTION",
          "SCHEDULED_REPORT",
          "CREDENTIAL_ROTATION",
          "HEALTH_PROBE",
          "INDEX_REBUILD",
          "STATE_SYNC",
          "METRICS_AGGREGATION",
          "CLEANUP_TEMP_DATA",
          "UPDATE_CONFIG_CACHE"
        ],
        "description": "Selected cron task from closed enum"
      }
    },
    "required": ["ledger_path", "cron_task_id"]
  }
}
```

### 8.2 Stage Registration

Update [`src/clarityburst/stages.ts`](src/clarityburst/stages.ts):

```typescript
export type ClarityBurstStageId =
  | "CRON_PREFLIGHT_GATE"  // NEW: runs first
  | "BROWSER_AUTOMATE"
  | "CANVAS_UI"
  | "CRON_SCHEDULE"
  | "FILE_SYSTEM_OPS"
  | "MEDIA_GENERATE"
  | "MEMORY_MODIFY"
  | "MESSAGE_EMIT"
  | "NETWORK_IO"
  | "NODE_INVOKE"
  | "SHELL_EXEC"
  | "SUBAGENT_SPAWN"
  | "TOOL_DISPATCH_GATE";

export const ALL_STAGE_IDS: readonly ClarityBurstStageId[] = [
  "CRON_PREFLIGHT_GATE",  // NEW
  "BROWSER_AUTOMATE",
  // ... rest
] as const;
```

---

## 9. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Incoming Cron Request                                           │
│ (from scheduler, system timer, or manual trigger)               │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
      ┌───────────────────────────────────┐
      │ CronPreflightGate (CRON_PREFLIGHT │
      │ _GATE stage)                      │
      │                                   │
      │  1. Load ledger file              │
      │  2. Parse JSONL entries           │
      │  3. Run verification invariants   │
      └───────────────────────────────────┘
              │           │
         ┌────┘           └──────┐
         │ PASS                  │ FAIL
         │                       │
         ▼                       ▼
    ┌─────────────┐      ┌──────────────────────┐
    │ Verification│      │ ESCALATE_CRON_STATE_ │
    │ Success     │      │ INVALID              │
    └─────────────┘      │                      │
         │               │ [Operator Intervention]
         │               │ STOP EXECUTION       │
         │               └──────────────────────┘
         │
         ▼
    ┌──────────────────────┐
    │ Select nextCronTask  │
    │ from closed enum     │
    │                      │
    │ • Deterministic      │
    │ • No ambiguity       │
    └──────────────────────┘
         │       │
         │   ┌───┴───────────────┐
         │   │ Ambiguous task    │
         │   │ selection?        │
         │   │ YES → ESCALATE    │
         │   └───────────────────┘
         │
         ▼
    ┌──────────────────────────┐
    │ Lock task to             │
    │ CronDecisionRecord       │
    │ (immutable)              │
    │                          │
    │ nextCronTask = selected  │
    │ task_committed_at = now  │
    └──────────────────────────┘
         │
         ▼
    ┌──────────────────────┐
    │ PROCEED outcome      │
    │                      │
    │ Pass decision record │
    │ to downstream stages │
    └──────────────────────┘
         │
         ▼
    ┌──────────────────────┐
    │ TOOL_DISPATCH_GATE   │
    │ (next in pipeline)   │
    │                      │
    │ Reads nextCronTask   │
    │ from decision record │
    │ Uses for context     │
    └──────────────────────┘
         │
         ▼
    [Other stages, tool execution, etc.]
```

---

## 10. Integration Points

### 10.1 Integration with TOOL_DISPATCH_GATE

**Before**: TOOL_DISPATCH_GATE is the first gate.

**After**: CRON_PREFLIGHT_GATE runs before TOOL_DISPATCH_GATE.

- TOOL_DISPATCH_GATE **reads** `nextCronTask` from decision record
- Can use it to filter allowed contracts (e.g., only dispatch tools allowed for this task)
- Cannot modify or override the task

### 10.2 Integration with Other Stages

All downstream stages can:
- **Query** the task from decision record
- **Use** it for context-aware routing
- **Enforce** task-specific capability requirements
- **NOT** modify or override it

### 10.3 Ledger Recording

After execution:
1. Create entry in ledger with runId, workloadId, mode, metrics
2. Ledger entry includes reference to nextCronTask
3. Next preflight run will verify this entry as part of invariant check

---

## 11. Closure Properties: Why Closed Enum Prevents Ambiguity

### 11.1 Closed Universe Benefit

**Problem (dynamic tasks)**: 
- At runtime, new task types can be created
- Router or late-binding logic picks one
- No way to know if "right" task was picked
- Escalation path unclear

**Solution (closed enum)**:
- All tasks declared upfront in code
- Type-safe; cannot add at runtime
- Every valid task is known and declared
- Ambiguous state = explicitly escalate

### 11.2 Type Safety

```typescript
// This is impossible (compile-time error):
const task: CronTaskId = "UNKNOWN_TASK";  // ❌ Type error

// This is guaranteed valid:
const task: CronTaskId = "HEARTBEAT_CHECK";  // ✓ Type-safe

// No way to create invalid task at runtime:
const dynamicTask = userInput as CronTaskId;  // ⚠️ Type-safe but runtime risk → catch and escalate
```

### 11.3 Decision Record Immutability

Once `nextCronTask` is set:
- Cannot be changed (enforced by lock)
- Cannot be null/undefined (enforced by assertion)
- Provides single source of truth for task identity
- Prevents mid-execution task reassignment

---

## 12. Success Criteria

The design is successful when:

✅ Ledger verification runs **programmatically**, not as subprocess
✅ Invalid ledger state triggers **immediate ESCALATE**, no retry
✅ Task selection is **deterministic and unambiguous**
✅ `nextCronTask` is **mandatory and immutable** in decision record
✅ CRON_PREFLIGHT_GATE runs **before all other stages**
✅ Downstream stages **cannot override** task selection
✅ Failure paths are **explicit and operator-facing**
✅ Closed enum prevents **dynamic task creation at runtime**

---

## 13. Future Enhancements (Out of Scope)

- Task scheduling hints (e.g., "run this task at this frequency")
- Distributed coordination (prevent multiple agents running same task)
- Task dependency graphs
- Dynamic task whitelist management via secure config
