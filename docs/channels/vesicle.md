---
summary: "iMessage via Vesicle's native REST API."
read_when:
  - Setting up Vesicle native iMessage support
  - Migrating away from BlueBubbles compatibility
  - Debugging Vesicle send/probe behavior
title: "Vesicle"
sidebarTitle: "Vesicle"
---

Status: bundled channel for Vesicle's native API. The first native surface supports
health probes and text sends to existing Messages chats. Native inbound webhooks are
the next migration step.

## Quick start

Configure OpenClaw with the Vesicle server URL and bearer token:

```json5
{
  channels: {
    vesicle: {
      enabled: true,
      serverUrl: "http://127.0.0.1:1234",
      authToken: "example-token",
    },
  },
}
```

Then start the gateway and verify channel status:

```bash
openclaw gateway
openclaw status channels vesicle
```

## Sending

The initial native send route targets existing chats by Messages chat GUID:

```bash
openclaw deliver --channel vesicle --to "chat_guid:iMessage;-;+15551234567" "hello"
openclaw deliver --channel vesicle --to "chat_guid:iMessage;+;chat123" "hello group"
```

Plain phone-number or email targets are intentionally rejected until Vesicle exposes
a native chat lookup/create route. Use `chat_guid:<GUID>` during the migration window.

## Native API

OpenClaw uses:

- `GET /api/v1/vesicle/health`
- `GET /api/v1/vesicle/capabilities`
- `POST /api/v1/vesicle/message/text`

Requests use `Authorization: Bearer <authToken>`.

Unsupported BlueBubbles-only features remain disabled on this channel: reactions,
edits, unsend, effects, attachments, and group management.

## Migration Notes

`channels.bluebubbles` can continue to run against Vesicle's compatibility routes
while `channels.vesicle` is introduced. To remove BlueBubbles from the required stack,
finish the native webhook path and cut over inbound routing to `channels.vesicle`.
