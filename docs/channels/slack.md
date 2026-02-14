---
summary: "Slack setup and runtime behavior (Socket Mode + HTTP Events API)"
read_when:
  - Setting up Slack or debugging Slack socket/HTTP mode
title: "Slack"
---

# Slack

Status: production-ready for DMs + channels via Slack app integrations. Default mode is Socket Mode; HTTP Events API mode is also supported.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Slack DMs default to pairing mode.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior and command catalog.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
</CardGroup>

## Quick setup

<Tabs>
  <Tab title="Socket Mode (default)">
    <Steps>
      <Step title="Create Slack app and tokens">
        In Slack app settings:

        - enable **Socket Mode**
        - create **App Token** (`xapp-...`) with `connections:write`
        - install app and copy **Bot Token** (`xoxb-...`)
      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        Env fallback (default account only):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="Subscribe app events">
        Subscribe bot events for:

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        Also enable App Home **Messages Tab** for DMs.
      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Events API mode">
    <Steps>
      <Step title="Configure Slack app for HTTP">

        - set mode to HTTP (`channels.slack.mode="http"`)
        - copy Slack **Signing Secret**
        - set Event Subscriptions + Interactivity + Slash command Request URL to the same webhook path (default `/slack/events`)

      </Step>

      <Step title="Configure OpenClaw HTTP mode">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

      </Step>

      <Step title="Use unique webhook paths for multi-account HTTP">
        Per-account HTTP mode is supported.

        Give each account a distinct `webhookPath` so registrations do not collide.
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Token model

- `botToken` + `appToken` are required for Socket Mode.
- HTTP mode requires `botToken` + `signingSecret`.
- Config tokens override env fallback.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env fallback applies only to the default account.
- `userToken` (`xoxp-...`) is config-only (no env fallback) and defaults to read-only behavior (`userTokenReadOnly: true`).

<Tip>
For actions/directory reads, user token can be preferred when configured. For writes, bot token remains preferred; user-token writes are only allowed when `userTokenReadOnly: false` and bot token is unavailable.
</Tip>

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.slack.dm.policy` controls DM access:

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `dm.allowFrom` to include `"*"`)
    - `disabled`

    DM flags:

    - `dm.enabled` (default true)
    - `dm.allowFrom`
    - `dm.groupEnabled` (group DMs default false)
    - `dm.groupChannels` (optional MPIM allowlist)

    Pairing in DMs uses `openclaw pairing approve slack <code>`.

  </Tab>

  <Tab title="Channel policy">
    `channels.slack.groupPolicy` controls channel handling:

    - `open`
    - `allowlist`
    - `disabled`

    Channel allowlist lives under `channels.slack.channels`.

    Runtime note: if `channels.slack` is completely missing (env-only setup) and `channels.defaults.groupPolicy` is unset, runtime falls back to `groupPolicy="open"` and logs a warning.

    Name/ID resolution:

    - channel allowlist entries and DM allowlist entries are resolved at startup when token access allows
    - unresolved entries are kept as configured

  </Tab>

  <Tab title="Mentions and channel users">
    Channel messages are mention-gated by default.

    Mention sources:

    - explicit app mention (`<@botId>`)
    - mention regex patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - implicit reply-to-bot thread behavior

    Per-channel controls (`channels.slack.channels.<id|name>`):

    - `requireMention`
    - `users` (allowlist)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## Commands and slash behavior

- Native command auto-mode is **off** for Slack (`commands.native: "auto"` does not enable Slack native commands).
- Enable native Slack command handlers with `channels.slack.commands.native: true` (or global `commands.native: true`).
- When native commands are enabled, register matching slash commands in Slack (`/<command>` names).
- If native commands are not enabled, you can run a single configured slash command via `channels.slack.slashCommand`.

Default slash command settings:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

Slash sessions use isolated keys:

- `agent:<agentId>:slack:slash:<userId>`

and still route command execution against the target conversation session (`CommandTargetSessionKey`).

## Threading, sessions, and reply tags

- DMs route as `direct`; channels as `channel`; MPIMs as `group`.
- With default `session.dmScope=main`, Slack DMs collapse to agent main session.
- Channel sessions: `agent:<agentId>:slack:channel:<channelId>`.
- Thread replies can create thread session suffixes (`:thread:<threadTs>`) when applicable.
- `channels.slack.thread.historyScope` default is `thread`; `thread.inheritParent` default is `false`.
- `channels.slack.thread.initialHistoryLimit` controls how many existing thread messages are fetched when a new thread session starts (default `20`; set `0` to disable).

Reply threading controls:

- `channels.slack.replyToMode`: `off|first|all` (default `off`)
- `channels.slack.replyToModeByChatType`: per `direct|group|channel`
- legacy fallback for direct chats: `channels.slack.dm.replyToMode`

Manual reply tags are supported:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

## Media, chunking, and delivery

<AccordionGroup>
  <Accordion title="Inbound attachments">
    Slack file attachments are downloaded from Slack-hosted private URLs (token-authenticated request flow) and written to the media store when fetch succeeds and size limits permit.

    Runtime inbound size cap defaults to `20MB` unless overridden by `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Outbound text and files">
    - text chunks use `channels.slack.textChunkLimit` (default 4000)
    - `channels.slack.chunkMode="newline"` enables paragraph-first splitting
    - file sends use Slack upload APIs and can include thread replies (`thread_ts`)
    - outbound media cap follows `channels.slack.mediaMaxMb` when configured; otherwise channel sends use MIME-kind defaults from media pipeline
  </Accordion>

  <Accordion title="Delivery targets">
    Preferred explicit targets:

    - `user:<id>` for DMs
    - `channel:<id>` for channels

    Slack DMs are opened via Slack conversation APIs when sending to user targets.

  </Accordion>
</AccordionGroup>

## Actions and gates

Slack actions are controlled by `channels.slack.actions.*`.

Available action groups in current Slack tooling:

| Group      | Default |
| ---------- | ------- |
| messages   | enabled |
| reactions  | enabled |
| pins       | enabled |
| memberInfo | enabled |
| emojiList  | enabled |

## Events and operational behavior

- Message edits/deletes/thread broadcasts are mapped into system events.
- Reaction add/remove events are mapped into system events.
- Member join/leave, channel created/renamed, and pin add/remove events are mapped into system events.
- `channel_id_changed` can migrate channel config keys when `configWrites` is enabled.
- Channel topic/purpose metadata is treated as untrusted context and can be injected into routing context.

## Manifest and scope checklist

<AccordionGroup>
  <Accordion title="Slack app manifest example">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "im:history",
        "mpim:history",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

  </Accordion>

  <Accordion title="Optional user-token scopes (read operations)">
    If you configure `channels.slack.userToken`, typical read scopes are:

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (if you depend on Slack search reads)

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Check, in order:

    - `groupPolicy`
    - channel allowlist (`channels.slack.channels`)
    - `requireMention`
    - per-channel `users` allowlist

    Useful commands:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="DM messages ignored">
    Check:

    - `channels.slack.dm.enabled`
    - `channels.slack.dm.policy`
    - pairing approvals / allowlist entries

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode not connecting">
    Validate bot + app tokens and Socket Mode enablement in Slack app settings.
  </Accordion>

  <Accordion title="HTTP mode not receiving events">
    Validate:

    - signing secret
    - webhook path
    - Slack Request URLs (Events + Interactivity + Slash Commands)
    - unique `webhookPath` per HTTP account

  </Accordion>

  <Accordion title="Native/slash commands not firing">
    Verify whether you intended:

    - native command mode (`channels.slack.commands.native: true`) with matching slash commands registered in Slack
    - or single slash command mode (`channels.slack.slashCommand.enabled: true`)

    Also check `commands.useAccessGroups` and channel/user allowlists.

  </Accordion>
</AccordionGroup>

## Configuration reference pointers

Primary reference:

- [Configuration reference - Slack](/gateway/configuration-reference#slack)

High-signal Slack fields:

- mode/auth: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM access: `dm.enabled`, `dm.policy`, `dm.allowFrom`, `dm.groupEnabled`, `dm.groupChannels`
- channel access: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- threading/history: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `mediaMaxMb`
- ops/features: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## Related

- [Pairing](/channels/pairing)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
- [Configuration](/gateway/configuration)
- [Slash commands](/tools/slash-commands)
