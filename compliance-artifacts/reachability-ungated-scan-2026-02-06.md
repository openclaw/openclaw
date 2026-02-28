# Reachability-Bound Ungated Scan Report
**Timestamp:** 2026-02-06T03:52:17.685Z  
**Scan Type:** Tool-Reachable Ungated Irreversible Primitives Analysis  
**Status:** ✅ PASS

---

## Executive Summary

The Reachability-Bound Ungated Scan analyzed all 12 ontology packs in the OpenClaw security model and confirmed that **zero tool-reachable ungated irreversible primitives** exist, including NODE_INVOKE operations.

**Pass Condition Met:** ✅ YES

---

## Scan Output

```
======================================================================
REACHABILITY-BOUND UNGATED SCAN REPORT
======================================================================

FINDINGS SUMMARY:
  Critical: 0
  High:     0
  Medium:   0
  Low:      0
  Total:    0

PASS CONDITION: ✅ PASS
Tool-reachable ungated irreversible primitives: 0

✅ No ungated irreversible primitives found

======================================================================
```

---

## Ontology Packs Analyzed

| Pack ID | Status | Irreversible Contracts |
|---------|--------|------------------------|
| `openclawd.NODE_INVOKE` | ✅ Gated | NODE_EVAL_CODE, NODE_CREATE_VM_CONTEXT, NODE_NATIVE_ADDON, NODE_MODIFY_PROCESS |
| `openclawd.TOOL_DISPATCH_GATE` | ✅ Gated | DISPATCH_DELETE, DISPATCH_SHELL_EXEC, DISPATCH_PRIVILEGED_ADMIN, DISPATCH_SENSITIVE_DATA |
| `openclawd.FILE_SYSTEM_OPS` | ✅ Gated | FS_DELETE_FILE, FS_DELETE_DIRECTORY, FS_REMOVE_TREE |
| `openclawd.SHELL_EXEC` | ✅ Gated | SHELL_EXEC_PRIVILEGED, SHELL_EXEC_SYSTEM |
| `openclawd.CRON_SCHEDULE` | ✅ Gated | CRON_DELETE_JOB, CRON_DISABLE_JOB |
| `openclawd.SUBAGENT_SPAWN` | ✅ Checked | No ungated primitives |
| `openclawd.MESSAGE_EMIT` | ✅ Checked | No ungated primitives |
| `openclawd.BROWSER_AUTOMATE` | ✅ Checked | No ungated primitives |
| `openclawd.CANVAS_UI` | ✅ Checked | No ungated primitives |
| `openclawd.MEDIA_GENERATE` | ✅ Checked | No ungated primitives |
| `openclawd.MEMORY_MODIFY` | ✅ Checked | No ungated primitives |
| `openclawd.NETWORK_IO` | ✅ Checked | No ungated primitives |

---

## Gating Verification Details

### NODE_INVOKE Contracts
All irreversible NODE_INVOKE operations are properly gated:

- **NODE_EVAL_CODE** (HIGH risk)
  - `needs_confirmation: true` ✅
  - `deny_by_default: false` (confirmation required)
  
- **NODE_CREATE_VM_CONTEXT** (HIGH risk)
  - `needs_confirmation: true` ✅
  - `deny_by_default: false` (confirmation required)
  
- **NODE_NATIVE_ADDON** (CRITICAL risk)
  - `deny_by_default: true` ✅
  - `needs_confirmation: true` ✅
  
- **NODE_MODIFY_PROCESS** (CRITICAL risk)
  - `deny_by_default: true` ✅
  - `needs_confirmation: true` ✅

### TOOL_DISPATCH_GATE Contracts
All sensitive dispatch operations are properly gated:

- **DISPATCH_DELETE** (HIGH risk)
  - `needs_confirmation: true` ✅
  - Requires `confirmation_token` field
  
- **DISPATCH_SHELL_EXEC** (HIGH risk)
  - `needs_confirmation: true` ✅
  - Requires `command` and `working_directory` fields
  
- **DISPATCH_PRIVILEGED_ADMIN** (CRITICAL risk)
  - `deny_by_default: true` ✅
  - `needs_confirmation: true` ✅
  - Requires `authorization_token` field
  
- **DISPATCH_SENSITIVE_DATA** (HIGH risk)
  - `needs_confirmation: true` ✅
  - Requires `access_justification` field

---

## Compliance Certification

### Security Baseline: Reachability-Bound Ungated Primitives
✅ **PASS** - Zero tool-reachable ungated irreversible primitives detected

### Key Findings
- All CRITICAL-risk operations require either `deny_by_default=true` or `needs_confirmation=true`
- All HIGH-risk irreversible operations are gated with confirmation requirements
- NODE_INVOKE critical primitives (native addons, process modification) properly deny-by-default
- Tool dispatch sensitive operations (delete, shell exec, privileged) require user confirmation or tokens

### Risk Assessment
- **No gaps found** in gating coverage for irreversible operations
- **Audit trail enforcement** enabled for all sensitive contracts
- **Denial of unsafe operations** at default (deny-by-default for critical contracts)

---

## Scanner Implementation

**Scanner:** [`openclaw/src/security/reachability-ungated-scan.ts`](openclaw/src/security/reachability-ungated-scan.ts)  
**Runner:** [`openclaw/src/security/run-reachability-ungated-scan.ts`](openclaw/src/security/run-reachability-ungated-scan.ts)

### Scan Methodology
1. Load all 12 ontology packs from `openclaw/ontology-packs/`
2. Identify all contracts matching irreversible primitive definitions
3. Check each irreversible contract for gating (`deny_by_default` OR `needs_confirmation`)
4. Report findings categorized by severity and contract type
5. Enforce pass condition: zero ungated irreversible primitives

---

## Certification Details

| Attribute | Value |
|-----------|-------|
| Scan Version | 1.0.0 |
| Scan Date | 2026-02-06 |
| Scan Time (UTC) | 03:52:17.685Z |
| Packs Analyzed | 12 |
| Packs Passed | 12 |
| Pass Rate | 100% |
| Finding Count | 0 |
| Critical Findings | 0 |
| High Findings | 0 |

**Compliance Status:** ✅ **APPROVED**

---

## Conclusion

The system demonstrates full compliance with the Reachability-Bound Ungated Scan baseline. All irreversible operations that are tool-reachable are properly protected by gating mechanisms requiring user confirmation or implementing deny-by-default policies. The ontology model successfully prevents unauthorized execution of dangerous primitives including NODE_INVOKE operations.
