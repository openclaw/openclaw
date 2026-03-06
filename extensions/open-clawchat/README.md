# Open-ClawChat Channel Plugin

OpenClaw channel plugin for integrating with Open-ClawChat real-time chat platform.

## Features

- **Dual Connection Mode**: Supports both WebSocket and Webhook connection modes
  - **WebSocket Mode (default)**: Real-time bidirectional communication without requiring public IP
  - **Webhook Mode**: HTTP callback-based communication for servers with public IP
- **Multi-room Support**: Subscribe to multiple chat rooms
- **Flexible Permissions**: Configurable DM and group chat policies
- **Mention Support**: Optional @mention requirement in group chats

## Installation

### Download

```bash
curl -o open-clawchat-plugin.zip https://home.puckguo.asia/openclaw-plugin/open-clawchat-plugin.zip
unzip open-clawchat-plugin.zip -d openclaw/extensions/open-clawchat
```

Or manually copy the plugin directory to OpenClaw's extensions folder:

```bash
cp -r open-clawchat openclaw/extensions/
```

The plugin will be automatically loaded when OpenClaw starts.

## Configuration

Add the following to your `openclaw.json5` configuration file:

```json5
{
  channels: {
    "open-clawchat": {
      enabled: true,
      serverUrl: "https://your-openclawchat-server.com",
      connectionMode: "websocket", // or "webhook"
      webhookPort: 8790, // only for webhook mode
      agentId: "openclaw-agent-001", // optional, auto-generated if not specified
      agentName: "OpenClaw AI Agent",
      rooms: ["room-1", "room-2"],
      // Permission settings
      dmPolicy: "open", // "open" | "pairing" | "allowlist"
      groupPolicy: "open", // "open" | "allowlist" | "disabled"
      requireMention: true, // require @mention in group chats
      allowFrom: [], // allowed senders for DM (when dmPolicy is "allowlist")
      groupAllowFrom: [], // allowed senders for group (when groupPolicy is "allowlist")
    },
  },
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable the channel |
| `serverUrl` | string | (required) | Open-ClawChat server URL |
| `connectionMode` | "websocket" \| "webhook" | `"websocket"` | Connection mode |
| `webhookPort` | number | `8790` | Port for webhook server (webhook mode only) |
| `agentId` | string | auto-generated | Unique agent identifier |
| `agentName` | string | `"OpenClaw Agent"` | Display name for the agent |
| `rooms` | string[] | `[]` | List of room IDs to subscribe |
| `wsUrl` | string | (derived) | WebSocket URL (optional, derived from serverUrl) |
| `dmPolicy` | "open" \| "pairing" \| "allowlist" | `"open"` | Direct message policy |
| `groupPolicy` | "open" \| "allowlist" \| "disabled" | `"open"` | Group chat policy |
| `requireMention` | boolean | `true` | Require @mention in group chats |
| `allowFrom` | string[] | `[]` | Allowed senders for DM |
| `groupAllowFrom` | string[] | `[]` | Allowed senders for group |

## Connection Modes

### WebSocket Mode (Recommended)

WebSocket mode provides real-time bidirectional communication:

- No public IP required
- Lower latency
- Automatic reconnection
- Supports typing indicators

### Webhook Mode

Webhook mode uses HTTP callbacks:

- Requires publicly accessible server
- Agent registers webhook URL with Open-ClawChat server
- Server pushes messages via HTTP POST to the webhook endpoint

## API Endpoints

The plugin interacts with the following Open-ClawChat server endpoints:

- `POST /api/agent/register` - Register agent with server
- `POST /api/agent/heartbeat` - Send heartbeat to maintain connection
- `POST /api/agent/message` - Send message to a room
- `POST /api/agent/unregister` - Unregister agent from server
- `GET /api/health` - Health check endpoint

## WebSocket Protocol

When using WebSocket mode, the agent connects to `/ws` with the following query parameters:

- `session` - Session/room ID
- `name` - Agent display name
- `role` - User role ("ai")
- `user_id` - Agent ID

## Development

### Project Structure

```
extensions/open-clawchat/
├── openclaw.plugin.json    # Plugin manifest
├── package.json            # NPM configuration
├── index.ts               # Entry point
├── src/
│   ├── channel.ts         # ChannelPlugin implementation
│   ├── types.ts           # TypeScript type definitions
│   ├── config-schema.ts   # Zod configuration schema
│   ├── api-client.ts      # REST API client
│   ├── websocket-client.ts # WebSocket client
│   └── webhook-server.ts  # Webhook server
└── README.md              # This file
```

### Building

The plugin is written in TypeScript and compiled as part of the OpenClaw build process:

```bash
cd openclaw-main
pnpm build
```

### Testing

Start OpenClaw with the plugin:

```bash
cd openclaw-main
pnpm gateway
```

## License

MIT
