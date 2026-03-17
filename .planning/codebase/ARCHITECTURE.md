# Architecture

**Analysis Date:** 2026-03-17

## Pattern Overview

**Overall:** Multi-channel AI gateway with modular provider, channel, and agent layers.

**Key Characteristics:**

- **Plugin-based extensibility**: Core channels and LLM providers packaged as extensions in `extensions/`
- **Session-driven routing**: Inbound messages routed through agent selection layer to session-specific agent instances
- **Config-driven behavior**: System behavior parameterized via JSON5 config, not hardcoded
- **Multi-channel message handling**: Channels (Discord, Telegram, Slack, Signal, iMessage, WhatsApp, etc.) abstract transport; core routing logic is channel-agnostic
- **ACP (Agent Control Protocol) integration**: Native support for agent-to-agent communication and spawning via `src/acp/`

## Layers

**CLI Layer:**

- Purpose: Command-line interface; entry point for user interactions and daemon management
- Location: `src/cli/`, `src/entry.ts`
- Contains: CLI argument parsing, command registration, option definitions
- Depends on: Config, daemon, gateway, runtime
- Used by: Direct user invocation; `openclaw` binary in `openclaw.mjs`

**Command Layer:**

- Purpose: Top-level operations (agent runs, channel setup, model/auth selection, onboarding)
- Location: `src/commands/`
- Contains: Command implementations (agent, gateway-status, channels, models, setup, onboard-non-interactive)
- Depends on: Agents, gateway, config, routing
- Used by: CLI layer

**Gateway Layer:**

- Purpose: WebSocket server managing real-time message routing, multi-channel aggregation, agent spawning
- Location: `src/gateway/`
- Contains: WebSocket server (`src/gateway/server/ws-connection.ts`), channel integrations, health checks, protocol handlers
- Depends on: Channels, agents, routing, sessions, auth profiles
- Used by: External clients connecting via WebSocket; daemon process

**Routing Layer:**

- Purpose: Determine which agent handles an inbound message from which channel
- Location: `src/routing/`
- Contains: Route resolution logic (`resolve-route.ts`), session key generation, account/agent/peer mapping, binding rules
- Depends on: Config, session keys
- Used by: Gateway, agent command layer

**Agent Layer:**

- Purpose: AI agent orchestration, model selection, auth profile management, spawned sub-agents, CLI execution
- Location: `src/agents/`
- Contains: Agent command handler (`agent-command.ts`), model selection, auth profile store, spawned process management, PI agent integration
- Depends on: Config, auth profiles, models, providers, sessions, ACP
- Used by: Commands, gateway

**Session Management:**

- Purpose: Persist and retrieve agent conversation state, transcripts, model/auth overrides
- Location: `src/config/sessions/`, `src/sessions/`
- Contains: Session store (JSON), transcript files, session entry types, level/model overrides
- Depends on: Config paths, file I/O
- Used by: Agents, commands, gateway

**Channel Transport Layer:**

- Purpose: Abstract message transport across multiple platforms
- Location: `src/channels/`, `extensions/*/src/channel.ts`
- Contains: Channel configuration, message parsing, account snapshots, allowlist enforcement, routing attributes
- Depends on: Routing, config
- Used by: Gateway

**Configuration Layer:**

- Purpose: Load, validate, cache, and provide access to system configuration
- Location: `src/config/`
- Contains: Config types, I/O, validation, migrations, paths, runtime snapshots
- Depends on: File system
- Used by: All layers

**Provider/Model Layer:**

- Purpose: LLM provider integrations (Anthropic, Google, OpenAI, etc.)
- Location: `extensions/*/` (anthropic, google, openai, etc.), `src/providers/`
- Contains: Provider-specific auth, model listings, API adapters
- Depends on: Auth profiles, config
- Used by: Agent layer (model selection and execution)

**Auth Profile Layer:**

- Purpose: Manage user authentication credentials for providers and channels
- Location: `src/agents/auth-profiles/`
- Contains: Auth store, token management, cooldown tracking, profile resolution
- Depends on: Secrets, config
- Used by: Agents, providers

**Plugin/Extension System:**

- Purpose: Load and manage bundled + user-installed extensions
- Location: `src/plugins/`, `extensions/`
- Contains: Plugin registry, manifest loading, MCP bridge support
- Depends on: Bundle loader, config
- Used by: Gateway, agents (channel and provider plugins)

**Daemon Layer:**

- Purpose: Background process lifecycle management (launchd on macOS, systemd on Linux/Windows services)
- Location: `src/daemon/`
- Contains: Daemon process management, plist generation, restart handoff
- Depends on: Config, runtime
- Used by: CLI (daemon start/stop/restart commands)

**ACP (Agent Control Protocol) Layer:**

- Purpose: Agent-to-agent communication and spawning
- Location: `src/acp/`
- Contains: ACP server/client, spawning policy, provenance tracking
- Depends on: Gateway protocol, agents
- Used by: Agents (sub-agent spawning), external ACP clients

## Data Flow

**Inbound Message Path:**

1. **Channel receives message** → Message arrives on Slack, Discord, WhatsApp, etc.
2. **Gateway channel transport** → `src/gateway/server-channels.ts` receives message from channel plugin
3. **Route resolution** → `src/routing/resolve-route.ts` determines which agent/session handles it based on config bindings
4. **Session retrieval** → `src/config/sessions/` loads previous conversation state
5. **Agent command execution** → `src/agents/agent-command.ts` invokes model with context
6. **Model selection** → `src/agents/model-selection.ts` picks model based on config/auth/model overrides
7. **Provider API call** → Extension plugin (e.g., `extensions/anthropic/`) makes API request
8. **Response processing** → Agent formats response via `src/auto-reply/reply/`
9. **Session persistence** → Updated session written back to `src/config/sessions/`
10. **Channel delivery** → `src/gateway/server-channels.ts` routes response back to originating channel

**State Management:**

- **Sessions** live in `~/.openclaw/sessions/` — one JSON file per agent + conversation thread
- **Transcripts** stored as `*.jsonl` in session directory — append-only event log
- **Config** cached in memory with refresh hooks — changes detected via file monitoring
- **Auth profiles** cached in `~/.openclaw/auth-profiles/` — modified with cooldown tracking + last-used state
- **Agent execution context** temporary — cleared after agent run completes

**Gateway-to-Client Communication:**

- WebSocket connection established by client (macOS app, web UI, external gateway client)
- Messages exchanged via JSON-RPC protocol (`src/gateway/protocol/`)
- Gateway pushes channel presence, message updates, health status to clients
- Clients request agent runs, channel operations, configuration changes

## Key Abstractions

**Session Key:**

- Purpose: Unique identifier for agent + channel + peer conversation
- Examples: `agent:main:main`, `agent:main:discord:@user123`
- Pattern: `agent:<agent_id>:<channel>:<peer_id>` (peer_id omitted for "main" session)
- Used in: Session store paths, routing, transcript identification

**Route Binding:**

- Purpose: Map incoming message source to target agent
- Examples: Direct peer binding, role-based (Discord), guild/team, default channel fallback
- Matches: Channel + peer ID → agent ID (with hierarchical fallback: peer → parent peer → guild+roles → guild → team → account → channel → default)
- File: `src/routing/resolve-route.ts`

**Model Selection:**

- Purpose: Pick LLM provider + model for agent execution
- Order: Session override → Agent config → Global default
- Includes: Fallback chain if primary model fails
- Files: `src/agents/model-selection.ts`, `src/sessions/model-overrides.ts`

**Auth Profile:**

- Purpose: Credential container for LLM/channel providers
- Structure: Provider ID → tokens/secrets + cooldown state + last-used timestamp
- Resolution: Config order → last-used → round-robin fallback
- Files: `src/agents/auth-profiles.ts`, `src/agents/auth-profiles/resolve-auth-profile-order.ts`

**Channel Transport:**

- Purpose: Bidirectional message abstraction
- Provides: Inbound/outbound message parsing, account snapshots, allowlisting
- Lives in: `src/channels/` (core logic), `extensions/*/src/channel.ts` (implementations)

**Config Snapshot:**

- Purpose: Immutable in-memory representation of current config state
- Updated: On file change via watcher
- Cached: To avoid repeated file I/O
- Files: `src/config/io.ts` (loader), `src/config/runtime-overrides.ts` (in-memory state)

**Agent Command:**

- Purpose: Encapsulate a single agent execution request
- Includes: Session ID, model override, auth override, message content, metadata
- Returns: Streaming response events or batch result
- File: `src/agents/agent-command.ts`

## Entry Points

**CLI Entry:**

- Location: `src/entry.ts`
- Triggers: User runs `openclaw` binary or `openclaw <command>`
- Responsibilities: Parse argv, setup runtime, invoke command handler or daemon startup

**Gateway Server:**

- Location: `src/gateway/server-shared.ts` (initialization), `src/gateway/server/ws-connection.ts` (WebSocket handler)
- Triggers: `openclaw gateway run` command or daemon startup
- Responsibilities: Listen on port, accept WebSocket clients, route messages, health checks

**Agent Command:**

- Location: `src/agents/agent-command.ts`
- Triggers: User message routed to agent, `openclaw agent` CLI command
- Responsibilities: Load session, select model, invoke AI, format response, persist state

**Channel Handler:**

- Location: `extensions/<channel>/src/channel.ts` (e.g., `extensions/discord/src/channel.ts`)
- Triggers: Inbound message from platform (Discord webhook, Telegram polling, etc.)
- Responsibilities: Parse platform message, emit gateway events, handle outbound delivery

## Error Handling

**Strategy:** Errors caught at layer boundaries; context-specific retry/fallback logic.

**Patterns:**

- **Model Fallback** (`src/agents/model-fallback.ts`): If primary model fails, attempt next in chain
- **Auth Cooldown** (`src/agents/auth-profiles.ts`): Failed auth marked with cooldown timer; next attempt after cooldown
- **Failover** (`src/agents/failover-error.ts`): Structured error for model selection failures
- **Session Recovery** (`src/config/sessions/`): If transcript corrupted, fallback to last-good snapshot
- **Gateway Disconnection** (`src/gateway/protocol/`): Client connection drops; server holds session state; client reconnects
- **Port Conflict** (`src/infra/net/`): Daemon port in use; suggest alternative or kill incumbent

## Cross-Cutting Concerns

**Logging:**

- Subsystem logger via `src/logging/subsystem.ts` (structured, with prefix)
- Config controls verbosity via `config.logging.level`
- Agent event logging via `src/infra/agent-events.ts`

**Validation:**

- Config validation via `src/config/validation.ts` (JSON schema)
- Message validation via channel transport layer
- Type safety via TypeScript strict mode

**Authentication:**

- API tokens stored in auth profile store (`~/.openclaw/auth-profiles/`)
- Secrets manager integration for credential retrieval
- Session-level auth overrides via `src/agents/auth-profiles/session-override.ts`

**Concurrency:**

- Agent sessions isolated by session key; concurrent agents run independently
- File I/O protected by locking mechanism in session store
- WebSocket connections concurrent; gateway manages multiplexing

---

_Architecture analysis: 2026-03-17_
