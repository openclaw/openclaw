---
summary: "Microsoft Teams Adaptive Card approvals, polls, presentation cards, member info, and targets"
read_when:
  - Sending approvals, polls, or presentation cards to Teams
  - Addressing a Teams user or conversation from the CLI or message tool
  - Resolving roster details for a Teams conversation
title: "Microsoft Teams cards and actions"
sidebarTitle: "Cards and actions"
---

The Adaptive Card surfaces OpenClaw sends to Teams, the Graph-backed roster lookup, and the target formats that address them.

## Member info action

OpenClaw exposes a Graph-backed `member-info` action for Microsoft Teams so agents and automations can resolve verified roster details for a configured conversation.

Requirements:

- `ChannelSettings.Read.Group` and `TeamMember.Read.Group` RSC permissions (already in the recommended manifest).

The action is available whenever Graph credentials are configured; there is no separate `channels.msteams.actions.memberInfo` toggle.
Standard-channel lookups return the matching team-roster identity, display name, email, and roles.
In the current DM or group chat, the action can return the trusted sender's stable user ID.
Private/shared-channel and non-current chat member lookups require additional roster permissions
and are rejected by the default permission baseline.

## Native approval cards

Microsoft Teams can deliver exec and plugin approval requests as Adaptive Cards in the originating conversation. Each card describes the requested command or plugin action and provides only the decisions allowed for that request, such as **Approve once**, **Always allow**, and **Deny**. After a decision or expiration, OpenClaw updates the original card with its final status.

Enable the existing top-level approval forwarding settings for each approval type you want to receive:

```json5
{
  approvals: {
    exec: { enabled: true, mode: "session" },
    plugin: { enabled: true, mode: "session" },
  },
  channels: {
    msteams: {
      allowFrom: ["00000000-0000-0000-0000-000000000000"],
    },
  },
}
```

`approvals.exec` and `approvals.plugin` are independent; enabling one does not enable the other. Native card delivery also requires a configured Teams bot and at least one approver resolved from `channels.msteams.allowFrom` or `channels.msteams.defaultTo`. Approvers must be stable AAD object IDs; display names, email addresses, group entries, and conversation IDs do not grant approval access. OpenClaw checks the clicking user's AAD object ID before resolving the request.

No Teams-specific approval configuration is required. The existing `/approve <id> <decision>` command remains available as a text fallback when native delivery is unavailable. For forwarding modes and supported decisions, see [Approval forwarding to chat channels](/tools/exec-approvals-advanced#approval-forwarding-to-chat-channels).

## Polls (Adaptive Cards)

OpenClaw sends Teams polls as Adaptive Cards (there is no native Teams poll API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> --poll-question "..." --poll-option "..." --poll-option "..."`.
- Votes are recorded by the gateway in OpenClaw plugin-state SQLite under `state/openclaw.sqlite`.
- Existing `msteams-polls.json` files are imported by `openclaw doctor --fix`, not by the running plugin.
- The gateway must stay online to record votes.
- Polls do not auto-post result summaries, and there is no poll-results CLI yet.

## Presentation cards

Send semantic presentation payloads to Teams users or conversations using the `message` tool, CLI, or normal reply delivery. OpenClaw renders them as Teams Adaptive Cards from the generic presentation contract.

The `presentation` parameter accepts semantic blocks. When `presentation` is provided, the message text is optional. Buttons render as Adaptive Card submit or URL actions. Select menus are not native in the Teams renderer, so OpenClaw downgrades them to readable text before delivery.

**Agent tool:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:<id>",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello!" }],
  },
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello!"}]}'
```

For target format details, see [Target formats](#target-formats) below.

## Target formats

MSTeams targets use prefixes to distinguish between users and conversations:

| Target type         | Format                           | Example                                                                                                |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                                                            |
| User (by name)      | `user:<display-name>`            | `user:John Smith` (requires Graph API)                                                                 |
| Group/channel       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                                               |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2`, `19:...@unq.gbl.spaces`, or a bare `a:`/`8:orgid:`/`29:` Bot Framework id |

**CLI examples:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send a presentation card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello"}]}'
```

**Agent tool examples:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:John Smith",
  message: "Hello!",
}
```

```json5
{
  action: "send",
  channel: "msteams",
  target: "conversation:19:abc...@thread.tacv2",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
  },
}
```

<Note>
Without the `user:` prefix, names default to group or team resolution. Always use `user:` when targeting people by display name.
</Note>

## Proactive messaging

- Proactive messages are only possible **after** a user has interacted, because OpenClaw stores conversation references at that point.
- See [/gateway/configuration](/gateway/configuration) for `dmPolicy` and allowlist gating.
