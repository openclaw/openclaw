# SYSTEM Tier — Internal Runtime Security

**Status:** Implemented in Phase 1-2 (Heimdall Security Layer)
**Version:** 2026.2.12

---

## Overview

The **SYSTEM tier** provides least-privilege security for trusted internal runtime operations (cron jobs, heartbeat tasks, CLI invocations) without granting full OWNER access.

**Key properties:**

- ✅ **Conservative baseline** — same tool access as MEMBER tier (read-only + safe operations)
- ✅ **Non-delegable** — subagents do NOT inherit SYSTEM tier (prevents confused deputy attacks)
- ✅ **Auditable** — all SYSTEM tier operations logged with optional tracing fields
- ✅ **Configurable** — can be extended via `toolACL` config for deployment-specific needs

---

## Sender Tier Hierarchy

### Resolution Order

```
isTrustedInternal flag → OWNER list → MEMBER list → allowFrom → GUEST (fail-closed)
```

**When `isTrustedInternal=true` is set:**

- Resolution **stops immediately** and returns SYSTEM tier
- Even senders in `owners` list will get SYSTEM (not OWNER)
- This is intentional: automated calls should have minimal privileges

### Privilege Levels

```
OWNER >> SYSTEM = MEMBER > GUEST
```

| Tier       | Privilege Level      | Use Case                         | Tool Access                   |
| ---------- | -------------------- | -------------------------------- | ----------------------------- |
| **OWNER**  | Unrestricted         | Human administrators, direct CLI | All tools (hardcoded bypass)  |
| **SYSTEM** | Read-only + safe ops | Cron, heartbeat, maintenance     | Same as MEMBER (conservative) |
| **MEMBER** | Read-only + safe ops | Team members, normal users       | DEFAULT_MEMBER_SAFE list      |
| **GUEST**  | Minimal              | External users, unauthorized     | Read-only or deny-all         |

**Note:** SYSTEM and MEMBER have **identical tool access** by default. SYSTEM is a **trust boundary marker**, not a privilege escalation.

---

## When to Use SYSTEM Tier

### ✅ **Use SYSTEM tier for:**

| Scenario              | Rationale                                                                    |
| --------------------- | ---------------------------------------------------------------------------- |
| **Cron jobs**         | Automated tasks should have minimal privileges (read-only + safe operations) |
| **Heartbeat tasks**   | Health checks, status updates — no file writes or command execution needed   |
| **CLI invocations**   | Script-driven operations — use SYSTEM unless explicit OWNER approval         |
| **Maintenance tasks** | Cleanup, monitoring, reporting — conservative baseline prevents accidents    |
| **Internal APIs**     | Service-to-service calls within trusted boundary                             |

### ❌ **Do NOT use SYSTEM tier for:**

| Scenario                     | Reason                                                      | Use Instead                                              |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| **Human-initiated commands** | User should get their normal tier (OWNER/MEMBER/GUEST)      | `internal: false` (default)                              |
| **Deployments, migrations**  | May need file writes, exec — requires OWNER                 | Owner credentials + `internal: false`                    |
| **Subagent calls**           | Subagents use parent sender identity, NOT parent privileges | Automatic (EmbeddedRunAttemptParams excludes `internal`) |
| **External webhooks**        | Untrusted input — should be GUEST tier                      | `internal: false`, rely on senderId resolution           |

---

## Usage

### 1. Marking Calls as Internal

**In pi-tools (tool creation):**

```typescript
import { createOpenClawCodingTools } from "./agents/pi-tools.js";

// Cron job example
const tools = createOpenClawCodingTools({
  config,
  senderId: "cron", // Internal caller identity
  internal: true, // ← SYSTEM tier flag
  sessionKey: "agent:cron:daily-sync",
});

// Result: senderTier = "system"
// Allowed tools: search, read, sessions_list, web_fetch, etc. (DEFAULT_MEMBER_SAFE)
```

**In CLI commands:**

```typescript
// src/commands/agent.ts
const tools = createOpenClawCodingTools({
  config,
  senderId: userId, // CLI user identity
  internal: true, // ← SYSTEM tier (even if userId in owners list)
});
```

**In cron jobs:**

```typescript
// src/cron/isolated-agent/run.ts
const tools = createOpenClawCodingTools({
  config,
  internal: true, // ← SYSTEM tier
  senderId: "cron",
  senderIsOwner: true, // Legacy (removed in Task 2.3)
});
```

---

### 2. Default Tool Access (Conservative Baseline)

**SYSTEM tier uses `DEFAULT_MEMBER_SAFE` list** (same as MEMBER):

```typescript
// From src/security/heimdall/tool-acl.ts:50-62
const DEFAULT_MEMBER_SAFE: Set<string> = new Set([
  "search", // grep-style search
  "read", // file reading
  "sessions_list", // list agent sessions
  "sessions_history", // session message history
  "session_status", // session status queries
  "image", // image operations (read EXIF, analysis)
  "memory_search", // search memory store
  "memory_get", // retrieve memory entries
  "web_search", // web search queries
  "web_fetch", // HTTP GET operations
  "agents_list", // list available agents
]);
```

**Blocked by default:**

- **File writes:** `write`, `edit`, `sandboxed_write`, `sandboxed_edit` (dangerous patterns)
- **Command execution:** `exec`, `process` (dangerous patterns), `bash` (not in safe list)
- **Code patching:** `apply_patch` (dangerous pattern)
- **MCP operations:** `mcp__*__execute_*`, `mcp__*__write_*`, `mcp__*__delete_*` (dangerous patterns)

---

### 3. Extending SYSTEM Tier (Custom ACL)

**To allow additional tools for SYSTEM tier**, add custom `toolACL` entry:

```typescript
// In openclaw.json config
{
  "agents": {
    "defaults": {
      "heimdall": {
        "enabled": true,
        "toolACL": [
          {
            "pattern": "message",
            "allowedTiers": ["system", "member", "owner"]
          },
          {
            "pattern": "sessions_send",
            "allowedTiers": ["system", "member", "owner"]
          },
          {
            "pattern": "telegram_*",   // Allow all Telegram operations
            "allowedTiers": ["system", "owner"]
          }
        ]
      }
    }
  }
}
```

**Custom ACL evaluation order:**

1. OWNER bypass (always allowed)
2. Normalize tool name
3. **Custom toolACL** — first matching pattern wins
4. Default rules (dangerous patterns → deny, safe lists → allow)

**Note:** Custom ACL is checked BEFORE defaults, so you can override baseline.

---

### 4. Audit Logging

**SYSTEM tier operations are logged** with optional tracing fields:

```typescript
import { getHeimdallAuditLogger } from "./security/heimdall/audit.js";

const logger = getHeimdallAuditLogger(config.audit);

// Log tool block with SYSTEM tier context
logger.logToolBlocked({
  toolName: "exec",
  senderTier: "system",
  reason: "Tool not in SYSTEM tier safe list",
  internal_reason: "cron", // Optional: what triggered this (cron/heartbeat/maintenance)
  correlation_id: "cron-job-abc123", // Optional: trace ID for multi-step operations
});

// Log rate limit event
logger.logRateLimit({
  senderId: "cron",
  senderTier: "system",
  internal_reason: "maintenance",
  correlation_id: "maint-task-456",
});
```

**Audit log format:**

```json
{
  "event": "tool_blocked",
  "toolName": "write",
  "senderTier": "system",
  "reason": "Tool requires OWNER tier",
  "internal_reason": "heartbeat",
  "correlation_id": "heartbeat-xyz789"
}
```

---

## Security Considerations

### 1. Non-Delegation (Subagent Isolation)

**SYSTEM tier is NOT inherited by subagents.**

```typescript
// Parent session (cron job)
const parentTools = createOpenClawCodingTools({
  config,
  internal: true, // ← SYSTEM tier
  senderId: "cron",
});

// Subagent session (spawned by parent)
const subagentTools = createOpenClawCodingTools({
  config,
  internal: false, // ← NOT inherited (EmbeddedRunAttemptParams excludes `internal`)
  senderId: "cron", // Parent senderId propagated
  spawnedBy: "agent:cron:daily-sync",
});

// Result:
// - Parent: senderTier = "system"
// - Subagent: senderTier = "guest" (senderId="cron" not in config)
```

**Why non-delegation matters:**

- **Prevents confused deputy attacks** — subagent cannot impersonate internal runtime
- **Principle of attenuation** — delegated privileges ≤ delegator privileges
- **Audit trail clarity** — SYSTEM tier events are direct internal operations, not delegated work

**Type-level enforcement:**

```typescript
// From src/agents/pi-embedded-runner/run/types.ts:37
export type EmbeddedRunAttemptParams = {
  // ... many fields
  senderIsOwner?: boolean; // Legacy field
  // NO internal?: boolean field — subagents cannot claim SYSTEM tier
};
```

---

### 2. Precedence Over OWNER Resolution

**`isTrustedInternal=true` overrides OWNER tier** (by design).

```typescript
// User in owners list
config.agents.defaults.heimdall.senderTiers.owners = [111, "thebtf"];

// OWNER credentials + internal flag
const tools = createOpenClawCodingTools({
  config,
  senderId: 111, // In owners list
  senderUsername: "thebtf",
  internal: true, // ← Overrides OWNER resolution
});

// Result: senderTier = "system" (NOT "owner")
```

**Rationale:** Automated calls should have minimal privileges, even when using owner credentials.

**If you need OWNER privileges for internal operations**, omit `internal` flag:

```typescript
// OWNER tier for deployment script
const tools = createOpenClawCodingTools({
  config,
  senderId: 111,
  senderUsername: "thebtf",
  internal: false, // ← Explicit: use normal tier resolution
});

// Result: senderTier = "owner"
```

---

### 3. Provenance Hardening

**How to verify internal calls are authentic:**

1. **Type system:** `EmbeddedRunAttemptParams` excludes `internal` field (subagents cannot fake it)
2. **Gateway isolation:** `sessions_spawn` does NOT accept `internal` parameter
3. **Explicit attestation:** Each SYSTEM tier call must set `internal: true` at source (cron, CLI)
4. **Audit logs:** All SYSTEM tier operations logged with optional `internal_reason` and `correlation_id`

**Attack vectors mitigated:**

- ❌ Subagent inheriting SYSTEM tier → Type definition excludes `internal` field
- ❌ External API call with `internal=true` → Gateway does not expose `internal` parameter
- ❌ Malicious tool spawning subagent as SYSTEM → `sessions_spawn` does not pass `internal` flag

---

## Migration Guide

### From `senderIsOwner: true` to `internal: true`

**Old behavior (privilege escalation risk):**

```typescript
// Before Task 2.3
const tools = createOpenClawCodingTools({
  config,
  senderIsOwner: true, // ← Forced OWNER tier (full access)
  senderId: "cron",
});

// Result: senderTier = "owner" (via override workaround at pi-tools.ts:379-382)
```

**New behavior (least privilege):**

```typescript
// After Task 2.3
const tools = createOpenClawCodingTools({
  config,
  internal: true, // ← SYSTEM tier (read-only + safe operations)
  senderId: "cron",
  senderIsOwner: true, // Legacy (kept for backward compat, removed in future)
});

// Result: senderTier = "system" (conservative baseline)
```

**Breaking changes:**

- ❌ Internal calls NO LONGER have `write`, `edit`, `exec`, `process` by default
- ✅ Must explicitly extend via `toolACL` config if these tools are needed
- ✅ Audit trail now accurate (SYSTEM tier logged, not OWNER)

**Rollback plan (if deployment breaks):**

```typescript
// Emergency: restore OWNER override
{
  "agents": {
    "defaults": {
      "heimdall": {
        "enabled": true,
        "toolACL": [
          {
            "pattern": "*",  // Allow all tools for SYSTEM (NOT recommended)
            "allowedTiers": ["system", "owner"]
          }
        ]
      }
    }
  }
}
```

**Recommended migration:**

1. Audit existing cron/heartbeat operations — what tools do they use?
2. Add custom `toolACL` entries for required tools (message, sessions_send, etc.)
3. Test in staging with `internal: true`
4. Monitor audit logs for blocked tools
5. Extend `toolACL` as needed, deploy to production

---

## Examples

### Example 1: Cron Job with Notification

```typescript
// src/cron/isolated-agent/run.ts
const tools = createOpenClawCodingTools({
  config,
  internal: true,
  senderId: "cron",
  sessionKey: "agent:cron:daily-report",
});

// Default: read-only + safe operations (search, read, web_fetch)
// To send notifications, extend toolACL:
{
  "agents": {
    "defaults": {
      "heimdall": {
        "toolACL": [
          {
            "pattern": "message",
            "allowedTiers": ["system", "member", "owner"]
          }
        ]
      }
    }
  }
}
```

### Example 2: Heartbeat Task (Read-Only)

```typescript
// Heartbeat task — no writes needed
const tools = createOpenClawCodingTools({
  config,
  internal: true,
  senderId: "heartbeat",
  sessionKey: "agent:heartbeat:health-check",
});

// Uses DEFAULT_MEMBER_SAFE: sessions_list, session_status, agents_list
// No toolACL extension needed (read-only operations)
```

### Example 3: CLI Invocation (Interactive)

```typescript
// src/commands/agent.ts
const tools = createOpenClawCodingTools({
  config,
  senderId: userId, // CLI user identity
  senderUsername: username,
  internal: true, // ← SYSTEM tier (even if user is owner)
});

// Result: SYSTEM tier (read-only + safe operations)
// If CLI needs OWNER privileges, omit `internal: true`
```

### Example 4: Deployment Script (OWNER Required)

```typescript
// Deployment script — needs file writes and exec
const tools = createOpenClawCodingTools({
  config,
  senderId: deployUserId, // Owner credentials
  senderUsername: "deploy-bot",
  internal: false, // ← Use normal tier resolution (OWNER)
});

// Result: senderTier = "owner" (full access)
// DO NOT use internal: true for deployments
```

---

## FAQ

### Q: Can I disable SYSTEM tier and use OWNER for all internal calls?

**A:** Yes, but NOT recommended. Set `internal: false` for internal calls:

```typescript
const tools = createOpenClawCodingTools({
  config,
  senderId: "cron",
  senderIsOwner: true, // Legacy (forces OWNER via config)
  internal: false, // ← Disable SYSTEM tier
});
```

**Why not recommended:**

- ❌ Privilege escalation risk (compromised cron → full system access)
- ❌ No audit trail clarity (OWNER logged, but not human-initiated)
- ❌ Violates principle of least privilege

### Q: How do I know if SYSTEM tier is blocking my cron job?

**A:** Check audit logs for `tool_blocked` events:

```bash
# Search for blocked tools with SYSTEM tier
grep 'tool_blocked' ~/.openclaw/logs/heimdall-audit.jsonl | grep '"senderTier":"system"'
```

**Output example:**

```json
{
  "event": "tool_blocked",
  "toolName": "write",
  "senderTier": "system",
  "reason": "Tool requires OWNER tier"
}
```

**Fix:** Add `write` to `toolACL` with `"system"` in `allowedTiers`.

### Q: Can subagents have SYSTEM tier?

**A:** No. Subagents use parent `senderId` but NOT parent `internal` flag. Type system enforces this (`EmbeddedRunAttemptParams` excludes `internal` field).

**Why:** Prevents confused deputy attacks — subagent cannot impersonate internal runtime.

### Q: What if I need SYSTEM tier for subagents?

**A:** Re-attest at subagent spawn (rare):

```typescript
// Parent session
const subagentSessionKey = await spawnSubagent({
  sessionKey: parentSessionKey,
  // ... subagent params
});

// Manually create tools for subagent with internal=true (NOT recommended)
const subagentTools = createOpenClawCodingTools({
  config,
  internal: true, // ← Explicit re-attestation
  senderId: "subagent-cron",
  sessionKey: subagentSessionKey,
});
```

**Warning:** This bypasses non-delegation design. Only use if absolutely necessary.

### Q: How do I audit SYSTEM tier usage?

**A:** Query audit logs with `senderTier: "system"`:

```bash
# Count SYSTEM tier events
grep '"senderTier":"system"' ~/.openclaw/logs/heimdall-audit.jsonl | wc -l

# Group by internal_reason
grep '"senderTier":"system"' ~/.openclaw/logs/heimdall-audit.jsonl | \
  jq '.internal_reason' | sort | uniq -c
```

**Output:**

```
  42 "cron"
  18 "heartbeat"
   3 "maintenance"
```

---

## Related Documentation

- [Heimdall Security Overview](../../src/security/heimdall/README.md)
- [Tool ACL Implementation](../../src/security/heimdall/tool-acl.ts)
- [Sender Tier Resolution](../../src/security/heimdall/sender-tier.ts)
- [Audit Logging](../../src/security/heimdall/audit.ts)

---

**Implementation:** Phase 1-2 (February 2026)
**Author:** thebtf
**Co-Authored-By:** Claude Sonnet 4.5
