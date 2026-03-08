# Architecture

**Analysis Date:** 2026-03-08

## Pattern Overview

**Overall:** Multi-channel AI gateway with plugin architecture

OpenClaw is a self-hosted AI gateway that routes messages between messaging channels (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, etc.) and AI model providers (Anthropic, OpenAI, Google, etc.). It runs as a local gateway server with a CLI interface, native apps (macOS, iOS, Android), and a web control UI.

**Key Characteristics:**
- CLI-first interface built on Commander.js with lazy command registration
- Long-running gateway server (WebSocket + HTTP) that manages channel connections and AI agent sessions
- Plugin/extension architecture for channels and capabilities via `plugin-sdk`
- Multi-agent system with embedded Pi (AI) runner, subagent spawning, and session management
- Configuration-driven: YAML config at `~/.openclaw/config.yaml` controls all behavior

## Layers

**Entry / CLI Layer:**
- Purpose: Parse CLI commands, bootstrap runtime, route to subcommands
- Location: `src/entry.ts`, `src/cli/`, `src/commands/`
- Contains: CLI program definition, command registration, argument parsing, profile management
- Depends on: Config, Infra, Gateway
- Used by: End users via `openclaw` CLI binary
- Key files:
  - `src/entry.ts` - Process entry point (respawn, fast-path version/help, delegates to `run-main.ts`)
  - `src/cli/run-main.ts` - Main CLI bootstrap (`runCli()`) with lazy command registration
  - `src/cli/program.ts` - Re-exports `buildProgram` from `src/cli/program/build-program.ts`
  - `src/cli/deps.ts` - `createDefaultDeps()` for dependency injection of channel senders
  - `src/commands/` - All CLI command implementations (onboard, configure, doctor, status, agent, etc.)

**Gateway Layer:**
- Purpose: Run the persistent gateway server that manages channels, agents, and WebSocket clients
- Location: `src/gateway/`
- Contains: HTTP/WS server, authentication, channel management, agent event handling, config reload, cron, node registry, OpenAI-compatible API
- Depends on: Channels, Agents, Config, Plugins, Secrets, Infra
- Used by: CLI (`openclaw gateway run`), native apps (macOS menubar, iOS, Android)
- Key files:
  - `src/gateway/server.impl.ts` - `startGatewayServer()` main entry; assembles all gateway subsystems
  - `src/gateway/server-http.ts` - HTTP request handling
  - `src/gateway/server-channels.ts` - Channel lifecycle management
  - `src/gateway/server-chat.ts` - Agent event handler (message routing to AI)
  - `src/gateway/openai-http.ts` - OpenAI-compatible chat completions API
  - `src/gateway/server-methods.ts` - Core RPC method handlers
  - `src/gateway/server-plugins.ts` - Plugin loading for gateway
  - `src/gateway/control-ui*.ts` - Web-based control panel serving

**Agents Layer:**
- Purpose: Manage AI agent sessions, prompt construction, tool execution, model provider interaction
- Location: `src/agents/`
- Contains: Pi embedded runner (core AI loop), system prompts, tool definitions, model catalog, sandbox, skills, subagent management, compaction
- Depends on: Config, Providers, Media, Infra
- Used by: Gateway (via agent event handler), CLI (`openclaw agent`)
- Key files:
  - `src/agents/pi-embedded-runner.ts` - Core AI agent run loop (`runEmbeddedPiAgent`)
  - `src/agents/pi-embedded-subscribe.ts` - Stream subscription for AI responses
  - `src/agents/system-prompt.ts` - System prompt construction
  - `src/agents/pi-tools.ts` - Tool registration and policy
  - `src/agents/model-catalog.ts` - Model discovery and catalog
  - `src/agents/models-config.ts` - Model provider configuration resolution
  - `src/agents/sandbox.ts` - Docker/sandbox execution context
  - `src/agents/skills/` - Skills system (workspace, remote, bundled)
  - `src/agents/subagent-registry.ts` - Subagent spawning and lifecycle
  - `src/agents/bash-tools.ts` - Shell/command execution tools for agents
  - `src/agents/compaction.ts` - Context window compaction

**Channels Layer:**
- Purpose: Abstract messaging platform integrations into a unified channel interface
- Location: `src/channels/`, `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/` (WhatsApp), `src/line/`
- Contains: Channel registry, message routing, allowlists, typing indicators, draft streaming, thread bindings
- Depends on: Config, Routing
- Used by: Gateway, CLI (message send)
- Key files:
  - `src/channels/registry.ts` - Channel ID registry and metadata (`CHAT_CHANNEL_ORDER`)
  - `src/channels/plugins/` - Channel plugin type definitions and registration
  - `src/channels/transport/` - Transport-level abstractions
  - `src/channel-web.ts` - WhatsApp Web channel monitor

**Extensions Layer:**
- Purpose: Plugin-based channel and capability extensions (workspace packages)
- Location: `extensions/`
- Contains: 40+ extension packages (channel plugins, auth providers, utilities)
- Depends on: `openclaw/plugin-sdk` (from `src/plugin-sdk/`)
- Used by: Gateway plugin loader
- Key files:
  - `extensions/telegram/` - Telegram channel plugin
  - `extensions/discord/` - Discord channel plugin
  - `extensions/msteams/` - MS Teams channel plugin
  - `extensions/matrix/` - Matrix channel plugin
  - `extensions/voice-call/` - Voice call plugin
  - `extensions/memory-core/`, `extensions/memory-lancedb/` - Memory plugins
  - `extensions/lobster/` - UI theming plugin

**Plugin SDK Layer:**
- Purpose: Provide stable API surface for extension development
- Location: `src/plugin-sdk/`
- Contains: Re-exports from core modules, channel-specific SDK helpers, shared types
- Depends on: Channels, Config, Plugins, Infra (internal)
- Used by: Extensions (via `openclaw/plugin-sdk`, `openclaw/plugin-sdk/telegram`, etc.)
- Key files:
  - `src/plugin-sdk/index.ts` - Main SDK entry
  - `src/plugin-sdk/core.ts` - Core plugin types and utilities
  - `src/plugin-sdk/compat.ts` - Compatibility helpers
  - Per-channel SDK files: `src/plugin-sdk/telegram.ts`, `src/plugin-sdk/discord.ts`, etc.

**Config Layer:**
- Purpose: Load, validate, and manage YAML configuration with Zod schemas
- Location: `src/config/`
- Contains: Config loading/writing, Zod schema definitions, legacy migration, environment variable substitution, session management
- Depends on: Nothing (foundational)
- Used by: All layers
- Key files:
  - `src/config/config.ts` - `loadConfig()`, `CONFIG_PATH`, config I/O
  - `src/config/schema.ts` - Zod schema for `OpenClawConfig`
  - `src/config/types.ts` - Config type definitions (re-exports from `types.*.ts`)
  - `src/config/sessions.ts` - Session key derivation and session store
  - `src/config/legacy-migrate.ts` - Legacy config migration pipeline
  - `src/config/io.ts` - Config file read/write with validation

**Infra Layer:**
- Purpose: Cross-cutting infrastructure utilities
- Location: `src/infra/`
- Contains: Port management, dotenv, error formatting, runtime guards, update checks, heartbeat, exec approvals, device pairing, Tailscale integration, file locking, provider usage tracking
- Depends on: Nothing (foundational)
- Used by: All layers
- Key files:
  - `src/infra/env.ts` - Environment variable normalization
  - `src/infra/dotenv.ts` - `.env` file loading
  - `src/infra/ports.ts` - Port availability and conflict detection
  - `src/infra/exec-approvals.ts` - Command execution approval system
  - `src/infra/restart.ts` - Gateway restart management
  - `src/infra/update-check.ts` - Version update detection

**Secrets Layer:**
- Purpose: Manage secrets (API keys, tokens) with a structured reference system
- Location: `src/secrets/`
- Contains: Secret resolution, audit, runtime snapshot, gateway auth surface management, credential matrix
- Depends on: Config
- Used by: Gateway, Agents, CLI
- Key files:
  - `src/secrets/runtime.ts` - Runtime secret snapshot activation
  - `src/secrets/apply.ts` - Secret application to config
  - `src/secrets/audit.ts` - Security audit of stored secrets

**Routing Layer:**
- Purpose: Resolve message routing (which account, which session key) for incoming messages
- Location: `src/routing/`
- Contains: Account resolution, route resolution, session key derivation
- Depends on: Config
- Used by: Channels, Gateway
- Key files:
  - `src/routing/resolve-route.ts` - Route resolution logic
  - `src/routing/account-id.ts` - Account ID normalization
  - `src/routing/session-key.ts` - Session key derivation from routing context

**Media Layer:**
- Purpose: Handle media files (images, audio, PDFs) for inbound/outbound messages
- Location: `src/media/`
- Contains: Audio processing (ffmpeg), image ops, MIME detection, media store, PDF extraction
- Depends on: Infra
- Used by: Agents, Channels
- Key files:
  - `src/media/server.ts` - Media HTTP server
  - `src/media/store.ts` - Media file storage
  - `src/media/audio.ts` - Audio processing via ffmpeg

**Native Apps Layer:**
- Purpose: macOS, iOS, and Android native applications
- Location: `apps/macos/`, `apps/ios/`, `apps/android/`
- Contains: Swift (macOS/iOS) and Kotlin (Android) native apps that embed/connect to the gateway
- Depends on: Gateway (via WebSocket/HTTP protocol)
- Used by: End users on desktop/mobile
- Key files:
  - `apps/macos/Sources/OpenClaw/` - macOS menubar app (SwiftUI)
  - `apps/ios/Sources/` - iOS app with chat, voice, settings
  - `apps/android/app/src/main/java/ai/openclaw/app/` - Android app (Kotlin)
  - `apps/shared/OpenClawKit/` - Shared Swift package for iOS/macOS

**Web Control UI Layer:**
- Purpose: Browser-based control panel for gateway management
- Location: `ui/`
- Contains: Vite-based web app served by gateway's control UI HTTP handler
- Depends on: Gateway (API consumer)
- Used by: Gateway serves this at its HTTP port

## Data Flow

**Inbound Message Flow (Channel to AI):**

1. Message arrives on channel (e.g., Telegram webhook, WhatsApp Web listener, Discord bot event)
2. Channel plugin normalizes message into internal envelope format via `src/channels/`
3. Routing layer (`src/routing/resolve-route.ts`) determines account, session key, and agent
4. Gateway's agent event handler (`src/gateway/server-chat.ts`) dispatches to embedded Pi runner
5. Pi runner (`src/agents/pi-embedded-runner.ts`) constructs system prompt, loads history, calls AI provider
6. AI response streams back; Pi subscribe handler (`src/agents/pi-embedded-subscribe.ts`) processes tool calls and text chunks
7. Reply dispatched back through channel's send function (e.g., `sendMessageTelegram`)

**Outbound Message Flow (CLI to Channel):**

1. CLI command `openclaw message send` invokes send logic
2. `createDefaultDeps()` lazy-loads the appropriate channel sender runtime module
3. Message sent directly via channel-specific API (Telegram API, Discord API, etc.)

**Gateway Client Flow (Apps/Web UI):**

1. Client (macOS app, iOS app, web UI) connects via WebSocket to gateway
2. Client authenticates with gateway auth token
3. Client sends RPC method calls (chat, config, status) via WebSocket JSON messages
4. Gateway dispatches to registered method handlers (`src/gateway/server-methods.ts`)
5. Responses stream back over WebSocket

**State Management:**
- Configuration: YAML file at `~/.openclaw/config.yaml`, loaded once, reloaded on file change via `src/gateway/config-reload.ts`
- Session state: JSONL files under `~/.openclaw/agents/<agentId>/sessions/`
- Channel credentials: Stored under `~/.openclaw/credentials/`
- Auth profiles: Managed via `src/agents/auth-profiles/` for API key rotation
- Runtime state: In-memory within the gateway process (`src/gateway/server-runtime-state.ts`)

## Key Abstractions

**ChannelPlugin:**
- Purpose: Unified interface for messaging channel integrations
- Examples: `extensions/telegram/src/channel.ts`, `extensions/msteams/src/channel.ts`
- Pattern: Each channel implements `ChannelPlugin` interface from `src/channels/plugins/types.plugin.ts`; registered via plugin manifest in extension `package.json` (`openclaw.extensions` field)

**OpenClawConfig:**
- Purpose: Typed configuration object validated by Zod schemas
- Examples: `src/config/config.ts`, `src/config/schema.ts`, `src/config/types.ts`
- Pattern: Central Zod schema defines all config; `loadConfig()` reads YAML, validates, and returns typed config

**Pi Embedded Runner:**
- Purpose: Core AI conversation loop that manages context, tools, and streaming
- Examples: `src/agents/pi-embedded-runner.ts`
- Pattern: Stateful run loop that builds system prompt, resolves model auth, calls provider API, processes tool calls, handles compaction

**GatewayServer:**
- Purpose: Central server object that holds all runtime state and subsystem handles
- Examples: `src/gateway/server.impl.ts`
- Pattern: Factory function `startGatewayServer()` assembles all subsystems and returns server handle

**Plugin SDK exports:**
- Purpose: Stable API boundary between core and extensions
- Examples: `src/plugin-sdk/core.ts`, `src/plugin-sdk/telegram.ts`
- Pattern: Each SDK subpath re-exports specific symbols from internal modules, providing a stable interface while allowing internal refactoring

**CliDeps / Dependency Injection:**
- Purpose: Decouple CLI commands from heavy runtime modules via lazy loading
- Examples: `src/cli/deps.ts`
- Pattern: `createDefaultDeps()` returns lazy-loaded function proxies; each channel sender has a `*.runtime.ts` boundary module for dynamic import

## Entry Points

**CLI Entry (`src/entry.ts`):**
- Location: `src/entry.ts`
- Triggers: `openclaw` binary (via `openclaw.mjs` wrapper)
- Responsibilities: Process setup (title, compile cache, warning filter), profile parsing, respawn for Node flags, delegates to `src/cli/run-main.ts`

**Library Entry (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `require("openclaw")` or `import from "openclaw"`
- Responsibilities: Exports public API for programmatic use; also runs CLI when invoked as main module

**Gateway Server (`src/gateway/server.impl.ts`):**
- Location: `src/gateway/server.impl.ts`
- Triggers: `openclaw gateway run` CLI command
- Responsibilities: Start HTTP/WS server, load plugins, start channels, initialize agent runtime, run cron, expose control UI

**Build Entry Points (`tsdown.config.ts`):**
- Location: `tsdown.config.ts`
- Triggers: `pnpm build`
- Responsibilities: Defines all bundle entry points including `src/index.ts`, `src/entry.ts`, plugin SDK subpaths, channel action modules, hooks

## Error Handling

**Strategy:** Fail-safe with structured error reporting

**Patterns:**
- Global `uncaughtException` and `unhandledRejection` handlers installed at CLI startup (`src/cli/run-main.ts`, `src/infra/unhandled-rejections.ts`)
- `formatUncaughtError()` (`src/infra/errors.ts`) standardizes error output
- Gateway uses `try/catch` with structured logging via `src/logging/subsystem.ts`
- Agent runs use failover error handling (`src/agents/failover-error.ts`) for model provider failures with automatic retry/rotation
- Channel health monitoring (`src/gateway/channel-health-monitor.ts`) tracks and auto-restarts unhealthy channels

## Cross-Cutting Concerns

**Logging:**
- Subsystem logger: `src/logging/subsystem.ts` (`createSubsystemLogger()`)
- Console capture: `src/logging.ts` (`enableConsoleCapture()`) wraps console output into structured logs
- Diagnostic logging: `src/logging/diagnostic.ts` for heartbeat-based diagnostics
- File-based log rotation with size caps

**Validation:**
- Config validation: Zod schemas in `src/config/schema.ts` and `src/config/zod-schema.*.ts`
- Input validation throughout CLI via Commander.js option parsing
- Plugin manifest validation: `src/plugins/schema-validator.ts`

**Authentication:**
- Gateway auth: Token-based (`src/gateway/auth.ts`, `src/gateway/device-auth.ts`)
- Provider auth: API keys with profile rotation (`src/agents/auth-profiles/`)
- Channel auth: Per-channel credential management
- Rate limiting: `src/gateway/auth-rate-limit.ts`

**Security:**
- Exec approvals: `src/infra/exec-approvals.ts` gates agent shell command execution
- Sandbox: `src/agents/sandbox.ts` for Docker-based code isolation
- SSRF policy: `src/plugin-sdk/ssrf-policy.ts`
- Host env security: `src/infra/host-env-security.ts`
- Secret management: `src/secrets/` layer with audit trail

---

*Architecture analysis: 2026-03-08*
