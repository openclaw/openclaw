# OpenClaw Architecture Report

**Project**: OpenClaw WhatsApp Gateway CLI
**Audit Date**: February 7, 2026

---

## Executive Summary

OpenClaw is a personal AI assistant platform that bridges messaging channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and 20+ extensions) to AI agents. It follows a microkernel architecture with a small core and extensive plugin system, supporting multi-agent routing, native desktop/mobile apps, and an OpenAI-compatible HTTP API.

---

## 1. System Architecture & Data Flow

### High-Level Architecture

```
Native Apps (macOS/iOS/Android)
        ↓ WebSocket
    ┌──────────────────────────────────────────┐
    │            Gateway Server                 │
    │  ┌────────────────────────────────────┐  │
    │  │  WebSocket Protocol (JSON-RPC)     │  │
    │  │  HTTP Endpoints (OpenAI-compat)    │  │
    │  │  Control UI (Lit Web Components)   │  │
    │  └────────────────────────────────────┘  │
    │                                           │
    │  ┌──────────┐  ┌──────────┐  ┌────────┐ │
    │  │ Routing   │  │ Sessions │  │ Hooks  │ │
    │  │ Engine    │  │ Manager  │  │ System │ │
    │  └──────────┘  └──────────┘  └────────┘ │
    │                                           │
    │  ┌──────────────────────────────────────┐ │
    │  │          Agent Runtime               │ │
    │  │  Pi Embedded Runner → Tool Exec      │ │
    │  │  Model Selection → Auth Profiles     │ │
    │  │  System Prompts → Skills             │ │
    │  └──────────────────────────────────────┘ │
    │                                           │
    │  ┌──────────────────────────────────────┐ │
    │  │       Channel Adapters (Plugins)     │ │
    │  │  WhatsApp │ Telegram │ Discord │ ... │ │
    │  └──────────────────────────────────────┘ │
    └──────────────────────────────────────────┘
```

### Complete Message Flow

```
1. INBOUND MESSAGE
   Channel SDK (Baileys/Grammy/Carbon/etc.)
     → Channel Monitor (src/<channel>/monitor.ts)
     → Inbound Debouncer (batch rapid messages)
     → Allowlist Check (src/channels/allowlists/)
     → Mention/Command Gating (src/channels/mention-gating.ts)
     → Message Deduplication (LRU cache)
     → Route Resolution (src/routing/resolve-route.ts)
     → Session Key Construction (src/routing/session-key.ts)

2. AGENT PROCESSING
   Session Manager
     → Load/Create Session (src/config/sessions.ts)
     → Pi Embedded Runner (src/agents/pi-embedded-runner.ts)
       → System Prompt Construction (src/agents/system-prompt.ts)
       → Model Selection + Failover (src/agents/model-selection.ts)
       → Auth Profile Resolution (src/agents/auth-profiles.ts)
       → Tool Registration + Policy (src/agents/pi-tools.ts)
       → LLM API Call (anthropic/openai/google/etc.)
       → Tool Execution Loop
       → Response Streaming

3. OUTBOUND DELIVERY
   Block Stream Coalescer (src/auto-reply/block-stream.ts)
     → Message Chunking (src/auto-reply/chunk.ts)
     → Markdown Formatting (src/auto-reply/reply.ts)
     → Outbound Delivery (src/infra/outbound/deliver.ts)
     → Channel Send Adapter (src/<channel>/send.ts)
     → Gateway Broadcast (WebSocket → all clients)
```

---

## 2. CLI Architecture

### Entry Flow

```
openclaw.mjs
  → Enables Node compile cache
  → Imports dist/entry.js

src/entry.ts
  → Sets process.title = "openclaw"
  → Installs process warning filter
  → Normalizes environment variables
  → Respawns with --disable-warning=ExperimentalWarning if needed
  → Parses CLI profile (--profile flag)
  → Imports src/cli/run-main.ts

src/cli/run-main.ts
  → runCli(argv)
  → Lazy-loads subcommands (150ms faster startup)
  → Registers update notifier
  → Invokes Commander program

src/cli/program.ts (via program/)
  → build-program.ts: Creates Commander program
  → register.subclis.ts: Registers all subcommands
  → Each subcommand is a lazy-loaded module
```

### Dependency Injection Pattern

`src/cli/deps.ts` provides `createDefaultDeps()` which returns per-channel send functions. This enables testing without real channel connections:

```typescript
type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};
```

`createOutboundSendDeps(deps)` converts `CliDeps` to `OutboundSendDeps` for the delivery layer. Extend both when adding new outbound channels.

---

## 3. Agent Runtime

### Pi Embedded Runner

The core agent loop lives in `src/agents/pi-embedded-runner.ts`, wrapping the `@mariozechner/pi-*` SDK packages:

```
runEmbeddedPiAgent(options)
  ├─ Resolve agent config (agentId, workspace, models)
  ├─ Build system prompt (src/agents/system-prompt.ts)
  │   ├─ Agent identity (name, instructions, avatar)
  │   ├─ Bootstrap files (workspace context)
  │   ├─ Skills prompt (src/agents/skills.ts)
  │   ├─ Channel-specific context
  │   └─ Session history (with compaction)
  │
  ├─ Resolve model + auth profile
  │   ├─ Model selection (src/agents/model-selection.ts)
  │   ├─ Auth profile rotation (src/agents/auth-profiles.ts)
  │   ├─ Failover chain (src/agents/model-fallback.ts)
  │   └─ Provider-specific quirks (src/agents/model-compat.ts)
  │
  ├─ Register tools (src/agents/pi-tools.ts)
  │   ├─ Core tools: read, write, exec, browser, message
  │   ├─ OpenClaw tools: sessions, agents, camera, screen
  │   ├─ Channel tools: channel-specific actions
  │   ├─ Plugin tools: from extensions
  │   └─ Apply tool policy (global → agent → group → sender)
  │
  ├─ Execute agent loop
  │   ├─ Send to LLM API
  │   ├─ Process tool calls
  │   ├─ Handle streaming responses
  │   ├─ Compaction on context overflow
  │   └─ Auth profile rotation on failure
  │
  └─ Subscribe to events (src/agents/pi-embedded-subscribe.ts)
      ├─ Text streaming (soft chunking)
      ├─ Tool call summaries
      ├─ Block reply flushing
      └─ Lifecycle events (start, end, error)
```

### Tool Registration & Policy

Tools are registered in `src/agents/pi-tools.ts` and governed by a 6-layer policy:

```
Tool Policy Resolution (highest to lowest):
  1. Global policy (config.tools.allow)
  2. Provider restrictions (model-specific limits)
  3. Agent policy (config.agents.list[].tools)
  4. Group policy (per-group tool restrictions)
  5. Sender policy (owner-only tools)
  6. Owner restrictions (elevated commands)
```

### Session Management

Sessions are persisted per-agent as JSON files under `~/.openclaw/agents/<agentId>/sessions/`:

- Session key encodes: agentId + channel + accountId + peer
- DM scope modes: `main` (shared), `per-peer` (isolated), `per-channel-peer`, `per-account-channel-peer`
- Session repair: `src/agents/session-file-repair.ts` handles corrupted files
- Write locks: `src/agents/session-write-lock.ts` prevents concurrent corruption

---

## 4. Gateway Server Architecture

### Server Structure

The gateway server (`src/gateway/server.impl.ts`, 639 LOC) orchestrates:

```
Gateway Server
  ├─ HTTP Server (Express/Hono)
  │   ├─ /v1/chat/completions (OpenAI-compatible)
  │   ├─ /v1/responses (Open Responses API)
  │   ├─ /hooks/* (Webhook receivers)
  │   ├─ /ui/* (Control UI static files)
  │   └─ /health, /status endpoints
  │
  ├─ WebSocket Server (ws)
  │   ├─ JSON-RPC protocol (src/gateway/protocol/)
  │   ├─ Method handlers (src/gateway/server-methods/)
  │   │   ├─ agent.ts: Start/stop agent sessions
  │   │   ├─ chat.ts: Send/receive messages
  │   │   ├─ config.ts: Read/write configuration
  │   │   ├─ channels.ts: Channel management
  │   │   ├─ sessions.ts: Session CRUD
  │   │   ├─ devices.ts: Device registration
  │   │   ├─ skills.ts: Skill management
  │   │   └─ web.ts: Web provider methods
  │   │
  │   ├─ Broadcast system (src/gateway/server-broadcast.ts)
  │   │   ├─ Event-driven: agents emit → gateway broadcasts
  │   │   ├─ O(N) to all connected clients
  │   │   └─ No subscription filtering
  │   │
  │   └─ Client management
  │       ├─ Device auth (src/gateway/device-auth.ts)
  │       ├─ Connection lifecycle
  │       └─ Max payload limits (src/gateway/client.ts)
  │
  ├─ Channel Lifecycle (src/gateway/server-channels.ts)
  │   ├─ Start/stop channel monitors
  │   ├─ Handle reconnection
  │   └─ Status reporting
  │
  ├─ Plugin Hosting (src/gateway/server-plugins.ts)
  │   ├─ Load/unload plugins
  │   ├─ Plugin HTTP routes
  │   └─ Plugin WebSocket methods
  │
  ├─ Discovery (src/gateway/server-discovery.ts)
  │   ├─ mDNS (Bonjour) via @homebridge/ciao
  │   └─ LAN device discovery
  │
  └─ Cron (src/gateway/server-cron.ts)
      ├─ Scheduled tasks (via croner)
      └─ Per-agent cron jobs
```

### OpenAI-Compatible HTTP API

`src/gateway/openai-http.ts` provides `/v1/chat/completions`:

- Accepts OpenAI chat completion request format
- Routes to the agent's configured model
- Supports streaming (SSE) and non-streaming responses
- Authentication via `Authorization: Bearer <gateway_token>`
- Used by third-party tools (Continue.dev, Cursor, Aider)

---

## 5. Plugin/Extension System

### Plugin Discovery & Loading

```
Plugin Sources:
  1. Bundled: extensions/ directory (workspace packages)
  2. npm packages: openclaw-plugin-* or @*/openclaw-plugin-*
  3. Local paths: File system paths in config

Loading Pipeline (src/plugins/loader.ts):
  discoverOpenClawPlugins()
    ├─ Read openclaw.plugin.json manifests
    ├─ Read package.json "openclaw" field
    └─ Resolve entry point (index.js/index.ts)

  loadGatewayPlugins(options)
    ├─ Normalize config (resolve enable state, validate schemas)
    ├─ Create plugin runtime (OpenClawPluginApi)
    ├─ Load plugin modules (jiti for TypeScript support)
    ├─ Execute plugin.register(api)
    │   ├─ api.registerChannel() → Channel plugin
    │   ├─ api.registerTool() → Agent tools
    │   ├─ api.registerHook() → Lifecycle hooks
    │   ├─ api.registerGatewayMethod() → WebSocket handlers
    │   ├─ api.registerCommand() → CLI commands
    │   └─ api.registerService() → Long-running services
    └─ Build plugin registry (validate no conflicts)
```

### Extension Inventory

31 extensions, of which 12 have runtime dependencies:

| Category               | Extensions                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Messaging Channels** | bluebubbles, discord, feishu, googlechat, imessage, line, matrix, mattermost, msteams, nextcloud-talk, nostr, signal, slack, telegram, tlon, twitch, voice-call, whatsapp, zalo, zalouser |
| **Auth Providers**     | copilot-proxy, google-antigravity-auth, google-gemini-cli-auth, minimax-portal-auth, qwen-portal-auth                                                                                     |
| **Features**           | diagnostics-otel, llm-task, lobster, memory-core, memory-lancedb, open-prose                                                                                                              |

---

## 6. Configuration System

### Dual Schema System

- **Zod** (`src/config/zod-schema.ts`): Runtime validation with TypeScript type inference
- **TypeBox** (`src/config/types.*.ts`): JSON Schema export for Control UI config editor

### Config Resolution Order

```
1. Base config file (OPENCLAW_HOME/config.json5)
2. Include files (config.includes: ["path/to/other.json5"])
3. Environment variable substitution (${OPENAI_API_KEY})
4. Runtime overrides (env vars: OPENCLAW_*, CLAWDBOT_*)
5. Apply defaults (agent defaults, model defaults)
6. Normalize paths (resolve workspace dirs, auth dirs)
```

### Multi-Agent Configuration

```json5
{
  agents: {
    list: [
      {
        id: "openclaw",
        dir: "~/.openclaw/agents/openclaw",
        models: { default: "anthropic/claude-opus-4-6" },
        tools: { allow: "all" },
      },
      {
        id: "workbot",
        dir: "~/.openclaw/agents/workbot",
        models: { default: "openai/gpt-4" },
        tools: { allow: ["read", "write", "message"] },
      },
    ],
  },
  bindings: {
    routes: [
      { match: { channel: "telegram", accountId: "workbot" }, agentId: "workbot" },
      { match: { channel: "whatsapp" }, agentId: "openclaw" },
    ],
  },
}
```

---

## 7. Channel Abstraction & Routing

### Channel Registry

`src/channels/registry.ts` defines the built-in channel order and metadata. Plugin channels are added dynamically via `api.registerChannel()`.

### Routing System

`src/routing/resolve-route.ts` resolves which agent handles a message:

```
Binding Priority (highest to lowest):
  1. Peer match (specific chat/contact ID)
  2. Parent peer (thread inheritance)
  3. Guild match (Discord servers)
  4. Team match (Slack workspaces)
  5. Account match (specific channel account)
  6. Channel wildcard (any account on channel)
  7. Default agent (first in list)
```

### Session Key Construction

`src/routing/session-key.ts` builds keys like: `openclaw:main:whatsapp:default:+1234567890`

DM Scope Modes:

- `main`: All DMs share one session (default)
- `per-peer`: Each contact gets isolated session
- `per-channel-peer`: Isolated per channel + contact
- `per-account-channel-peer`: Full isolation

### Allowlists & Command Gating

- **DM access**: `dmPolicy` (open/pairing/closed) → pairing store → explicit allowlist
- **Group access**: `config.channels.<channel>.groups.allowFrom` → group ID match
- **Command gating** (`src/channels/command-gating.ts`): Require @bot mention, keyword, or slash command
- **Mention gating** (`src/channels/mention-gating.ts`): Process only when bot is mentioned in groups

---

## 8. Build & Module System

### Build Pipeline

```
pnpm build
  ├─ pnpm canvas:a2ui:bundle → Bundle A2UI renderer (Lit components)
  ├─ tsdown → Bundle TypeScript to dist/
  │   ├─ src/index.ts → dist/index.js (library)
  │   ├─ src/entry.ts → dist/entry.js (CLI)
  │   ├─ src/plugin-sdk/index.ts → dist/plugin-sdk/index.js
  │   └─ src/extensionAPI.ts → dist/extensionAPI.js
  ├─ tsc -p tsconfig.plugin-sdk.dts.json → Plugin SDK types
  ├─ scripts/write-plugin-sdk-entry-dts.ts
  ├─ scripts/canvas-a2ui-copy.ts
  ├─ scripts/copy-hook-metadata.ts
  ├─ scripts/write-build-info.ts
  └─ scripts/write-cli-compat.ts
```

### Package Exports

```json
{
  ".": "./dist/index.js",
  "./plugin-sdk": "./dist/plugin-sdk/index.js",
  "./cli-entry": "./openclaw.mjs"
}
```

### Native Apps Integration

Native apps connect to the gateway server via WebSocket:

- **macOS** (`apps/macos/`): Swift + SwiftUI, embeds Node.js, spawns gateway process, menu bar app
- **iOS** (`apps/ios/`): Swift + SwiftUI, connects to remote gateway, mobile node role (camera/screen/mic)
- **Android** (`apps/android/`): Kotlin + Jetpack Compose, connects to remote gateway, mobile node role
- **Shared** (`apps/shared/`): OpenClawKit framework shared between macOS/iOS

Protocol codegen: TypeScript types → `scripts/protocol-gen-swift.ts` → `GatewayModels.swift`

---

## 9. Architectural Patterns

### Key Patterns

| Pattern                    | Implementation                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Microkernel**            | Small core + plugin extensions                                                     |
| **Event-Driven Messaging** | Agent events broadcast to all connected clients; dedupe layer prevents duplicates  |
| **Dependency Injection**   | `createDefaultDeps()` for channel send functions; enables testing                  |
| **Repository**             | Config store (JSON5), Session store (per-agent JSON), Auth profiles, Pairing store |
| **Factory**                | `createOpenClawCodingTools()`, `createChannelHandler()`, `createDefaultDeps()`     |
| **Strategy**               | Tool policy resolution, DM scope modes, channel authentication methods             |
| **Layered Architecture**   | CLI → Gateway → Agent Runtime → Channel Adapters                                   |

### Separation of Concerns

**Well-Separated**:

- CLI vs Gateway (can run separately)
- Gateway vs Agent Runtime (RPC boundary)
- Channel abstraction (plugin interface)
- Config vs Runtime State (immutable config, mutable runtime)

**Could Improve**:

- `src/gateway/server.impl.ts` (639 LOC) orchestrates too many concerns
- `src/config/io.ts` mixes I/O, validation, and transformation
- Auto-reply system spans 10+ files

### Coupling Analysis

**Low Coupling**: Plugins are isolated; channel implementations don't depend on each other; CLI commands are independently testable.

**Moderate Coupling**: Agent runtime tightly coupled to Pi SDK (`@mariozechner/pi-*`); gateway server depends on many subsystems.

**High Coupling**: Tool registration couples agent runtime to channel-specific logic; session management couples routing, config, and persistence.

---

## 10. Technical Debt & Improvement Opportunities

### 1. Monolithic Gateway Server

`server.impl.ts` (639 LOC) orchestrates channels, discovery, maintenance, cron, and more. Recommendation: extract subsystem builders.

### 2. Config System Fragmentation

Dual schema (Zod + TypeBox) with 80+ config type files adds maintenance burden. Recommendation: consolidate or auto-generate TypeBox from Zod.

### 3. Session Store Persistence

No transaction support (concurrent writes can corrupt), no compression. Recommendation: use SQLite or atomic write-rename pattern.

### 4. Tool Policy Complexity

6-layer policy resolution adds debugging difficulty. Recommendation: simplify to 3 layers (global, agent, group).

### 5. Missing Observability

No structured tracing (OpenTelemetry spans for key operations). Limited metrics collection (usage tracking only).

### 6. Error Handling Inconsistency

Some modules throw, others return Result types. Error messages lack context (file paths, session keys). Recommendation: adopt `Result<T, E>` pattern consistently.

### Performance Considerations

**Strengths**: Lazy subcommand loading (150ms faster startup), config caching, message dedupe, block streaming coalescing.

**Bottlenecks**: Session store I/O blocks agent runtime (synchronous JSON writes), config validation on every load, plugin discovery scans node_modules, WebSocket broadcast O(N) with no subscription filtering.

---

## 11. Essential Files Reference

### Core Entry Points

1. `openclaw.mjs` - CLI entry shim
2. `src/entry.ts` - Bootstrap and respawn
3. `src/cli/run-main.ts` - CLI orchestrator
4. `src/index.ts` - Library exports

### Gateway Server

5. `src/gateway/server.impl.ts` - Main server
6. `src/gateway/server-methods.ts` - Method handlers
7. `src/gateway/server-channels.ts` - Channel lifecycle
8. `src/gateway/openai-http.ts` - OpenAI-compatible API

### Agent Runtime

9. `src/agents/pi-embedded-runner.ts` - Agent loop
10. `src/agents/pi-tools.ts` - Tool registration
11. `src/agents/auth-profiles.ts` - Auth management
12. `src/agents/system-prompt.ts` - System prompt construction

### Configuration

13. `src/config/io.ts` - Config loading
14. `src/config/zod-schema.ts` - Config schema
15. `src/config/sessions.ts` - Session persistence

### Routing & Channels

16. `src/routing/resolve-route.ts` - Agent routing
17. `src/channels/registry.ts` - Channel registry
18. `src/channels/plugins/` - Plugin channel interface

### Plugin System

19. `src/plugins/loader.ts` - Plugin loading
20. `src/plugins/runtime.ts` - Global registry
21. `src/plugin-sdk/index.ts` - Plugin SDK
