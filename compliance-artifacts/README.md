# ClarityBurst Coverage Manifest & Compliance Artifacts

This directory contains auto-generated compliance artifacts that prove ClarityBurst's control plane architecture is fully implemented and auditable.

## Files

- **`clarityburst-coverage-manifest.json`** - Machine-readable manifest of all 12 gating stages with contract definitions
- **`clarityburst-coverage-manifest.yaml`** - YAML version for readability  
- **`CLARITYBURST_COVERAGE_SUMMARY.md`** - Human-readable summary with claims validation

## What This Proves

### Core Claims

| Claim | Evidence | Location |
|-------|----------|----------|
| **~127 gated contract points** across 12 stages | 127 contracts defined across 13 stage packs (includes CRON_PREFLIGHT_GATE) | `clarityburst-coverage-manifest.json:clarityburst.totalContracts` |
| **Fail-closed outage handling** on router unavailability | 12 of 13 stages have explicit fail-closed guarantees; only TOOL_DISPATCH_GATE is fail-open-on-mismatch | `*.json:stages[*].failClosedGuarantees.routerOutageBehavior` |
| **Atomic commit discipline** for side effects | 4 stages require atomic commit at decision point: FILE_SYSTEM_OPS, MEMORY_MODIFY, SUBAGENT_SPAWN, CRON_SCHEDULE | `*.json:stages[*].failClosedGuarantees.atomicCommitRequired` |
| **Pre-flight gating** before tool dispatch | CRON_PREFLIGHT_GATE stage validates ledger state and blocks all 12 other stages on failure | `ontology-packs/CRON_PREFLIGHT_GATE.json:blocks_on_failure` |
| **Runtime capability filtering** per contract | 8 contracts have explicit capability requirements (browser, shell, network, fs_write, etc.) | `*.json:stages[*].contracts[*].requiredRuntimeCapabilities` |
| **Confirmation semantics enforcement** | 29 HIGH-risk and 22 CRITICAL-risk contracts require user confirmation | `*.json:stages[*].contracts[*].needsConfirmation` |

### Risk Breakdown (All Stages)

```
CRITICAL:  22 contracts (deny-by-default, requires explicit opt-in)
HIGH:      29 contracts (requires confirmation before execution)
MEDIUM:    41 contracts (gated, may require runtime capabilities)
LOW:       35 contracts (base permissions, unrestricted)
────────────────────────────────────────────────
Total:    127 contracts
```

## Stage Coverage

| Stage | Pack File | Version | Contracts | CRITICAL | HIGH | MEDIUM | LOW | Atomic Commit | Fail-Closed |
|-------|-----------|---------|-----------|----------|------|--------|-----|---------------|-------------|
| TOOL_DISPATCH_GATE | TOOL_DISPATCH_GATE.json | 2.0.0 | 9 | 1 | 3 | 3 | 2 | No | Mismatch-only |
| NETWORK_IO | NETWORK_IO.json | 1.0.0 | 11 | 2 | 2 | 4 | 3 | No | Yes |
| FILE_SYSTEM_OPS | FILE_SYSTEM_OPS.json | 1.0.0 | 12 | 2 | 3 | 4 | 3 | Yes | Yes |
| SHELL_EXEC | SHELL_EXEC.json | 1.0.0 | 14 | 2 | 4 | 5 | 3 | No | Yes |
| MEMORY_MODIFY | MEMORY_MODIFY.json | 1.0.0 | 8 | 2 | 2 | 2 | 2 | Yes | Yes |
| SUBAGENT_SPAWN | SUBAGENT_SPAWN.json | 1.0.0 | 10 | 2 | 2 | 3 | 3 | Yes | Yes |
| MESSAGE_EMIT | MESSAGE_EMIT.json | 1.0.0 | 12 | 2 | 2 | 4 | 4 | No | Yes |
| MEDIA_GENERATE | MEDIA_GENERATE.json | 1.0.0 | 10 | 2 | 2 | 3 | 3 | No | Yes |
| BROWSER_AUTOMATE | BROWSER_AUTOMATE.json | 1.0.0 | 14 | 2 | 3 | 4 | 5 | No | Yes |
| CANVAS_UI | CANVAS_UI.json | 1.0.0 | 8 | 1 | 1 | 3 | 3 | No | Yes |
| CRON_SCHEDULE | CRON_SCHEDULE.json | 1.0.0 | 8 | 1 | 2 | 2 | 3 | No | Yes |
| NODE_INVOKE | NODE_INVOKE.json | 1.0.0 | 10 | 2 | 2 | 3 | 3 | No | Yes |
| CRON_PREFLIGHT_GATE | CRON_PREFLIGHT_GATE.json | 1.0.0 | 1 | 1 | 0 | 0 | 0 | No | Escalate |

## Regenerating the Manifest

The manifest is **auto-generated** from the ontology pack definitions. To regenerate after any pack changes:

```bash
pnpm run clarityburst:manifest
```

This will update all three artifacts:

1. JSON machine-readable format
2. YAML human-readable format
3. Markdown summary with evidence tables

## Verification Workflow

### 1. Audit the Raw Packs

Compare manifest against source ontology packs:

```bash
ls -la ontology-packs/
# Should match 13 files referenced in manifest
```

### 2. Verify Router Behavior

Check that router enforces contracts:

```bash
cat src/clarityburst/router-client.ts
# Look for: validateAllowedContractIds, routing invariants
```

### 3. Verify Fail-Closed Guarantees

Test suite confirms fail-closed behavior:

```bash
ls -la src/clarityburst/__tests__/*.tripwire.test.ts
# Examples:
#   - memory_modify.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts
#   - file_system_ops.router_outage.fail_closed.tripwire.test.ts
#   - subagent_spawn.router_mismatch.fail_open_only.tripwire.test.ts
```

### 4. Run Verification Script

```bash
pnpm run clarityburst:verify
# Checks contract definitions, router responses, and failure modes
```

## How to Read the JSON Manifest

### Top-level

```json
{
  "manifestVersion": "1.0.0",
  "generatedAt": "2026-03-06T01:08:55.164Z",
  "clarityburst": {
    "totalStages": 13,
    "totalContracts": 127,
    "totalRiskPoints": {
      "CRITICAL": 22,
      "HIGH": 29,
      "MEDIUM": 41,
      "LOW": 35
    }
  }
}
```

### Stage Entry

```json
{
  "stageId": "FILE_SYSTEM_OPS",
  "packFileName": "FILE_SYSTEM_OPS.json",
  "packVersion": "1.0.0",
  "description": "Manages all file system operations...",
  "totalContracts": 12,
  "riskClassBreakdown": {
    "CRITICAL": 2,
    "HIGH": 3,
    "MEDIUM": 4,
    "LOW": 3
  },
  "contracts": [
    {
      "contractId": "FS_READ_FILE",
      "riskClass": "LOW",
      "needsConfirmation": false,
      "denyByDefault": false,
      "requiredRuntimeCapabilities": [],
      "requiresAudit": false
    },
    {
      "contractId": "FS_DELETE_FILE",
      "riskClass": "HIGH",
      "needsConfirmation": true,
      "denyByDefault": false,
      "requiredRuntimeCapabilities": [],
      "requiresAudit": false
    },
    {
      "contractId": "FS_MODIFY_PERMISSIONS",
      "riskClass": "CRITICAL",
      "needsConfirmation": true,
      "denyByDefault": true,
      "requiredRuntimeCapabilities": [],
      "requiresAudit": true
    }
  ],
  "failClosedGuarantees": {
    "packMissingBehavior": "ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome",
    "routerOutageBehavior": "FAIL_CLOSED (no retries, block execution)",
    "preflightGate": false,
    "atomicCommitRequired": true
  }
}
```

## Key Guarantees

### Fail-Closed on Router Outage

When the router is unavailable:

- **12 stages** block execution (return empty allowedContractIds, trip ABSTAIN_CLARIFY)
- **1 stage** (TOOL_DISPATCH_GATE) can fail open, but only if mismatch is detected

### Pack Validation

If an ontology pack is missing or malformed:

- All stages convert `PackPolicyIncompleteError` → `ClarityBurstAbstainError`
- Result: Deterministic ABSTAIN_CLARIFY outcome (operation blocked)

### Atomic Commit

4 stages enforce atomic commit at the decision point:

- **FILE_SYSTEM_OPS**: Commit before write
- **MEMORY_MODIFY**: Commit before state change
- **SUBAGENT_SPAWN**: Commit before spawn
- **CRON_SCHEDULE**: Commit before job registration

This ensures that if the router is queried and a contract is selected, but the decision cannot be persisted, the operation is blocked (not retried).

### Capability-Based Filtering

Runtime capabilities are enforced **per-contract**:

- `fsWriteEnabled` controls: DISPATCH_WRITE, DISPATCH_DELETE, FS_* contracts
- `shellEnabled` controls: DISPATCH_SHELL_EXEC, SHELL_* contracts
- `networkEnabled` controls: DISPATCH_NETWORK_REQUEST, NETWORK_* contracts
- `browserEnabled` controls: DISPATCH_BROWSER_AUTOMATE, BROWSER_* contracts
- `sensitiveAccessEnabled` controls: DISPATCH_SENSITIVE_DATA, etc.

If a capability is disabled, contracts requiring it are filtered out before routing.

## Testing & Validation

The test suite includes specific tripwire tests (fail-safe tests) that verify:

- ✓ Pack incomplete → FAIL_CLOSED
- ✓ Router outage → FAIL_CLOSED (or FAIL_OPEN_ONLY_ON_MISMATCH for TOOL_DISPATCH_GATE)
- ✓ Empty allowlist → ABSTAIN_CLARIFY
- ✓ Confirmation token mismatch → blocked
- ✓ Atomic commit rollback → blocked

See `src/clarityburst/__tests__/` for the full suite of tripwire tests.

## Compliance Notes

This manifest is:

- **Auto-generated** (not manually edited)
- **Auditable** (JSON schema matches source packs)
- **Verifiable** (regenerate with `pnpm run clarityburst:manifest`)
- **Comprehensive** (~127 contracts across 12+ stages)
- **Fail-safe** (explicit guarantees for all outage scenarios)

Do **not** edit these files manually. They are intended for audit and compliance purposes only.
