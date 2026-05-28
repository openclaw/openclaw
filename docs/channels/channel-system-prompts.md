---
summary: "Per-channel system prompt overlays injected automatically at session start and compaction rebuild"
read_when:
  - You want a channel to have a persistent role or context that survives session resets
  - Your agent keeps losing its instructions after /new, /reset, or compaction
title: "Channel System Prompts"
---

# Channel System Prompts

OpenClaw lets you map an exact chat channel to a prompt file. The file's
contents are automatically prepended to the assembled system prompt every time
the agent starts or rebuilds a session for that channel. This includes:

- New sessions created by `/new`
- Sessions reset by `/reset`
- Context rebuilds triggered by `/compact` or overflow compaction

No model-side logic is required. The runtime reads the file and injects the
content before the model sees the turn.

## When to use this

Use a channel system prompt when a specific chat channel should always
represent a specific role or domain — for example a `#data-team` channel where
the agent should always introduce itself as the analytics assistant, or a
`#ops` channel where the agent should always follow the incident playbook.

Before this feature, users often reset sessions with `/new` to keep the
context window small, then had to re-state the channel role every time. This
removes that repetition.

## Configuration

Add a `systemPromptByChannel` map under the channel plugin's section of your
`openclaw` config. The outer key is the channel plugin id (for example
`slack`, `discord`, `telegram`). The inner key is the exact conversation id
as your plugin reports it at runtime — the same value used elsewhere in the
runtime as `currentChannelId`.

```yaml
channels:
  slack:
    systemPromptByChannel:
      "C1234567890": "prompts/analytics.md"
      "C9876543210": "prompts/ops.md"
  discord:
    systemPromptByChannel:
      "111111111111111111": "prompts/general.md"
      "222222222222222222": "prompts/support.md"
  telegram:
    systemPromptByChannel:
      "-1001234567890": "prompts/team.md"
```

Each entry is exact-match only. There is no fallback, no wildcard matching,
and no inheritance between channels. Channels that are not listed get no
injection.

## Path resolution

Relative paths resolve against the agent workspace directory. Absolute paths
are used as-is. `~` and `$HOME` expand before resolution.

| Config value                   | Resolves to                           |
| ------------------------------ | ------------------------------------- |
| `"prompts/analytics.md"`       | `<workspaceDir>/prompts/analytics.md` |
| `"/etc/openclaw/prompts/x.md"` | `/etc/openclaw/prompts/x.md`          |
| `"~/prompts/x.md"`             | `<home>/prompts/x.md`                 |

## Channels vs. sessions

The prompt is channel-scoped, not session-scoped. OpenClaw does not store the
resolved prompt inside the session file, so:

- Editing a prompt file takes effect on the next session start or compaction
  rebuild, without migrating any existing session state.
- One long-lived agent serving multiple channels uses each channel's own
  prompt automatically — the lookup is resolved on every system prompt
  assembly.
- Sessions that are not tied to any channel (pure CLI, ambient runs) get no
  channel prompt, which is expected.

## Missing-file behavior

If a configured prompt file is missing or unreadable, OpenClaw logs a warning
and proceeds with the base system prompt for that turn. The agent continues
to function; the channel role is simply absent. This is intentional — a typo
should never block the turn. Fix the file path or the file itself and the
next session start or compaction rebuild picks up the corrected prompt.

## Composition with other system prompts

When a session already has an `extraSystemPrompt` (for example from
`--system-prompt` CLI flags or a session-level setup hook), the channel
prompt is prepended to it, separated by a blank line:

```
<channel prompt contents>

<existing extraSystemPrompt>
```

The channel prompt provides the outer frame; per-session extras refine inside
that frame.

## Finding your channel id

The conversation id is whatever your channel plugin uses at runtime. You can
find it in the structured logs when a message arrives (look for
`currentChannelId` or the channel's own log lines), or by checking the
channel plugin's docs:

- [Slack](/channels/slack) uses channel ids like `C1234567890`.
- [Discord](/channels/discord) uses numeric snowflake ids.
- [Telegram](/channels/telegram) uses chat ids, including negative ids for
  groups and channels.
- [Matrix](/channels/matrix) uses room ids like `!room:server.example`.

Paste the exact id as the inner key; OpenClaw does not normalize or parse it.

## Scope

This feature is intentionally minimal. It does not support:

- Default or wildcard prompts across channels
- Per-sender or per-user overrides
- Hot-reload on file change mid-session (changes take effect at the next
  rebuild)
- Template interpolation of runtime values

If you need any of these, they are tracked as potential follow-up features
and can be layered on top of this base mapping.
