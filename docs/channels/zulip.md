---
summary: "Zulip bot setup and OpenClaw config"
read_when:
  - Setting up Zulip
  - Debugging Zulip routing
title: "Zulip"
---

# Zulip (plugin)

Status: supported via plugin (bot email + API key + event queue). Streams/topics are supported.
Private messages are not included in the first version. File uploads are supported via Zulip `user_uploads`.

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

      // Reply to every message in monitored streams/topics (default: true).
      alwaysReply: true,

      // Default topic when outbound targets omit a topic.
      defaultTopic: "general chat",
    },
  },
}
```

## Replying to every message

Zulip defaults to replying to every message in monitored streams/topics (so it behaves like a
chat bot, not "mention-only"). To make it trigger-only, set:

```json5
{
  channels: {
    zulip: {
      alwaysReply: false,
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

To leave the `onStart` reaction (for example, keep `eyes` on the triggering message), set:

```json5
{
  channels: {
    zulip: {
      reactions: {
        clearOnFinish: false,
      },
    },
  },
}
```

## Sessions (topics → sessions)

Zulip topics map to OpenClaw sessions:

- Same stream + same topic → same session
- Different topic → different session

This keeps conversations separated per topic.

## Creating new topics

Zulip "creates" topics automatically when a message is sent with a new topic name.

To let the agent intentionally switch topics, it can prefix a reply with:

```text
[[zulip_topic: <topic>]]
```

OpenClaw strips this directive before posting and sends the reply into the requested topic.

## Media (uploads)

Inbound: when a message contains `user_uploads` links, OpenClaw downloads up to `mediaMaxMb` and attaches the files to the agent context.

Outbound: OpenClaw can upload local files (or remote URLs) to Zulip and post the resulting link into the stream/topic.

Optional size limit:

```json5
{
  channels: {
    zulip: {
      // Default is 5MB.
      mediaMaxMb: 5,
    },
  },
}
```

## Targets for outbound delivery

Use these target formats with `openclaw message send` (quote if there are spaces):

- `stream:<streamName>#<topic>` for a stream + topic
- `stream:<streamName>` to use `channels.zulip.defaultTopic`

Examples:

```bash
openclaw message send --channel zulip --target "stream:marcel-ai" --message "hello"
openclaw message send --channel zulip --target "stream:marcel-ai#deploy-notes" --message "ship it"
openclaw message send --channel zulip --target "stream:marcel-ai" --message "screenshot" --media ./screenshot.png
```

## Troubleshooting

- No replies: confirm the bot is subscribed to the stream and that `channels.zulip.streams` includes the stream name (without `#`).
- Auth errors: verify `baseUrl`, `email`, and `apiKey` (bot API key, not your personal user key).
