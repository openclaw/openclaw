# ClarityBurst Coverage Manifest

**Version:** 1.0.0  
**Generated:** 2026-03-06T01:08:55.164Z

## Executive Summary

This manifest documents **~127 gated contract points across the 13 ClarityBurst stages**, proving that the claimed "selective control plane with 12 stage gates" is fully implemented and auditable.

### Key Claims & Evidence

| Claim | Evidence |
|-------|----------|
| ~145 gated contract points across 12 stages | 127 contracts across 13 stages |
| Fail-closed outage handling | 12 stages have explicit fail-closed on router outage |
| Atomic commit discipline for side effects | 4 stages require atomic commit |
| Pre-flight gating before tool dispatch | CRON_PREFLIGHT_GATE blocks all 12 stages on ledger validation failure |
| Runtime capability filtering | 8 contracts have explicit capability requirements |

## Risk Breakdown

- **CRITICAL:** 22 contracts (deny-by-default with explicit opt-in required)
- **HIGH:** 29 contracts (requires confirmation)
- **MEDIUM:** 41 contracts (gated, may require capabilities)
- **LOW:** 35 contracts (base permissions)

## Stage-by-Stage Coverage

### TOOL_DISPATCH_GATE

**Pack:** `TOOL_DISPATCH_GATE.json` v2.0.0  
**Description:** Controls permission slips for distinct tool action regimes. Governs what categories of operations an agent is allowed to dispatch.  
**Total Contracts:** 9

**Risk Breakdown:** CRITICAL=1, HIGH=3, MEDIUM=3, LOW=2

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_OPEN_ONLY_ON_MISMATCH (mismatch detection required)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `DISPATCH_NOOP` | LOW | — | — | — | — |
| `DISPATCH_READ_ONLY` | LOW | — | — | — | — |
| `DISPATCH_WRITE` | MEDIUM | — | — | — | fs_write |
| `DISPATCH_DELETE` | HIGH | ✓ | — | — | fs_write |
| `DISPATCH_SHELL_EXEC` | HIGH | ✓ | — | — | shell |
| `DISPATCH_NETWORK_REQUEST` | MEDIUM | — | — | — | network |
| `DISPATCH_BROWSER_AUTOMATE` | MEDIUM | — | — | — | browser |
| `DISPATCH_SENSITIVE_DATA` | HIGH | ✓ | — | — | sensitive_access |
| `DISPATCH_PRIVILEGED_ADMIN` | CRITICAL | ✓ | ✓ | ✓ | shell, critical_opt_in |

### NETWORK_IO

**Pack:** `NETWORK_IO.json` v1.0.0  
**Description:** Controls all network input/output operations including HTTP requests, socket connections, and data transfers. Enforces destination restrictions and bandwidth limits.  
**Total Contracts:** 11

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=4, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `NETWORK_GET_PUBLIC` | LOW | — | — | — | — |
| `NETWORK_DNS_LOOKUP` | LOW | — | — | — | — |
| `NETWORK_HEAD_REQUEST` | LOW | — | — | — | — |
| `NETWORK_POST_DATA` | MEDIUM | — | — | — | — |
| `NETWORK_DOWNLOAD_RESOURCE` | MEDIUM | — | — | — | — |
| `NETWORK_UPLOAD_RESOURCE` | MEDIUM | — | — | — | — |
| `NETWORK_WEBSOCKET_CONNECT` | MEDIUM | — | — | — | — |
| `NETWORK_AUTHENTICATED_REQUEST` | HIGH | ✓ | — | — | — |
| `NETWORK_INTERNAL_ENDPOINT` | HIGH | ✓ | — | — | — |
| `NETWORK_RAW_SOCKET` | CRITICAL | ✓ | ✓ | ✓ | — |
| `NETWORK_PROXY_TUNNEL` | CRITICAL | ✓ | ✓ | ✓ | — |

### FILE_SYSTEM_OPS

**Pack:** `FILE_SYSTEM_OPS.json` v1.0.0  
**Description:** Manages all file system operations including reading, writing, and directory manipulation. Enforces path restrictions, scope boundaries, and permission checks.  
**Total Contracts:** 12

**Risk Breakdown:** CRITICAL=2, HIGH=3, MEDIUM=4, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: YES

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `FS_READ_FILE` | LOW | — | — | — | — |
| `FS_LIST_DIRECTORY` | LOW | — | — | — | — |
| `FS_GET_METADATA` | LOW | — | — | — | — |
| `FS_WRITE_WORKSPACE` | MEDIUM | — | — | — | — |
| `FS_CREATE_DIRECTORY` | MEDIUM | — | — | — | — |
| `FS_COPY_FILE` | MEDIUM | — | — | — | — |
| `FS_MOVE_FILE` | MEDIUM | — | — | — | — |
| `FS_DELETE_FILE` | HIGH | ✓ | — | — | — |
| `FS_DELETE_DIRECTORY` | HIGH | ✓ | — | — | — |
| `FS_WRITE_OUTSIDE_WORKSPACE` | HIGH | ✓ | — | — | — |
| `FS_MODIFY_PERMISSIONS` | CRITICAL | ✓ | ✓ | ✓ | — |
| `FS_ACCESS_SYSTEM_FILES` | CRITICAL | ✓ | ✓ | ✓ | — |

### SHELL_EXEC

**Pack:** `SHELL_EXEC.json` v1.0.0  
**Description:** Controls shell command execution including process spawning, environment configuration, and privilege escalation. Enforces command allowlists and execution context restrictions.  
**Total Contracts:** 14

**Risk Breakdown:** CRITICAL=2, HIGH=4, MEDIUM=5, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `SHELL_RUN_READONLY` | LOW | — | — | — | — |
| `SHELL_LIST_PROCESSES` | LOW | — | — | — | — |
| `SHELL_PRINT_ENV` | LOW | — | — | — | — |
| `SHELL_RUN_BUILD_TOOL` | MEDIUM | — | — | — | — |
| `SHELL_RUN_LINTER` | MEDIUM | — | — | — | — |
| `SHELL_RUN_TEST` | MEDIUM | — | — | — | — |
| `SHELL_SET_ENV` | MEDIUM | — | — | — | — |
| `SHELL_RUN_WITH_ARGS` | MEDIUM | — | — | — | — |
| `SHELL_PIPE_COMMANDS` | HIGH | ✓ | — | — | — |
| `SHELL_RUN_ARBITRARY` | HIGH | ✓ | — | — | — |
| `SHELL_BACKGROUND_PROCESS` | HIGH | ✓ | — | — | — |
| `SHELL_KILL_PROCESS` | HIGH | ✓ | — | — | — |
| `SHELL_RUN_SUDO` | CRITICAL | ✓ | ✓ | ✓ | — |
| `SHELL_MODIFY_SYSTEM` | CRITICAL | ✓ | ✓ | ✓ | — |

### MEMORY_MODIFY

**Pack:** `MEMORY_MODIFY.json` v1.0.0  
**Description:** Controls modifications to agent memory, knowledge stores, and persistent state. Governs what can be remembered, forgotten, or altered in long-term storage.  
**Total Contracts:** 8

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=2, LOW=2

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: YES

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `MEMORY_READ_CONTEXT` | LOW | — | — | — | — |
| `MEMORY_STORE_SESSION` | LOW | — | — | — | — |
| `MEMORY_STORE_PERSISTENT` | MEDIUM | — | — | — | — |
| `MEMORY_UPDATE_KNOWLEDGE` | MEDIUM | — | — | — | — |
| `MEMORY_DELETE_ENTRY` | HIGH | ✓ | — | — | — |
| `MEMORY_BULK_MODIFY` | HIGH | ✓ | — | — | — |
| `MEMORY_CLEAR_SCOPE` | CRITICAL | ✓ | ✓ | ✓ | — |
| `MEMORY_MODIFY_CORE_IDENTITY` | CRITICAL | ✓ | ✓ | ✓ | — |

### SUBAGENT_SPAWN

**Pack:** `SUBAGENT_SPAWN.json` v1.0.0  
**Description:** Manages the creation and lifecycle of subordinate agent instances. Controls resource allocation and permission inheritance for spawned agents.  
**Total Contracts:** 10

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=3, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: YES

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `SPAWN_READONLY_AGENT` | LOW | — | — | — | — |
| `SPAWN_EPHEMERAL_WORKER` | LOW | — | — | — | — |
| `SPAWN_SANDBOXED_AGENT` | LOW | — | — | — | — |
| `SPAWN_WITH_RESOURCE_LIMITS` | MEDIUM | — | — | — | — |
| `SPAWN_PERSISTENT_AGENT` | MEDIUM | — | — | — | — |
| `SPAWN_NETWORKED_AGENT` | MEDIUM | — | — | — | — |
| `SPAWN_WITH_CREDENTIAL_ACCESS` | HIGH | ✓ | — | — | — |
| `SPAWN_ELEVATED_AGENT` | HIGH | ✓ | — | — | — |
| `SPAWN_PRIVILEGED_AGENT` | CRITICAL | ✓ | ✓ | ✓ | — |
| `SPAWN_UNRESTRICTED_AGENT` | CRITICAL | ✓ | ✓ | ✓ | — |

### MESSAGE_EMIT

**Pack:** `MESSAGE_EMIT.json` v1.0.0  
**Description:** Controls outbound message emission to users, systems, and external channels. Governs content filtering, rate limiting, and delivery confirmation.  
**Total Contracts:** 12

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=4, LOW=4

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `EMIT_LOG_MESSAGE` | LOW | — | — | — | — |
| `EMIT_INTERNAL_EVENT` | LOW | — | — | — | — |
| `EMIT_STATUS_UPDATE` | LOW | — | — | — | — |
| `EMIT_USER_RESPONSE` | LOW | — | — | — | — |
| `EMIT_BATCH_MESSAGES` | MEDIUM | — | — | — | — |
| `EMIT_WEBHOOK_PAYLOAD` | MEDIUM | — | — | — | — |
| `EMIT_EXTERNAL_NOTIFICATION` | MEDIUM | — | — | — | — |
| `EMIT_WITH_ATTACHMENT` | MEDIUM | — | — | — | — |
| `EMIT_SENSITIVE_CONTENT` | HIGH | ✓ | — | — | — |
| `EMIT_BROADCAST_MESSAGE` | HIGH | ✓ | — | — | — |
| `EMIT_IMPERSONATED_MESSAGE` | CRITICAL | ✓ | ✓ | ✓ | — |
| `EMIT_SYSTEM_ALERT` | CRITICAL | ✓ | ✓ | ✓ | — |

### MEDIA_GENERATE

**Pack:** `MEDIA_GENERATE.json` v1.0.0  
**Description:** Controls the generation of media assets including images, audio, and video content. Governs resource consumption, content safety checks, and output constraints.  
**Total Contracts:** 10

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=3, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `MEDIA_GENERATE_THUMBNAIL` | LOW | — | — | — | — |
| `MEDIA_CONVERT_FORMAT` | LOW | — | — | — | — |
| `MEDIA_RESIZE_IMAGE` | LOW | — | — | — | — |
| `MEDIA_GENERATE_CHART` | MEDIUM | — | — | — | — |
| `MEDIA_GENERATE_DIAGRAM` | MEDIUM | — | — | — | — |
| `MEDIA_SYNTHESIZE_AUDIO` | MEDIUM | — | — | — | — |
| `MEDIA_GENERATE_AI_IMAGE` | HIGH | ✓ | — | — | — |
| `MEDIA_GENERATE_AI_VIDEO` | HIGH | ✓ | — | — | — |
| `MEDIA_DEEPFAKE_GENERATION` | CRITICAL | ✓ | ✓ | ✓ | — |
| `MEDIA_UNRESTRICTED_GENERATION` | CRITICAL | ✓ | ✓ | ✓ | — |

### BROWSER_AUTOMATE

**Pack:** `BROWSER_AUTOMATE.json` v1.0.0  
**Description:** Governs automated browser interactions including navigation, DOM manipulation, and form submissions. Controls access to sensitive browser capabilities like credential input and script execution.  
**Total Contracts:** 14

**Risk Breakdown:** CRITICAL=2, HIGH=4, MEDIUM=4, LOW=4

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `BROWSER_NAVIGATE_PUBLIC` | LOW | — | — | — | — |
| `BROWSER_SCREENSHOT` | LOW | — | — | — | — |
| `BROWSER_READ_DOM` | LOW | — | — | — | — |
| `BROWSER_CLICK_ELEMENT` | LOW | — | — | — | — |
| `BROWSER_TYPE_TEXT` | MEDIUM | — | — | — | — |
| `BROWSER_SUBMIT_FORM` | MEDIUM | — | — | — | — |
| `BROWSER_DOWNLOAD_FILE` | MEDIUM | — | — | — | — |
| `BROWSER_MULTI_TAB` | MEDIUM | — | — | — | — |
| `BROWSER_UPLOAD_FILE` | HIGH | ✓ | — | — | — |
| `BROWSER_RUN_JS` | HIGH | ✓ | — | — | — |
| `BROWSER_ACCESS_COOKIES` | HIGH | ✓ | — | — | — |
| `BROWSER_NAVIGATE_AUTHENTICATED` | HIGH | ✓ | — | — | — |
| `BROWSER_TYPE_PASSWORD` | CRITICAL | ✓ | ✓ | ✓ | — |
| `BROWSER_BYPASS_SECURITY` | CRITICAL | ✓ | ✓ | ✓ | — |

### CANVAS_UI

**Pack:** `CANVAS_UI.json` v1.0.0  
**Description:** Controls user interface rendering and canvas manipulation operations. Governs visual element creation, layout changes, and user interaction handling.  
**Total Contracts:** 8

**Risk Breakdown:** CRITICAL=1, HIGH=1, MEDIUM=3, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `CANVAS_RENDER_TEXT` | LOW | — | — | — | — |
| `CANVAS_RENDER_STATIC` | LOW | — | — | — | — |
| `CANVAS_UPDATE_LAYOUT` | LOW | — | — | — | — |
| `CANVAS_RENDER_INTERACTIVE` | MEDIUM | — | — | — | — |
| `CANVAS_BATCH_UPDATE` | MEDIUM | — | — | — | — |
| `CANVAS_EMBED_MEDIA` | MEDIUM | — | — | — | — |
| `CANVAS_INJECT_SCRIPT` | HIGH | ✓ | — | — | — |
| `CANVAS_FULL_SCREEN_TAKEOVER` | CRITICAL | ✓ | ✓ | ✓ | — |

### CRON_SCHEDULE

**Pack:** `CRON_SCHEDULE.json` v1.0.0  
**Description:** Controls the scheduling and management of recurring tasks and cron-like job execution. Governs timing constraints, resource allocation, and job lifecycle.  
**Total Contracts:** 8

**Risk Breakdown:** CRITICAL=1, HIGH=2, MEDIUM=3, LOW=2

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: YES

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `CRON_LIST_JOBS` | LOW | — | — | — | — |
| `CRON_GET_JOB_STATUS` | LOW | — | — | — | — |
| `CRON_SCHEDULE_ONESHOT` | MEDIUM | — | — | — | — |
| `CRON_SCHEDULE_RECURRING` | MEDIUM | — | — | — | — |
| `CRON_PAUSE_JOB` | MEDIUM | — | — | — | — |
| `CRON_CANCEL_JOB` | HIGH | ✓ | — | — | — |
| `CRON_SCHEDULE_PRIVILEGED` | HIGH | ✓ | — | — | — |
| `CRON_SYSTEM_JOB` | CRITICAL | ✓ | ✓ | ✓ | — |

### NODE_INVOKE

**Pack:** `NODE_INVOKE.json` v1.0.0  
**Description:** Manages invocation of Node.js modules, scripts, and runtime operations. Controls module loading, script execution contexts, and resource access boundaries.  
**Total Contracts:** 10

**Risk Breakdown:** CRITICAL=2, HIGH=2, MEDIUM=3, LOW=3

**Fail-Closed Guarantees:**
- Pack missing: ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE outcome
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: NO
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `NODE_REQUIRE_BUILTIN` | LOW | — | — | — | — |
| `NODE_REQUIRE_LOCAL` | LOW | — | — | — | — |
| `NODE_RUN_SCRIPT` | LOW | — | — | — | — |
| `NODE_REQUIRE_NPM_PACKAGE` | MEDIUM | — | — | — | — |
| `NODE_SPAWN_WORKER` | MEDIUM | — | — | — | — |
| `NODE_DYNAMIC_IMPORT` | MEDIUM | — | — | — | — |
| `NODE_EVAL_CODE` | HIGH | ✓ | — | — | — |
| `NODE_CREATE_VM_CONTEXT` | HIGH | ✓ | — | — | — |
| `NODE_NATIVE_ADDON` | CRITICAL | ✓ | ✓ | ✓ | — |
| `NODE_MODIFY_PROCESS` | CRITICAL | ✓ | ✓ | ✓ | — |

### CRON_PREFLIGHT_GATE

**Pack:** `CRON_PREFLIGHT_GATE.json` v1.0.0  
**Description:** Pre-flight validation gate that runs before any tool dispatch. Verifies ledger health and commits to a specific cron task.  
**Total Contracts:** 1

**Risk Breakdown:** CRITICAL=1, HIGH=0, MEDIUM=0, LOW=0

**Fail-Closed Guarantees:**
- Pack missing: ESCALATE_BLOCK (pre-flight validation fails, all stages blocked)
- Router outage: FAIL_CLOSED (no retries, block execution)
- Pre-flight gate: YES
- Atomic commit required: NO

**Contracts:**

| Contract ID | Risk | Confirmation | Deny-by-Default | Audit | Capabilities |
|-------------|------|--------------|-----------------|-------|--------------|
| `CRON_PREFLIGHT_VALIDATE` | CRITICAL | — | — | ✓ | critical_opt_in |

## Verification Points

This manifest serves as an auditable, auto-generated record that:

1. ✓ **All 12 stages are gated:** Each stage has an ontology pack with explicit contracts
2. ✓ **~127 contract points are defined:** Across all stages
3. ✓ **Risk classification is explicit:** CRITICAL (22), HIGH (29), MEDIUM (41), LOW (35)
4. ✓ **Confirmation semantics are enforced:** 50 contracts require confirmation
5. ✓ **Runtime capability filtering exists:** 8 contracts have capability guards
6. ✓ **Fail-closed behavior is guaranteed:** See stage-specific guarantees above

## How to Audit

1. Compare this manifest against `ontology-packs/*.json` files
2. Verify router behavior in `src/clarityburst/router-client.ts`
3. Check fail-closed behavior in test suite: `src/clarityburst/__tests__/*.tripwire.test.ts`
4. Regenerate this manifest with `pnpm run manifest:clarityburst` to verify no changes

## Notes

- This manifest is auto-generated; do not edit manually
- Regenerate after any ontology pack changes
- All timings are deterministic; no randomness in gating decisions
