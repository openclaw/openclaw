# OpenClaw Architecture

> A comprehensive guide to OpenClaw's codebase structure, design patterns, and message flow.

## Table of Contents

1. [Overview](#overview)
2. [Project Structure](#project-structure)
3. [Entry Points](#entry-points)
4. [Message Flow](#message-flow)
5. [Gateway Architecture](#gateway-architecture)
6. [Channel System](#channel-system)
7. [Agent Execution](#agent-execution)
8. [Provider System](#provider-system)
9. [Tool System](#tool-system)
10. [Skills System](#skills-system)
11. [Plugin System](#plugin-system)
12. [Configuration](#configuration)
13. [Key Design Patterns](#key-design-patterns)
14. [Extension Points](#extension-points)

---

## Overview

OpenClaw is a multi-channel AI assistant platform that routes messages from various chat platforms (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.) through a unified gateway to AI model providers (Anthropic Claude, OpenAI, Google Gemini, etc.).

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Devices                                 │
│   WhatsApp  │  Telegram  │  Discord  │  Slack  │  Signal  │  ...    │
└──────┬──────┴─────┬──────┴─────┬─────┴────┬────┴────┬─────┴─────────┘
       │            │            │          │         │
       └────────────┴────────────┴──────────┴─────────┘
                              │
                    ┌─────────▼─────────┐
                    │     Gateway       │
                    │  (WebSocket/HTTP) │
                    └─────────┬─────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   ┌──────▼──────┐    ┌───────▼───────┐   ┌──────▼──────┐
   │   Routing   │    │    Agent      │   │   Config    │
   │  (Sessions) │    │  (PI Core)    │   │   Reload    │
   └──────┬──────┘    └───────┬───────┘   └─────────────┘
          │                   │
          │           ┌───────▼───────┐
          │           │    Tools      │
          │           │  (60+ tools)  │
          │           └───────┬───────┘
          │                   │
          └───────────────────┼───────────────────┐
                              │                   │
                    ┌─────────▼─────────┐  ┌──────▼──────┐
                    │   AI Providers    │  │   Skills    │
                    │ Claude/GPT/Gemini │  │  (Bundled)  │
                    └───────────────────┘  └─────────────┘
```

---

## Project Structure

### Core Directories (`/src/`)

| Directory | Purpose |
|-----------|---------|
| `cli/` | Command-line interface, Commander program, commands |
| `commands/` | CLI command implementations (send, status, login, etc.) |
| `gateway/` | WebSocket/HTTP server, channel coordination |
| `agents/` | Agent execution (PI core), tools, skills |
| `channels/` | Channel abstractions, plugins, routing |
| `auto-reply/` | Message dispatch, response generation |
| `routing/` | Session key resolution and normalization |
| `config/` | Configuration loading, validation, sessions |
| `plugins/` | Plugin discovery, loading, registry |
| `infra/` | Infrastructure (logging, errors, binary management) |

### Channel-Specific Directories

| Directory | Channel |
|-----------|---------|
| `telegram/` | Telegram Bot API (grammy) |
| `discord/` | Discord.js integration |
| `whatsapp/` | WhatsApp Web via Baileys |
| `slack/` | Slack Bolt SDK |
| `signal/` | Signal via signal-cli |
| `imessage/` | iMessage via BlueBubbles |
| `web/` | WhatsApp Web provider |

### Extensions (`/extensions/`)

Plugin-based extensions for additional channels, providers, and features:

- **Channels:** `googlechat`, `line`, `matrix`, `msteams`, `zalo`, `zalouser`
- **Providers:** `copilot-proxy`, `google-gemini-cli-auth`, `qwen-portal-auth`
- **Memory:** `memory-core`, `memory-lancedb`
- **Features:** `voice-call`, `lobster`, `llm-task`

---

## Entry Points

### CLI Entry (`/src/index.ts`)

```typescript
// Main CLI entry point
export { buildProgram } from "./cli/program/build-program.js"
export { runCli } from "./cli/run.js"
```

- Loads environment and configuration
- Builds Commander program with all commands
- Exports public API for programmatic use

### Process Wrapper (`/src/entry.ts`)

- Suppresses experimental Node.js warnings
- Platform-specific normalization (Windows arg fixing)
- Handles CLI profile selection and respawning

### Gateway Entry (`/src/gateway/server.impl.ts`)

- Initializes all gateway subsystems
- Starts WebSocket/HTTP server
- Coordinates channel lifecycle

---

## Message Flow

### Incoming Message Pipeline

```
1. Channel Webhook/Listener
   └── src/telegram/bot-handlers.ts
   └── src/whatsapp/message-handler.ts
   └── etc.
        │
2. Message Normalization
   └── src/auto-reply/dispatch.ts
   └── dispatchInboundMessage()
        │
3. Session Routing
   └── src/routing/session-key.ts
   └── Resolves: agent:main:telegram:dm:123456
        │
4. Agent Dispatch
   └── src/auto-reply/reply/dispatch-from-config.ts
   └── Routes to configured agent
        │
5. Agent Execution
   └── src/agents/pi-embedded-runner.ts
   └── runEmbeddedPiAgent()
        │
6. AI Provider Call
   └── src/auto-reply/reply/provider-dispatcher.ts
   └── Claude, GPT, Gemini, etc.
        │
7. Response Streaming
   └── src/agents/pi-embedded-block-chunker.ts
   └── Smart paragraph/code block detection
        │
8. Channel Delivery
   └── src/telegram/send.ts
   └── src/whatsapp/send.ts
   └── etc.
```

### Session Key Format

Session keys determine conversation context:

```
agent:{agentId}:{mainKey}
agent:{agentId}:{channel}:{accountId}:{peerId}

Examples:
- agent:main:main                    # Default session
- agent:main:telegram:dm:123456      # Telegram DM
- agent:main:discord:guild:789       # Discord server
```

**Resolution:** `src/routing/session-key.ts`

---

## Gateway Architecture

### Purpose

The gateway is a centralized WebSocket server that:
- Manages channel lifecycle (start/stop/status)
- Routes messages between channels and agents
- Coordinates agent execution and events
- Provides hot-reload for configuration
- Handles device/client pairing

### Core Files

| File | Purpose |
|------|---------|
| `server.impl.ts` | Main server bootstrap |
| `server-channels.ts` | Channel manager (`createChannelManager`) |
| `server-chat.ts` | Agent event streaming |
| `server-methods.ts` | RPC method handlers |
| `protocol/` | WebSocket protocol definitions |

### WebSocket Protocol

Methods available via WebSocket/HTTP:
- `agent` - Agent control and events
- `chat` - Message sending
- `config` - Configuration queries
- `sessions` - Session management
- `channels` - Channel status and control
- `health` - Health checks

---

## Channel System

### Channel Registry

```typescript
// src/channels/registry.ts
const CHAT_CHANNEL_ORDER = [
  "telegram", "whatsapp", "discord",
  "googlechat", "slack", "signal", "imessage"
]
```

### Channel Plugin Interface

Each channel implements adapters:

```typescript
// src/channels/plugins/types.plugin.ts
type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId
  meta: ChannelMeta
  capabilities: ChannelCapabilities

  // Core adapters
  config: ChannelConfigAdapter<ResolvedAccount>
  outbound?: ChannelOutboundAdapter
  gateway?: ChannelGatewayAdapter<ResolvedAccount>
  messaging?: ChannelMessagingAdapter

  // Feature adapters
  groups?: ChannelGroupAdapter
  mentions?: ChannelMentionAdapter
  threading?: ChannelThreadingAdapter
  commands?: ChannelCommandAdapter
}
```

### Channel Dock (Metadata)

```typescript
// src/channels/dock.ts
interface ChannelDock {
  capabilities: {
    chatTypes: ("dm" | "group")[]
    nativeCommands: boolean
    reactions: boolean
    media: MediaCapabilities
    threads: boolean
    blockStreaming: boolean
  }
  outboundLimits: {
    maxTextLength: number  // e.g., Telegram: 4000, Discord: 2000
  }
}
```

---

## Agent Execution

### PI Embedded Runner

The agent execution engine uses PI Agent Core:

```typescript
// src/agents/pi-embedded-runner.ts
async function runEmbeddedPiAgent(ctx: AgentRunContext): Promise<void> {
  // 1. Load session history
  // 2. Resolve auth profiles (Anthropic, OpenAI, etc.)
  // 3. Build system prompt with available tools
  // 4. Execute agent loop
  // 5. Emit events and stream responses
}
```

### Agent Events

```typescript
// src/infra/agent-events.ts
type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error"

type AgentEventPayload = {
  runId: string
  seq: number
  stream: AgentEventStream
  ts: number
  data: Record<string, unknown>
  sessionKey?: string
}
```

Events are broadcast to connected clients in real-time.

---

## Provider System

### Supported Providers

| Provider | Models |
|----------|--------|
| Anthropic | Claude 3.5, Claude 3 Opus/Sonnet/Haiku |
| OpenAI | GPT-4o, GPT-4 Turbo, o1 |
| Google | Gemini 2.0, 1.5 Pro/Flash |
| AWS Bedrock | Claude, Titan |
| Ollama | Local models |
| GitHub Copilot | Token exchange |

### Model Configuration

```typescript
// src/agents/models-config.providers.ts
interface ModelDefinitionConfig {
  id: string
  name: string
  cost: { input, output, cacheRead, cacheWrite }
  contextWindow: number
  maxTokens: number
  input: ("text" | "image" | "audio")[]
  reasoning?: boolean
}
```

### Auth Profiles

```typescript
// src/agents/auth-profiles.ts
// Manages multiple credentials per provider
// Fallback ordering: Current → Last used → Explicit → First available
```

---

## Tool System

### Tool Categories

OpenClaw includes ~60 tools organized by function:

| Category | Tools | Location |
|----------|-------|----------|
| **Messaging** | send, edit, react, fetch | `tools/message-tool.ts` |
| **Browser** | navigate, click, screenshot | `tools/browser-tool.ts` |
| **Web** | fetch, search | `tools/web-fetch.ts`, `web-search.ts` |
| **Media** | image gen, TTS | `tools/image-tool.ts`, `tts-tool.ts` |
| **System** | bash, gateway, nodes | `tools/bash-tools.exec.ts` |
| **Channel** | telegram, discord, slack actions | `tools/*-actions.ts` |

### Tool Schema Definition

Uses TypeBox for type-safe schemas:

```typescript
// Example from message-tool.ts
const buildSendSchema = () => ({
  message: Type.Optional(Type.String()),
  media: Type.Optional(Type.String()),
  buttons: Type.Optional(Type.Array(buttonSchema)),
  target: Type.Optional(channelTargetSchema())
})
```

### Tool Policy

```typescript
// src/agents/pi-tools.policy.ts
// Controls which tools are available per session
// Filters based on: config, allowlists, channel type, sandbox mode
```

---

## Skills System

### What are Skills?

Skills are bundled or custom commands that agents can invoke. They're discovered from the workspace and loaded via YAML frontmatter.

### Skill Metadata

```yaml
---
name: Weather
source: openclaw-bundled
description: Get weather forecasts
os: [darwin, linux, win32]
requires:
  bins: [curl]
  env: []
---
```

### Skill Discovery

1. Bundled: `/extensions/*/skills/`
2. Workspace: `~/.clawdbot/agents/<agentId>/skills/`
3. Filtered by: OS, binaries, env vars, config paths

### Key Files

| File | Purpose |
|------|---------|
| `skills/types.ts` | Skill metadata types |
| `skills/workspace.ts` | Discovery and loading |
| `skills/frontmatter.ts` | YAML parsing |
| `skills/config.ts` | Eligibility checking |

---

## Plugin System

### Plugin Registry

```typescript
// src/plugins/registry.ts
type PluginRegistry = {
  plugins: PluginRecord[]
  tools: PluginToolRegistration[]
  hooks: PluginHookRegistration[]
  channels: PluginChannelRegistration[]
  providers: PluginProviderRegistration[]
  gatewayHandlers: GatewayRequestHandlers
  httpHandlers: PluginHttpRegistration[]
  cliRegistrars: PluginCliRegistration[]
  services: PluginServiceRegistration[]
  commands: PluginCommandRegistration[]
}
```

### Plugin API

```typescript
// src/plugins/types.ts
type OpenClawPluginApi = {
  id: string
  logger: PluginLogger

  // Registration methods
  registerTool(factory, options)
  registerHook(name, handler, options)
  registerChannel(plugin)
  registerProvider(provider)
  registerCliCommand(definition)
  registerGatewayHandler(path, handler)
  registerHttpHandler(handler)
  registerService(service)
}
```

### Plugin Loading

```typescript
// src/plugins/loader.ts
// 1. Discovers plugins from ~/.clawdbot/plugins/ and bundled extensions
// 2. Loads via dynamic import
// 3. Validates manifests
// 4. Registers with global registry
```

---

## Configuration

### Config Schema

```typescript
// src/config/types.ts
type OpenClawConfig = {
  agents?: Record<string, AgentConfig>
  channels?: {
    telegram?: TelegramConfig
    whatsapp?: WhatsAppConfig
    discord?: DiscordConfig
    slack?: SlackConfig
    signal?: SignalConfig
    // ...
  }
  models?: ModelProviderConfig[]
  hooks?: HookConfig[]
  sandbox?: SandboxConfig
}
```

### Config Locations

- Global: `~/.clawdbot/openclaw.json` or `~/.openclaw/openclaw.json`
- Sessions: `~/.clawdbot/sessions/{sessionKey}.jsonl`

### Hot Reload

```typescript
// src/gateway/config-reload.ts
// Detects file changes and reloads:
// - Channel configurations
// - Model providers
// - Skills
// - Agent settings
```

---

## Key Design Patterns

### 1. Dependency Injection

```typescript
// src/cli/deps.ts
function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp,
    sendMessageTelegram,
    sendMessageDiscord,
    // ...
  }
}
```

### 2. Factory Pattern

- Channel plugins created per account
- Tool factories receive context
- Adapters are functions receiving config

### 3. Plugin Slots

- **Hooks:** Named events with handler registration
- **Gateway methods:** RPC handlers per channel
- **HTTP routes:** Extensible routing

### 4. Session-Based Routing

```
agent:{agentId} → channel → account → peer
```

Resolves to correct session storage and conversation context.

### 5. Block Streaming

Messages streamed in semantic blocks (paragraphs, code blocks) for:
- Reduced token count
- Improved perceived responsiveness
- Better formatting

---

## Extension Points

### Adding a Channel

1. Create plugin in `extensions/{channelId}/`
2. Implement `ChannelPlugin` with adapters
3. Register in plugin `index.ts`

### Adding a Provider

1. Create `ProviderPlugin` in plugin
2. Implement auth flow
3. Define model capabilities

### Adding Tools

```typescript
api.registerTool(
  (ctx) => ({
    name: "my_tool",
    description: "Does something",
    inputSchema: mySchema,
    execute: async (input) => { /* ... */ }
  }),
  { category: "custom" }
)
```

### Adding Hooks

```typescript
api.registerHook("message:received", async (msg) => {
  // Handle incoming message
})
```

### Adding Gateway Methods

```typescript
api.registerGatewayHandler("custom/method", async (req, res) => {
  // Handle RPC request
})
```

---

## Critical Files Reference

| Purpose | File |
|---------|------|
| CLI entry | `src/index.ts` |
| Gateway bootstrap | `src/gateway/server.impl.ts` |
| Message dispatch | `src/auto-reply/dispatch.ts` |
| Agent execution | `src/agents/pi-embedded-runner.ts` |
| Session routing | `src/routing/session-key.ts` |
| Tool definitions | `src/agents/tools/` |
| Skill loading | `src/agents/skills/workspace.ts` |
| Plugin registry | `src/plugins/registry.ts` |
| Channel plugins | `src/channels/plugins/` |
| Config types | `src/config/types.ts` |

---

*Generated by OpenClaw architecture review*
