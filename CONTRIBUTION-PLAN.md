# Contribution Plan: WhatsApp Link Preview Security Fix

**Issue:** Data exfiltration via URL previews in WhatsApp channel
**Reference:** https://www.promptarmor.com/resources/llm-data-exfiltration-via-url-previews-(with-openclaw-example-and-test)

## Problem Summary

When an AI agent outputs a URL in a WhatsApp message, WhatsApp automatically generates a link preview by making an HTTP request to that URL. If an attacker can trick the agent (via prompt injection) into outputting a URL with sensitive data in the query params, the data is exfiltrated without user interaction.

**Telegram already has this fix:** `channels.telegram.linkPreview: false`
**WhatsApp needs the same protection.**

---

## Files to Modify

### 1. Type Definitions

**File:** `src/config/types.whatsapp.ts`

Add to `WhatsAppConfig`:

```typescript
/** Controls whether link previews are shown in outbound messages. Default: true. */
linkPreview?: boolean;
```

Add to `WhatsAppAccountConfig`:

```typescript
/** Controls whether link previews are shown in outbound messages. Default: true. */
linkPreview?: boolean;
```

### 2. Zod Schema Validation

**File:** `src/config/zod-schema.providers-whatsapp.ts`

Add to `WhatsAppAccountSchema`:

```typescript
linkPreview: z.boolean().optional(),
```

Add to `WhatsAppConfigSchema`:

```typescript
linkPreview: z.boolean().optional(),
```

### 3. Send API Implementation

**File:** `src/web/inbound/send-api.ts`

Modify `createWebSendApi` to accept linkPreview config and pass to Baileys:

```typescript
// In sendMessage function, update the text payload:
} else {
  // When linkPreview is false, disable preview generation
  payload = linkPreviewEnabled
    ? { text }
    : { text, linkPreview: null };  // Baileys: null disables preview
}
```

### 4. Config Resolution

**File:** `src/web/inbound/monitor.ts` (or where send-api is initialized)

Pass the linkPreview config from the resolved account config to createWebSendApi.

### 5. Documentation

**File:** `docs/channels/whatsapp.md`

Add documentation:

````markdown
### Link Preview Security

By default, WhatsApp generates previews for URLs in messages. This can be a
security risk with AI agents (see [PromptArmor advisory](https://www.promptarmor.com/...)).

To disable link previews:

```json
{
  "channels": {
    "whatsapp": {
      "linkPreview": false
    }
  }
}
```
````

````

---

## Tasks Checklist

### Phase 1: Types & Schema (Low risk, easy to test)
- [ ] **Task 1.1:** Add `linkPreview?: boolean` to `WhatsAppConfig` type
- [ ] **Task 1.2:** Add `linkPreview?: boolean` to `WhatsAppAccountConfig` type
- [ ] **Task 1.3:** Add `linkPreview: z.boolean().optional()` to `WhatsAppAccountSchema`
- [ ] **Task 1.4:** Add `linkPreview: z.boolean().optional()` to `WhatsAppConfigSchema`

### Phase 2: Implementation (Core logic)
- [ ] **Task 2.1:** Modify `createWebSendApi` to accept linkPreview param
- [ ] **Task 2.2:** Update text message payload to disable preview when `linkPreview: false`
- [ ] **Task 2.3:** Wire up config resolution to pass linkPreview to send API

### Phase 3: Tests
- [ ] **Task 3.1:** Add unit test for config schema accepting linkPreview
- [ ] **Task 3.2:** Add unit test for send-api respecting linkPreview setting
- [ ] **Task 3.3:** Run existing WhatsApp tests to ensure no regression

### Phase 4: Documentation & PR
- [ ] **Task 4.1:** Update docs/channels/whatsapp.md
- [ ] **Task 4.2:** Create PR with security context

---

## Testing Strategy

### Local Testing
```bash
# Build
pnpm install
pnpm build

# Run type check
pnpm check

# Run all tests
pnpm test

# Run only WhatsApp-related tests
pnpm test -- --grep whatsapp
````

### Manual Testing

1. Set `channels.whatsapp.linkPreview: false` in config
2. Send a message containing a URL
3. Verify WhatsApp doesn't show a link preview

### E2E Test with AITextRisk.com

1. Configure agent with `linkPreview: false`
2. Have agent output URL: `http://aitextrisk.com/test?data=SECRET`
3. Check aitextrisk.com - should NOT see preview request

---

## Branch Strategy

```bash
# Create feature branch
git checkout -b feat/whatsapp-link-preview-security

# After changes
git add .
git commit -m "feat(whatsapp): add linkPreview config to prevent data exfiltration

Adds `linkPreview` config option to WhatsApp channel (matching Telegram).
When set to false, disables link preview generation for outbound messages,
preventing potential data exfiltration via prompt injection attacks.

Refs: promptarmor.com/resources/llm-data-exfiltration-via-url-previews"

# Push to fork
git push origin feat/whatsapp-link-preview-security
```

---

## PR Description Template

```markdown
## Summary

Adds `linkPreview` configuration option to WhatsApp channel to mitigate data exfiltration risk via URL previews.

## Problem

Messaging apps like WhatsApp automatically generate link previews, which involves making HTTP requests to URLs in messages. When combined with AI agents that can be manipulated via prompt injection, this creates a data exfiltration vector where sensitive information can be leaked via crafted URLs.

Reference: [PromptArmor Advisory](<https://www.promptarmor.com/resources/llm-data-exfiltration-via-url-previews-(with-openclaw-example-and-test)>)

## Solution

- Add `linkPreview: boolean` config option to WhatsApp channel (default: true for backwards compatibility)
- When `linkPreview: false`, disable preview generation in outbound messages
- Mirrors existing Telegram implementation (`channels.telegram.linkPreview`)

## Testing

- [x] Unit tests for config schema
- [x] Unit tests for send-api behavior
- [x] Existing WhatsApp tests pass
- [ ] Manual verification with aitextrisk.com

## AI-Assisted

This PR was developed with AI assistance (Claude). The contributor understands the code and has tested it.
```

---

## Questions for Arnab

1. **Ready to start?** We can begin with Phase 1 (types/schema) - safest changes
2. **Node.js version?** Need Node 18+ and pnpm for building
3. **Can run tests?** Some tests may need WhatsApp credentials mocked

Let me know when you want to start implementing!
