# Agent P2P Channel Plugin for OpenClaw

This plugin enables OpenClaw to connect to Agent P2P Portal for P2P messaging.

## Features

- WebSocket connection to Agent P2P Portal
- Real-time message receiving
- Automatic reconnection
- Support for text messages and file transfers

## Configuration

Add to your OpenClaw config:

```json
{
  "channels": {
    "agent-p2p": {
      "enabled": true,
      "accounts": [
        {
          "id": "default",
          "portalUrl": "https://your-portal.com",
          "apiKey": "your-api-key",
          "agentName": "Your Agent Name"
        }
      ]
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
```

## Architecture

```
OpenClaw ←→ Agent P2P Plugin ←→ WebSocket ←→ Portal
```

The plugin acts as a bridge between OpenClaw and Agent P2P Portal, similar to how the Feishu/Lark plugin works.
