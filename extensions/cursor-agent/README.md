# Cursor Agent Extension for OpenClaw

Integrate [Cursor Background Agents](https://cursor.com/docs/agent/overview) with OpenClaw. Send coding tasks from WhatsApp, Telegram, Slack, or any OpenClaw channel, and Cursor's AI will implement features, fix bugs, and create pull requests for you.

## Features

- **Multi-Channel Access**: Send coding tasks from any OpenClaw channel
- **Automatic PR Creation**: Cursor Agent creates branches and pull requests
- **Webhook Integration**: Receive real-time status updates and results
- **Session Correlation**: Results are routed back to the original conversation
- **Repository/Branch Control**: Specify repo and branch in messages

## Prerequisites

1. **Cursor Account**: Pro/Business subscription with Background Agents access
2. **API Key**: Get from [Cursor Dashboard](https://cursor.com/dashboard?tab=background-agents)
3. **GitHub Repository**: Connected to your Cursor account

## Installation

The extension is included in OpenClaw. Enable it by adding configuration:

```bash
# Run the setup wizard
openclaw channels add cursor-agent
```

Or manually add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "cursorAgent": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiKey": "your-cursor-api-key",
          "repository": "https://github.com/your-org/your-repo",
          "branch": "main",
          "webhookUrl": "https://your-gateway.example.com/cursor-agent/default/webhook",
          "webhookSecret": "your-webhook-secret-min-8-chars"
        }
      }
    }
  }
}
```

## Configuration Options

| Option                | Required | Description                                             |
| --------------------- | -------- | ------------------------------------------------------- |
| `apiKey`              | Yes      | Cursor API key from dashboard                           |
| `repository`          | No       | Default GitHub repository URL                           |
| `branch`              | No       | Default branch (default: "main")                        |
| `webhookUrl`          | No       | URL for receiving status updates                        |
| `webhookSecret`       | No       | Secret for webhook signature verification (8-256 chars) |
| `defaultModel`        | No       | AI model preference                                     |
| `defaultInstructions` | No       | Prefix added to all tasks                               |

## Usage

### Basic Usage

Send a message to Cursor Agent from any OpenClaw channel:

```
Fix the bug in src/utils.ts that causes the login to fail
```

### Specify Repository

Override the default repository:

```
@repo:https://github.com/myorg/other-repo Add a README with installation instructions
```

### Specify Branch

Override the default branch:

```
@branch:feature-auth Implement user authentication
```

### Combined

```
@repo:https://github.com/myorg/webapp @branch:develop Add dark mode toggle to settings
```

## How It Works

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   WhatsApp/     │      │    OpenClaw     │      │  Cursor Agent   │
│   Telegram/     │ ──▶  │    Gateway      │ ──▶  │  Background     │
│   Slack/etc     │      │                 │      │  API            │
└─────────────────┘      └────────┬────────┘      └────────┬────────┘
                                  │                        │
                                  │    ┌───────────────────┘
                                  │    │ Webhook (statusChange)
                                  │    ▼
                         ┌────────┴────────┐
                         │   Results:      │
                         │   - Summary     │
                         │   - PR URL      │
                         │   - Branch      │
                         └─────────────────┘
```

1. **User sends message** via WhatsApp/Telegram/Slack/Discord/etc.
2. **OpenClaw routes** message to Cursor Agent channel
3. **API call** launches Cursor Background Agent with instructions
4. **Cursor Agent** clones repo, implements changes, creates PR
5. **Webhook** notifies OpenClaw when task completes
6. **Results** are sent back to the original conversation

## Response Format

### Success

```
✅ Cursor Agent Task Completed

Summary: Added dark mode toggle with localStorage persistence

Pull Request: https://github.com/your-org/your-repo/pull/123
Branch: cursor/add-dark-mode-456

View in Cursor
```

### Error

```
❌ Cursor Agent Task Failed

Error: Repository not found or access denied

View Details
```

## Webhook Setup

For receiving real-time results, configure webhooks:

### 1. Expose Gateway

If your Gateway is behind a firewall, use Tailscale Funnel or ngrok:

```bash
# Using Tailscale Funnel
tailscale funnel 18789

# Or ngrok
ngrok http 18789
```

### 2. Configure Webhook URL

Set `webhookUrl` to your public Gateway URL:

```json
{
  "webhookUrl": "https://your-gateway.example.com/cursor-agent/default/webhook"
}
```

### 3. Set Webhook Secret

Generate a secure secret (8-256 characters):

```bash
openssl rand -hex 32
```

Add to your config and to Cursor (if configurable).

## API Reference

### Endpoints Used

| Endpoint                  | Method | Description        |
| ------------------------- | ------ | ------------------ |
| `/v0/agents`              | POST   | Launch a new agent |
| `/v0/agents`              | GET    | List all agents    |
| `/v0/agents/:id`          | GET    | Get agent details  |
| `/v0/agents/:id/messages` | POST   | Send follow-up     |

### Webhook Events

Currently only `statusChange` events are supported:

```json
{
  "event": "statusChange",
  "timestamp": "2024-01-15T10:30:00Z",
  "id": "bc_abc123",
  "status": "FINISHED",
  "source": {
    "repository": "https://github.com/your-org/your-repo",
    "ref": "main"
  },
  "target": {
    "url": "https://cursor.com/agents?id=bc_abc123",
    "branchName": "cursor/add-readme-1234",
    "prUrl": "https://github.com/your-org/your-repo/pull/1234"
  },
  "summary": "Added README.md with installation instructions"
}
```

## Troubleshooting

### "API key is required"

Ensure `apiKey` is set in your configuration.

### "No repository specified"

Either:

- Set a default `repository` in config
- Include `@repo:URL` in your message

### "Repository not found"

Ensure:

- The repository exists and is public, OR
- You've connected it to Cursor via GitHub integration

### Webhook not receiving events

1. Check webhook URL is publicly accessible
2. Verify HTTPS is used (required)
3. Check webhook secret matches
4. Look at Gateway logs for errors

## Development

```bash
# Clone OpenClaw
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Install dependencies
pnpm install

# Run tests for this extension
pnpm test -- extensions/cursor-agent

# Start Gateway with this extension
pnpm gateway:watch
```

## Files

```
extensions/cursor-agent/
├── index.ts           # Plugin entry point
├── package.json       # Dependencies
├── README.md          # This file
└── src/
    ├── api.ts         # Cursor API client
    ├── config.ts      # Config management
    ├── config-schema.ts # Zod validation schema
    ├── monitor.ts     # Webhook handler
    ├── onboarding.ts  # Setup wizard
    ├── outbound.ts    # Message sending
    ├── plugin.ts      # ChannelPlugin implementation
    ├── runtime.ts     # Runtime management
    ├── task-store.ts  # Session correlation
    └── types.ts       # TypeScript types
```

## References

- [Cursor Agent Overview](https://cursor.com/docs/agent/overview)
- [Cursor Background Agents API](https://docs.cursor.com/en/background-agent/api/)
- [Cursor Webhooks](https://cursor.mintlify.app/en/background-agent/api/webhooks)
- [OpenClaw Plugin SDK](../../src/plugin-sdk/index.ts)
- [Example: Twitch Extension](../twitch/)

## License

MIT - Same as OpenClaw
