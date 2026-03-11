# ClarityBurst Ontology Overview

**Understanding the 127 contracts across 13 stages**

---

## What is an Ontology Pack?

An **ontology pack** is a JSON file that defines all authorized contracts (operations) for a given stage. Each contract specifies:

- **Contract ID** – Unique identifier (e.g., `SHELL_EXEC:001`)
- **Name** – Human-readable operation name
- **Risk Level** – LOW, MEDIUM, HIGH, CRITICAL
- **Requires Confirmation** – Whether user approval is needed
- **Capabilities Required** – What permissions this contract needs
- **Conditions** – Contextual gating rules

---

## The 13 Stages & Their Purposes

| # | Stage | Contracts | Risk | Purpose |
|---|-------|-----------|------|---------|
| 1 | `TOOL_DISPATCH_GATE` | ~10 | Medium | Tool availability routing; determines which tools can be used |
| 2 | `SHELL_EXEC` | ~10 | **HIGH** | Shell command execution; e.g., `exec`, `spawn`, `bash` |
| 3 | `NETWORK_IO` | ~15 | **HIGH** | Network requests; HTTP, fetch, socket operations |
| 4 | `FILE_SYSTEM_OPS` | ~25 | **HIGH** | File system operations; read, write, delete, rename |
| 5 | `SUBAGENT_SPAWN` | ~8 | **HIGH** | Subagent creation and spawning |
| 6 | `MEMORY_MODIFY` | ~12 | Medium | Memory/knowledge base updates |
| 7 | `NODE_INVOKE` | ~10 | Medium | Node execution; `node`, `eval`, `require` |
| 8 | `CRON_SCHEDULE` | ~12 | Medium | Scheduled task definition; cron jobs |
| 9 | `CRON_PREFLIGHT_GATE` | ~8 | Medium | Preflight validation for cron tasks |
| 10 | `MESSAGE_EMIT` | ~8 | Low | Message output; notifications, logs |
| 11 | `CANVAS_UI` | ~5 | Low | Canvas UI operations; rendering |
| 12 | `BROWSER_AUTOMATE` | ~12 | Medium | Browser automation; click, type, navigate |
| 13 | `MEDIA_GENERATE` | ~6 | Low | Media generation; images, audio |

**Total Contracts:** ~127 across 13 stages

---

## Example Contract Structure

```json
{
  "stage_id": "SHELL_EXEC",
  "contracts": [
    {
      "contract_id": "SHELL_EXEC:001",
      "name": "Execute arbitrary shell command",
      "risk_level": "CRITICAL",
      "requires_confirmation": true,
      "capabilities_required": ["shell", "critical_opt_in"],
      "description": "Run any command via shell (bash, zsh, PowerShell, etc.)"
    },
    {
      "contract_id": "SHELL_EXEC:002",
      "name": "Execute read-only file inspection",
      "risk_level": "LOW",
      "requires_confirmation": false,
      "capabilities_required": ["shell"],
      "description": "Safe commands: ls, cat, grep (read-only)"
    },
    {
      "contract_id": "SHELL_EXEC:003",
      "name": "Execute with output capture",
      "risk_level": "MEDIUM",
      "requires_confirmation": false,
      "capabilities_required": ["shell"],
      "description": "Execute and capture stdout/stderr"
    }
  ]
}
```

---

## Risk Levels Explained

| Level | Meaning | User Confirmation | Examples |
|-------|---------|------------------|----------|
| **LOW** | Safe operation; no sensitive impact | No | Read-only file ops, message emit |
| **MEDIUM** | Potential side effects; reversible | Maybe | Network requests, cron scheduling |
| **HIGH** | Significant impact; hard to reverse | Maybe | Shell execution, file deletion |
| **CRITICAL** | Irreversible; major damage possible | **Yes** | Arbitrary shell commands, privilege escalation |

---

## Capabilities Required

Contracts reference these capability sets:

| Capability | Meaning | Risk |
|------------|---------|------|
| `browser` | Can automate browser; click, type, navigate | Medium |
| `shell` | Can execute shell commands | **HIGH** |
| `network` | Can make network requests | **HIGH** |
| `fs_write` | Can write/delete files | **HIGH** |
| `critical_opt_in` | Requires explicit user opt-in | **CRITICAL** |
| `sensitive_access` | Access to sensitive resources | **HIGH** |

---

## Confirmation Requirements

If a contract has `requires_confirmation: true`, the operation is blocked until:

1. **User confirms** the operation
2. **User provides exact token** (substring/prefix NOT accepted)
3. **Token matches** what the gating layer expects

Example:

```typescript
// Attempt to execute arbitrary shell command
await executeShell("rm -rf /");

// ClarityBurst intercepts and requires confirmation
// Gating returns: ABSTAIN_CONFIRM
// User must provide token: "execute_arbitrary_shell_SHELL_EXEC:001"
// Only exact match accepted; no substrings
```

---

## How Routing Works

```
Request: { stageId, commandContext, requiredCapabilities }
  ↓
ClarityBurst Router evaluates:
  1. Stage is one of 13 known stages ✓
  2. Determine allowed contracts based on context
  3. Match against top-2 contracts by relevance
  4. Apply deterministic arbitration
  ↓
Response: { topMatch, topTwoMatches, ... }
  ↓
Decision Override applies outcome:
  - PROCEED: allow operation
  - ABSTAIN_CLARIFY: ask user or block
  - ABSTAIN_CONFIRM: require confirmation
  - MODIFY: allow with constraints
```

---

## Coverage by Stage

See [`Coverage Summary`](COVERAGE_SUMMARY.md) for detailed breakdown of contracts per stage.

Quick summary:

- **FILE_SYSTEM_OPS** has most contracts (~25) – reflects complexity of file operations
- **NETWORK_IO** has ~15 contracts – reflects HTTP method variety
- **SHELL_EXEC** has ~10 contracts – reflects command complexity levels
- **CRON_SCHEDULE** has ~12 contracts – reflects scheduling flexibility
- **MESSAGE_EMIT** has ~8 contracts – reflects channel/medium variety

---

## Accessing Ontology Packs

Packs are loaded dynamically from `ontology-packs/*.json`:

```typescript
import { getPackForStage } from '../src/clarityburst/pack-registry';

// Get the SHELL_EXEC pack
const shellPack = await getPackForStage('SHELL_EXEC');

// Access contracts
const contracts = shellPack.contracts;
const contractIds = contracts.map(c => c.contract_id);

console.log(contractIds);
// ['SHELL_EXEC:001', 'SHELL_EXEC:002', 'SHELL_EXEC:003', ...]
```

---

## Ontology Evolution

The ontology is **versioned** and can be extended:

- **Add new contract:** Add to pack JSON + regenerate manifest
- **Update risk level:** Modify pack JSON + rerun validation
- **Deprecate contract:** Mark as deprecated; prefer new contract
- **Revalidate:** Run `pnpm run clarityburst:manifest` to regenerate

See [`Implementation Status`](../reference/IMPLEMENTATION_STATUS.md) for current coverage.

---

## Manifest Generation

To regenerate the human-readable and machine-readable manifests:

```bash
pnpm run clarityburst:manifest
```

This generates:

- [`MANIFEST.json`](../compliance/MANIFEST.json) – Machine-readable
- [`MANIFEST.yaml`](../compliance/MANIFEST.yaml) – Human-readable
- [`COVERAGE_SUMMARY.md`](COVERAGE_SUMMARY.md) – Markdown summary

---

## See Also

- **Stage Definitions:** [`Stage Definitions`](STAGE_DEFINITIONS.md) (full specifications)
- **Coverage Report:** [`Coverage Summary`](COVERAGE_SUMMARY.md) (metrics)
- **Contract Lookup:** [`Contract Reference`](CONTRACT_REFERENCE.md) (search by ID)
- **Pack Source:** [`ontology-packs/`](../../ontology-packs/) (raw JSON files)

---

**Last Updated:** 2026-03-07  
**Total Contracts:** 127  
**Total Stages:** 13
