# Contact Permissions Feature Spec

## Overview

Add contact-based tool permissions with verification-aware sender identity resolution.

**Security Model:**

- Default-DENY for non-owners (everyone blocked until explicitly allowlisted)
- Default-ALLOW for owner (Jamie's numbers auto-get everything)
- Verification gate: only WhatsApp and iMessage are verified; SMS is not

## Current Architecture

The codebase already has:

- `src/config/group-policy.ts`: `resolveToolsBySender()` matches sender identity
- `src/config/types.tools.ts`: `GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>`
- Groups support `toolsBySender` keyed by senderId, senderE164, senderUsername, senderName

## What's Missing

### 1. DM-level toolsBySender

Currently `toolsBySender` only exists under `channels.*.groups.*`. For DMs, the sender IS the contact, so we need:

```yaml
channels:
  whatsapp:
    toolsBySender: # <-- NEW: top-level, applies to DMs
      "+15550001111": { allow: ["*"] }
      "+15550003333": { allow: ["*"] }
      "*": { deny: ["*"] } # default deny
    groups:
      "some-group":
        toolsBySender: { ... } # existing
```

### 2. Channel verification flag

Add `verified: boolean` to channel config:

```yaml
channels:
  whatsapp:
    verified: true
  imessage:
    verified: true
  sms:
    verified: false
```

### 3. Policy resolution with verification

Modify `resolveChannelGroupToolsPolicy()` (or create new `resolveChannelDMToolsPolicy()`) to:

1. Check if channel is verified
2. If not verified, skip sender-specific policies (treat as untrusted)
3. Apply default policy for unverified senders

### 4. Owner shorthand

Add `owner` config for convenience:

```yaml
owner:
  phones: ["+15550001111", "+15550002222"]
  # These get allow: ["*"] on all verified channels
```

## Files to Modify

1. **`src/config/types.whatsapp.ts`** - Add top-level `toolsBySender` and `verified`
2. **`src/config/types.imessage.ts`** - Add `verified` flag
3. **`src/config/types.sms.ts`** (if exists) - Add `verified: false` default
4. **`src/config/group-policy.ts`** - Add `resolveChannelDMToolsPolicy()` function
5. **`src/config/zod-schema.agent-runtime.ts`** - Add schema validation for new fields
6. **Gateway tool filtering** - Apply DM policy during tool call resolution

## Implementation Order

1. Add types (toolsBySender at channel level, verified flag)
2. Add zod schemas for validation
3. Add `resolveChannelDMToolsPolicy()` function
4. Wire into gateway tool filtering
5. Add tests
6. Update docs

## Example Config (Target State)

```yaml
owner:
  phones:
    - "+15550001111"
    - "+15550002222"

channels:
  whatsapp:
    verified: true
    toolsBySender:
      "+15550003333": # McKenna (close friend)
        allow: ["*"]
      "+15550004444": # Becca (close friend)
        allow: ["message:*", "cron:*", "calendar:read"]
      "*":
        deny: ["*"] # default deny for unknown contacts

  imessage:
    verified: true
    toolsBySender:
      # inherits from owner.phones -> allow all
      "+15550003333": { allow: ["*"] }
      "*": { deny: ["*"] }

  sms:
    verified: false
    # toolsBySender ignored - unverified channel
```

## Test Cases

1. Owner phone via WhatsApp → all tools allowed
2. Close friend via WhatsApp → allowed tools work, others blocked
3. Unknown contact via WhatsApp → all tools blocked
4. Owner phone via SMS → should this work? (spoofable)
5. Close friend phone via SMS → blocked (unverified)
