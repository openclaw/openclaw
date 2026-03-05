---
summary: "Google Workspace Events subscription hooks wired into OpenClaw webhooks via gws"
read_when:
  - Wiring Workspace Events (Calendar, Drive, Chat) triggers to OpenClaw
  - Setting up workspace event subscriptions for agent wake
title: "Workspace Events"
---

# Google Workspace Events -> OpenClaw

Subscribe to real-time Google Workspace changes (Calendar updates, Drive file edits,
Chat messages, etc.) and forward them as hook events to your OpenClaw agent.

Uses `gws events +subscribe` (pull-based Pub/Sub, NDJSON on stdout).

## Prerequisites

- `gcloud` installed and logged in ([install guide](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gws` installed and authorized: `npm i -g @googleworkspace/cli && gws auth login`.
- OpenClaw hooks enabled (see [Webhooks](/automation/webhook)).
- A GCP project with the Workspace Events API and Pub/Sub API enabled.

## Quick start

### 1. Setup

```bash
openclaw webhooks events setup \
  --target '//chat.googleapis.com/spaces/SPACE_ID' \
  --event-types 'google.workspace.chat.message.v1.created' \
  --project my-gcp-project
```

This writes `hooks.workspaceEvents` config and adds the `"workspace-events"` preset.

### 2. Run

```bash
openclaw webhooks events run
```

Or let the gateway start it automatically on boot (if `hooks.workspaceEvents.target` is configured).

## Configuration

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["workspace-events"],
    workspaceEvents: {
      project: "my-gcp-project",
      target: "//chat.googleapis.com/spaces/SPACE_ID",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      // Optional:
      // subscription: "existing-sub-name",
      // hookUrl: "http://127.0.0.1:18789/hooks/workspace-events",
      // pollInterval: 5,
      // maxMessages: 10,
      // cleanup: false,
      // model: "provider/model",
      // thinking: "low",
    },
  },
}
```

### Config fields

| Field                        | Type     | Default    | Description                                                    |
| ---------------------------- | -------- | ---------- | -------------------------------------------------------------- |
| `project`                    | string   | (required) | GCP project ID                                                 |
| `target`                     | string   | (required) | Workspace resource URI (e.g. `//chat.googleapis.com/spaces/X`) |
| `eventTypes`                 | string[] | (required) | Event types to subscribe to                                    |
| `subscription`               | string   | (auto)     | Reuse an existing Pub/Sub subscription                         |
| `hookUrl`                    | string   | auto       | Override the hook POST URL                                     |
| `pollInterval`               | number   | 5          | Pub/Sub poll interval in seconds                               |
| `maxMessages`                | number   | 10         | Max messages per poll batch                                    |
| `cleanup`                    | boolean  | false      | Delete Pub/Sub resources on process exit                       |
| `model`                      | string   | (default)  | Model override for hook processing                             |
| `thinking`                   | string   | (default)  | Thinking level override                                        |
| `allowUnsafeExternalContent` | boolean  | false      | Disable external content safety wrapping                       |

## Event types

Common event types:

- `google.workspace.chat.message.v1.created` - New Chat message
- `google.workspace.chat.message.v1.updated` - Chat message edited
- `google.workspace.chat.membership.v1.created` - New Chat space member
- `google.workspace.calendar.event.v1.created` - New Calendar event
- `google.workspace.calendar.event.v1.updated` - Calendar event updated
- `google.workspace.drive.file.v1.updated` - Drive file updated

Multiple types can be specified as a comma-separated list in the CLI or as an array in config.

## Hook payload

Each event is forwarded as:

```json
{
  "events": [
    {
      "type": "google.workspace.chat.message.v1.created",
      "source": "//chat.googleapis.com/spaces/X",
      "time": "2026-02-13T10:00:00Z",
      "resourceType": "chat.message",
      "summary": "chat.message created from //chat.googleapis.com/spaces/X",
      "data": { ... }
    }
  ]
}
```

## Environment variables

| Variable                          | Effect                                                           |
| --------------------------------- | ---------------------------------------------------------------- |
| `OPENCLAW_SKIP_WS_EVENTS_WATCHER` | Set to `1` to prevent the gateway from auto-starting the watcher |

## Custom mappings

Override the default preset mapping to deliver events to a specific channel:

```json5
{
  hooks: {
    presets: ["workspace-events"],
    mappings: [
      {
        match: { path: "workspace-events" },
        action: "agent",
        name: "Workspace Event",
        deliver: true,
        channel: "slack",
        sessionKey: "hook:ws-event:{{events[0].type}}:{{events[0].time}}",
        messageTemplate: "Workspace event: {{events[0].summary}}\nData: {{events[0].data}}",
      },
    ],
  },
}
```
