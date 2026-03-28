# @openclaw/ani

OpenClaw channel plugin for Agent-Native IM (ANI), a messaging platform built for human and AI bot collaboration. Version **2026.3.28**.

## Features

- **Bidirectional messaging** -- receive messages via WebSocket, send replies immediately via REST API (not buffered)
- **Tools**: `ani_send_file`, `ani_fetch_chat_history_messages`, `ani_list_conversation_tasks`, `ani_get_task`, `ani_create_task`, `ani_update_task`, `ani_delete_task`
- **Streaming progress** -- long-running tasks show real-time status in chat via status layers with typing indicators
- **Artifact rendering** -- `<artifact>` tags in model output sent as structured content (HTML, code, mermaid)
- **File handling** -- send/receive images, documents, audio, video, archives (up to 32 MB); small text files inlined for AI, protected binary files downloaded with ANI auth and saved to local media paths
- **Multi-bot collaboration** -- group conversations with multiple bots, @mention routing, conversation context injection
- **Message revoke listener** -- detects `message.revoked` events and aborts in-flight delivery for that message
- **Stream cancel abort** -- `stream.cancel` / `task.cancel` events abort the active agent dispatch via AbortController
- **Reactions** -- ack-reaction on message receipt (configurable via `messages.ackReaction`)
- **Interactive cards** -- approval/selection UI via ANI's interaction layer
- **Message chunking** -- long replies split at markdown boundaries (configurable limit)
- **Auto-reconnecting WebSocket** -- ping/pong keepalive with exponential backoff
- **Retry with exponential backoff** -- REST calls retry on transient failures (502/503/504) with jitter
- **Config hot reload** -- changes under `channels.ani` auto-detected; most take effect without restart
- **Multi-agent routing** -- route specific conversations to dedicated OpenClaw agents with separate workspaces

## Quick Start

### Option A: Install from npm

```bash
openclaw plugins install @openclaw/ani
```

### Option B: Install from local extension

```bash
# From the OpenClaw repo with extensions/ani/ present
openclaw plugins install ./extensions/ani
```

### Configure

```bash
# 1. Set ANI server and API key (create a Bot in ANI Web to get the key)
openclaw config set channels.ani.serverUrl "https://your-ani-server.example.com"
openclaw config set channels.ani.apiKey "aim_your_api_key"

# 2. Enable the tools
openclaw config set tools.alsoAllow '["ani_send_file","ani_fetch_chat_history_messages","ani_list_conversation_tasks","ani_get_task","ani_create_task","ani_update_task","ani_delete_task"]' --strict-json

# 3. Check the gateway status
openclaw gateway status
```

If ANI does not appear online after updating the config, reconnect or restart the OpenClaw gateway.

## Configuration

All settings live under `channels.ani` in your OpenClaw config.

| Field            | Type    | Required | Default       | Description                                                          |
| ---------------- | ------- | -------- | ------------- | -------------------------------------------------------------------- |
| `serverUrl`      | string  | yes      | --            | ANI server base URL (no trailing slash)                              |
| `apiKey`         | string  | yes      | --            | Permanent API key (`aim_` prefix). Legacy `aimb_` keys are rejected. |
| `entityId`       | number  | no       | auto-detected | Legacy numeric override. Usually leave empty.                        |
| `enabled`        | boolean | no       | `true`        | Enable/disable the channel                                           |
| `textChunkLimit` | number  | no       | `4000`        | Max chars per outbound message chunk                                 |
| `dm.policy`      | string  | no       | `"open"`      | DM routing: `"open"` or `"disabled"`                                 |
| `name`           | string  | no       | --            | Display name for status output                                       |

## How It Works

**Inbound (ANI -> OpenClaw):** WebSocket connection to `/api/v1/ws`. On `message.new`, fetches conversation context (title, participants, memories), formats an agent envelope, dispatches through the reply pipeline. Revoked messages and cancelled streams are detected and aborted in-flight.

**Outbound (OpenClaw -> ANI):** REST API `POST /api/v1/messages/send`. Parses `<artifact>` tags into structured content. Plain text chunked at markdown boundaries. Files uploaded via multipart then sent as attachments.

**Authentication:** On startup, calls `GET /api/v1/me` to verify the API key and auto-discover bot identity. Only permanent keys (`aim_`) are accepted.

## Task Roadmap Tools

The ANI plugin can now read and mutate the current conversation task roadmap through dedicated tools:

- `ani_list_conversation_tasks`
- `ani_get_task`
- `ani_create_task`
- `ani_update_task`
- `ani_delete_task`

These tools reuse ANI's backend permissions:

- the bot must be a member of the conversation
- create/list/get require conversation participation
- update/delete still follow ANI's existing creator / assignee / admin rules

Planned but not implemented yet:

- approval workflow for task mutations in group chats
- member-submitted task edits entering a pending-review queue for group admins

## Attachment Behavior

This plugin now follows ANI's protected attachment model:

- conversation files stay as protected ANI resources
- the plugin downloads them with ANI auth
- binary/media files are saved locally and passed via `MediaPath` / `MediaPaths`
- small text files may be inlined into the model prompt
- the plugin should not expose naked protected `/files/...` URLs to the agent as if they were public downloads

Practical implication:

- transport can succeed even if the model cannot truly understand the file contents
- image/audio/video understanding still depends on the selected model/runtime
- PDF / office docs are transport-supported, but parser experience is still incomplete

Current support levels:

- text files: most reliable, small files may be inlined for the model
- images / audio / video: transport works, understanding still depends on the selected model/runtime
- PDF / Office documents: transport works, parser experience is still incomplete

If you need a fuller attachment capability breakdown, document it in your ANI deployment docs rather than relying on private local paths.

## Multi-Agent Routing

```yaml
agents:
  list:
    - id: main
      workspace: ~/.openclaw/workspace
    - id: ops-agent
      workspace: ~/.openclaw/workspace-ops

bindings:
  - agentId: ops-agent
    match:
      channel: ani
      peer:
        kind: channel
        id: "2920436443328762" # ANI conversation ID
```

Find conversation IDs in: ANI web URL bar, gateway logs (`ani: inbound conv=<id>`), or the bot's system prompt.

## Limitations

- **Single account** -- one ANI account per OpenClaw instance
- **No threads** -- ANI uses a flat conversation model
- **No polls** -- not supported by ANI
- **Model-dependent multimodality** -- successful attachment delivery does not guarantee image/audio/video understanding

## Development

```bash
# From OpenClaw repo root
npx vitest run --config vitest.extensions.config.ts extensions/ani/
```
