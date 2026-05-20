# WhatsApp `open-except` DM Policy

**Date:** 2026-05-20
**Status:** Approved

## Summary

Add a new `dmPolicy` value `"open-except"` to the WhatsApp plugin. When active, OpenClaw replies to all incoming DMs **except** contacts listed in a new `manualFrom` field. Those contacts are fully silenced (no reply, no read receipt, no processing). The `manualFrom` list is managed via WhatsApp self-chat by sending a command (`add` or `rm`) alongside a vCard contact attachment.

## Motivation

The existing policies require either a pairing challenge per unknown contact (`"pairing"`) or a pre-approved allowlist (`"allowlist"`). Neither fits the use case where the user wants OpenClaw to handle most contacts automatically while reserving a specific set of contacts for manual replies.

---

## Section 1: Config Schema

New `dmPolicy` value added to the existing union:

```
dmPolicy: "pairing" | "allowlist" | "open" | "open-except" | "disabled"
```

New field added alongside `allowFrom`:

```
manualFrom: string[]   // defaults to []
```

`manualFrom` is only meaningful when `dmPolicy: "open-except"`. It accepts phone numbers in any normalized form (e.g., `"+5511999988888"`, `"5511999988888"`).

Both fields work at global level (`channels.whatsapp`) and per-account level (`channels.whatsapp.accounts.<accountId>`), consistent with all other access-control fields.

**Files:**
- `src/config/zod-schema.providers-whatsapp.ts` — add `"open-except"` to `dmPolicy` union, add `manualFrom` field
- `extensions/whatsapp/src/config-schema.ts` — mirror schema changes if needed

---

## Section 2: Access Control

In `extensions/whatsapp/src/inbound/access-control.ts`, add a new branch in the DM policy check:

```
if dmPolicy === "open-except":
  if sender is in manualFrom (normalized match):
    return { allowed: false, shouldMarkRead: false }   // fully silent
  else:
    return { allowed: true }                            // handle normally
```

Phone number normalization applies the same logic already used for `allowFrom`: strips `+`, handles `@s.whatsapp.net` JID suffix, so `+55 11 9999-8888`, `5511999988888`, and the WhatsApp JID all match the same entry.

**Files:**
- `extensions/whatsapp/src/inbound/access-control.ts`
- `extensions/whatsapp/src/inbound-policy.ts` (if policy resolution lives there)

---

## Section 3: vCard Command Handler

A new handler in `extensions/whatsapp/src/inbound/` watches **self-chat** (from-me messages to own number) for messages containing both a text command and a vCard contact attachment.

### Trigger conditions

- Message is from-me (sent by the account owner)
- Message target is self-chat (own JID)
- Message contains a vCard (`contactMessage`) attachment
- Message caption/text matches `add` or `rm` (case-insensitive, trimmed)

### Commands

| Command | Effect | Reply |
|---------|--------|-------|
| `add` + vCard | Add contact's number to `manualFrom` | `"Added +55119... to manual list"` |
| `rm` + vCard | Remove contact's number from `manualFrom` | `"Removed +55119... from manual list"` |

### Edge cases

- `add` when already in list → reply `"Already in manual list"`
- `rm` when not in list → reply `"Not in manual list"`
- vCard with no recognized command → silently ignored
- `selfChatMode: false` → handler no-ops, logs warning once
- `configWrites: false` → handler no-ops, logs warning once

### vCard parsing

Phone number is extracted from the vCard `TEL` field, preferring the `waid=` parameter when present (this is the WhatsApp-internal number, most reliable). Falls back to normalizing the raw `TEL` value.

**Files:**
- `extensions/whatsapp/src/inbound/vcard-command-handler.ts` (new file)
- `extensions/whatsapp/src/inbound/monitor.ts` — wire up handler

---

## Section 4: Config Persistence

The handler writes back to the config path for the specific account that received the self-chat message:

- Single-account: `channels.whatsapp.manualFrom`
- Multi-account: `channels.whatsapp.accounts.<accountId>.manualFrom`

Uses the existing `configWrites` mechanism already present in the plugin — no new write path needed.

**Startup notice:** If `dmPolicy: "open-except"` is set but `manualFrom` is empty or missing, OpenClaw logs an info-level message: `"dmPolicy is open-except but manualFrom is empty — all DMs will be handled"`. Not an error.

**Files:**
- `extensions/whatsapp/src/inbound/vcard-command-handler.ts` — uses existing config-write helper

---

## Testing

- Unit tests for `access-control.ts`: new `"open-except"` branch, normalized phone matching
- Unit tests for `vcard-command-handler.ts`: `add`/`rm` commands, edge cases (already present, not present, no command, wrong event source)
- Config schema tests: `"open-except"` accepted, `manualFrom` defaults to `[]`

---

## Requirements Summary

| Requirement | Detail |
|---|---|
| `selfChatMode: true` | Required for vCard command handler |
| `configWrites: true` | Required for vCard command handler |
| `dmPolicy: "open-except"` | Enables the new behavior |
| `manualFrom: []` | Populated via self-chat commands |
