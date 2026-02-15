---
name: whatsapp-tools
description: WhatsApp contact sync, group management, and administrative tools via Baileys API. Use for: extracting all contacts from groups, creating groups, fetching group metadata, or any WhatsApp operation beyond basic messaging.
---

# WhatsApp Tools

Advanced WhatsApp operations using direct Baileys API access.

## Prerequisites

- WhatsApp linked via `openclaw channels login --channel whatsapp`
- Valid credentials in `~/.openclaw/credentials/whatsapp/default/`

## Contact Sync

Extract all contacts from all WhatsApp groups:

```bash
# Run from OpenClaw source root (requires dependencies)
npx tsx skills/whatsapp-tools/scripts/wa-fetch-contacts.ts
```

**Output:** `~/.openclaw/workspace/bank/whatsapp-contacts-full.json`

Contains:
- All groups with participant counts
- All contacts with phone numbers (LID-resolved)
- Group membership per contact
- Admin status

## Group Creation

Create a new WhatsApp group:

```bash
# Run from OpenClaw source root
npx tsx skills/whatsapp-tools/scripts/wa-create-group.ts "Group Name" "+phone1" "+phone2"
```

**Notes:**
- Phone numbers in E.164 format (+countrycode...)
- Creator (linked account) auto-added as admin
- Returns group JID for further operations

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/wa-fetch-contacts.ts` | Sync all contacts from all groups |
| `scripts/wa-create-group.ts` | Create new group with participants |

## How It Works

Scripts connect directly to WhatsApp via Baileys using existing OpenClaw credentials. This bypasses the gateway listener, so:
- Works even if gateway WhatsApp listener is down
- Does not affect active message monitoring
- Uses same auth state (no re-linking needed)

## Key Baileys Methods

| Method | Description |
|--------|-------------|
| `groupFetchAllParticipating()` | Get all groups + participants |
| `groupMetadata(jid)` | Get single group details |
| `groupCreate(name, participants)` | Create new group |
| `groupUpdateSubject(jid, name)` | Rename group |
| `groupUpdateDescription(jid, desc)` | Update group description |
| `groupParticipantsUpdate(jid, participants, action)` | Add/remove/promote/demote |

## LID Resolution

WhatsApp uses LIDs (Linked IDs) internally. The contact sync script automatically resolves LIDs to phone numbers using mappings stored in:
`~/.openclaw/credentials/whatsapp/default/lid-mapping-*_reverse.json`
