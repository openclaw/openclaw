---
summary: "Zulip bot setup, stream/topic routing, and configuration"
read_when:
  - You want to connect OpenClaw to Zulip
  - You are configuring a Zulip bot for direct messages, streams, or topics
title: Zulip
---

# Zulip

Zulip is an open-source team chat platform with hosted Zulip Cloud and self-hosted deployments. The OpenClaw Zulip channel plugin connects agents to Zulip direct messages, streams, and topics.

**Status:** external plugin. Install it before enabling the channel.

---

## Install the plugin

```bash
openclaw plugins install zulip
```

Then restart the Gateway after configuration changes:

```bash
openclaw gateway restart
```

---

## Create a Zulip bot

1. In Zulip, open **Settings → Your bots**.
2. Create a new bot or choose an existing bot.
3. Copy the bot email and API key.
4. Use your Zulip organization URL as `url`, for example `https://example.zulipchat.com`.

---

## Basic configuration

```json5
{
  channels: {
    zulip: {
      enabled: true,
      url: "https://example.zulipchat.com",
      email: "openclaw-bot@example.zulipchat.com",
      apiKey: "***",
      streams: ["general"],
      dmPolicy: "allowlist",
      allowFrom: ["user@example.com"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@example.com"],
    },
  },
}
```

For development or secret-managed installs, `apiKey` can also be an OpenClaw secret reference.

---

## Streams and topics

Zulip stream messages are treated as group messages. Use `streams`, `topics`, and `streamTopics` to control which conversations the bot monitors.

```json5
{
  channels: {
    zulip: {
      streams: ["general", "support"],
      topics: ["bot help"],
      streamTopics: {
        support: ["triage", "alerts"],
      },
      requireMention: true,
    },
  },
}
```

Topic filters trim whitespace and match case-insensitively. Omit filters, use an empty array, or include `"*"` to allow all topics.

---

## Direct messages and access control

`dmPolicy` controls direct messages:

- `allowlist` only allows senders listed in `allowFrom`.
- `open` allows any direct message sender.
- `pairing` requires pairing approval.
- `disabled` disables direct messages.

`groupPolicy` controls stream messages:

- `allowlist` only allows senders listed in `groupAllowFrom`.
- `open` allows monitored stream messages.
- `disabled` disables stream messages.

Use allowlists for production bots unless the Zulip organization is already tightly controlled.

---

## Reactions

The plugin supports Zulip message reactions through OpenClaw's `message` action, including add/remove behavior and common emoji normalization.

The `agentReactionGuidance` setting controls model-level prompt guidance for expressive reactions:

```json5
{
  channels: {
    zulip: {
      agentReactionGuidance: "minimal", // "off" | "minimal" | "extensive"
    },
  },
}
```

This is separate from lifecycle/status reaction indicators.

---

## Multi-account setup

```json5
{
  channels: {
    zulip: {
      defaultAccount: "main",
      accounts: {
        main: {
          url: "https://example.zulipchat.com",
          email: "openclaw-bot@example.zulipchat.com",
          apiKey: "***",
          streams: ["general"],
        },
        ops: {
          url: "https://ops.example.com",
          email: "ops-bot@ops.example.com",
          apiKey: "***",
          streams: ["alerts"],
        },
      },
    },
  },
}
```

---

## Troubleshooting

### Bot receives DMs but does not reply in streams

Check stream policy first. Stream messages are group messages, so `groupPolicy`, `groupAllowFrom`, `requireMention`, `streams`, `topics`, and `streamTopics` can all intentionally suppress replies.

### Bot does not receive messages

Verify the bot email, API key, Zulip URL, stream subscriptions, and Gateway logs.

```bash
openclaw gateway status
openclaw logs --follow
```

### Plugin loads but durable receive journaling is unavailable

Durable inbound receive journaling requires host support for trusted plugin keyed state. The channel still operates without it, but replay behavior may be limited to the live process.

---

## Resources

- [Zulip API documentation](https://zulip.com/api/overview)
- [Zulip bots documentation](https://zulip.com/api/running-bots)
- [Plugin package](https://www.npmjs.com/package/openclaw-channel-zulip)
- [Plugin source](https://github.com/FtlC-ian/openclaw-channel-zulip)
