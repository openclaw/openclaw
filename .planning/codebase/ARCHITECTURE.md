# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** Multi-layered gateway/agent platform with extensible channel integrations, modular plugin system, and separate CLI/runtime separation patterns.

**Key Characteristics:**

- **Layered separation**: CLI entry points, business logic, channel transports, and infrastructure layers
- **Plugin-based extensibility**: Extensions (plugins) live under `extensions/*` with standardized SDK contracts
- **Agent-centric**: Core abstracts agent execution, command processing, and session management
- **Channel abstraction**: Multiple messaging channels (Discord, Telegram, WhatsApp, Signal, etc.) share common interfaces
- **Runtime boundaries**: `.runtime.ts` and `.setup.ts` files mark setup-time vs. runtime code separation

## Layers

**Entry Point / CLI Layer:**

- Purpose: Process initialization, argument parsing, container detection, profile management, version checking
- Location: `src/entry.ts`, `src/index.ts`, `src/cli/run-main.ts`
- Contains: CLI command routing, argument normalization, error handling, process setup
- Depends on: Infra (env, paths, process), CLI utilities, config loading
- Used by: Node.js entry wrapper (`openclaw.mjs`)

**CLI Command Layer:**

- Purpose: Handle user commands (gateway, agent, config, onboarding, browser, etc.)
- Location: `src/cli/route.ts` (routing), individual `*-cli.ts` files for command handlers
- Contains: Command-specific logic, argument handling, output formatting
- Depends on: Config, agents, channels, plugins
- Used by: Entry/main process

**Configuration / State Layer:**

- Purpose: Load, validate, serialize, and manage application state (config files, sessions, secrets)
- Location: `src/config/` (schemas, I/O, validation), `src/config/sessions/` (session storage)
- Contains: YAML/JSON parsing, schema validation (Zod), environment substitution, legacy migrations
- Depends on: Infra (file I/O, paths), types, utils
- Used by: All runtime layers

**Auto-reply / Conversation Layer:**

- Purpose: Message routing, command dispatch, agent execution, and reply generation
- Location: `src/auto-reply/` (command detection, registry, execution), `src/auto-reply/reply/` (reply generation)
- Contains: Command validation, command execution context, agent invocation, chunk handling, template rendering
- Depends on: Config, agents, routing, channels, plugins
- Used by: Channel handlers, daemon/gateway processes

**Agents / Execution Layer:**

- Purpose: Spawn and manage AI agent processes (ACPs), tool execution, streaming, patch application
- Location: `src/agents/` (main agent commands, spawning, streaming, patching)
- Contains: ACP process spawning, tool invocation, streaming response handling, Anthropic/vendor integration
- Depends on: Config, sandbox, plugins, infra (processes, TLS, network)
- Used by: Auto-reply, commands, tools

**Channel / Transport Layer:**

- Purpose: Abstract inbound/outbound messaging across multiple platforms
- Location: `src/channels/` (core abstraction), individual channel directories under `extensions/*/src/`
- Contains: Channel lifecycle, account management, inbound message normalization, outbound serialization
- Depends on: Config, routing, auto-reply, plugins (for extension channels)
- Used by: Gateway daemon, CLI message send commands

**Plugin SDK / Extensibility:**

- Purpose: Public API for extensions to integrate custom channels, providers, tools, and hooks
- Location: `src/plugin-sdk/` (barrel exports and contracts), `extensions/*/src/` (extension implementations)
- Contains: Channel setup/runtime contracts, provider setup, config helpers, allowlist management, routing helpers
- Depends on: Core types, config schema contracts
- Used by: Extension packages, core runtime (loads and wires extensions)

**Routing / Session Management:**

- Purpose: Determine message destination (account, channel, agent) based on sender and config rules
- Location: `src/routing/resolve-route.ts`, `src/routing/session-key.ts`, `src/routing/account-id.ts`
- Contains: Route resolution logic, session key derivation, account lookup, allowlist enforcement
- Depends on: Config, channels, utils
- Used by: Auto-reply, inbound channel handlers

**Memory / Knowledge Base:**

- Purpose: Store and retrieve conversation history, embeddings, and vector search
- Location: `src/memory/` (backend config, batch embedding, search managers)
- Contains: Backend configuration (OpenAI, Gemini, local), batch processing, similarity search
- Depends on: Config, providers, infra (HTTP, processes)
- Used by: Auto-reply context building, agents (via context)

**Browser / Automation Layer:**

- Purpose: Control Chrome/Playwright for web automation, screenshot capture, state management
- Location: `src/browser/` (Chrome launch, Playwright sessions, CDP proxy, client actions)
- Contains: Chrome executable detection, profile management, Playwright session pooling, CDP forwarding, client action execution
- Depends on: Config, infra (paths, processes, ports)
- Used by: Browser CLI commands, agent tools

**Plugins / Runtime:**

- Purpose: Load and initialize channel and provider plugins at startup
- Location: `src/plugins/runtime/` (plugin loading, runtime initialization)
- Contains: Plugin resolution, channel instantiation, provider registration
- Depends on: Config, plugin-sdk, extensions
- Used by: Gateway daemon, CLI initialization

**Infrastructure / Utilities:**

- Purpose: Cross-cutting services (file I/O, process management, networking, error handling, logging)
- Location: `src/infra/` (core utilities), `src/shared/` (shared algorithms), `src/utils/` (app-specific helpers)
- Contains: Archive handling, Bonjour discovery, backup/restore, environment setup, error formatting, network utilities
- Depends on: Standard library, npm packages
- Used by: All layers

## Data Flow

**Inbound Message (Channel -> Reply):**

1. Channel receives external message (webhook, polling, stream)
2. Channel normalizes to `ChannelInbound` contract via transport/adapter
3. `routing/resolve-route.ts` determines target account/channel/agent from config rules
4. `auto-reply/dispatch.ts` routes to command dispatcher or auto-reply handler
5. `auto-reply/commands-registry.ts` matches command or triggers agent
6. `auto-reply/reply/agent-runner-execution.ts` spawns ACP (Anthropic Control Plane process)
7. Agent executes with tools, memory context, and response streaming
8. Chunk handler (`auto-reply/chunk.ts`) processes output chunks (text, tool calls)
9. Tools executed, results streamed back to agent (if needed)
10. Final reply generated via `auto-reply/templating.ts`
11. Channel adapter serializes reply and sends outbound (via `channels/*/outbound`)

**Configuration Load (Start -> Ready):**

1. `src/entry.ts` initializes process, sets environment
2. `src/cli/run-main.ts` determines primary command
3. Command loads config via `src/config/io.ts` → `loadConfig()`
4. `io.ts` reads YAML, applies env substitution, validates against schema
5. Legacy migrations applied if needed (`legacy.migrations.ts`)
6. Config passed to command handler or daemon
7. Daemon initializes: channels, plugins, agent pool, memory backends
8. `src/plugins/runtime/` registers all installed plugins
9. Channels instantiate with runtime config
10. Gateway waits for inbound messages

**Plugin Loading (Init -> Ready):**

1. Config references plugin IDs in `plugins:` section
2. `src/config/plugin-auto-enable.ts` auto-enables based on channel requirements
3. `src/plugins/runtime/` resolves plugin packages from `extensions/*/`
4. Each plugin exports `setup.ts` for config-time validation
5. Each plugin exports `.runtime.ts` for startup services
6. Plugin's channel (if any) registered in global channel map
7. Plugin's tools/providers made available to agents
8. Plugin's hooks registered in event system

## Key Abstractions

**Channel Interface:**

- Purpose: Abstract message send/receive across platforms
- Examples: `extensions/discord/src/channel.ts`, `extensions/telegram/src/channel.ts`, `src/channels/web/`
- Pattern: Implement `setup.ts` and `channel.runtime.ts` exports; handle inbound normalization and outbound serialization

**Account / Config Presence:**

- Purpose: Represent authenticated connection to external service
- Examples: Discord guild + bot token, Telegram chat ID, WhatsApp phone number
- Pattern: Config defines accounts under `channels.<id>.accounts`, tools access via `accountId` resolution

**Inbound / Outbound Contracts:**

- Purpose: Normalize cross-channel message structure
- Location: `src/channels/plugins/contracts/`
- Pattern: Extensions normalize native platform messages to `ChannelInbound`, outbound converts replies to platform format

**Agent / Command Execution:**

- Purpose: Represent an AI execution context with tools, memory, and streaming
- Location: `src/agents/acp-spawn.ts` (spawning), `src/agents/agent-command.ts` (command context)
- Pattern: CLI or channel invokes agent with message/system prompt; handles tool calls via streaming

**Session Key / Route Resolution:**

- Purpose: Derive stable session ID from message sender/channel/account
- Location: `src/routing/session-key.ts`, `src/routing/resolve-route.ts`
- Pattern: Hash sender ID + channel + account to get session key; used for memory continuity and allowlist lookup

## Entry Points

**CLI Entry (`src/entry.ts` → `src/index.ts`):**

- Location: `src/entry.ts` (shell check guard), `src/index.ts` (library export)
- Triggers: Node.js executable, or package import
- Responsibilities: Process title setup, compile cache, env normalization, respawn logic, CLI routing

**Gateway Daemon (CLI `gateway run`):**

- Location: `src/cli/daemon-cli/`
- Triggers: `openclaw gateway run [options]`
- Responsibilities: Bind to port, load all channels, listen for inbound, manage agent pool, serve control UI

**Agent Command Spawning (Internal):**

- Location: `src/agents/acp-spawn.ts`, `src/auto-reply/reply/agent-runner-execution.ts`
- Triggers: Auto-reply handler, CLI `agent` command
- Responsibilities: Spawn child process, manage streams, execute tools, collect output

**Web UI Server (`src/browser/server.ts`):**

- Location: `src/browser/server.ts`, `src/browser/routes/`
- Triggers: Browser CLI commands or gateway integration
- Responsibilities: Serve control UI, handle browser session management, proxy CDP connections

## Error Handling

**Strategy:** Graceful degradation with detailed error context and logging

**Patterns:**

- **Top-level handlers**: `src/index.ts` installs uncaught exception handler; `src/entry.ts` catches respawn errors
- **Config validation**: Schema validation via Zod; issues formatted with field paths and suggestions
- **Channel errors**: Inbound handler catches and logs; outbound failures trigger retry or fallback
- **Agent errors**: ACP stream errors captured; partial response sent if available
- **Tool errors**: Tool execution wrapped in try-catch; error passed to agent for recovery
- **Port conflicts**: `src/infra/ports.ts` detects and suggests alternatives
- **Memory errors**: Batch processing handles failures per-item; continues on partial success

## Cross-Cutting Concerns

**Logging:**

- `src/logging.ts` provides `console` capture and per-level filtering
- Channels may log via environment (e.g., `OPENCLAW_DISCORD_LOG`)
- CLI flags control verbosity; daemon config specifies log output

**Validation:**

- Entry point normalizes argv, detects container vs. host, profiles
- Config validation centralized in `src/config/validation.ts` and Zod schemas
- Plugin schemas validated at load time via SDK contracts
- Command arguments validated per-command

**Authentication:**

- Secrets stored in config under `secrets:` section
- Env substitution allows runtime override
- API keys masked in logs via `src/utils/mask-api-key.ts`
- Web UI auth handled via `src/browser/control-auth.ts`

---

_Architecture analysis: 2026-03-26_
