---
summary: "Zulip bot setup and OpenClaw config"
read_when:
  - Setting up Zulip
  - Debugging Zulip routing
title: "Zulip"
---

# Zulip (plugin)

Status: supported via plugin (bot email + API key + event queue). Streams/topics are supported.
Private messages and attachments are not included in the first version.

## Plugin required

Zulip ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/zulip
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/zulip
```

Details: [Plugins](/plugin)

## Quick setup

1. Create a Zulip bot and copy its API key.
2. Subscribe the bot to the stream(s) you want it to monitor (stream names do **not** include `#`).
3. Configure OpenClaw and start the gateway.

Minimal config:

```json5
{
  channels: {
    zulip: {
      enabled: true,
      baseUrl: "https://zulip.example.com",
      email: "your-bot@zulip.example.com",
      apiKey: "zulip-bot-api-key",

      // Only these streams are monitored.
      streams: ["marcel-ai"],

      // Default topic when outbound targets omit a topic.
      defaultTopic: "general chat",
    },
  },
}
```

## Reaction indicators (responding / done / failed)

By default, while OpenClaw is generating a reply, it reacts to the triggering message:

- Start: `eyes`
- Success: `check`
- Failure: `warning`

You can customize:

```json5
{
  channels: {
    zulip: {
      reactions: {
        enabled: true,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
      },
    },
  },
}
```

Note: emoji availability is server-specific. Use emoji names from your Zulip server.

## Sessions (topics → sessions)

Zulip topics map to OpenClaw sessions:

- Same stream + same topic → same session
- Different topic → different session

This keeps conversations separated per topic.

## Targets for outbound delivery

Use these target formats with `openclaw message send` (quote if there are spaces):

- `stream:<streamName>#<topic>` for a stream + topic
- `stream:<streamName>` to use `channels.zulip.defaultTopic`

Examples:

```bash
openclaw message send --channel zulip --target "stream:marcel-ai" --message "hello"
openclaw message send --channel zulip --target "stream:marcel-ai#deploy-notes" --message "ship it"
```

## Troubleshooting

- No replies: confirm the bot is subscribed to the stream and that `channels.zulip.streams` includes the stream name (without `#`).
- Auth errors: verify `baseUrl`, `email`, and `apiKey` (bot API key, not your personal user key).
