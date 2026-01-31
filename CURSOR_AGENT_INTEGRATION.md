# Cursor Agent Integration for OpenClaw

## Executive Summary

This document analyzes the feasibility of integrating **Cursor Agent** (Cursor's Background Agents API) with **OpenClaw** as a new channel extension. Based on the codebase analysis, there is **no existing integration**, but OpenClaw's plugin architecture makes this integration highly feasible.

## What is Cursor Agent?

**Cursor Agent** is Cursor's AI coding assistant that can:

- Complete complex coding tasks independently
- Run terminal commands
- Edit code files
- Search codebases semantically
- Execute browser automation
- Generate images

**Cursor Background Agents API** provides:

- **Programmatic agent launch** - Launch agents via API with instructions, tools, and context
- **Webhook support** - Receive real-time notifications about agent status changes (`statusChange` events)
- **HTTP-based integration** - REST API endpoints for agent management

## OpenClaw Integration Architecture

### Current Channel Structure

OpenClaw channels are implemented as **plugins** that implement the `ChannelPlugin` interface. There are two types:

1. **Core Channels** (`src/channels/` + `src/{channel}/`) - Built-in channels like Discord, Slack, Telegram
2. **Extension Channels** (`extensions/{channel}/`) - External plugins like Twitch, Zalo, Matrix

### Integration Pattern

Based on the Twitch extension example (`extensions/twitch/`), a Cursor Agent integration would follow this pattern:

```
extensions/cursor-agent/
├── index.ts                    # Plugin entry point
├── src/
│   ├── plugin.ts              # ChannelPlugin implementation
│   ├── config-schema.ts       # Configuration schema
│   ├── config.ts              # Config management
│   ├── monitor.ts             # Webhook listener for agent events
│   ├── outbound.ts            # Send messages/tasks to Cursor Agent
│   ├── onboarding.ts          # Setup wizard
│   ├── status.ts              # Health checks
│   ├── types.ts               # TypeScript types
│   └── api.ts                 # Cursor API client
```

### Key Components Needed

#### 1. **Channel Plugin** (`plugin.ts`)

Implements `ChannelPlugin` interface with:

- **Meta**: Channel metadata (id: "cursor-agent", label: "Cursor Agent")
- **Capabilities**: `{ chatTypes: ["dm"] }` (likely DM-only initially)
- **Config Schema**: API keys, webhook URLs, workspace paths
- **Outbound Adapter**: Send tasks/messages to Cursor Agent API
- **Gateway Adapter**: Start/stop webhook listener
- **Status Adapter**: Health checks and connection status

#### 2. **API Client** (`api.ts`)

HTTP client for Cursor Background Agents API:

- Launch agent with instructions
- Poll agent status
- Handle webhook verification
- Manage agent lifecycle

#### 3. **Monitor** (`monitor.ts`)

Webhook listener that:

- Receives `statusChange` events from Cursor
- Processes agent completion/results
- Routes responses back to OpenClaw sessions
- Handles webhook signature verification

#### 4. **Outbound** (`outbound.ts`)

Sends messages to Cursor Agent:

- Converts OpenClaw messages to Cursor agent tasks
- Maps OpenClaw context to Cursor instructions
- Handles file attachments (code files, etc.)

#### 5. **Onboarding** (`onboarding.ts`)

Setup wizard for:

- API key configuration
- Webhook URL setup
- Workspace path selection
- Test connection

## Integration Approach

### Option 1: Channel Integration (Recommended)

**Treat Cursor Agent as a messaging channel** where:

- OpenClaw sends coding tasks to Cursor Agent
- Cursor Agent executes tasks and sends results back
- Two-way communication via webhooks

**Pros:**

- Fits existing OpenClaw architecture perfectly
- Can route Cursor Agent responses to any OpenClaw channel
- Leverages existing session management

**Cons:**

- Cursor Agent is more of a tool than a chat channel
- May need custom message formatting

### Option 2: Tool Integration

**Integrate Cursor Agent as an agent tool** (like `browser`, `canvas`, `nodes`):

- Add `cursor_agent` tool to OpenClaw's tool registry
- Agent can invoke Cursor Agent for coding tasks
- Results returned as tool outputs

**Pros:**

- More natural fit for Cursor Agent's purpose
- Can be used by any OpenClaw agent

**Cons:**

- Requires different integration pattern
- May need async handling for long-running tasks

### Option 3: Hybrid Approach (Best)

**Both channel AND tool integration:**

- Channel for direct Cursor Agent communication
- Tool for agent-to-agent usage

## Implementation Details

### Configuration Schema

```typescript
{
  channels: {
    cursorAgent: {
      accounts: {
        default: {
          enabled: true,
          apiKey: string,           // Cursor API key
          webhookUrl?: string,       // OpenClaw webhook endpoint
          webhookSecret?: string,    // Webhook verification secret
          workspacePath?: string,    // Default workspace for agents
          defaultModel?: string,     // Cursor model preference
        }
      }
    }
  }
}
```

### Message Flow

1. **User sends message** → OpenClaw receives via WhatsApp/Telegram/etc.
2. **OpenClaw routes** → Determines if message should go to Cursor Agent
3. **Outbound adapter** → Converts message to Cursor agent task:
   ```json
   {
     "instructions": "Fix the bug in src/utils.ts",
     "context": { "files": ["src/utils.ts"] },
     "webhookUrl": "https://openclaw.example.com/webhooks/cursor-agent"
   }
   ```
4. **Cursor Agent executes** → Runs task, makes changes
5. **Webhook received** → OpenClaw receives `statusChange` event
6. **Monitor processes** → Extracts results, updates session
7. **Response sent** → Results sent back to original channel

### Webhook Handler

```typescript
// extensions/cursor-agent/src/monitor.ts
export async function monitorCursorAgentProvider(options: {
  account: CursorAccountConfig;
  accountId: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
}): Promise<void> {
  // Register webhook endpoint
  // Listen for statusChange events
  // Process agent results
  // Route back to OpenClaw sessions
}
```

## Inspiration from Existing Integrations

### From Twitch Extension

- **Monitor pattern**: Long-running connection that processes incoming events
- **Client manager**: Registry for managing multiple connections
- **Status tracking**: Runtime state management

### From Zalo Extension

- **Webhook handling**: Secure webhook verification
- **Polling fallback**: Alternative to webhooks if needed
- **Onboarding flow**: Step-by-step setup wizard

### From Discord/Slack Extensions

- **Message normalization**: Convert platform-specific formats
- **Action handling**: React to user interactions
- **Directory integration**: User/channel resolution

## Technical Considerations

### 1. **API Authentication**

- Cursor API requires API keys
- Webhook verification via signatures
- Rate limiting considerations

### 2. **Async Task Handling**

- Cursor Agent tasks can be long-running
- Need to handle pending states
- Store task IDs for correlation

### 3. **Context Management**

- Map OpenClaw workspace to Cursor workspace
- Handle file references
- Preserve conversation context

### 4. **Error Handling**

- API failures
- Webhook delivery failures
- Agent execution errors

### 5. **Security**

- Validate webhook signatures
- Sanitize user inputs
- Rate limit API calls

## Next Steps

1. **Research Cursor API**
   - [ ] Get API documentation
   - [ ] Understand authentication
   - [ ] Test webhook flow
   - [ ] Identify rate limits

2. **Create Extension Structure**
   - [ ] Set up `extensions/cursor-agent/` directory
   - [ ] Implement basic plugin structure
   - [ ] Create config schema
   - [ ] Add types

3. **Implement Core Features**
   - [ ] API client for agent launch
   - [ ] Webhook handler
   - [ ] Outbound adapter
   - [ ] Status monitoring

4. **Integration Testing**
   - [ ] Test with real Cursor API
   - [ ] Verify webhook flow
   - [ ] Test error scenarios

5. **Documentation**
   - [ ] Usage guide
   - [ ] Configuration examples
   - [ ] Troubleshooting

## References

- [Cursor Agent Overview](https://cursor.com/docs/agent/overview)
- [Cursor Background Agents API](https://docs.cursor.com/en/background-agent/api/launch-an-agent)
- [Cursor Webhooks](https://docs.cursor.com/en/background-agent/api/webhooks)
- [OpenClaw Channel Plugins](https://github.com/openclaw/openclaw/tree/main/src/channels/plugins)
- [OpenClaw Plugin SDK](https://github.com/openclaw/openclaw/tree/main/src/plugin-sdk)
- [Twitch Extension Example](https://github.com/openclaw/openclaw/tree/main/extensions/twitch)

## Questions to Resolve

1. **API Access**: Does Cursor provide public API access, or is it enterprise-only?
2. **Webhook Format**: What is the exact webhook payload structure?
3. **Task Results**: How are agent execution results returned?
4. **Workspace Sync**: How to sync OpenClaw workspace with Cursor workspace?
5. **File Handling**: How to handle file attachments and code references?
