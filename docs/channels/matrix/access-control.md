---
summary: "DM and room policy, allowlists, bot-to-bot traffic, and command authorization"
read_when:
  - Deciding who may DM the bot or talk to it in a Matrix room
  - Debugging a Matrix room where the bot stays silent
  - Allowing traffic between two OpenClaw Matrix accounts
title: "Matrix access control"
sidebarTitle: "Access control"
---

Who may reach OpenClaw through Matrix, which supplemental context it keeps, and which senders may run commands.

## Bot-to-bot rooms

By default, Matrix messages from other configured OpenClaw Matrix accounts are ignored. Use `allowBots` to intentionally allow inter-agent traffic:

```json5
{
  channels: {
    matrix: {
      allowBots: "mentions", // true | "mentions"
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

- `allowBots: true` accepts messages from other configured Matrix bot accounts in allowed rooms and DMs.
- `allowBots: "mentions"` accepts those messages only when they visibly mention this bot in rooms; DMs are still allowed regardless.
- `groups.<room>.allowBots` overrides the account-level setting for one room.
- Accepted configured-bot messages use shared [bot loop protection](/channels/bot-loop-protection). Configure `channels.defaults.botLoopProtection`, then override per-account with `channels.matrix.botLoopProtection` or per-room with `channels.matrix.groups.<room>.botLoopProtection`.
- OpenClaw still ignores messages from the same Matrix user ID to avoid self-reply loops.
- Matrix has no native bot flag; OpenClaw treats "bot-authored" as "sent by another configured Matrix account on this OpenClaw gateway".

Use strict room allowlists and mention requirements when enabling bot-to-bot traffic in shared rooms.

## Context visibility

Matrix supports the shared `contextVisibility` control for supplemental room context such as fetched reply text, thread roots, and pending history.

- `contextVisibility: "all"` is the default. Supplemental context is kept as received.
- `contextVisibility: "allowlist"` filters supplemental context to senders allowed by the active room/user allowlist checks.
- `contextVisibility: "allowlist_quote"` behaves like `allowlist`, but still keeps one explicit quoted reply.

This affects supplemental context visibility only, not whether the inbound message itself can trigger a reply. Trigger authorization still comes from `groupPolicy`, `groups`, `groupAllowFrom`, and DM policy settings.

## DM and room policy

```json5
{
  channels: {
    matrix: {
      dm: {
        policy: "allowlist",
        allowFrom: ["@admin:example.org"],
        threadReplies: "off",
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": { requireMention: true },
      },
    },
  },
}
```

To silence DMs entirely while keeping rooms working, set `dm.enabled: false`:

```json5
{
  channels: {
    matrix: {
      dm: { enabled: false },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
    },
  },
}
```

See [Groups](/channels/groups) for mention-gating and allowlist behavior.

Pairing example for Matrix DMs:

```bash
openclaw pairing list matrix
openclaw pairing approve matrix <CODE>
```

If an unapproved Matrix user keeps messaging before approval, OpenClaw reuses the same pending pairing code and may send a reminder reply after a short cooldown instead of minting a new code.

See [Pairing](/channels/pairing) for the shared DM pairing flow and storage layout.

## Slash commands

Slash commands (`/new`, `/reset`, `/model`, `/agents`, `/session`, `/acp`, `/approve`, etc.) work directly in DMs. In rooms, OpenClaw also recognizes commands prefixed with the bot's own Matrix mention, so `@bot:server /new` triggers the command path without a custom mention regex - this keeps the bot responsive to the room-style `@mention /command` posts that Element and similar clients emit when a user tab-completes the bot before typing the command.

Authorization rules still apply: command senders must satisfy the same DM or room allowlist/owner policies as plain messages.
