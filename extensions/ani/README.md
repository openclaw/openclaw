# @openclaw/ani

ANI channel plugin for OpenClaw.

This plugin connects OpenClaw to Agent-Native IM (ANI) so that ANI direct chats and group chats behave like a normal OpenClaw channel:

- inbound ANI messages enter ordinary OpenClaw sessions
- final replies are delivered back into the same ANI conversation
- protected ANI attachments remain authenticated resources
- OpenClaw text control commands such as `/approve`, `/exec`, and `/status` work from ANI chats

## Install (local checkout)

```bash
openclaw plugins install ./extensions/ani
```

## Install (npm)

```bash
openclaw plugins install @openclaw/ani
```

Onboarding: select Agent-Native IM and confirm the install prompt to fetch the plugin automatically.

## Requirements

- A reachable ANI server exposing the standard ANI REST and WebSocket APIs
- A permanent ANI API key with the `aim_` prefix
- A recent OpenClaw build compatible with the plugin SDK subpaths used by this plugin

## Config

Minimal config:

```json5
{
  channels: {
    ani: {
      enabled: true,
      serverUrl: "https://your-ani-server.example.com",
      apiKey: "aim_your_api_key",
    },
  },
}
```

Recommended tool allowlist if you want ANI task/file/history features:

```bash
openclaw config set tools.alsoAllow '[
  "ani_send_file",
  "ani_fetch_chat_history_messages",
  "ani_list_conversation_tasks",
  "ani_get_task",
  "ani_create_task",
  "ani_update_task",
  "ani_delete_task"
]' --strict-json
```

Config reference:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable or disable the ANI channel |
| `name` | string | none | Optional display name shown in status output |
| `serverUrl` | string | none | ANI server base URL without trailing slash |
| `apiKey` | string | none | Permanent ANI API key with `aim_` prefix |
| `entityId` | number | auto-detected | Legacy numeric override; usually leave unset |
| `textChunkLimit` | number | `4000` | Maximum characters per outbound text chunk |
| `dm.policy` | `"open" \| "disabled"` | `"open"` | Whether ANI direct messages are accepted |

Restart or reconnect the gateway after config changes if ANI does not come online immediately.

## What It Supports

- inbound ANI delivery over WebSocket
- outbound replies over ANI REST APIs
- direct and group conversation routing
- reply-to context preservation
- protected attachment download and authenticated upload
- long reply chunking at markdown-friendly boundaries
- `<artifact>` rendering for HTML, code, and Mermaid content
- ANI task tools
- multi-agent routing via standard OpenClaw bindings
- native slash/control command routing for ANI chats

## Routing Model

### Ordinary conversation traffic

ANI group and direct messages are routed into ordinary OpenClaw sessions based on ANI conversation identity.

### Slash / control commands

ANI control commands such as `/approve`, `/exec`, and `/status` are not treated as ordinary chat text. They:

- bypass ANI's inbound debounce logic
- route through a synthetic `ani:slash:<senderId>` command session
- retain the original ANI conversation session as `CommandTargetSessionKey`
- execute through OpenClaw's native command system

This gives ANI the same high-level control-command behavior expected from mature OpenClaw channels.

Important boundary:

- ANI routes the command correctly
- OpenClaw still decides whether the command is allowed
- `/exec` still obeys OpenClaw host approval, allowlist, and security policy

If you want `/exec` to run without interactive prompts, configure OpenClaw approvals and exec policy accordingly.

## Attachments

ANI attachments are treated as conversation-scoped protected resources.

Behavior:

- small text files may be inlined for the model
- binary/media files are downloaded with ANI authentication
- local saved media paths are attached to the inbound OpenClaw context
- outbound uploads are bound to the current ANI conversation

Attachment understanding still depends on the selected model/runtime. Transport support does not guarantee image, audio, video, or document understanding.

## ANI Tools

- `ani_send_file`
- `ani_fetch_chat_history_messages`
- `ani_list_conversation_tasks`
- `ani_get_task`
- `ani_create_task`
- `ani_update_task`
- `ani_delete_task`

These tools operate against the current ANI conversation and reuse ANI's own permissions. The plugin does not define a separate task authorization model.

## Multi-Agent Routing

ANI works with standard OpenClaw bindings. Example:

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
        id: "2920436443328762"
```

You can obtain ANI conversation ids from ANI web URLs, gateway logs such as `ani: inbound conv=<id>`, or ANI bot/system prompt context.

## Limits

- one ANI account per OpenClaw instance
- ANI uses a flat conversation model, not native subthreads
- no poll support
- attachment comprehension remains model-dependent

## Validation

Validation matrix:

- [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md)

Local validation from the OpenClaw repo root:

```bash
pnpm test:extension ani
pnpm run lint:plugins:no-monolithic-plugin-sdk-entry-imports
```

## Troubleshooting

### ANI does not come online

Check:

- `channels.ani.serverUrl`
- `channels.ani.apiKey`
- `openclaw plugins inspect ani`
- `openclaw status`

The plugin authenticates by calling `GET /api/v1/me` on startup. Legacy `aimb_` keys are not supported.

### Final replies or command results do not appear

Check:

- ANI channel connectivity in gateway logs
- that the ANI conversation still exists and the bot is a participant
- OpenClaw exec approvals if the task uses `/exec`
- plugin health with `openclaw plugins inspect ani`

### Control commands reach the chat but still request approval

That usually means ANI routing is working, but OpenClaw host exec policy is still blocking the underlying command. Review:

- `openclaw approvals get --json`
- your allowlist entries
- the session's `/exec ...` policy

### Final replies do not return

Check:

- gateway logs for ANI reconnect / send failures
- ANI conversation membership and bot permissions
- whether the final reply was generated locally but failed during outbound delivery

### Attachments upload but cannot be downloaded

Check whether uploaded files were bound to the correct ANI conversation. Outbound ANI uploads should include the target `conversation_id`.

## Development Notes

ANI follows the same general OpenClaw channel principles used by mature channels such as Telegram, Discord, Signal, and Feishu:

- channel-owned reply delivery
- session-aware command routing
- explicit command/auth boundaries
- testable behavior for inbound, outbound, and control paths

The goal is to keep ANI aligned with standard OpenClaw channel patterns rather than inventing private routing behavior.
