---
title: Contact Permissions
summary: "Sender-aware tool permissions with contact groups and channel verification"
read_when: "You want to control what tools different people can use when they message your assistant"
status: active
---

# Contact Permissions

Control which tools different contacts can use, with cryptographic sender verification.

## Why This Exists

When you expose an AI assistant via messaging, you need granular access control:

- Your spouse shouldn't have the same restrictions as a stranger
- Close friends should check your calendar, but strangers shouldn't access email
- LLM-based access control is unreliable (prompt injection can trick it)

Contact permissions enforce access at the **infrastructure level**, before the LLM sees the request.

## Security Model

- **Default-DENY for non-owners**: Everyone blocked until explicitly allowlisted
- **Default-ALLOW for owners**: Your phone numbers get full access
- **Verification-aware**: Only verified channels (WhatsApp, iMessage, Signal) honor sender-specific policies; unverified channels (SMS) use restrictive defaults

## Quick Start

### 1. Define contacts

```yaml
contacts:
  entries:
    alice:
      phone: "+15551234567"
      name: "Alice Smith"
    bob:
      phone: "+15559876543"
      name: "Bob Jones"
```

### 2. Create groups

```yaml
contacts:
  groups:
    close_friends:
      members: [alice, bob]
      tools:
        allow:
          - "exec:gog calendar*"
          - "web_search"
      instructions: "Be casual and friendly."
```

### 3. Reference in channel config

```yaml
channels:
  whatsapp:
    verified: true
    toolsBySender:
      "+15550000001": { allow: ["*"] } # Owner
      "@close_friends": {} # Group reference
      "*": { deny: ["*"] } # Block everyone else
```

## Scoped Exec Patterns

Allow specific commands while blocking others:

```yaml
allow:
  - "exec:gog calendar freebusy*" # Calendar freebusy only
  - "exec:gog calendar events*" # Calendar events only
```

Pattern syntax:

- `exec:prefix*` — commands starting with prefix
- `exec:exact` — exact command match
- `exec:*` — all exec (use sparingly)

## Channel Verification

| Channel  | Verified | Notes                             |
| -------- | -------- | --------------------------------- |
| WhatsApp | ✅       | Cryptographic sender verification |
| iMessage | ✅       | Apple ID verification             |
| Signal   | ✅       | Cryptographic verification        |
| SMS      | ❌       | Sender ID is spoofable            |

For unverified channels, sender-specific policies are ignored:

```yaml
channels:
  sms:
    verified: false # Default
    toolsBySender:
      "+15551234567": { allow: ["*"] } # IGNORED
      "*": { deny: ["*"] } # Only this applies
```

## Group Instructions

Inject behavioral guidance based on sender:

```yaml
groups:
  close_friends:
    members: [alice, bob]
    instructions: |
      This is a close friend. Be casual.
      Share calendar details directly.
```

Instructions appear in the system prompt when a group member messages.

## Contact Context

When a registered contact messages, the LLM sees trusted metadata:

```json
{
  "contact": {
    "name": "Alice Smith",
    "groups": ["close_friends"],
    "verified": true,
    "is_owner": false
  }
}
```

## Priority Order

1. Direct phone match in `toolsBySender` (highest)
2. First matching `@group` reference (config order)
3. Entry-level `tools` override group-level
4. Wildcard `"*"` (lowest)

## Configuration Reference

### Contact Entry

```yaml
contacts:
  entries:
    <key>:
      phone: "+15551234567" # Required, E.164
      name: "Display Name" # Optional
      email: "a@example.com" # Optional
      tools: # Optional, overrides group
        allow: [...]
        deny: [...]
```

### Contact Group

```yaml
contacts:
  groups:
    <name>:
      members: [alice, "+15559999999"] # Keys or inline phones
      tools:
        allow: [...]
        deny: [...]
      instructions: "..." # Injected into prompt
```

### toolsBySender

```yaml
channels:
  <channel>:
    verified: true
    toolsBySender:
      "<phone>": { allow: [...] }
      "@<group>": {} # Inherits group tools
      "*": { deny: ["*"] } # Fallback
```

## Example: Tiered Access

```yaml
contacts:
  entries:
    spouse: { phone: "+15551111111", name: "Pat" }
    coworker: { phone: "+15552222222", name: "Alex" }

  groups:
    family:
      members: [spouse]
      tools: { allow: ["*"] }
    work:
      members: [coworker]
      tools:
        allow: ["exec:gog calendar freebusy*", "web_search"]

channels:
  whatsapp:
    toolsBySender:
      "+15550000001": { allow: ["*"] } # You
      "@family": {}
      "@work": {}
      "*": { deny: ["*"] }
```

## Troubleshooting

### Tools not working for a contact

1. Check `verified: true` on channel
2. Verify E.164 format (`+15551234567`)
3. Check group membership
4. Look for conflicting `deny` rules

### Contact not recognized

1. Phone must match exactly (with country code)
2. Group name must match `contacts.groups` key
3. Entry key in `members` must match `contacts.entries` key

### Instructions not appearing

1. Only verified channels inject instructions
2. Sender must be in the group
3. Gateway must be running updated code
