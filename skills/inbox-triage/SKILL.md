---
name: inbox-triage
description: Daily Gmail + WhatsApp triage. Pulls unread items, categorises them, drafts replies, and delivers a brief to the user's WhatsApp self-DM.
metadata: { "openclaw": { "emoji": "📥" } }
---

# Inbox triage

Use this skill once per morning (cron-driven, 07:00) or whenever the user asks
for "what's in my inbox" / "morning brief" / "any unread".

## Tool

`inbox_triage_run(deliver?: boolean, lookbackHours?: number)`

- `deliver` — whether to actually post the brief (default `true`).
- `lookbackHours` — override the configured window (default 24).

The tool pulls unread Gmail and recent WhatsApp inbound messages, sends them
to the model for categorisation, renders a Markdown brief, and (if
`deliver=true`) posts it to the configured channel/target.

## How to use

When the cron job fires, just call the tool:

```
inbox_triage_run()
```

If the user asks for the brief manually mid-day:

```
inbox_triage_run(deliver: false, lookbackHours: 6)
```

…and reply with the rendered text instead of posting it.

## Reply approval

After the brief is delivered, the user can reply on the same channel:

- `Y <id>` — sends the cached draft for that item.
- `S <id>` — skips the draft.

Drafts are kept in memory only until the next triage run, so don't promise
the user that drafts persist forever.

## Output shape

The tool returns:

```json
{
  "delivered": true,
  "gmailCount": 12,
  "whatsappCount": 4,
  "summary": "Two-sentence overview…",
  "items": [
    { "id": "...", "channel": "gmail", "from": "...", "category": "URGENT", "one_line": "...", "draft_reply": "..." }
  ]
}
```

Use `summary` and `items` if the user asks follow-ups like "what was urgent?"
— don't re-call the tool, the data is already in your context.
