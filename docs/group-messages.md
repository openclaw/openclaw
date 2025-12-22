---
summary: "Behavior and config for WhatsApp group message handling"
read_when:
  - Changing group message rules or mentions
---
# Group messages (web provider)

Goal: let Clawd sit in WhatsApp groups, wake up only when pinged, and keep that thread separate from the personal DM session.

## What’s implemented (2025-12-03)
- Activation modes: `mention` (default) or `always`. `mention` requires a ping (real WhatsApp @-mentions via `mentionedJids`, regex patterns, or the bot’s E.164 anywhere in the text). `always` wakes the agent on every message but it should reply only when it can add meaningful value; otherwise it returns the silent token `NO_REPLY`. Activation is controlled per group (command or UI), not via config.
- Group allowlist bypass: we still enforce `allowFrom` on the participant at inbox ingest, but group JIDs themselves no longer block replies.
- Per-group sessions: session keys look like `group:<jid>` so commands such as `/verbose on` or `/think:high` are scoped to that group; personal DM state is untouched. Heartbeats are skipped for group threads.
- Context injection: last N (default 50) group messages are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`.
- Sender surfacing: every group batch now ends with `[from: Sender Name (+E164)]` so Pi knows who is speaking.
- Ephemeral/view-once: we unwrap those before extracting text/mentions, so pings inside them still trigger.
- New session primer: on the first turn of a group session we now prepend a short blurb to the model like `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` If metadata isn’t available we still tell the agent it’s a group chat.

## Config for Clawd UK (+447700900123)
Add a `groupChat` block to `~/.clawdis/clawdis.json` so display-name pings work even when WhatsApp strips the visual `@` in the text body:

```json5
{
  "inbound": {
    "groupChat": {
      "historyLimit": 50,
      "mentionPatterns": [
        "@?clawd",
        "@?clawd\\s*uk",
        "@?clawdbot",
        "\\+?447700900123"
      ]
    }
  }
}
```

Notes:
- The regexes are case-insensitive; they cover `@clawd`, `@clawd uk`, `clawdbot`, and the raw number with or without `+`/spaces.
- WhatsApp still sends canonical mentions via `mentionedJids` when someone taps the contact, so the number fallback is rarely needed but is a good safety net.

### Activation command (owner-only)

Use the group chat command:
- `/activation mention`
- `/activation always`

Only the owner number (from `allowFrom`, defaulting to the bot’s own E.164 when unset) can change this. `/status` in the group shows the current activation mode.

## How to use
1) Add Clawd UK (`+447700900123`) to the group.
2) Say `@clawd …` (or `@clawd uk`, `@clawdbot`, or include the number). Anyone in the group can trigger it.
3) The agent prompt will include recent group context plus the trailing `[from: …]` marker so it can address the right person.
4) Session-level directives (`/verbose on`, `/think:high`, `/new` or `/reset`) apply only to that group’s session; your personal DM session remains independent.

## Testing / verification
- Automated: `pnpm test -- src/web/auto-reply.test.ts --runInBand` (covers mention gating, history injection, sender suffix).
- Manual smoke:
  - Send an `@clawd` ping in the group and confirm a reply that references the sender name.
  - Send a second ping and verify the history block is included then cleared on the next turn.
- Check gateway logs (run with `--verbose`) to see `inbound web message` entries showing `from: <groupJid>` and the `[from: …]` suffix.

## Known considerations
- Heartbeats are intentionally skipped for groups to avoid noisy broadcasts.
- Echo suppression uses the combined batch string; if you send identical text twice without mentions, only the first will get a response.
- Session store entries will appear as `group:<jid>` in the session store (`~/.clawdis/sessions/sessions.json` by default); a missing entry just means the group hasn’t triggered a run yet.
