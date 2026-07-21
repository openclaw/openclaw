# 🦞 OpenClaw → Mythos-Class: Complete Technical & Architectural Specification
## Engineering Mythos-Class Capabilities on a Rust-Based Polyglot Architecture

**Version**: 1.0.0 — 2026-07-20  
**Repository**: `openclaw/openclaw` @ `2026.5.10-beta.1`  
**License**: MIT  
**Branch**: `arena/019f8084-openclaw`

---

## TABLE OF CONTENTS

1. [Platform Genesis & Scale Metrics](#i-platform-genesis--scale-metrics)
2. [Monorepo Structure & Build System](#ii-monorepo-structure--build-system)
3. [Seven-Component Architecture Model](#iii-seven-component-architecture-model)
4. [Gateway — Control Plane (Deep Code Paths)](#iv-gateway--control-plane)
5. [Agent Runtime — The Cognition Engine](#v-agent-runtime--the-cognition-engine)
6. [Tool System — Execution Capabilities](#vi-tool-system--execution-capabilities)
7. [MCP Dual-Role Architecture](#vii-mcp-dual-role-architecture)
8. [Memory System — 4-Layer Architecture](#viii-memory-system--4-layer-architecture)
9. [Dreaming System — Neuromorphic Consolidation](#ix-dreaming-system--neuromorphic-consolidation)
10. [Channel System — Multi-Platform Adapters](#x-channel-system--multi-platform-adapters)
11. [ACP — Agent Client Protocol](#xi-acp--agent-client-protocol)
12. [TaskFlow — Durable Orchestration](#xii-taskflow--durable-orchestration)
13. [Lobster — YAML Workflow Engine](#xiii-lobster--yaml-workflow-engine)
14. [Cron & Automation Engine](#xiv-cron--automation-engine)
15. [Security Architecture](#xv-security-architecture)
16. [Native Client Stack (Swift/SwiftUI)](#xvi-native-client-stack)
17. [Plugin SDK & Extension System](#xvii-plugin-sdk--extension-system)
18. [Rust/Polyglot Integration Surface](#xviii-rustpolyglot-integration-surface)
19. [Mythos-Class Transformation Blueprint](#xix-mythos-class-transformation-blueprint)
20. [Complete Subsystem Code Map](#xx-complete-subsystem-code-map)

---

## I. PLATFORM GENESIS & SCALE METRICS

### Repository Scale (Measured 2026-07-20)

| Dimension | Count |
|---|---|
| **Core TypeScript (src/)** | 7,883 files, ~306,398 lines |
| **Extensions (133 plugins)** | ~578,595 lines TypeScript |
| **Native Swift Apps** | macOS, iOS, watchOS, Android |
| **Gateway Protocol Schemas** | 25 TypeBox schema modules |
| **Plugin SDK Surface** | 300+ exported types/functions |
| **CLI Commands** | 150+ commands |
| **Test Files** | ~3,000+ colocated `.test.ts` |
| **Package Manager** | pnpm 10.33.2 (monorepo workspace) |
| **Node.js** | >= 22.16.0 (runtime) |
| **TypeScript** | 6.0.3 (tsgo native compiler) |
| **Build Tool** | tsdown (Rolldown-based bundler) |
| **Test Framework** | Vitest 4.1.5 |
| **Linting** | oxlint 1.63.0 + oxfmt 0.48.0 |

### Dependency Architecture

**Core Runtime Dependencies** (from `package.json`):

```
@agentclientprotocol/sdk 0.21.0     — ACP JSON-RPC protocol
@anthropic-ai/sdk 0.95.1            — Claude provider
@anthropic-ai/vertex-sdk ^0.16.0    — Claude on Vertex
@aws-sdk/client-bedrock 3.1045.0    — Bedrock provider
@google/genai ^2.0.1                — Gemini provider
@grammyjs/runner ^2.0.3             — Telegram runner
@homebridge/ciao ^1.3.8             — mDNS/Bonjour discovery
@lydell/node-pty 1.2.0-beta.12      — PTY terminal emulation
@mariozechner/pi-agent-core 0.73.1  — Pi agent framework
@mariozechner/pi-coding-agent 0.73.1 — Pi coding agent
@modelcontextprotocol/sdk 1.29.0    — MCP protocol
@slack/bolt ^4.7.2                  — Slack adapter
baileys (WhatsApp)                   — WhatsApp Web protocol
chokidar ^5.0.0                      — File watching
commander ^14.0.3                    — CLI framework
croner ^10.0.1                       — Cron scheduling
express 5.2.1                        — HTTP server
grammy ^1.42.0                       — Telegram Bot API
kysely 0.29.0                        — SQL query builder
linkedom ^0.18.12                    — DOM parsing
markdown-it 14.1.1                   — Markdown rendering
openshell 0.1.0                      — Sandbox backend
playwright-core 1.59.1               — Browser automation
sqlite-vec 0.1.9                     — Vector search (Rust native)
typebox 1.1.38                       — JSON Schema / TypeBox
undici 8.2.0                         — HTTP client
web-push ^3.6.7                      — Push notifications
web-tree-sitter ^0.26.8              — Incremental parsing
ws ^8.20.0                           — WebSocket server
zod ^4.4.3                           — Runtime validation
```

**Native/Rust-Adjacent Dependencies**:

| Package | Language | Role |
|---|---|---|
| `sqlite-vec` | **Rust** | Vector similarity search extension for SQLite |
| `sharp` | **Rust** (libvips) | Image processing |
| `node-llama-cpp` | **C++/Rust** | Local GGUF model inference |
| `@napi-rs/canvas` | **Rust** | Native canvas rendering |
| `@matrix-org/matrix-sdk-crypto-nodejs` | **Rust** (libolm) | E2E encryption for Matrix |
| `protobufjs` | **C++** native | Protocol Buffers (WhatsApp/Tlon) |
| `tree-sitter-bash` | **C/Rust** | Incremental Bash parsing |
| `koffi` | **C** FFI | Foreign function interface |
| `baileys` | **TypeScript** | WhatsApp Web protocol (native crypto) |

---

## II. MONOREPO STRUCTURE & BUILD SYSTEM

### Workspace Layout (`pnpm-workspace.yaml`)

```
openclaw/
├── .                          # Root package (openclaw)
├── ui/                        # Control UI (Lit web components + Vite)
├── packages/
│   ├── memory-host-sdk/       # Memory host interface SDK
│   ├── plugin-package-contract/ # Plugin package contract types
│   ├── plugin-sdk/            # Public plugin SDK (published)
│   └── sdk/                   # External consumer SDK
├── extensions/                # 133 plugin packages
│   ├── anthropic/             # Claude provider
│   ├── openai/                # GPT provider
│   ├── google/                # Gemini provider
│   ├── telegram/              # Telegram channel
│   ├── discord/               # Discord channel
│   ├── slack/                 # Slack channel
│   ├── whatsapp/              # WhatsApp channel
│   ├── memory-core/           # Core memory engine
│   ├── memory-wiki/           # Provenance wiki layer
│   ├── memory-lancedb/        # LanceDB vector backend
│   ├── active-memory/         # Active memory plugin
│   ├── browser/               # Browser automation (CDP+Playwright)
│   ├── canvas/                # A2UI visual workspace
│   ├── lobster/               # YAML workflow engine
│   ├── openshell/             # OS-level sandbox backend
│   ├── webhooks/              # HTTP webhook ingress
│   ├── voice-call/            # Voice call support
│   ├── deepgram/              # Speech-to-text
│   ├── elevenlabs/            # Text-to-speech
│   ├── ollama/                # Local model provider
│   ├── codex/                 # OpenAI Codex ACP harness
│   ├── acpx/                  # ACP extension framework
│   └── ... (113 more)
├── apps/
│   ├── macos/                 # Swift menu bar app
│   ├── ios/                   # Swift iOS app
│   ├── android/               # Kotlin/Compose Android
│   ├── shared/OpenClawKit/    # Shared Swift protocol library
│   ├── swabble/               # Wake-word daemon (Swift)
│   └── macos-mlx-tts/         # Local MLX TTS (Apple Silicon)
├── src/                       # Core agent code (~7,883 TS files)
├── skills/                    # 52 built-in skills
├── docs/                      # Documentation
├── scripts/                   # Build & CI scripts
├── security/                  # Security policies
├── qa/                        # QA test infrastructure
└── test/                      # Shared test utilities
```

### Build Pipeline

```bash
# Install dependencies
pnpm install

# Build UI (Vite + Lit)
pnpm ui:build

# Build core (tsdown → dist/)
pnpm build

# Typecheck (tsgo — native TypeScript compiler)
pnpm tsgo:prod

# Run tests
pnpm test:unit:fast

# Run gateway in dev mode
pnpm gateway:watch
```

### Entry Point Chain

```
openclaw.mjs                    # Shell wrapper (bin entry)
  └── src/entry.ts              # CLI entry: argv parsing, profile, respawn
       └── src/entry.compile-cache.ts  # Node.js compile cache
       └── src/entry.respawn.ts        # Process respawn logic
       └── src/entry.version-fast-path.ts  # --version fast path
       └── src/cli/run-main.ts         # Main CLI dispatch
            └── src/library.ts          # Library API surface
                 └── src/gateway/server.ts   # Gateway server
                      └── src/gateway/server.impl.ts  # Full implementation
```

---

## III. SEVEN-COMPONENT ARCHITECTURE MODEL

```
┌───────────────────────────────────────────────────────────────────┐
│                    INTERACTION LAYER                               │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────────┐ │
│  │WhatsApp │ │ Telegram │ │ Discord │ │ Slack  │ │ 20+ more   │ │
│  │ Baileys │ │  grammY  │ │discordjs│ │  Bolt  │ │ Channels   │ │
│  └────┬────┘ └─────┬────┘ └────┬────┘ └───┬────┘ └─────┬──────┘ │
│       └──────────┬──┴──────────┴───────────┴────────────┘        │
├──────────────────┼───────────────────────────────────────────────┤
│           GATEWAY / CONTROL PLANE  (port 18789)                   │
│  ┌───────────────┼─────────────────────────────────────────┐     │
│  │  WS Server │ HTTP Server │ Session Mgr │ Event Bus      │     │
│  │  Channel Router │ Device Pairing │ Auth/Challenge       │     │
│  │  Cron Scheduler │ Hook Engine │ TaskFlow Orchestrator   │     │
│  │  Plugin Runtime │ MCP Dual-Role │ Talk/Voice Relay      │     │
│  └───────────────┬─────────────────────────────────────────┘     │
├──────────────────┼───────────────────────────────────────────────┤
│              COGNITION LAYER                                      │
│  ┌───────────────┼─────────────────────────────────────────┐     │
│  │ Agent Runtime │ Orchestrator │ Context Assembly          │     │
│  │ LLM Providers│ Tool Dispatch │ Multi-turn Loop           │     │
│  │ ACP Harnesses │ Pi Embedded Runner │ Failover            │     │
│  └───────────────┬─────────────────────────────────────────┘     │
├──────────────────┼───────────────────────────────────────────────┤
│             EXECUTION LAYER                                       │
│  ┌───────────────┼─────────────────────────────────────────┐     │
│  │ Browser (CDP) │ Canvas (A2UI) │ Shell (exec)            │     │
│  │ File I/O      │ Nodes (iOS/Android/macOS) │ MCP Tools   │     │
│  │ Docker Sandbox│ OpenShell │ Peekaboo (macOS UI)         │     │
│  └───────────────┬─────────────────────────────────────────┘     │
├──────────────────┼───────────────────────────────────────────────┤
│            PERSISTENCE LAYER                                      │
│  ┌───────────────┼─────────────────────────────────────────┐     │
│  │ MEMORY.md │ Daily Logs │ JSONL Transcripts │ SQLite     │     │
│  │ Vector Index (sqlite-vec) │ FTS5 │ Workspace Files      │     │
│  │ Dreaming System │ memory-wiki │ QMD Sidecar             │     │
│  └─────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────┘
```

### Source Directory → Component Mapping

| Component | Source Path | Key Files |
|---|---|---|
| **Gateway** | `src/gateway/` | `server.ts`, `server.impl.ts`, `protocol/schema/` |
| **Agent Runtime** | `src/agents/` | `pi-embedded-runner/run.ts`, `harness/` |
| **ACP** | `src/acp/` | `client.ts`, `server.ts`, `control-plane/` |
| **Tools** | `src/tools/`, `src/agents/tools/` | `descriptors.ts`, `planner.ts`, `execution.ts` |
| **MCP** | `src/mcp/` | `channel-server.ts`, `plugin-tools-serve.ts` |
| **Memory** | `extensions/memory-core/` | `src/memory/manager.ts`, `hybrid.ts`, `embeddings.ts` |
| **Memory Wiki** | `extensions/memory-wiki/` | `src/`, `skills/` |
| **Dreaming** | `extensions/memory-core/src/memory/` | `dreaming.ts`, `dreaming-phases.ts` |
| **Channels** | `src/channels/`, `extensions/` | `plugins/`, `telegram/`, `discord/` |
| **Cron** | `src/cron/` | `service.ts`, `store.ts`, `isolated-agent.ts` |
| **Tasks** | `src/tasks/` | `task-flow-registry.ts`, `task-executor.ts` |
| **Hooks** | `src/hooks/` | `bundled/`, routing |
| **Security** | `src/security/` | `audit.ts`, `audit-exec-*.ts` |
| **Sessions** | `src/sessions/` | transcript management |
| **Context Engine** | `src/context-engine/` | `registry.ts`, `types.ts` |
| **Browser** | `extensions/browser/` | `browser-tool.ts`, `security/` |
| **Canvas** | `extensions/canvas/` | A2UI protocol, WKWebView |
| **OpenShell** | `extensions/openshell/` | `backend.ts`, `config.ts` |
| **Talk/Voice** | `src/talk/` | voice pipeline, WebRTC relay |
| **TUI** | `src/tui/` | terminal UI components |
| **Plugin SDK** | `src/plugin-sdk/` | 300+ exported types |
| **Config** | `src/config/` | `io.ts`, `types.openclaw.ts` |

---

## IV. GATEWAY — CONTROL PLANE

### Source Location: `src/gateway/`

The Gateway is the central nervous system. It is a long-running process that owns:
- WebSocket server (primary protocol, port 18789)
- HTTP server (health checks, REST API, Control UI)
- Session management (creation, persistence, compaction)
- Channel routing (inbound message → session key → agent)
- Event distribution (broadcast to connected clients)
- Device pairing & authentication
- Cron scheduler integration
- Hook engine
- Plugin runtime lifecycle

### Core Files

```
src/gateway/
├── server.ts                    # Public API: startGatewayServer()
├── server.impl.ts               # Full implementation (1000+ lines)
├── server-http.ts               # HTTP request handling pipeline
├── server-channels.ts           # Channel plugin lifecycle
├── server-chat.ts               # Chat session management
├── server-cron.ts               # Cron scheduler integration
├── server-plugins.ts            # Plugin bootstrap & reload
├── server-startup-config.ts     # Config resolution at startup
├── server-startup-early.ts      # Early startup tasks
├── server-startup-post-attach.ts # Post-attach initialization
├── server-methods.ts            # WS method dispatch table
├── server-methods/              # Individual method handlers
├── server-network-runtime.ts    # Network binding (loopback/LAN/Tailscale)
├── server-reload-handlers.ts    # Hot-reload logic
├── server-runtime-state.ts      # Runtime state management
├── server-runtime-services.ts   # Service lifecycle
├── auth.ts                      # Gateway auth resolution
├── connection-auth.ts           # Per-connection auth
├── device-auth.ts               # Device token auth (v2/v3 payloads)
├── node-registry.ts             # Node (mobile/desktop) registry
├── node-command-policy.ts       # Per-node command allowlists
├── node-pairing-auto-approve.ts # SSH-based auto-approval
├── control-ui.ts                # Control UI HTTP serving
├── control-ui-routing.ts        # UI route handling
├── exec-approval-manager.ts     # Human-in-the-loop exec gates
├── hooks.ts                     # Internal hook engine
├── mcp-http.ts                  # MCP over HTTP transport
├── openai-http.ts               # OpenAI-compatible API endpoint
├── openresponses-http.ts        # OpenAI Responses API compat
├── talk-realtime-relay.ts       # Voice realtime relay
├── talk-session-registry.ts     # Talk session tracking
└── protocol/schema/             # TypeBox protocol definitions
    ├── frames.ts                # Request/Response/Event frame schemas
    ├── sessions.ts              # Session management schemas
    ├── agents-models-skills.ts   # Agent/model/skill schemas
    ├── channels.ts              # Channel schemas
    ├── config.ts                # Config schemas
    ├── cron.ts                  # Cron schemas
    ├── devices.ts               # Device schemas
    ├── exec-approvals.ts        # Exec approval schemas
    ├── nodes.ts                 # Node schemas
    ├── plugins.ts               # Plugin schemas
    ├── secrets.ts               # Secret management schemas
    ├── tasks.ts                 # Task schemas
    └── wizard.ts                # Onboarding wizard schemas
```

### Gateway Protocol (Wire-Level)

**Transport**: WebSocket (text frames, JSON payloads)  
**Port**: 18789 (default)  
**Protocol Version**: Defined in `src/gateway/protocol/schema/frames.ts`

**Handshake Sequence**:
```
Client→Gateway:  req:connect {minProtocol:3, maxProtocol:3, client, role, scopes, auth}
Gateway→Client:  res {ok:true} → hello-ok {policy, auth:{deviceToken}}
Gateway→Client:  event:presence
Gateway→Client:  event:tick (periodic heartbeat)
```

**Auth Payload v3** (`src/gateway/device-auth.ts`):
```typescript
// buildDeviceAuthPayloadV3 binds:
// platform + deviceFamily + device + client + role + scopes + token + nonce
```

**Frame Size Limits**:
- Pre-connect: 64 KiB (`MAX_PREAUTH_PAYLOAD_BYTES`)
- Post-connect: `hello-ok.policy.maxPayload` + `maxBufferedBytes`

**Server Methods** (`src/gateway/server-methods-list.ts`):
- `health`, `status`, `send`, `agent`, `system-presence`
- Events: `tick`, `agent`, `presence`, `shutdown`, `cron`, `chat`, `health`, `heartbeat`

### Server Implementation Entry (`server.impl.ts`)

```typescript
// Core startup sequence:
export async function startGatewayServer(options: GatewayServerOptions) {
  // 1. Load runtime config
  // 2. Resolve auth (token/password/Tailscale)
  // 3. Initialize plugin runtime
  // 4. Bootstrap channel plugins
  // 5. Start WS server + HTTP server
  // 6. Register server methods
  // 7. Start cron scheduler (lazy)
  // 8. Enable hot-reload
  // 9. Start diagnostic heartbeat
  // 10. Signal readiness
}
```

---

## V. AGENT RUNTIME — THE COGNITION ENGINE

### Source Location: `src/agents/`

The Agent Runtime executes the AI inference loop. It is the "brain" — which in OpenClaw's gateway-first architecture is a **plugin to the gateway**, not the center.

### Core Files

```
src/agents/
├── pi-embedded-runner/
│   ├── run.ts                   # Main entry: runEmbeddedPiAgent()
│   ├── run/                     # Sub-modules
│   │   ├── backend.ts           # Provider backend dispatch
│   │   ├── auth-controller.ts   # Auth profile management
│   │   ├── assistant-failover.ts # Cross-provider failover
│   │   ├── attempt-stage-timing.ts # Stage timing
│   │   └── failover-observation.ts
│   ├── run-state.ts             # Active run tracking
│   ├── model.ts                 # Model resolution
│   ├── model.static-catalog.ts  # Static model catalog
│   ├── system-prompt.ts         # System prompt construction
│   ├── compact.ts               # Context compaction
│   ├── compact.runtime.ts       # Compaction runtime
│   ├── compact.runtime.types.ts # Compaction types
│   ├── history.ts               # Conversation history management
│   ├── replay-history.ts        # Transcript replay
│   ├── thinking.ts              # Chain-of-thought management
│   ├── extensions.ts            # Runtime extensions
│   ├── skills-runtime.ts        # Skill loading & injection
│   ├── context-engine-capabilities.ts
│   ├── context-engine-maintenance.ts
│   ├── tool-schema-runtime.ts   # Tool schema resolution
│   ├── tool-split.ts            # Tool splitting logic
│   ├── tool-result-truncation.ts # Result size management
│   ├── tool-call-argument-decoding.ts
│   ├── stream-resolution.ts     # Stream processing
│   ├── usage-accumulator.ts     # Token usage tracking
│   └── lanes.ts                 # Session lane management
├── harness/
│   ├── selection.ts             # Agent harness selection
│   ├── runtime-plugin.ts        # Harness plugin integration
│   ├── builtin-pi.ts            # Built-in Pi harness
│   ├── registry.ts              # Harness registry
│   ├── policy.ts                # Harness policy
│   └── types.ts                 # Harness types
├── tools/                       # Agent tool implementations
│   ├── web-fetch.ts             # Web content fetching
│   ├── web-search.ts            # Web search
│   ├── image-tool.ts            # Image generation
│   ├── video-generate-tool.ts   # Video generation
│   ├── music-generate-tool.ts   # Music generation
│   ├── pdf-tool.ts              # PDF processing
│   ├── tts-tool.ts              # Text-to-speech
│   ├── sessions-send-tool.ts    # Cross-session messaging
│   ├── sessions-spawn-tool.ts   # Sub-agent spawning
│   ├── sessions-yield-tool.ts   # Session yield
│   ├── cron-tool.ts             # Cron scheduling
│   ├── nodes-tool.ts            # Node device control
│   ├── message-tool.ts          # Channel messaging
│   ├── gateway-tool.ts          # Gateway operations
│   ├── subagents-tool.ts        # Sub-agent management
│   ├── web-fetch-visibility.ts  # SSRF visibility
│   └── web-guarded-fetch.ts     # Guarded web fetching
├── sandbox/                     # Docker sandbox management
├── auth-profiles/               # Auth profile management
├── cli-runner/                  # CLI execution runner
├── command/                     # Command processing
├── pi-embedded-helpers/         # Helper utilities
├── pi-hooks/                    # Pi agent hooks
│   └── context-pruning/         # Context pruning
├── runtime-plan/                # Runtime plan construction
│   ├── auth.ts                  # Auth plan
│   └── build.ts                 # Plan builder
├── schema/                      # Agent schemas
├── skills/                      # Skill management
├── agent-scope.ts               # Agent scope resolution
├── agent-runtime-config.ts      # Runtime config
├── anthropic-transport-stream.ts # Anthropic streaming
├── failover-error.ts            # Failover error handling
├── usage.ts                     # Usage normalization
└── workspace-run.ts             # Workspace run management
```

### The Multi-Turn Reasoning Loop

```typescript
// src/agents/pi-embedded-runner/run.ts — Simplified flow
async function runEmbeddedPiAgent(params) {
  // 1. Resolve auth profiles (buildAgentRuntimeAuthPlan)
  // 2. Select model (resolveModelAsync)
  // 3. Build system prompt (system-prompt.ts)
  //    ├── Base prompt
  //    ├── Compact skills list (names + descriptions only)
  //    ├── Bootstrap context files (SOUL.md, AGENTS.md, USER.md, etc.)
  //    └── Per-run overrides
  // 4. Load conversation history (replay-history.ts)
  // 5. Enter reasoning loop:
  //    a. Call LLM provider with context
  //    b. If tool calls emitted → dispatch tools → append results → goto (a)
  //    c. If text-only response → terminate loop
  // 6. Persist transcript (JSONL)
  // 7. Trigger memory flush if approaching compaction
  // 8. Handle compaction (compact.ts)
}
```

### Failover & Model Arbitrage

```typescript
// Cross-provider failover chain:
// 1. Try primary provider/model
// 2. On auth error → rotate auth profile (resolveAuthProfileOrder)
// 3. On rate limit → switch to fallback model
// 4. On context overflow → trigger compaction, retry
// 5. On provider failure → handleAssistantFailover()

// Model arbitrage (routing rules in config):
// triage    → fast/cheap model  (Gemini Flash, Haiku)
// reasoning → premium model     (Claude Opus, o3)
// coding    → code-specialized  (via ACP harness)
// sensitive → local model       (Nemotron, GGUF)
```

---

## VI. TOOL SYSTEM — EXECUTION CAPABILITIES

### Source Location: `src/tools/` (planner/descriptors) + `src/agents/tools/` (implementations)

### Tool Architecture

```typescript
// src/tools/types.ts — Core types

type ToolOwnerRef =
  | { kind: "core" }                              // Built-in tools
  | { kind: "plugin"; pluginId: string }           // Plugin tools
  | { kind: "channel"; channelId: string }         // Channel actions
  | { kind: "mcp"; serverId: string };             // MCP server tools

type ToolExecutorRef =
  | { kind: "core"; executorId: string }
  | { kind: "plugin"; pluginId: string; toolName: string }
  | { kind: "channel"; channelId: string; actionId: string }
  | { kind: "mcp"; serverId: string; toolName: string };

type ToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  owner: ToolOwnerRef;
  executor?: ToolExecutorRef;
  availability?: ToolAvailabilityExpression;
  annotations?: JsonObject;
  sortKey?: string;
};
```

### Tool Availability System

```typescript
// Tools can be conditionally available based on:
type ToolAvailabilitySignal =
  | { kind: "always" }                              // Always available
  | { kind: "auth"; providerId: string }            // Requires provider auth
  | { kind: "config"; path: string[] }              // Requires config value
  | { kind: "env"; name: string }                   // Requires env variable
  | { kind: "plugin-enabled"; pluginId: string }    // Requires plugin active
  | { kind: "context"; key: string; equals?: any }; // Requires runtime context

// Composable expressions:
type ToolAvailabilityExpression =
  | ToolAvailabilitySignal
  | { allOf: ToolAvailabilityExpression[] }   // AND
  | { anyOf: ToolAvailabilityExpression[] };  // OR
```

### Tool Planner (`src/tools/planner.ts`)

```typescript
// buildToolPlan() resolves which tools are available for a given run:
// 1. Collect all registered tool descriptors
// 2. Evaluate availability expressions against current context
// 3. Apply allowlists/denylists from tool policy
// 4. Return ordered ToolPlanEntry[] for LLM consumption
```

### Full Tool Registry

| Tool | Source | Executor |
|---|---|---|
| `exec` (shell) | `src/agents/bash-tools.exec.ts` | Core |
| `read` (file) | Core | Core |
| `write` (file) | Core | Core |
| `edit` (file) | Core | Core |
| `web_fetch` | `src/agents/tools/web-fetch.ts` | Core |
| `web_search` | `src/agents/tools/web-search.ts` | Core |
| `image_generate` | `src/agents/tools/image-tool.ts` | Core |
| `video_generate` | `src/agents/tools/video-generate-tool.ts` | Core |
| `music_generate` | `src/agents/tools/music-generate-tool.ts` | Core |
| `pdf_tool` | `src/agents/tools/pdf-tool.ts` | Core |
| `tts` | `src/agents/tools/tts-tool.ts` | Core |
| `sessions_send` | `src/agents/tools/sessions-send-tool.ts` | Core |
| `sessions_spawn` | `src/agents/tools/sessions-spawn-tool.ts` | Core |
| `sessions_yield` | `src/agents/tools/sessions-yield-tool.ts` | Core |
| `cron` | `src/agents/tools/cron-tool.ts` | Core |
| `nodes` | `src/agents/tools/nodes-tool.ts` | Core |
| `message` | `src/agents/tools/message-tool.ts` | Core |
| `gateway` | `src/agents/tools/gateway-tool.ts` | Core |
| `subagents` | `src/agents/tools/subagents-tool.ts` | Core |
| `browser_*` | `extensions/browser/` | Plugin |
| `canvas_*` | `extensions/canvas/` | Plugin |
| `memory_search` | `extensions/memory-core/` | Plugin |
| `memory_get` | `extensions/memory-core/` | Plugin |
| `wiki_*` | `extensions/memory-wiki/` | Plugin |
| MCP tools | `src/mcp/` | External servers |

---

## VII. MCP DUAL-ROLE ARCHITECTURE

### Source Location: `src/mcp/`

OpenClaw is **both an MCP client AND an MCP server simultaneously**.

### Three MCP Server Surfaces

```
src/mcp/
├── channel-server.ts            # Exposes Gateway conversations to external AI hosts
├── channel-bridge.ts            # Translates Gateway events ↔ MCP protocol
├── channel-tools.ts             # Tools: list conversations, read/send messages
├── plugin-tools-serve.ts        # Exposes plugin tools to ACP/Codex sessions
├── plugin-tools-handlers.ts     # Plugin tool request handlers
├── openclaw-tools-serve.ts      # Exposes built-in tools (cron, etc.)
└── tools-stdio-server.ts        # stdio transport server
```

### Client Mode — External Tool Consumption

Configured in `openclaw.json` → `mcpServers`:

```json5
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "DATABASE_URL": "..." }
    }
  }
}
```

**Transports supported**: stdio (local process) + HTTP/SSE (remote server)

### Server Mode — Exposing OpenClaw Capabilities

```
External AI Hosts connect TO OpenClaw:
  Claude Code    ──MCP──► OpenClaw Channel Server
  Codex          ──MCP──► OpenClaw Plugin Tools Server
  ACP sessions   ──MCP──► OpenClaw Tools Server
  Custom hosts   ──MCP──► Any of the three surfaces
```

**Process Isolation Rule**: Channel Server and Plugin Tools Server are separate processes — never combined.

---

## VIII. MEMORY SYSTEM — 4-LAYER ARCHITECTURE

### Source Location: `extensions/memory-core/src/memory/`

```
extensions/memory-core/src/memory/
├── manager.ts                   # Core MemorySearchManager implementation
├── manager-search.ts            # searchVector() + searchKeyword()
├── manager-sync-ops.ts          # Sync operations (file watching, indexing)
├── manager-atomic-reindex.ts    # Atomic reindexing (temp file + swap)
├── manager-batch-state.ts       # Batch embedding state
├── manager-cache.ts             # Singleton cache management
├── manager-db.ts                # SQLite database operations
├── manager-embedding-cache.ts   # Embedding cache (avoid re-computation)
├── manager-embedding-ops.ts     # Embedding CRUD operations
├── manager-embedding-policy.ts  # Embedding policy (retry, fallback)
├── manager-fts-state.ts         # Full-text search state
├── manager-provider-state.ts    # Provider state management
├── manager-reindex-state.ts     # Reindex state tracking
├── manager-runtime.ts           # Runtime integration
├── manager-search-preflight.ts  # Search preflight checks
├── manager-session-reindex.ts   # Session transcript reindexing
├── manager-session-sync-state.ts
├── manager-source-state.ts      # Memory source tracking
├── manager-status-state.ts      # Status aggregation
├── manager-sync-control.ts      # Sync control (error recovery)
├── manager-targeted-sync.ts     # Targeted sync operations
├── manager-vector-warning.ts    # Vector extension warnings
├── manager-vector-write.ts      # Vector write operations
├── hybrid.ts                    # Hybrid search (vector + BM25 merge)
├── embeddings.ts                # Embedding provider abstraction
├── provider-adapters.ts         # Provider adapter registration
├── qmd-manager.ts               # QMD sidecar manager
├── qmd-compat.ts                # QMD compatibility layer
├── temporal-decay.ts            # Temporal decay scoring
├── mmr.ts                       # Maximal Marginal Relevance diversification
├── rem-evidence.ts              # REM phase evidence tracking
├── rem-harness.ts               # REM harness for dreaming preview
├── dreaming.ts                  # Dreaming system entry
├── dreaming-phases.ts           # Light/REM/Deep phase implementations
├── dreaming-markdown.ts         # Markdown processing for dreaming
├── dreaming-narrative.ts        # Narrative generation
├── dreaming-repair.ts           # Dreaming data repair
├── dreaming-shared.ts           # Shared dreaming utilities
├── dreaming-command.ts          # CLI commands for dreaming
├── short-term-promotion.ts      # Candidate promotion logic
├── tools.ts                     # memory_search, memory_get tools
├── tools.runtime.ts             # Tool runtime integration
├── tools.citations.ts           # Search result citations
├── tools.recall-tracking.ts     # Recall frequency tracking
├── prompt-section.ts            # Memory injection into prompts
├── session-search-visibility.ts # Search visibility rules
├── flush-plan.ts                # Memory flush planning
├── public-artifacts.ts          # Public artifact management
└── concept-vocabulary.ts        # Concept vocabulary extraction
```

### SQLite Schema

```sql
-- Vector chunks table
chunks (id, path, start_line, end_line, text, hash)

-- Vector embeddings (sqlite-vec)
chunks_vec (id, embedding)  -- 1536 dimensions

-- Full-text search (FTS5)
chunks_fts (text)

-- Embedding cache
embedding_cache (hash, vector)
```

### Hybrid Search Algorithm

```typescript
// From extensions/memory-core/src/memory/hybrid.ts + manager-search.ts

// 1. Vector search: top (maxResults × candidateMultiplier) by cosine similarity
// 2. BM25 search: top (maxResults × candidateMultiplier) by FTS5 BM25 rank
// 3. Merge: finalScore = vectorWeight × vectorScore + textWeight × textScore
// 4. Apply MMR diversification (mmr.ts)
// 5. Apply temporal decay (temporal-decay.ts, configurable half-life)

// Default weights:
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_TEXT_WEIGHT = 0.3;
```

### Key Engineering Constants

```typescript
const SNIPPET_MAX_CHARS              = 700;
const SESSION_DIRTY_DEBOUNCE_MS      = 5000;
const EMBEDDING_BATCH_MAX_TOKENS     = 8000;
const EMBEDDING_INDEX_CONCURRENCY   = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS  = 3;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;  // 64KB
const VECTOR_LOAD_TIMEOUT_MS        = 30_000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS  = 5 * 60_000;
```

### Embedding Providers

```typescript
// From extensions/memory-core/src/memory/embeddings.ts
type EmbeddingProviderId =
  | "openai"        // Default
  | "gemini"        // Google Gemini
  | "voyage"        // Voyage AI
  | "mistral"       // Mistral
  | "bedrock"       // AWS Bedrock
  | "deepinfra"     // DeepInfra
  | "local"         // node-llama-cpp (GGUF)
  | "ollama"        // Ollama
  | "lmstudio"     // LM Studio
  | "github-copilot" // GitHub Copilot
  | "generic";      // OpenAI-compatible endpoint
```

---

## IX. DREAMING SYSTEM — NEUROMORPHIC CONSOLIDATION

### Source Location: `extensions/memory-core/src/memory/dreaming*.ts`

The Dreaming system is OpenClaw's autonomous memory consolidation engine.

### Three-Phase Lifecycle

```
┌─────────────────────────────────────┐
│         LIGHT PHASE                 │
│  • Ingest daily YYYY-MM-DD.md files│
│  • Parse → snippet chunks           │
│  • Ingest session transcripts       │
│  • Deduplicate (Jaccard ≥ 0.9)      │
│  • Record short-term signals        │
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│          REM PHASE                  │
│  • Read recall entries (7-day)      │
│  • Extract recurring themes         │
│  • Identify "candidate truths"      │
│  • Reinforce phase signals          │
│  • Flag stale MEMORY.md entries     │
│  • Memory decay (low-confidence)    │
└──────────────────┬──────────────────┘
                   ▼
┌─────────────────────────────────────┐
│         DEEP PHASE                  │
│  • Weighted scoring (6 signals)     │
│  • Three threshold gates:           │
│    minScore (0.8), minRecallCount,  │
│    minUniqueQueries                 │
│  • ONLY Deep writes to MEMORY.md    │
│  • Promotion re-reads live daily    │
│    note (respects edits/deletions)  │
└─────────────────────────────────────┘
```

### Six-Signal Deep Scoring Model

```typescript
// From extensions/memory-core/src/memory/dreaming-phases.ts
const DEEP_RANKING_SIGNALS = {
  relevance:       0.30,  // Retrieval relevance score
  frequency:       0.24,  // Recall frequency
  queryDiversity:  0.15,  // Unique query diversity
  recency:         0.15,  // Temporal recency
  consolidation:   0.10,  // Cross-day consolidation
  conceptRichness: 0.06,  // Derived concept richness
};

// Threshold gates for promotion:
// minScore:        0.6 (0-1 scale)
// minRecallCount:  3
// minUniqueQueries: 3
// Pending band:    0.4-0.6 (reconsidered next cycle)
```

### Configuration

```json5
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "frequency": "0 */3 * * *",   // Every 3 hours
            "timezone": "UTC",
            "model": "claude-haiku-3-5",
            "deep": {
              "minScore": 0.75,
              "minRecallCount": 2,
              "minUniqueQueries": 2
            },
            "storage": { "mode": "both" }  // inline + separate reports
          }
        }
      }
    }
  }
}
```

---

## X. CHANNEL SYSTEM — MULTI-PLATFORM ADAPTERS

### Source Location: `src/channels/` + `extensions/<channel>/`

### Channel Plugin Architecture

```typescript
// src/channels/plugins/types.plugin.ts
type ChannelPlugin = {
  id: ChannelId;
  // Account management
  setup?: ChannelSetupWizard;
  // Message handling
  start: (ctx: ChannelGatewayContext) => Promise<void>;
  stop: () => Promise<void>;
  // Capabilities
  capabilities: ChannelCapabilities;
  // Status reporting
  status?: () => ChannelStatus;
};
```

### Supported Channels (133 extensions, 25+ channels)

| Channel | Extension | Protocol Library |
|---|---|---|
| WhatsApp | `extensions/whatsapp/` | Baileys |
| Telegram | `extensions/telegram/` | grammY |
| Discord | `extensions/discord/` | discord.js |
| Slack | `extensions/slack/` | @slack/bolt |
| Signal | `extensions/signal/` | signal-cli |
| iMessage | `extensions/imessage/` | Native macOS |
| Matrix | `extensions/matrix/` | matrix-sdk-crypto |
| IRC | `extensions/irc/` | Custom |
| Google Chat | `extensions/googlechat/` | Google API |
| MS Teams | `extensions/msteams/` | Bot Framework |
| Nostr | `extensions/nostr/` | Custom |
| LINE | `extensions/line/` | LINE SDK |
| Feishu | `extensions/feishu/` | Feishu API |
| Mattermost | `extensions/mattermost/` | Mattermost API |
| Twitch | `extensions/twitch/` | tmi.js |
| Nextcloud Talk | `extensions/nextcloud-talk/` | OCS API |
| Synology Chat | `extensions/synology-chat/` | Custom |
| Tlon | `extensions/tlon/` | @tloncorp/api |
| Zalo | `extensions/zalo/`, `extensions/zalouser/` | Custom |
| QQ | `extensions/qqbot/` | QQ Bot API |
| WebChat | Built-in (Control UI) | WebSocket |

### Channel Plugin Registry

```
src/channels/plugins/
├── registry-loaded.ts           # Loaded plugin registry
├── types.public.ts              # Public type exports
├── types.plugin.ts              # Plugin interface
├── types.adapters.ts            # Adapter types
├── types.config.ts              # Config types
├── binding-types.ts             # Binding types
├── stateful-target-drivers.ts   # Stateful session drivers
├── setup-wizard-types.ts        # Setup wizard types
├── contracts/                   # Channel contracts
│   ├── test-helpers/
│   └── inventory/
├── actions/                     # Channel message actions
├── outbound/                    # Outbound message pipeline
└── status-issues/               # Status issue tracking
```

---

## XI. ACP — AGENT CLIENT PROTOCOL

### Source Location: `src/acp/`

ACP is a JSON-RPC based protocol for spawning and managing external agent harnesses.

### Architecture

```
src/acp/
├── client.ts                    # ACP client (spawn agent process)
├── server.ts                    # ACP server (Gateway-side)
├── translator.ts                # Protocol translation
├── session.ts                   # ACP session management
├── session-mapper.ts            # Session key mapping
├── event-mapper.ts              # Event translation
├── event-ledger.ts              # Event ledger
├── policy.ts                    # ACP policy enforcement
├── permission-relay.ts          # Permission relay
├── commands.ts                  # ACP commands
├── meta.ts                      # Metadata management
├── control-plane/
│   ├── manager.ts               # Control plane manager
│   ├── manager.core.ts          # Core manager logic
│   ├── manager.types.ts         # Manager types
│   ├── manager.utils.ts         # Manager utilities
│   ├── manager.turn-stream.ts   # Turn streaming
│   ├── manager.identity-reconcile.ts
│   ├── manager.runtime-controls.ts
│   ├── spawn.ts                 # Process spawning
│   ├── runtime-cache.ts         # Runtime cache
│   ├── runtime-options.ts       # Runtime options
│   └── session-actor-queue.ts   # Session serialization
├── runtime/
│   ├── registry.ts              # Harness registry
│   ├── availability.ts          # Harness availability
│   ├── session-identifiers.ts   # Session ID management
│   ├── session-meta.ts          # Session metadata
│   ├── errors.ts                # Error classification
│   └── types.ts                 # Runtime types
└── persistent-bindings.*        # Persistent binding lifecycle
```

### ACP Command Surface

```
/acp spawn <prompt>     — Start background agent
/acp list               — List active ACP sessions
/acp steer <id> <text>  — Send instruction to active agent
/acp attach <id>        — Bind current channel to ACP output
```

### Session Isolation

```typescript
// Sub-agent session key format:
// agent:<agentId>:subagent:<uuid>
//
// Sub-agent bootstrap (minimal):
//   Gets: AGENTS.md + TOOLS.md only
//   Does NOT get: SOUL.md, USER.md, IDENTITY.md, MEMORY.md, HEARTBEAT.md
//   → All context must be passed in the task prompt
```

---

## XII. TASKFLOW — DURABLE ORCHESTRATION

### Source Location: `src/tasks/`

TaskFlow provides durable, restart-survivable, multi-step task orchestration.

### Core Files

```
src/tasks/
├── task-flow-registry.ts              # Main registry
├── task-flow-registry.store.ts        # Persistence layer
├── task-flow-registry.store.sqlite.ts # SQLite backend
├── task-flow-registry.store.types.ts  # Store types
├── task-flow-registry.types.ts        # Flow types
├── task-flow-registry.paths.ts        # File path resolution
├── task-flow-registry.audit.ts        # Audit logging
├── task-flow-registry.maintenance.ts  # Maintenance/cleanup
├── task-flow-owner-access.ts          # Owner access control
├── task-flow-runtime-internal.ts      # Internal runtime
├── task-executor.ts                   # Task execution engine
├── task-executor-policy.ts            # Execution policy
├── task-registry.ts                   # General task registry
├── task-registry.store.ts             # General store
├── task-registry.store.sqlite.ts      # SQLite backend
├── task-registry.audit.ts             # Audit logging
├── task-registry.maintenance.ts       # Maintenance
├── task-registry.reconcile.ts         # State reconciliation
├── task-registry.summary.ts           # Summary aggregation
├── detached-task-runtime.ts           # Detached task execution
├── detached-task-runtime-state.ts     # Detached state
└── task-status.ts                     # Status management
```

### Execution Modes

```typescript
// Managed Mode: TaskFlow controls full lifecycle
//   - Durable state survives Gateway restarts
//   - Revision tracking prevents concurrent conflicts
//   - Steps tracked with individual task records

// Mirrored Mode: External orchestrator owns execution
//   - OpenClaw mirrors state from external system
//   - For integration with external workflow engines
```

---

## XIII. LOBSTER — YAML WORKFLOW ENGINE

### Source Location: `extensions/lobster/`

```
extensions/lobster/src/
├── lobster-runner.ts          # Workflow execution engine
├── lobster-tool.ts            # Tool interface for agent
├── lobster-taskflow.ts        # TaskFlow integration
├── lobster-ajv-cache.ts       # Schema validation cache
└── lobster-core.d.ts          # Core type definitions
```

### Workflow Definition

```yaml
# example.lobster — YAML-native workflow
name: github-issue-triage
version: "1.0.0"
trigger:
  type: webhook
  path: /plugins/webhooks/github
steps:
  - id: fetch_context
    agent: research-agent
    prompt: "Fetch issue context..."
    tools: [read, memory_search]
  - id: classify
    agent: prime-agent
    prompt: "Classify priority..."
    depends_on: [fetch_context]
    model: gemini-flash-2
  - id: respond
    agent: code-agent
    prompt: "Draft response..."
    depends_on: [classify]
    model: claude-opus-4
```

---

## XIV. CRON & AUTOMATION ENGINE

### Source Location: `src/cron/`

```
src/cron/
├── service.ts                   # Cron service (scheduler)
├── store.ts                     # Job persistence (jobs.json)
├── types.ts                     # Type definitions
├── parse.ts                     # Cron expression parsing
├── schedule.ts                  # Schedule computation
├── normalize.ts                 # Job normalization
├── delivery.ts                  # Result delivery
├── delivery-plan.ts             # Delivery planning
├── run-log.ts                   # Execution logging
├── run-id.ts                    # Run ID generation
├── stagger.ts                   # Stagger window
├── session-target.ts            # Session targeting
├── session-reaper.ts            # Stale session cleanup
├── heartbeat-policy.ts          # Heartbeat deferral policy
├── isolated-agent.ts            # Isolated session execution
├── isolated-agent/              # Isolated agent helpers
├── service/                     # Service implementation
│   └── (50+ test files)
└── webhook-url.ts               # Webhook URL handling
```

### Execution Modes

```typescript
// Main Session: System event → heartbeat wake
// Isolated: Fresh session per run (cron:<jobId>)
// Custom Session: Persistent context across runs (session:xxx)

// Wake Modes:
//   "now"             — Immediate heartbeat run
//   "next-heartbeat"  — Wait for scheduled heartbeat
```

---

## XV. SECURITY ARCHITECTURE

### Source Location: `src/security/`

```
src/security/
├── audit.ts                     # Main audit entry
├── audit.runtime.ts             # Audit runtime
├── audit.deep.runtime.ts        # Deep audit
├── audit.nondeep.runtime.ts     # Non-deep audit
├── audit.types.ts               # Audit types
├── audit-channel.ts             # Channel security audit
├── audit-config-basics.test.ts  # Config security
├── audit-deep-code-safety.ts    # Code safety checks
├── audit-deep-probe-findings.ts # Deep probe findings
├── audit-exec-safe-bins.test.ts # Safe binary checks
├── audit-exec-sandbox-host.test.ts # Sandbox audit
├── audit-exec-surface.test.ts   # Exec surface audit
├── audit-filesystem-windows.test.ts # Windows FS audit
├── audit-fs.ts                  # Filesystem audit
├── audit-gateway.ts             # Gateway security
├── audit-gateway-auth-selection.test.ts
├── audit-gateway-config.ts      # Gateway config audit
├── audit-gateway-exposure.test.ts # Exposure audit
├── audit-hooks-routing.ts       # Hook routing audit
├── audit-model-hygiene.ts       # Model configuration hygiene
├── audit-model-refs.ts          # Model reference audit
├── audit-node-command-findings.ts # Node command audit
├── audit-plugin-code-safety.test.ts # Plugin code safety
├── audit-plugin-readonly-scope.test.ts # Read-only scope
├── audit-plugins-trust.ts       # Plugin trust evaluation
├── audit-sandbox-browser.test.ts # Browser sandbox audit
├── audit-sandbox-docker-config.test.ts # Docker sandbox
├── audit-skill-scanner.test.ts  # Skill scanning
├── audit-tool-policy.ts         # Tool policy audit
├── audit-trust-model.test.ts    # Trust model audit
├── audit-workspace-skill-escape.test.ts # Skill escape audit
├── audit-workspace-skills.ts    # Workspace skill audit
├── dangerous-config-flags.ts    # Dangerous flag detection
├── dangerous-tools.ts           # Dangerous tool detection
├── exec-filesystem-policy.ts    # Exec FS policy
├── external-content.ts          # External content safety
├── fix.ts                       # Auto-fix logic
├── safe-regex.ts                # Regex safety
├── scan-paths.ts                # Path scanning
├── secret-equal.ts              # Constant-time comparison
├── skill-scanner.ts             # Skill instruction scanner
├── context-visibility.ts        # Context visibility rules
├── dm-policy-shared.ts          # DM policy
└── windows-acl.ts               # Windows ACL checks
```

### OpenShell Sandbox (`extensions/openshell/`)

```typescript
// extensions/openshell/index.ts
export default definePluginEntry({
  id: "openshell",
  name: "OpenShell Sandbox",
  register(api) {
    registerSandboxBackend("openshell", {
      factory: createOpenShellSandboxBackendFactory({ pluginConfig }),
      manager: createOpenShellSandboxBackendManager({ pluginConfig }),
    });
  },
});

// Backend provides:
// - SSH session isolation
// - File system bridge
// - YAML policy enforcement
// - Network allowlisting
// - Per-agent sandbox boundaries
```

### Trust Boundaries

| Boundary | Protection |
|---|---|
| Gateway auth | Token + device pairing + challenge-response |
| Exec tool | Approval gates (human-in-the-loop) |
| Browser | SSRF protection, circuit breaker, profile isolation |
| Skills | Signed manifests + SkillSpector scanning |
| Memory | File-level access, workspace isolation |
| Nodes | Command allowlists, pairing approval |
| Plugins | Capability contracts, scope enforcement |
| Config | Base-hash guards, schema validation |

---

## XVI. NATIVE CLIENT STACK

### Swift Apps: macOS, iOS, watchOS

```
apps/
├── macos/
│   ├── Package.swift            # Swift Package (macOS 15+)
│   ├── Sources/
│   │   ├── OpenClaw/            # Main menu bar app
│   │   ├── OpenClawIPC/         # Zero-dependency local IPC
│   │   ├── OpenClawDiscovery/   # mDNS/Bonjour discovery
│   │   └── OpenClawMacCLI/      # Debug CLI tool
│   └── Tests/
├── ios/                         # iOS app (SwiftUI)
├── android/                     # Android (Jetpack Compose)
├── shared/OpenClawKit/          # Shared Swift protocol library
│   └── Sources/OpenClawProtocol/
│       └── GatewayModels.swift  # Code-generated from TypeBox
├── swabble/                     # Wake-word daemon
└── macos-mlx-tts/               # Local MLX TTS
```

### macOS App Capabilities

```swift
// Products:
// 1. OpenClaw (executable) — Menu bar app
// 2. OpenClawIPC (library) — Local IPC (Unix socket)
// 3. OpenClawDiscovery (library) — mDNS discovery
// 4. openclaw-mac (executable) — Debug CLI

// Dependencies:
// - MenuBarExtraAccess 1.3.0
// - swift-subprocess 0.4.0+
// - swift-log 1.10.1+
// - Sparkle 2.9.0+ (auto-update)
// - Peekaboo 3.0.0 (UI automation)
// - OpenClawKit (shared protocol)
// - SwabbleKit (wake-word)
```

### Node Capabilities

```
iOS/Android/macOS nodes expose:
├── canvas.present / canvas.navigate / canvas.eval / canvas.snapshot
├── camera.snap
├── screen.record / screen.snapshot
├── location.get
├── notifications.send
├── talk.ptt.start / talk.ptt.stop / talk.ptt.cancel / talk.ptt.once
├── healthkit.summary (iOS only)
├── system.run (macOS only, approval-gated)
└── sms.* (Android only)
```

---

## XVII. PLUGIN SDK & EXTENSION SYSTEM

### Source Location: `src/plugin-sdk/` (300+ exports)

### Plugin Entry Contract

```typescript
// Every extension uses definePluginEntry():
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "...",
  configSchema: createConfigSchema(),
  register(api: OpenClawPluginApi) {
    // api.registrationMode: "full" | "light"
    // Register tools, channels, providers, hooks, etc.
  },
});
```

### Plugin API Surface (Key Interfaces)

```typescript
type OpenClawPluginApi = {
  // Registration
  registrationMode: "full" | "light";
  pluginConfig: JsonObject;
  logger: PluginLogger;

  // Tool registration
  registerTool(descriptor: ToolDescriptor, executor: ToolExecutor): void;

  // Channel registration
  registerChannel(plugin: ChannelPlugin): void;

  // Provider registration
  registerProvider(plugin: UnifiedModelCatalogProviderPlugin): void;

  // Hook registration
  registerHook(hook: PluginHook): void;

  // Memory
  memory: MemoryHostApi;

  // Sandbox
  sandbox: SandboxApi;

  // Config
  config: ConfigApi;
};
```

### Extension Catalog (133 Extensions by Category)

**LLM Providers** (30+):
`anthropic`, `openai`, `google`, `deepseek`, `groq`, `mistral`, `ollama`, `lmstudio`, `together`, `fireworks`, `cerebras`, `chutes`, `huggingface`, `alibaba`, `amazon-bedrock`, `amazon-bedrock-mantle`, `azure-speech`, `byteplus`, `cloudflare-ai-gateway`, `copilot-proxy`, `deepinfra`, `github-copilot`, `gradium`, `kimi-coding`, `litellm`, `minimax`, `moonshot`, `nvidia`, `openrouter`, `perplexity`, `qianfan`, `qwen`, `sglang`, `stepfun`, `tencent`, `venice`, `vercel-ai-gateway`, `vllm`, `volcengine`, `voyage`, `xai`, `xiaomi`, `zai`, `arcee`

**Channel Adapters** (25+):
`telegram`, `discord`, `slack`, `whatsapp`, `signal`, `imessage`, `matrix`, `irc`, `googlechat`, `google-meet`, `msteams`, `nostr`, `line`, `feishu`, `mattermost`, `nextcloud-talk`, `synology-chat`, `tlon`, `twitch`, `qqbot`, `zalo`, `zalouser`, `brave`

**Memory & Knowledge** (5):
`memory-core`, `memory-wiki`, `memory-lancedb`, `active-memory`, `open-prose`

**Voice & Media** (12):
`elevenlabs`, `deepgram`, `senseaudio`, `tts-local-cli`, `talk-voice`, `voice-call`, `inworld`, `image-generation-core`, `video-generation-core`, `music-generation-providers`, `media-understanding-core`, `speech-core`

**Browser & Canvas** (3):
`browser`, `canvas`, `clickclack`

**Workflow & Automation** (4):
`lobster`, `webhooks`, `taskflow` (skill), `file-transfer`

**Security & Sandbox** (3):
`openshell`, `skill-workshop`, `device-pair`

**Diagnostics** (3):
`diagnostics-otel`, `diagnostics-prometheus`, `diffs`

**Tools & Utilities** (20+):
`firecrawl`, `exa`, `tavily`, `searxng`, `duckduckgo`, `document-extract`, `web-readability`, `nano-pdf`, `tokenjuice`, `comfy`, `fal`, `runway`, `phone-control`, `bonjour`, `thread-ownership`, `oc-path`, `llm-task`, `codex`, `acpx`, `opencode`, `opencode-go`, `kilocode`, `synthetic`

---

## XVIII. RUST/POLYGLOT INTEGRATION SURFACE

### Current Rust Touchpoints

The OpenClaw codebase is primarily TypeScript, but has several critical Rust integration points that form the foundation for a Rust-based polyglot architecture:

#### 1. sqlite-vec (Rust) — Vector Search Engine
```
Package: sqlite-vec 0.1.9
Location: Native .node addon (optional dependency)
Usage: extensions/memory-core/src/memory/
Purpose: In-process vector similarity search
Fallback: Pure JS brute-force cosine similarity
```

#### 2. sharp (Rust/libvips) — Image Processing
```
Package: sharp
Usage: Image generation, attachment processing
Purpose: High-performance image manipulation
```

#### 3. node-llama-cpp (C++/Rust) — Local Inference
```
Package: node-llama-cpp (optional, onlyBuiltDependencies)
Usage: Local GGUF embedding models
Model: embeddinggemma-300M-GGUF (~0.6GB)
Purpose: Zero-egress embedding generation
```

#### 4. @napi-rs/canvas (Rust) — Native Rendering
```
Package: @napi-rs/canvas (optional)
Usage: Canvas rendering, image generation
Purpose: Hardware-accelerated 2D rendering
```

#### 5. @matrix-org/matrix-sdk-crypto-nodejs (Rust/libolm)
```
Package: @matrix-org/matrix-sdk-crypto-nodejs
Usage: E2E encryption for Matrix channel
Purpose: Olm/Megolm cryptographic protocol
```

#### 6. tree-sitter-bash (C/Rust) — Incremental Parsing
```
Package: tree-sitter-bash + web-tree-sitter
Usage: Code understanding, tool parsing
Purpose: Incremental syntax tree construction
```

#### 7. openshell (External Rust Binary)
```
Package: openshell 0.1.0
Usage: extensions/openshell/src/backend.ts
Purpose: OS-level sandbox with SSH session isolation
Interface: CLI invocation (runOpenShellCli)
```

### Polyglot Integration Architecture for Mythos-Class

```
┌─────────────────────────────────────────────────────────────┐
│              MYTHOS RUST POLYGLOT LAYER                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  NATIVE RUST CRATES (via NAPI-RS or NDI bindings)   │    │
│  │                                                      │    │
│  │  mythos-vector-engine    — Replaces sqlite-vec       │    │
│  │    • HNSW index (not just flat search)               │    │
│  │    • Multi-index (per-memory-tier)                   │    │
│  │    • Quantization (f16/i8 for memory efficiency)     │    │
│  │    • Streaming batch embedding                       │    │
│  │                                                      │    │
│  │  mythos-causal-graph     — Knowledge graph engine     │    │
│  │    • Neo4j-compatible property graph                  │    │
│  │    • Causal relationship tracking                     │    │
│  │    • Temporal reasoning (before/after/caused-by)      │    │
│  │    • CRDT-based multi-agent consistency               │    │
│  │                                                      │    │
│  │  mythos-execution-sandbox — Replaces openshell CLI    │    │
│  │    • In-process sandboxing (no SSH overhead)          │    │
│  │    • seccomp-bpf syscall filtering                    │    │
│  │    • Capability-based access control                  │    │
│  │    • Audit trail with cryptographic signing           │    │
│  │                                                      │    │
│  │  mythos-protocol-codec   — Wire protocol engine       │    │
│  │    • Zero-copy JSON parsing (simd-json)               │    │
│  │    • WebSocket frame handling                         │    │
│  │    • Binary protocol option (for node→gateway)        │    │
│  │    • Protocol version negotiation                     │    │
│  │                                                      │    │
│  │  mythos-embedding-runtime — Local inference engine    │    │
│  │    • Candle/HF-based embedding                        │    │
│  │    • GPU acceleration (CUDA/Metal/Vulkan)             │    │
│  │    • Batch processing with async queue                │    │
│  │    • Model hot-swapping without restart               │    │
│  │                                                      │    │
│  │  mythos-search-engine    — Hybrid retrieval           │    │
│  │    • Tantivy-based BM25 (replaces FTS5)               │    │
│  │    • Combined vector + keyword in single query         │    │
│  │    • Sub-millisecond search on 1M+ documents          │    │
│  │    • Custom tokenizer (CJK, code, natural language)   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  INTEGRATION LAYER (NAPI-RS / Neon / WASM)          │    │
│  │                                                      │    │
│  │  mythos-napi-bridge      — Node.js ↔ Rust bridge    │    │
│  │    • Async/await compatible                          │    │
│  │    • Typed interfaces (match existing TS types)       │    │
│  │    • Worker thread pool for CPU-bound work            │    │
│  │    • Shared memory for large data (vectors, graphs)   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  INTEGRATION POINTS IN OPENCLAW                      │    │
│  │                                                      │    │
│  │  1. extensions/memory-core/src/memory/               │    │
│  │     → Replace sqlite-vec with mythos-vector-engine   │    │
│  │     → Replace FTS5 with mythos-search-engine         │    │
│  │     → Add causal graph layer (mythos-causal-graph)   │    │
│  │                                                      │    │
│  │  2. extensions/openshell/src/backend.ts               │    │
│  │     → Replace CLI-based openshell with native Rust   │    │
│  │     → In-process sandboxing via mythos-exec-sandbox  │    │
│  │                                                      │    │
│  │  3. src/gateway/server.impl.ts                        │    │
│  │     → Offload protocol encoding to mythos-protocol   │    │
│  │     → Hot path: WS frame parsing in Rust              │    │
│  │                                                      │    │
│  │  4. src/agents/pi-embedded-runner/run.ts              │    │
│  │     → Tool dispatch serialization in Rust             │    │
│  │     → Context assembly optimization                   │    │
│  │                                                      │    │
│  │  5. src/mcp/ (dual-role)                              │    │
│  │     → MCP protocol codec in Rust (zero-copy)          │    │
│  │     → High-throughput tool proxying                   │    │
│  │                                                      │    │
│  │  6. Local model inference                              │    │
│  │     → Replace node-llama-cpp with Candle/llama.rs     │    │
│  │     → GPU-accelerated embedding via mythos-embed      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Rust Crate Specifications for Mythos Integration

```toml
# Cargo.toml (workspace) — Mythos Rust Polyglot Crates

[workspace]
members = [
    "crates/mythos-vector-engine",
    "crates/mythos-causal-graph",
    "crates/mythos-execution-sandbox",
    "crates/mythos-protocol-codec",
    "crates/mythos-embedding-runtime",
    "crates/mythos-search-engine",
    "crates/mythos-napi-bridge",
]

[workspace.dependencies]
# Core
napi = { version = "2.16", features = ["async", "serde-json", "tokio_rt"] }
napi-derive = "2.16"
tokio = { version = "1.40", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Vector search
usearch = "2.17"           # HNSW vector search
hnswlib-rs = "0.7"         # Alternative HNSW
qdrant-client = "1.11"     # If using Qdrant

# Graph
petgraph = "0.6"           # Property graph
neo4rs = "0.8"             # Neo4j client

# Search
tantivy = "0.22"           # BM25 full-text search
tokenizers = "0.20"        # HuggingFace tokenizers

# Embedding / inference
candle-core = "0.7"        # ML framework (HuggingFace)
candle-nn = "0.7"
candle-transformers = "0.7"
ort = "2.0"                # ONNX Runtime

# Security
seccompiler = "0.4"        # seccomp-bpf
caps = "0.5"               # Linux capabilities

# Protocol
simd-json = "0.14"         # Zero-copy JSON
tungstenite = "0.24"       # WebSocket
```

### NAPI Binding Pattern (TypeScript ↔ Rust)

```typescript
// crates/mythos-napi-bridge/src/lib.rs → TypeScript types

// Rust side (via napi-rs):
// #[napi]
// pub async fn vector_search(
//   index_path: String,
//   query: Vec<f32>,
//   top_k: u32,
// ) -> napi::Result<Vec<SearchResult>> { ... }

// TypeScript side:
// import { vectorSearch } from '@openclaw/mythos-vector-engine';
// const results = await vectorSearch(indexPath, queryVec, 10);

// Integration with existing memory-core:
// Replace: searchVector() in manager-search.ts
// With:    import { vectorSearch } from '@openclaw/mythos-vector-engine';
```

---

## XIX. MYTHOS-CLASS TRANSFORMATION BLUEPRINT

### Tier 1 — Gateway Metamorphosis

```yaml
# Current: Single-process Gateway
# Target:  Clustered Gateway with Rust protocol codec

gateway:
  port: 18789
  # Rust-accelerated:
  protocolCodec: "mythos-protocol-codec"  # Zero-copy JSON
  wsFrameParser: "native"                  # Rust WS handling
  clustering:
    enabled: true
    discovery: "bonjour+consul"            # mDNS + service registry
```

### Tier 2 — Multi-Brain Cognition

```
Standard OpenClaw:
  runEmbeddedPiAgent() → [single model] → response

Mythos-Class:
  runMythosOrchestrator()
    ├── Task Classifier (Rust, <5ms, local model)
    │     └── Routes to specialized brain
    ├── Reasoning Brain (Claude Opus / o3)
    │     ├── Chain-of-thought planning
    │     ├── Goal tree decomposition
    │     └── Meta-cognitive reflection
    ├── Execution Brain (Gemini Flash / Haiku)
    │     ├── Tool dispatch
    │     ├── Shell/browser execution
    │     └── Result synthesis
    ├── Memory Brain (Rust, local)
    │     ├── mythos-vector-engine (HNSW)
    │     ├── mythos-search-engine (Tantivy)
    │     ├── mythos-causal-graph
    │     └── Dreaming management
    └── Critic Brain (verification)
          ├── Output validation
          ├── Adversarial probe defense
          └── Cryptographic audit log
```

### Tier 3 — 7-Layer Memory Architecture

```
CURRENT (4-Layer):                 MYTHOS (7-Layer):
┌─────────────────────┐           ┌──────────────────────────────┐
│ Session Context     │           │ L7: Causal Graph             │
├─────────────────────┤           │ (mythos-causal-graph, Rust)  │
│ Daily Logs          │           ├──────────────────────────────┤
├─────────────────────┤           │ L6: Episodic Memory          │
│ MEMORY.md           │           │ (event + temporal index)     │
├─────────────────────┤           ├──────────────────────────────┤
│ Vector Index        │           │ L5: Semantic Memory          │
│ (sqlite-vec)        │           │ (memory-wiki + QMD + CRDT)   │
└─────────────────────┘           ├──────────────────────────────┤
                                  │ L4: Procedural Memory        │
                                  │ (skill execution traces)     │
                                  ├──────────────────────────────┤
                                  │ L3: Long-Term (MEMORY.md)    │
                                  │ + Dreaming (3 phases)        │
                                  ├──────────────────────────────┤
                                  │ L2: Daily Logs + Transcripts │
                                  ├──────────────────────────────┤
                                  │ L1: Active Session Context   │
                                  └──────────────────────────────┘
                                  Backend: mythos-vector-engine
                                  Search:    mythos-search-engine
                                  Graph:     mythos-causal-graph
```

### Tier 4 — Rust Performance Boundaries

```
Component              Current (JS/TS)        Mythos (Rust)
────────────────────── ────────────────────── ──────────────────────
Vector search          sqlite-vec (flat)      HNSW (usearch)
Full-text search       SQLite FTS5            Tantivy (BM25+)
Embedding generation   node-llama-cpp         Candle (GPU-accel)
JSON parsing           JSON.parse()           simd-json (zero-copy)
WebSocket frames       ws library             tungstenite
Sandbox execution      openshell CLI (fork)   In-process seccomp
Protocol encoding      TypeScript objects     Zero-copy serialization
Graph queries          N/A (new)              petgraph / Neo4j
Image processing       sharp (libvips)        Direct libvips FFI
Token counting         tokenjuice (JS)        tiktoken-rs
```

---

## XX. COMPLETE SUBSYSTEM CODE MAP

### A-to-Z File Index (Key Files Only)

| Subsystem | Key Entry File | Purpose |
|---|---|---|
| **ACP Client** | `src/acp/client.ts` | Spawn external agent processes |
| **ACP Server** | `src/acp/server.ts` | Gateway-side ACP handler |
| **ACP Control Plane** | `src/acp/control-plane/manager.ts` | Session lifecycle |
| **Agent Runner** | `src/agents/pi-embedded-runner/run.ts` | Main inference loop |
| **Agent Harness** | `src/agents/harness/selection.ts` | Harness selection |
| **Agent Tools** | `src/agents/tools/*.ts` | 20+ tool implementations |
| **Auto-Reply** | `src/auto-reply/reply/` | Reply pipeline |
| **Bootstrap** | `src/bootstrap/` | First-run setup |
| **Browser** | `extensions/browser/src/browser-tool.ts` | CDP+Playwright |
| **Canvas** | `extensions/canvas/src/` | A2UI visual workspace |
| **Channel Plugins** | `src/channels/plugins/` | Channel abstraction |
| **Chat** | `src/chat/` | Chat session logic |
| **CLI** | `src/cli/` | Command-line interface |
| **Commands** | `src/commands/` | CLI command implementations |
| **Commitments** | `src/commitments/` | Temporal follow-up memory |
| **Config** | `src/config/` | Config I/O, sessions, types |
| **Context Engine** | `src/context-engine/` | Context assembly & management |
| **Cron** | `src/cron/service.ts` | Scheduled task engine |
| **Daemon** | `src/daemon/` | Background service management |
| **Dreaming** | `extensions/memory-core/src/memory/dreaming.ts` | Memory consolidation |
| **Entry** | `src/entry.ts` | CLI entry point |
| **Flows** | `src/flows/` | Channel setup flows |
| **Gateway Protocol** | `src/gateway/protocol/schema/` | 25 TypeBox schema modules |
| **Gateway Server** | `src/gateway/server.impl.ts` | Full gateway implementation |
| **Hooks** | `src/hooks/bundled/` | 5 bundled hooks |
| **i18n** | `src/i18n/` | Internationalization |
| **Image Gen** | `src/image-generation/` | Image generation pipeline |
| **Infrastructure** | `src/infra/` | Error handling, networking, TLS |
| **Library** | `src/library.ts` | Public library API |
| **Link Understanding** | `src/link-understanding/` | URL content extraction |
| **Logging** | `src/logging/` | Diagnostic logging |
| **Markdown** | `src/markdown/` | Markdown processing |
| **MCP** | `src/mcp/` | Dual-role MCP (client+server) |
| **Media** | `src/media/`, `src/media-generation/`, `src/media-understanding/` | Media pipeline |
| **Memory Core** | `extensions/memory-core/src/memory/manager.ts` | Memory engine |
| **Memory Wiki** | `extensions/memory-wiki/` | Provenance knowledge layer |
| **Memory Host SDK** | `packages/memory-host-sdk/` | Memory interface SDK |
| **Model Catalog** | `src/model-catalog/` | Model discovery & catalog |
| **Music Gen** | `src/music-generation/` | Music generation |
| **Node Host** | `src/node-host/` | Device node management |
| **OpenShell** | `extensions/openshell/src/backend.ts` | Sandbox backend |
| **Pairing** | `src/pairing/` | Device pairing |
| **Plugin SDK** | `src/plugin-sdk/index.ts` | 300+ exported types |
| **Plugin Runtime** | `src/plugins/runtime/` | Plugin lifecycle |
| **Process** | `src/process/` | Process supervision |
| **Proxy Capture** | `src/proxy-capture/` | Network proxy capture |
| **Realtime Transcription** | `src/realtime-transcription/` | Speech-to-text |
| **Routing** | `src/routing/` | Session key routing |
| **Security** | `src/security/audit.ts` | Security audit engine |
| **Secrets** | `src/secrets/` | Secret management |
| **Sessions** | `src/sessions/` | Session transcript management |
| **Skills** | `skills/` (52 built-in) | Agent skills |
| **Talk** | `src/talk/` | Voice pipeline |
| **Tasks** | `src/tasks/task-flow-registry.ts` | TaskFlow engine |
| **Terminal** | `src/terminal/` | Terminal UI |
| **Tools** | `src/tools/` | Tool planner & descriptors |
| **TTS** | `src/tts/` | Text-to-speech |
| **TUI** | `src/tui/` | Terminal UI components |
| **Video Gen** | `src/video-generation/` | Video generation |
| **Web Fetch** | `src/web-fetch/` | Web content fetching |
| **Web Search** | `src/web-search/` | Web search providers |
| **Wizard** | `src/wizard/` | Onboarding wizard |

### Built-In Skills (52)

```
skills/
├── 1password/          # Password manager
├── apple-notes/        # Apple Notes integration
├── apple-reminders/    # Apple Reminders
├── bear-notes/         # Bear notes app
├── blogwatcher/        # Web monitoring
├── blucli/             # Bluetooth CLI
├── camsnap/            # Camera capture
├── canvas/             # Canvas operations
├── clawhub/            # ClawHub registry
├── coding-agent/       # Code generation
├── discord/            # Discord operations
├── eightctl/           # 8sleep mattress
├── gemini/             # Gemini-specific
├── gh-issues/          # GitHub issues
├── gifgrep/            # GIF search
├── github/             # GitHub integration
├── gog/                # GOG gaming
├── goplaces/           # Location search
├── healthcheck/        # System health
├── himalaya/           # Email client
├── imsg/               # iMessage
├── mcporter/           # MCP bridge
├── model-usage/        # Usage tracking
├── nano-pdf/           # PDF processing
├── node-connect/       # Node connection
├── notion/             # Notion integration
├── obsidian/           # Obsidian vault
├── openai-whisper/     # Local transcription
├── openai-whisper-api/ # API transcription
├── openhue/            # Philips Hue
├── oracle/             # Prediction
├── ordercli/           # Order management
├── peekaboo/           # macOS UI automation
├── sag/                # Image generation
├── session-logs/       # Session logging
├── sherpa-onnx-tts/    # Local TTS
├── skill-creator/      # Skill creation
├── slack/              # Slack operations
├── songsee/            # Song recognition
├── sonoscli/           # Sonos control
├── spotify-player/     # Spotify
├── summarize/          # Text summarization
├── taskflow/           # TaskFlow management
├── taskflow-inbox-triage/ # Email triage
├── things-mac/         # Things app
├── tmux/               # Terminal multiplexer
├── trello/             # Trello boards
├── video-frames/       # Video frame extraction
├── voice-call/         # Voice calls
├── wacli/              # WhatsApp CLI
├── weather/            # Weather data
└── xurl/               # URL extraction
```

---

## SUMMARY: THE ARCHITECTURAL LEVERS FOR RUST POLYGLOT MYTHOS-CLASS

The OpenClaw codebase provides **seven decisive integration surfaces** for Rust-based performance transformation:

| # | Surface | Current Implementation | Rust Replacement | Impact |
|---|---|---|---|---|
| **1** | Vector Search | `sqlite-vec` (flat cosine) | `usearch` HNSW index | 100x faster at scale |
| **2** | Full-Text Search | SQLite FTS5 | `tantivy` BM25+ | 10x faster, better ranking |
| **3** | Embedding Inference | `node-llama-cpp` (CPU) | `candle` (GPU Metal/CUDA) | 50x faster embedding |
| **4** | Protocol Codec | `JSON.parse()` in JS | `simd-json` zero-copy | 5x WS throughput |
| **5** | Sandbox Execution | `openshell` CLI fork | In-process `seccomp-bpf` | 100x less overhead |
| **6** | Knowledge Graph | None (new capability) | `petgraph` + causal tracking | Enables L7 memory |
| **7** | Image/Media | `sharp` (already Rust) | Direct `libvips` FFI | Marginally faster |

The **gateway-first inversion** remains the foundational insight: OpenClaw's architecture was designed so that the "AI brain" is a plugin, not the center. This means every cognitive component — including new Rust-native ones — can be swapped in without touching the infrastructure. The 133-extension plugin system, the MCP dual-role architecture, and the ACP harness protocol all provide clean seams for Rust components to enter the system at any layer.

🦞→🏛️ **The lobster has claws. Rust makes them titanium.**
