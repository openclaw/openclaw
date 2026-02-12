# Heimdall Security Layer — Implementation Plan

## Context

OpenClaw's security model is sender-centric and multi-layered (allowFrom, dmPolicy, groupPolicy, elevated mode, command auth, device pairing), but ALL enforcement is either config-gated or prompt-based. There is no deterministic code-level enforcement of:

- Tool access by sender identity
- Output redaction of sensitive data
- Input boundary enforcement against injection

**Branch:** `feat/heimdall-security` (from `upstream/main`)
**Approach:** TDD — tests first, 100% coverage for security-critical code

## Architecture Overview

```
Telegram Message
    |
    v
[GATE] ──> SenderTier resolution (OWNER/MEMBER/GUEST)
    |       Uses: allowFrom, groupAllowFrom, pairing store, heimdall.senderTiers
    v
[SANITIZE] ──> Input boundaries (length, encoding, control chars)
    |
    v
[LLM Pipeline] ──> Agent processes message
    |
    v
[AUTHORIZE] ──> Tool ACL check at pi-tools.before-tool-call.ts choke point
    |              Uses: SenderTier + tool ACL config + glob matching
    v
[FILTER] ──> Output redaction on tool outputs & error messages
    |          Uses: regex patterns (built-in + custom)
    v
Telegram Reply
```

## Critical Discovery: Existing Integration Points

### Tool Execution Choke Point (CONFIRMED)

**File:** `src/agents/pi-tools.before-tool-call.ts`

- `runBeforeToolCallHook()` — EVERY tool call passes through this
- Already supports blocking (returns `{ blocked: true, reason }`)
- Already supports param modification (returns `{ blocked: false, params }`)
- Context available: `toolName`, `params`, `agentId`, `sessionKey`

### Existing Owner-Only Tool Policy (CONFIRMED)

**File:** `src/agents/pi-tools.ts:365`

```typescript
const senderIsOwner = options?.senderIsOwner === true;
const toolsByAuthorization = applyOwnerOnlyToolPolicy(tools, senderIsOwner);
```

- OpenClaw ALREADY has `senderIsOwner` concept passed into tool creation
- `applyOwnerOnlyToolPolicy()` filters tools by owner status
- Heimdall extends this to 3-tier system (OWNER/MEMBER/GUEST)

### Tool Policy Chain (CONFIRMED)

**File:** `src/agents/pi-tools.ts:409-435`
Tools are filtered through 7 policy layers:

1. profilePolicy → 2. providerProfilePolicy → 3. globalPolicy → 4. agentPolicy → 5. groupPolicy → 6. sandboxPolicy → 7. subagentPolicy

Heimdall's AUTHORIZE layer should integrate BEFORE this chain (at tool creation) or AT the before-tool-call hook (at execution time).

### Existing Security Module

**Directory:** `src/security/`

- `audit.ts` — 993-line security audit engine
- `fix.ts` — auto-fix security issues
- `channel-metadata.ts` — channel security context
- `external-content.ts` — external content validation

### Sender Identity Available At

**File:** `src/telegram/bot-message-context.ts`

- `msg.from?.id` (numeric Telegram user ID — immutable)
- `msg.from?.username` (Telegram @username — mutable)
- `msg.chat?.id` (DM or group chat ID)

### AllowFrom Resolution

**File:** `src/web/inbound/access-control.ts`

- Config `allowFrom` + pairing store merged at runtime
- Wildcard `"*"` support
- Per-channel (Telegram, Discord, WhatsApp, Slack)

---

## Implementation Steps

### Step 1: Types (`src/security/heimdall/types.ts`)

```typescript
export const SenderTier = {
  OWNER: "owner",
  MEMBER: "member",
  GUEST: "guest",
} as const;
export type SenderTier = (typeof SenderTier)[keyof typeof SenderTier];

export interface SecurityContext {
  senderId: string | number;
  senderUsername?: string;
  senderTier: SenderTier;
  channel: string;
  accountId?: string;
  groupId?: string;
  threadId?: string;
}

export interface ResolvedToolACLEntry {
  pattern: string; // glob pattern: "exec", "mcp__*", "browser_*"
  allowedTiers: SenderTier[];
}

export interface OutputFilterConfig {
  enabled: boolean;
  builtinPatterns: boolean;
  customPatterns: string[]; // additional regex strings
  redactWith: string; // default: "[REDACTED]"
}

export interface SanitizeConfig {
  enabled: boolean;
  maxLength: number; // default: 10000
  normalizeUnicode: boolean; // NFKC normalization
  maxControlCharDensity: number; // 0-1, default 0.05
}

export interface HeimdallConfig {
  enabled: boolean;
  senderTiers?: {
    owners?: (string | number)[];
    members?: (string | number)[];
  };
  toolACL?: ResolvedToolACLEntry[];
  defaultGuestPolicy?: "deny" | "read-only"; // default: "deny"
  defaultMemberPolicy?: "allow-known" | "deny-unknown"; // default: "deny-unknown"
  outputFilter?: Partial<OutputFilterConfig>;
  sanitize?: Partial<SanitizeConfig>;
}
```

### Step 2: SenderTier Resolution (`src/security/heimdall/sender-tier.ts`)

**TDD: Write tests first**

Tests (`sender-tier.test.ts`):

- Owner by numeric ID in heimdall.senderTiers.owners
- Owner by username in heimdall.senderTiers.owners
- Member via heimdall.senderTiers.members
- Member via existing allowFrom (interop with OpenClaw config)
- Guest for unknown sender (hardcoded fallback, non-configurable)
- Wildcard "\*" in allowFrom → MEMBER (not OWNER)
- Empty config → all GUEST
- Case-insensitive username matching
- Numeric ID as string vs number coercion

Logic:

```
resolveSenderTier(senderId, senderUsername, config):
  1. Check heimdall.senderTiers.owners → OWNER
  2. Check heimdall.senderTiers.members → MEMBER
  3. Check channel allowFrom + pairing store → MEMBER
  4. Fallback → GUEST (hardcoded, non-configurable)
```

### Step 3: Tool ACL (`src/security/heimdall/tool-acl.ts`)

**TDD: Write tests first**

Tests (`tool-acl.test.ts`):

- OWNER can use any tool (always allowed)
- MEMBER allowed for known safe tools
- MEMBER blocked from exec/shell tools by default
- GUEST denied ALL tools by default (defaultGuestPolicy: "deny")
- GUEST allowed read-only tools when defaultGuestPolicy: "read-only"
- Glob pattern matching: "mcp**\*" matches "mcp**github\_\_list_repos"
- Glob pattern: "browser\_\*" matches "browser_navigate"
- Custom ACL overrides defaults
- Unknown tool → denied for non-OWNER
- Tool name normalization (lowercase)

Key design decisions:

- Use `minimatch` or simple glob for pattern matching (check if already in deps)
- Default ACL embedded in code (not config), config extends it
- OWNER bypass is hardcoded — no config can restrict OWNER

Default dangerous tools (OWNER-only):

```
exec, process, apply_patch, write, edit,
sandboxed_write, sandboxed_edit,
mcp__*__execute_*, mcp__*__write_*, mcp__*__delete_*
```

### Step 4: Output Filter (`src/security/heimdall/output-filter.ts`)

**TDD: Write tests first**

Tests (`output-filter.test.ts`):

- Redacts OpenAI API keys (sk-...)
- Redacts GitHub tokens (ghp*..., gho*..., ghs\_...)
- Redacts Bearer tokens
- Redacts AWS keys (AKIA...)
- Redacts generic long hex/base64 strings with high entropy
- Does NOT redact normal text that happens to start with "sk-" in a word
- Handles multiline content
- Custom pattern matching
- Disabled when config.enabled = false
- Each built-in pattern individually describable (for logging what was redacted)
- Returns { redacted: string, matches: { pattern: string, count: number }[] }

Built-in patterns (conservative set):

```
sk-[a-zA-Z0-9]{20,}          # OpenAI
ghp_[a-zA-Z0-9]{36,}         # GitHub PAT
gho_[a-zA-Z0-9]{36,}         # GitHub OAuth
ghs_[a-zA-Z0-9]{36,}         # GitHub App
Bearer\s+[a-zA-Z0-9._\-]{20,}  # Bearer tokens
AKIA[A-Z0-9]{16}             # AWS Access Key
[a-zA-Z_]+=\s*["']?[a-zA-Z0-9/+=]{32,} # env var assignments with long values
```

### Step 5: Input Sanitize (`src/security/heimdall/sanitize.ts`)

**TDD: Write tests first**

Tests (`sanitize.test.ts`):

- Truncates input exceeding maxLength
- NFKC unicode normalization
- Strips excessive control characters (above maxControlCharDensity)
- Clean text passes through unchanged
- Returns warnings for each sanitization action
- Empty string → empty string (no crash)
- Very long input (100K chars) → truncated with warning

NO injection marker stripping — consensus says this is security theater.
Focus on: length limits, encoding normalization, control char density.

### Step 6: Config & Zod Schema

**`src/config/types.agent-defaults.ts`** — add HeimdallConfig to agent defaults:

```typescript
heimdall?: HeimdallConfig;
```

**`src/config/zod-schema.agent-runtime.ts`** — add Zod validation:

```typescript
const HeimdallSchema = z
  .object({
    enabled: z.boolean().optional(),
    senderTiers: z
      .object({
        owners: z.array(z.union([z.string(), z.number()])).optional(),
        members: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .optional(),
    toolACL: z
      .array(
        z.object({
          pattern: z.string(),
          allowedTiers: z.array(z.enum(["owner", "member", "guest"])),
        }),
      )
      .optional(),
    defaultGuestPolicy: z.enum(["deny", "read-only"]).optional(),
    defaultMemberPolicy: z.enum(["allow-known", "deny-unknown"]).optional(),
    outputFilter: z
      .object({
        enabled: z.boolean().optional(),
        builtinPatterns: z.boolean().optional(),
        customPatterns: z.array(z.string()).optional(),
        redactWith: z.string().optional(),
      })
      .strict()
      .optional(),
    sanitize: z
      .object({
        enabled: z.boolean().optional(),
        maxLength: z.number().optional(),
        normalizeUnicode: z.boolean().optional(),
        maxControlCharDensity: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
```

### Step 7: Minimal AUTHORIZE Integration (Feature-Flagged)

Per consensus: don't ship foundation without at least minimal enforcement.

**File:** `src/agents/pi-tools.before-tool-call.ts`

Add Heimdall check BEFORE existing hook runner:

```typescript
// Heimdall: deterministic tool authorization (code-level, not prompt-level)
if (heimdallConfig?.enabled) {
  const allowed = isToolAllowed(toolName, securityContext.senderTier, heimdallConfig);
  if (!allowed) {
    return {
      blocked: true,
      reason: `[heimdall] Tool "${toolName}" denied for ${securityContext.senderTier}`,
    };
  }
}
```

This requires propagating `SecurityContext` through the tool creation chain. The `senderIsOwner` already flows through `pi-tools.ts` — extend to full `SecurityContext`.

---

## Files Created/Modified

| File                                          | Action | Est. Lines            |
| --------------------------------------------- | ------ | --------------------- |
| `src/security/heimdall/types.ts`              | CREATE | ~60                   |
| `src/security/heimdall/sender-tier.ts`        | CREATE | ~50                   |
| `src/security/heimdall/sender-tier.test.ts`   | CREATE | ~120                  |
| `src/security/heimdall/tool-acl.ts`           | CREATE | ~80                   |
| `src/security/heimdall/tool-acl.test.ts`      | CREATE | ~100                  |
| `src/security/heimdall/output-filter.ts`      | CREATE | ~70                   |
| `src/security/heimdall/output-filter.test.ts` | CREATE | ~100                  |
| `src/security/heimdall/sanitize.ts`           | CREATE | ~40                   |
| `src/security/heimdall/sanitize.test.ts`      | CREATE | ~80                   |
| `src/security/heimdall/index.ts`              | CREATE | ~10                   |
| `src/config/types.agent-defaults.ts`          | MODIFY | +8                    |
| `src/config/zod-schema.agent-runtime.ts`      | MODIFY | +25                   |
| `src/agents/pi-tools.before-tool-call.ts`     | MODIFY | +15 (feature-flagged) |

---

## Verification

```bash
# Unit tests
npx vitest run src/security/heimdall/

# Type check
npx tsc --noEmit

# Existing tests still pass
npx vitest run src/security/
npx vitest run src/agents/

# Coverage
npx vitest run src/security/heimdall/ --coverage
```

---

## Config Example

```json
{
  "agents": {
    "defaults": {
      "heimdall": {
        "enabled": true,
        "senderTiers": {
          "owners": [281043, "thebtf"],
          "members": [123456]
        },
        "toolACL": [
          { "pattern": "browser_*", "allowedTiers": ["owner", "member"] },
          { "pattern": "mcp__github__*", "allowedTiers": ["owner", "member"] }
        ],
        "defaultGuestPolicy": "deny",
        "outputFilter": {
          "enabled": true,
          "builtinPatterns": true
        },
        "sanitize": {
          "enabled": true,
          "maxLength": 10000
        }
      }
    }
  }
}
```

---

## Risks & Mitigations

| Risk                                | Mitigation                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| Output filter false positives       | Conservative patterns, individually toggleable, log before redact |
| Dynamic MCP tool names              | Glob matching (mcp\_\_\*), default-deny for non-OWNER             |
| SecurityContext not propagated      | Extend existing senderIsOwner flow in pi-tools.ts                 |
| Breaking existing tool policy chain | Feature flag (heimdall.enabled), check runs BEFORE existing chain |
| Multi-agent tier propagation        | Future PR — document as known limitation                          |

---

## Not In Scope (Future PRs)

- Full pipeline integration (GATE at message intake, FILTER at delivery)
- Multi-agent SecurityContext propagation
- Per-channel heimdall overrides
- Audit logging infrastructure
- Rate limiting at GATE
- File content sanitization
- Streaming output filter
