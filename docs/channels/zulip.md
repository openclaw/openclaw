---
summary: "Zulip bot support, routing model, targets, and configuration"
read_when:
  - You want to set up the Zulip channel
  - You are configuring Zulip topics, widgets, or exec approvals
  - You need the supported Zulip target formats
title: "Zulip"
---

# Zulip

Status: ready for DMs and stream topics via the Zulip API.

## Quick setup

Zulip support lives in the `extensions/zulip` plugin. Configure a bot email, API key, and base URL for the account you want OpenClaw to use.

```json5
{
  channels: {
    zulip: {
      enabled: true,
      baseUrl: "https://chat.example.com",
      botEmail: "openclaw-bot@example.com",
      botApiKey: "YOUR_ZULIP_BOT_API_KEY",
      requireMention: true,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },
}
```

If you run multiple Zulip bots, use `channels.zulip.accounts.<accountId>`.

```json5
{
  channels: {
    zulip: {
      accounts: {
        ops: {
          enabled: true,
          baseUrl: "https://chat.example.com",
          botEmail: "ops-bot@example.com",
          botApiKey: "YOUR_API_KEY",
        },
        research: {
          enabled: true,
          baseUrl: "https://chat.example.com",
          botEmail: "research-bot@example.com",
          botApiKey: "YOUR_API_KEY",
        },
      },
    },
  },
}
```

## Runtime model

- DMs route back to the originating DM conversation.
- Stream replies route by `stream + topic`.
- Each topic can bind to its own session lifecycle when `threadBindings.enabled` is on.
- Draft streaming is supported.
- Interactive callback buttons are supported when `widgetsEnabled: true` and the server runs the Lionroot Zulip fork with `ocform`.

## Target formats

OpenClaw accepts these Zulip targets for outbound delivery:

- `stream:STREAM:topic:TOPIC`
- `dm:USER_ID`
- `dm:EMAIL`

Examples:

```text
stream:engineering:topic:deploys
dm:12345
dm:owner@example.com
```

For DMs, OpenClaw resolves numeric IDs directly and can also resolve exact email addresses. Shared directory-backed resolution also supports exact local-part and exact full-name matching when the result is unique.

## Access control and stream overrides

Common controls:

- `dmPolicy`: DM behavior (`pairing`, `allowlist`, `open`)
- `allowFrom`: DM allowlist entries (user IDs, emails, or `*`)
- `groupPolicy`: stream behavior
- `groupAllowFrom`: stream sender allowlist
- `streams`: per-stream overrides, currently `requireMention`

Example:

```json5
{
  channels: {
    zulip: {
      requireMention: true,
      allowFrom: ["owner@example.com"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["ops@example.com", 12345],
      streams: {
        engineering: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Topic-bound sessions

Use `threadBindings` to control when a Zulip topic keeps or rotates its bound session.

```json5
{
  channels: {
    zulip: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 168,
      },
    },
  },
}
```

Behavior:

- `enabled: true` binds active topics to topic-specific sessions
- `idleHours` rotates the binding after inactivity
- `maxAgeHours` forces rebinding even if the topic stays active
- new bindings are only created once a message actually passes mention / policy gating

## Widgets and component messages

Set `widgetsEnabled: true` to allow callback button widgets.

```json5
{
  channels: {
    zulip: {
      widgetsEnabled: true,
    },
  },
}
```

Current Zulip component support is intentionally narrow:

- markdown/text body
- heading
- callback buttons
- per-button allowed-users restrictions

When widgets are disabled or unavailable, OpenClaw falls back to plain markdown/text.

## Exec approvals

Zulip can own exec approval prompts directly. Approvals can go to approver DMs, the active session target, both, or a shared approval stream.

```json5
{
  channels: {
    zulip: {
      widgetsEnabled: true,
      execApprovals: {
        enabled: true,
        approvers: ["owner@example.com", 12345],
        target: "stream",
        stream: "ops-approvals",
        topic: "exec-review",
        cleanupAfterResolve: true,
      },
    },
  },
}
```

Relevant fields:

- `approvers`: Zulip user IDs or resolvable user identities
- `target`: `dm`, `session`, `both`, or `stream`
- `stream`: required when `target: "stream"`
- `topic`: optional topic for shared approval posts; defaults to `exec-approvals`
- `cleanupAfterResolve`: collapse resolved/expired prompts to a short status update

## Model picker and commands

Zulip supports text commands and button-first model selection flows. The shared command backend still owns the actual model change; Zulip adds transport UX on top.

Common commands:

- `/model`
- `/model list`
- `/models`
- `/status`

## Troubleshooting

- If buttons do not appear, confirm `widgetsEnabled: true` and that the server is running the Zulip fork with `ocform`.
- If DM sends by email fail, confirm the email uniquely resolves to a Zulip user visible to the bot.
- If a stream does not respond, check `groupPolicy`, `groupAllowFrom`, and `requireMention` / per-stream mention overrides.
- If a topic starts a fresh session unexpectedly, check `threadBindings.idleHours` and `threadBindings.maxAgeHours`.
