# Architecture

## System Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                         USER DEVICES                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ WhatsApp │ │ Telegram │ │  Slack   │ │ Discord  │ │ WebChat  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
└───────┼────────────┼────────────┼────────────┼────────────┼────────┘
        │            │            │            │            │
        └────────────┴────────────┼────────────┴────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        OPENCLAW GATEWAY                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     Channel Router                           │   │
│  │  Receives messages from all channels, routes to plugins      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                  │                                  │
│  ┌───────────┐  ┌───────────┐  ┌┴──────────────┐  ┌───────────┐   │
│  │  Discord  │  │  Slack    │  │ Cursor Agent  │  │  Twitch   │   │
│  │  Plugin   │  │  Plugin   │  │    Plugin     │  │  Plugin   │   │
│  └───────────┘  └───────────┘  └───────┬───────┘  └───────────┘   │
│                                        │                            │
│  ┌─────────────────────────────────────┴───────────────────────┐   │
│  │                      Session Manager                         │   │
│  │  Tracks conversations, correlates tasks with sessions        │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ HTTPS API Calls
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        CURSOR CLOUD                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Background Agents API                      │   │
│  │  POST /v0/agents        - Launch agent                       │   │
│  │  GET  /v0/agents        - List agents                        │   │
│  │  GET  /v0/agents/:id    - Get status                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                  │                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Agent Execution                           │   │
│  │  - Clones repository                                         │   │
│  │  - Analyzes codebase                                         │   │
│  │  - Makes changes                                             │   │
│  │  - Creates PR                                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                  │                                  │
│                                  │ Webhook (statusChange)           │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    OPENCLAW GATEWAY (Webhook Handler)               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  POST /cursor-agent/:accountId/webhook                       │   │
│  │  - Verifies signature                                        │   │
│  │  - Parses payload                                            │   │
│  │  - Updates task store                                        │   │
│  │  - Routes result to original session                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Cursor Agent Plugin

The plugin is structured as an OpenClaw channel extension:

```
extensions/cursor-agent/
├── index.ts                 # Plugin registration
└── src/
    ├── plugin.ts           # ChannelPlugin implementation
    ├── api.ts              # Cursor API client
    ├── monitor.ts          # Webhook handler
    ├── outbound.ts         # Message sending
    ├── task-store.ts       # Task tracking
    ├── config.ts           # Configuration
    ├── config-schema.ts    # Zod validation
    ├── onboarding.ts       # Setup wizard
    ├── runtime.ts          # Runtime context
    └── types.ts            # TypeScript types
```

### 2. Data Flow

#### Outbound (User → Cursor)

```
User Message
    │
    ▼
┌─────────────────────────────────┐
│  Channel Plugin (outbound.ts)   │
│  - Extract @repo: annotation    │
│  - Extract @branch: annotation  │
│  - Build instructions           │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  API Client (api.ts)            │
│  - Format request payload       │
│  - Add authentication           │
│  - POST to Cursor API           │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  Task Store (task-store.ts)     │
│  - Save task ID                 │
│  - Associate with session       │
│  - Track status                 │
└─────────────────────────────────┘
```

#### Inbound (Cursor → User)

```
Cursor Webhook
    │
    ▼
┌─────────────────────────────────┐
│  Monitor (monitor.ts)           │
│  - Verify signature             │
│  - Parse payload                │
│  - Validate event type          │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  Task Store (task-store.ts)     │
│  - Find task by ID              │
│  - Get associated session       │
│  - Update task status           │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  Session Router                 │
│  - Format response message      │
│  - Route to original channel    │
│  - Send to user                 │
└─────────────────────────────────┘
```

### 3. Plugin Interface

The plugin implements OpenClaw's `ChannelPlugin` interface:

```typescript
interface ChannelPlugin {
  id: string; // "cursor-agent"
  meta: ChannelMeta; // Display info
  capabilities: ChannelCapabilities;

  config: {
    listAccountIds(); // List configured accounts
    resolveAccount(); // Get account config
    isConfigured(); // Check if ready
    isEnabled(); // Check if active
  };

  outbound: {
    sendMessage(); // Send task to Cursor
    sendToolResult(); // Send follow-up
  };

  gateway: {
    startAccount(); // Start webhook listener
    stopAccount(); // Stop listener
  };

  status: {
    probeAccount(); // Health check
    buildAccountSnapshot(); // Current status
  };

  onboarding: {
    runSetup(); // CLI wizard
  };
}
```

### 4. Task Correlation

Tasks are tracked in an in-memory store:

```typescript
interface CursorAgentTask {
  id: string; // Cursor task ID (bc_xxx)
  sessionKey: string; // OpenClaw session
  accountId: string; // Cursor account
  instructions: string; // Original message
  repository: string; // GitHub repo
  branch: string; // Git branch
  status: Status; // PENDING/RUNNING/FINISHED/ERROR
  createdAt: number; // Timestamp
  updatedAt: number; // Last update
  prUrl?: string; // Pull request URL
}
```

### 5. Webhook Security

Webhooks are secured with HMAC-SHA256 signatures:

```
┌─────────────────────────────────────────────────┐
│  Cursor sends webhook with signature            │
│                                                 │
│  Headers:                                       │
│    X-Webhook-Signature: sha256=<hex_digest>     │
│    X-Webhook-ID: wh_xxx                         │
│    X-Webhook-Event: statusChange                │
│                                                 │
│  Verification:                                  │
│    expected = HMAC-SHA256(secret, raw_body)     │
│    valid = (signature === "sha256=" + expected) │
└─────────────────────────────────────────────────┘
```

## Configuration

```json
{
  "channels": {
    "cursorAgent": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiKey": "cursor-api-key",
          "repository": "https://github.com/org/repo",
          "branch": "main",
          "webhookUrl": "https://gateway.example.com/cursor-agent/default/webhook",
          "webhookSecret": "secret-for-verification"
        }
      }
    }
  }
}
```

## Error Handling

```
┌─────────────────────────────────────────────────┐
│  Error Type          │  Handling               │
├─────────────────────────────────────────────────┤
│  Invalid API key     │  Clear error to user    │
│  No repository       │  Prompt for @repo:      │
│  Rate limit          │  Retry with backoff     │
│  Webhook timeout     │  Poll for status        │
│  Agent failure       │  Forward error message  │
│  Network error       │  Retry + notify user    │
└─────────────────────────────────────────────────┘
```

## Scaling Considerations

- **Task Store**: Currently in-memory; could be Redis for multi-instance
- **Webhooks**: Single endpoint; load balance with sticky sessions
- **Rate Limits**: Cursor API has limits; queue requests if needed
