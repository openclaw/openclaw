# Architecture

**Analysis Date:** 2026-02-15

## Pattern Overview

**Overall:** Multi-layered event-driven system with clear separation between Gateway control plane, Agent execution, Channels, and Infrastructure.

**Key Characteristics:**
- Monolithic TypeScript codebase (Node.js ≥22) compiled to ESM
- CLI-driven command orchestration via Commander.js (`src/cli/`)
- Gateway HTTP/WebSocket server for coordination and state management
- AI Agent execution layer with embedded Pi framework integration
- Pluggable channel system (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, etc.)
- Sandbox-based tool execution for agent tasks
- Session-based conversation history and state persistence
- Configuration-driven via YAML + JSON5 with Zod validation

## Layers

**CLI Layer:**
- Purpose: User-facing command interface; entry point for all operations
- Location: `src/cli/`, `src/entry.ts`, `src/index.ts`
- Contains: Command builders, argument parsing, profile management, profile-based environment setup
- Depends on: Config, Commands, Infra, Runtime
- Used by: External users; spawns daemon, runs agents, configures channels

**Command Execution Layer:**
- Purpose: Implements domain-level operations (agent runs, channel setup, health checks, etc.)
- Location: `src/commands/`
- Contains: ~60+ command implementations (agent, onboard, configure, doctor, dashboard, gateway, etc.)
- Depends on: Gateway, Agents, Channels, Config, Infra
- Used by: CLI program builder

**Gateway Layer:**
- Purpose: Central HTTP/WebSocket server coordinating multi-agent, multi-channel operations
- Location: `src/gateway/`
- Contains: HTTP server setup, authentication, chat routing, model catalog, browser hosting, protocol handlers
- Depends on: Channels, Agents, Config, Protocols, Auth
- Used by: Commands, daemons, client applications

**Agent Execution Layer:**
- Purpose: AI reasoning engine with embedded Pi framework integration
- Location: `src/agents/`
- Contains: PI-embedded runner, tool definitions, sandbox management, auth profiles, skills, session handling
- Depends on: Providers, Sandbox, Tools, Sessions, Config
- Used by: Gateway, Commands, Channel handlers

**Channel Integration Layer:**
- Purpose: Multi-protocol messaging adapters
- Location: `src/channels/`, `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/whatsapp/`, `src/line/`
- Contains: Protocol-specific handlers, message routing, channel registry, plugins system
- Depends on: Config, Infra, Shared types
- Used by: Gateway, Commands, Routing layer

**Routing & Processing Layer:**
- Purpose: Message routing between channels and agents
- Location: `src/routing/`, `src/auto-reply/`
- Contains: Message routing logic, auto-reply templates, envelope processing
- Depends on: Channels, Gateway, Config
- Used by: Gateway, Commands

**Sandbox & Tool Execution:**
- Purpose: Safe execution of agent tools in isolated environments
- Location: `src/agents/sandbox/`, `src/agents/tools/`, `src/browser/`, `src/node-host/`, `src/canvas-host/`
- Contains: Docker container management, bash PTY, browser automation, canvas rendering
- Depends on: Config, Process, Infra
- Used by: Agent execution layer

**Storage & Session Layer:**
- Purpose: Conversation history, session state, memory indexing
- Location: `src/sessions/`, `src/memory/`
- Contains: Session file I/O, repair/migration utilities, memory search managers
- Depends on: Config, Infra
- Used by: Agents, Gateway, Commands

**Configuration Layer:**
- Purpose: Unified config loading, validation, and management
- Location: `src/config/`, `src/infra/env.ts`
- Contains: Config file I/O, Zod schema validation, legacy migration, runtime overrides
- Depends on: Infra, Shared
- Used by: All layers

**Infrastructure Layer:**
- Purpose: Low-level system utilities
- Location: `src/infra/`
- Contains: Port management, dotenv loading, environment normalization, error handling, process bridges, daemon management
- Depends on: None (foundation layer)
- Used by: All layers

**Type & Protocol Layer:**
- Purpose: Shared type definitions, protocol schemas
- Location: `src/types/`, `src/gateway/protocol/`, `src/shared/`
- Contains: TypeScript interfaces, Zod schemas for validation, chat envelope formats, chat content types
- Depends on: None
- Used by: All layers

## Data Flow

**Message Inbound Flow (Channel → Agent → Channel):**

1. External message arrives on channel (Telegram, WhatsApp, Discord, etc.)
2. Channel adapter receives message → formats as `ChatEnvelope` (in `src/shared/chat-envelope.ts`)
3. Message routed to Gateway via `src/routing/` logic
4. Gateway stores message in session file (`src/sessions/`)
5. Agent runner (`src/agents/pi-embedded-runner/`) reads session + config
6. Agent executes via embedded Pi framework with available tools
7. Tool results streamed back via `subscribeEmbeddedPiSession` (`src/agents/pi-embedded-subscribe/`)
8. Response streamed to channel via `subscribeEmbeddedPiSession` handlers
9. Auto-reply rules applied if configured
10. Message delivered back to originating or configured channels

**Agent Execution Flow:**

1. Session initialized with workspace config, model selection, auth profile
2. System prompt constructed from identity, skills, tool definitions
3. Pi-embedded agent runs with message history from session
4. Tool calls streamed to `src/agents/pi-embedded-subscribe/handlers/tools.ts`
5. Tools executed in sandbox (PTY for bash, browser for web, node for code)
6. Tool results appended to session transcript
7. Agent continues reasoning with results
8. Final response blocks emitted and sent to channels

**State Management:**

- Session state: JSON files in disk-based sessions directory (configurable)
- Gateway state: In-memory chat registries, daemon status tracking
- Config state: YAML files + env var overrides
- Agent state: Per-session transcript, memory index (SQLite with vec embeddings)

## Key Abstractions

**ChatEnvelope:**
- Purpose: Normalize messages across channels with metadata
- Examples: `src/shared/chat-envelope.ts`, `src/shared/chat-content.ts`
- Pattern: Message wrapper with sender identity, channel, timestamp, reply context

**Session:**
- Purpose: Persistent agent conversation context
- Examples: `src/sessions/`, `src/agents/pi-embedded-runner/`
- Pattern: JSON file-based with transaction locks, repair utilities for corruption recovery

**Plugin:**
- Purpose: Extensible channel/provider integration
- Examples: `src/plugins/`, `src/channels/plugins/`, extensions/
- Pattern: Runtime plugin discovery via `requireActivePluginRegistry`, metadata in `openclaw.plugin.json`

**Tool Policy:**
- Purpose: Control which tools agent can execute
- Examples: `src/agents/pi-tools.policy.ts`, `src/agents/tool-policy.ts`
- Pattern: Config-driven allowlists/blocklists with tool schema normalization

**Auth Profile:**
- Purpose: API key/OAuth credential rotation and failover
- Examples: `src/agents/auth-profiles/`
- Pattern: Ordered provider list with last-good tracking and cooldown logic

**Sandbox Context:**
- Purpose: Isolated execution environment for tools
- Examples: `src/agents/sandbox/`, `src/agents/pi-tools.ts`
- Pattern: Docker container management, workspace path isolation, PTY for shell access

**Memory Manager:**
- Purpose: Vector-based semantic search of session history
- Examples: `src/memory/`, `src/agents/memory-search.ts`
- Pattern: SQLite-vec for embedding storage, lazy initialization per session

## Entry Points

**CLI Entry:**
- Location: `src/entry.ts`
- Triggers: User invokes `openclaw` command
- Responsibilities: Bootstrap runtime, load dotenv, parse args, spawn respawned process if needed, delegate to CLI program

**Main Index:**
- Location: `src/index.ts`
- Triggers: Direct import or npm script invocation
- Responsibilities: Initialize CLI, install error handlers, parse commands, export public API

**Gateway Server:**
- Location: `src/gateway/server-http.ts`, `src/commands/gateway.ts`
- Triggers: `openclaw gateway` command
- Responsibilities: Start HTTP listener, initialize channel registries, expose WebSocket for clients

**Agent Command:**
- Location: `src/commands/agent.ts`, `src/agents/pi-embedded-runner/`
- Triggers: `openclaw agent` or `openclaw openclaw:rpc`
- Responsibilities: Load workspace, run agent with message, stream responses, deliver to channels if configured

**Onboard Wizard:**
- Location: `src/commands/onboard.ts`, `src/commands/onboarding/`
- Triggers: `openclaw onboard`
- Responsibilities: Interactive setup of config, channels, auth, workspace

## Error Handling

**Strategy:** Layered error handling with graceful degradation

**Patterns:**

- **Uncaught Exception Handler:** `src/entry.ts` installs global handler, logs with `formatUncaughtError`, exits with code 1
- **Unhandled Rejection Handler:** `src/infra/unhandled-rejections.js` prevents silent rejections
- **Command Errors:** Commands catch + return structured error objects, displayed by CLI formatter
- **Tool Execution Errors:** `src/agents/pi-embedded-helpers/` includes error classification (auth, billing, transient, context overflow, etc.)
- **Channel Errors:** Per-channel error handlers in `src/channels/*/` emit safe user-facing messages
- **Config Validation:** Zod schema validation in `src/config/validation.ts` catches malformed config early

## Cross-Cutting Concerns

**Logging:**
- Framework: `tslog` (`src/logging/`, `src/logger.ts`)
- Patterns: Structured logging with context prefix `[openclaw]`, console capture to structured format
- Environment: `OPENCLAW_LOG_LEVEL` controls verbosity

**Validation:**
- Framework: Zod (`src/config/zod-schema.ts`)
- Patterns: Schema-driven validation for config objects, protocol messages, session data
- Usage: `validateConfigObject`, `validateConfigObjectWithPlugins` in `src/config/validation.ts`

**Authentication:**
- Patterns: Auth profiles with provider resolution, API key/OAuth token exchange, failover logic
- Location: `src/agents/auth-profiles/`, `src/gateway/auth.ts`, `src/commands/auth-choice*`
- Strategy: Supports multiple providers per model, rotation on failure, cooldown tracking

---

*Architecture analysis: 2026-02-15*
