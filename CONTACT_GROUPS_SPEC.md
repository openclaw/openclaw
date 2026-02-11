# Contact Groups Specification

## Problem Statement

Managing tool permissions and instructions for contacts currently requires:

1. **Duplicating phone numbers** across multiple config locations (`toolsBySender`, workspace files)
2. **No single source of truth** — adding a contact means updating multiple places
3. **No grouping** — can't say "all close friends get these permissions"
4. **Brittle maintenance** — phone number typos, forgotten updates, inconsistencies

### Example of Current Pain

```yaml
# In config
channels:
  whatsapp:
    toolsBySender:
      "+15551234567": { allow: ["calendar", "web_search"] }
      "+15559876543": { allow: ["calendar", "web_search"] } # Same permissions, duplicated
      "+15555555555": { allow: ["calendar", "web_search"] } # And again...
```

```markdown
# In SCHEDULING.md - duplicated again!

| Name  | Phone           |
| ----- | --------------- |
| Alice | +1 555-123-4567 |
| Bob   | +1 555-987-6543 |
```

When you add a new friend, you must update both. When permissions change, you update N entries.

---

## Solution: Contact Registry with Groups

### Design Goals

1. **Single source of truth** — define contacts once, reference everywhere
2. **Group-based policies** — apply permissions to groups, not individuals
3. **Predictable resolution** — clear rules for overlapping group membership
4. **Backward compatible** — existing phone-based `toolsBySender` still works

### Config Structure

```yaml
contacts:
  # Individual contact entries (the registry)
  entries:
    alice:
      phone: "+15551234567"
      name: "Alice Smith"
      notes: "College friend, lives in NYC"
    bob:
      phone: "+15559876543"
      name: "Bob Jones"
    charlie:
      phone: "+15555555555"
      name: "Charlie Brown"

  # Groups reference entries by key
  groups:
    close_friends:
      members: [alice, bob, charlie]
      tools:
        allow: ["exec:gog calendar*", "web_search", "web_fetch"]
      instructions: |
        Close friends. Be casual, no formal scheduling.

    family:
      members: [alice] # Alice is both friend and family
      tools:
        allow: ["*"] # Family gets full access

channels:
  whatsapp:
    toolsBySender:
      "@family": {} # References group, inherits group tools
      "@close_friends": {} # Second priority
      "*": { deny: ["*"] } # Everyone else denied
```

---

## Resolution Rules

### 1. Group Reference Expansion

When `toolsBySender` contains a key starting with `@`, it's a group reference:

```
"@close_friends" → lookup contacts.groups.close_friends
                 → expand members to phone numbers
                 → apply group's tools policy to each
```

### 2. Policy Inheritance

```
Entry-level tools  >  Group-level tools  >  toolsBySender inline policy
(most specific)       (group default)       (at reference site)
```

Example:

```yaml
contacts:
  entries:
    alice:
      phone: "+15551234567"
      tools: { allow: ["*"] } # Entry-level override
  groups:
    friends:
      members: [alice]
      tools: { allow: ["web_search"] } # Group default

channels:
  whatsapp:
    toolsBySender:
      "@friends": { allow: ["calendar"] } # Reference-site policy
```

Alice gets `["*"]` because entry-level beats group-level.

### 3. Multiple Group Membership

When a contact is in multiple groups, **first match in toolsBySender order wins**:

```yaml
toolsBySender:
  "@family": { allow: ["*"] } # Checked first
  "@close_friends": { allow: [...] } # Checked second
  "*": { deny: ["*"] }
```

If Alice is in both `family` and `close_friends`, she matches `@family` first → full access.

**Why first-match?**

- Simple and predictable
- Matches existing wildcard `"*"` behavior
- Config order = priority order (no hidden rules)
- Easy to reason about: "put more privileged groups first"

### 4. Inline Phone Numbers Still Work

You can mix group references and direct phone numbers:

```yaml
toolsBySender:
  "@family": {}
  "+15559999999": { allow: ["web_search"] } # One-off, not in any group
  "@friends": {}
  "*": { deny: ["*"] }
```

### 5. Inline Members in Groups

Groups can include entry references OR inline phone numbers:

```yaml
groups:
  vips:
    members:
      - alice # Reference to entries.alice
      - "+15550001111" # Inline phone (no entry needed)
```

---

## Context Injection

When a message arrives, the resolved contact info can be injected into prompt context:

```typescript
// Resolved at message time
{
  sender: {
    phone: "+15551234567",
    name: "Alice Smith",
    entry: "alice",
    groups: ["close_friends", "family"],
    instructions: "Close friends. Be casual..."
  }
}
```

This allows workspace files (like SCHEDULING.md) to reference contact info without hardcoding:

```markdown
## Scheduling Rules

{{#if sender.groups.includes("close_friends")}}
Be casual. No Zoom. No formal booking.
{{else}}
Use standard scheduling protocol.
{{/if}}
```

Or simpler — just document that close friends are defined in config:

```markdown
Close friends are defined in `config.contacts.groups.close_friends`.
For close friends: be casual, no Zoom, no formal booking.
```

---

## Implementation Plan

### Files to Create/Modify

1. **`src/config/types.contacts.ts`** (new)
   - `ContactEntry` type
   - `ContactGroup` type
   - `ContactsConfig` type

2. **`src/config/zod-schema.contacts.ts`** (new)
   - Zod schemas for validation

3. **`src/config/schema.ts`**
   - Add `contacts` to root config

4. **`src/config/group-policy.ts`**
   - `expandGroupReference()` — resolve `@group` to phone list
   - `resolveContactTools()` — entry > group > inline precedence
   - Modify `resolveToolsBySender()` to handle `@` prefixed keys

5. **`src/config/group-policy.test.ts`**
   - Group expansion tests
   - Overlap resolution tests
   - Entry-level override tests

6. **`src/agents/pi-tools.ts`** (optional)
   - Inject sender context into prompt

### Migration

Existing configs continue to work unchanged. Group references are opt-in.

---

## Security Considerations

1. **Phone number privacy** — Contact entries may contain PII. Config files should be treated as sensitive.

2. **Group membership leakage** — The `instructions` field is injected into prompts. Don't include sensitive info that shouldn't be visible to the LLM.

3. **Verification still applies** — Group-based policies only apply on verified channels (WhatsApp, iMessage, Signal). SMS senders don't get group privileges.

---

## Examples

### Minimal Setup

```yaml
contacts:
  groups:
    trusted:
      members: ["+15551234567", "+15559876543"]
      tools: { allow: ["*"] }

channels:
  whatsapp:
    toolsBySender:
      "@trusted": {}
      "*": { deny: ["*"] }
```

### Full Setup with Entries

```yaml
contacts:
  entries:
    spouse:
      phone: "+15551111111"
      name: "Partner Name"
    sister:
      phone: "+15552222222"
      name: "Sister Name"
    friend1:
      phone: "+15553333333"
      name: "Friend One"

  groups:
    family:
      members: [spouse, sister]
      tools: { allow: ["*"] }
      instructions: "Family members. Full access, casual tone."

    close_friends:
      members: [friend1]
      tools:
        allow: ["exec:gog calendar freebusy*", "exec:gog calendar events*", "web_search"]
      instructions: "Close friends. Casual scheduling, no Zoom."

channels:
  whatsapp:
    verified: true
    toolsBySender:
      "@family": {}
      "@close_friends": {}
      "*": { deny: ["*"] }
```

---

## Future Extensions

1. **Contact sync** — Import from Google Contacts, Apple Contacts
2. **Dynamic groups** — Groups based on rules (e.g., "anyone who's messaged in last 30 days")
3. **Per-contact model** — Different models for different contacts
4. **Contact-specific prompts** — Full system prompt overrides per contact/group
