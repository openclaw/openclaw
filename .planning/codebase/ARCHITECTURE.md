# Architecture

**Analysis Date:** 2026-03-28

## Pattern Overview

**Overall:** Multi-layer plugin-driven gateway + messaging system with an embedded LLM agent core

**Key Characteristics:**

- Central gateway server (`src/gateway/server.impl.ts`) brokers all real-time communication via WebSocket (JSON-RPC-style protocol)
- Channel plugins normalize heterogeneous messaging surfaces (Telegram, Discord, Slack, Signal, WhatsApp, etc.) into a common pipeline
- An embedded AI agent (`@mariozechner/pi-agent-core`) drives AI responses; all model I/O flows through `src/agents/pi-embedded-runner/`
- Plugin SDK (`src/plugin-sdk/`) provides a stable public contract boundary between core and bundled/third-party extensions
- Strict module boundaries enforced by CLAUDE.md files in key directories

## Layers

**CLI / Entry Point:**

- Purpose: Parse argv, register lazy commands, bootstrap config, load plugins
- Location: `src/cli/`
- Contains: Commander-based program builder, per-command registrars, profile env handling, progress utilities
- Depends on: `src/config/`, `src/gateway/`, `src/plugins/`
- Used by: `openclaw.mjs` (Node entry), `pnpm openclaw ...` (Bun dev runner)

**Config:**

- Purpose: Load, validate, migrate, and snapshot `openclaw.json`; provide typed config to all layers
- Location: `src/config/`
- Contains: Zod schemas, per-channel type modules (`types.telegram.ts`, etc.), IO helpers, legacy migrations, merge-patch
- Depends on: nothing internal (leaf layer)
- Used by: every other layer

**Gateway Server:**

- Purpose: Runs the persistent local server; manages channels, plugins, sessions, auth, and RPC
- Location: `src/gateway/server.impl.ts`, `src/gateway/server.ts` (re-export)
- Contains: `startGatewayServer()`, channel manager, session handlers, model catalog, cron runner, health monitor, canvas host bootstrap
- Depends on: `src/config/`, `src/channels/`, `src/agents/`, `src/plugins/`, `src/daemon/`
- Used by: `src/cli/gateway-cli.ts` (`openclaw gateway run`), macOS app

**Gateway Protocol:**

- Purpose: Defines the typed wire contract for gateway ↔ clients (CLI, mobile, web UI, nodes)
- Location: `src/gateway/protocol/`
- Contains: JSON-RPC frame types (`frames.ts`), per-domain schema files (`schema/agent.ts`, `schema/channels.ts`, etc.), AJV validators
- Depends on: nothing internal
- Used by: `src/gateway/client.ts`, mobile apps, Control UI

**Gateway Client:**

- Purpose: WebSocket client that connects CLI commands and node-host runners to the gateway
- Location: `src/gateway/client.ts`
- Contains: `GatewayClient` class — device auth handshake, request/response multiplexing, reconnect
- Depends on: `src/gateway/protocol/`, `src/infra/`
- Used by: CLI commands, `src/node-host/`, `src/acp/server.ts`

**Channel Plugins:**

- Purpose: Normalize each messaging platform into a common adapter contract
- Location: `src/channels/plugins/` (core), `extensions/*/src/` (per-channel plugin bundles)
- Contains: `ChannelPlugin` type (`types.plugin.ts`), adapter interfaces (`types.adapters.ts`), registry, allowlist logic
- Depends on: `src/config/`, `src/plugin-sdk/`
- Used by: gateway server, auto-reply pipeline, routing

**Auto-Reply Pipeline:**

- Purpose: Process inbound messages: route, parse directives, run agent, dispatch reply
- Location: `src/auto-reply/`
- Contains: `dispatch.ts` (top-level dispatch), `reply/get-reply.ts` (orchestration), `reply/agent-runner.ts` (LLM turn execution), `reply/reply-dispatcher.ts` (outbound delivery with typing delay), command registry
- Depends on: `src/agents/`, `src/routing/`, `src/channels/`, `src/config/`
- Used by: gateway server's inbound message handlers

**Agent / LLM Core:**

- Purpose: Execute LLM turns via `@mariozechner/pi-agent-core`; handle auth profiles, model fallback, subagents, skills, sandboxing
- Location: `src/agents/`
- Contains: `pi-embedded-runner/run.ts` (main agent run), `pi-embedded-subscribe.ts` (streaming output processor), `model-auth.ts`, `models-config.ts`, `skills.ts`, `subagent-registry.ts`, `bash-tools.ts`
- Depends on: `src/config/`, `src/infra/`, `src/plugins/`
- Used by: `src/auto-reply/reply/agent-runner.ts`

**Plugin Runtime:**

- Purpose: Load, validate, and expose plugin capabilities to core (channels, providers, tools, hooks, web search, TTS, media)
- Location: `src/plugins/`
- Contains: manifest registry, loader, capability-provider runtime, hook runner, bundled plugin metadata (`bundled-plugin-metadata.generated.ts`)
- Depends on: `src/config/`, `src/plugin-sdk/`
- Used by: gateway server, agent runner, CLI

**Plugin SDK:**

- Purpose: Public API surface consumed by bundled and third-party plugins
- Location: `src/plugin-sdk/`
- Contains: `core.ts` (re-exports), channel contract, provider entry, runtime facade
- Depends on: internal type definitions only (no implementation pull-through)
- Used by: `extensions/*/src/` plugin packages

**Routing:**

- Purpose: Map (channel, accountId, peer) tuples to (agentId, sessionKey)
- Location: `src/routing/`
- Contains: `resolve-route.ts`, `session-key.ts`, `bindings.ts`, `account-lookup.ts`
- Depends on: `src/config/`
- Used by: auto-reply pipeline, gateway server

**Infra:**

- Purpose: Cross-cutting utilities — FS helpers, HTTP, networking, exec approvals, update checks, heartbeat, pairing, secrets, logging
- Location: `src/infra/`
- Contains: hundreds of focused utility modules; notably `exec-approvals.ts`, `outbound/`, `heartbeat-runner.ts`, `device-identity.ts`, `secure-random.ts`
- Depends on: `src/config/` (paths only)
- Used by: all layers

**Daemon / Service Manager:**

- Purpose: Install and manage the gateway as a system service (launchd, systemd, Windows Task Scheduler)
- Location: `src/daemon/`
- Contains: `service.ts` (unified interface), `launchd.ts`, `systemd.ts`, `schtasks.ts`
- Depends on: `src/infra/`, `src/config/`
- Used by: `src/commands/` onboard/setup flows, `openclaw gateway install`

**Node Host:**

- Purpose: Run a remote node that connects to a gateway and handles tool invocations
- Location: `src/node-host/`
- Contains: `runner.ts`, `invoke.ts`, `exec-policy.ts`
- Depends on: `src/gateway/client.ts`, `src/infra/`
- Used by: mobile apps (Android/iOS embed Node.js and run this), remote machines

**ACP (Agent Client Protocol):**

- Purpose: Serve the standard Agent-Client Protocol bridge, translating ACP requests into gateway calls
- Location: `src/acp/`
- Contains: `server.ts`, `translator.ts`, `control-plane/manager.ts`, `runtime/`
- Depends on: `src/gateway/client.ts`, `@agentclientprotocol/sdk`
- Used by: `openclaw acp` command, external ACP-capable clients

**TUI:**

- Purpose: Terminal UI for interactive chat sessions against the gateway
- Location: `src/tui/`
- Contains: `tui.ts`, `gateway-chat.ts`, component tree built with `@mariozechner/pi-tui`
- Depends on: `src/gateway/client.ts`, `src/routing/`
- Used by: `openclaw tui` command

**Canvas Host:**

- Purpose: Local HTTP/WS server for the a2ui canvas (agent-rendered interactive UI)
- Location: `src/canvas-host/`
- Contains: `server.ts`, `a2ui.ts`, `file-resolver.ts`
- Depends on: `src/config/`, `src/infra/`
- Used by: gateway server startup

**Control UI (Web UI):**

- Purpose: React SPA served from the gateway for browser-based management
- Location: `ui/src/`
- Contains: `main.ts`, `ui/` (React components), `app-gateway.ts`
- Depends on: gateway WebSocket protocol
- Used by: browsers connecting to `http://localhost:<port>`

## Data Flow

**Inbound Message → AI Reply:**

1. Channel plugin monitor receives message (e.g. Telegram bot update)
2. Message is normalized into a `MsgContext` in `src/auto-reply/templating.ts`
3. `dispatchInboundMessage()` in `src/auto-reply/dispatch.ts` is called
4. `getReplyFromConfig()` in `src/auto-reply/reply/get-reply.ts` resolves directives, model, session
5. `runPreparedReply()` in `src/auto-reply/reply/get-reply-run.ts` invokes `runReplyAgent()`
6. `runReplyAgent()` in `src/auto-reply/reply/agent-runner.ts` calls `runEmbeddedPiAgent()` in `src/agents/pi-embedded-runner/run.ts`
7. `runEmbeddedAttempt()` in `src/agents/pi-embedded-runner/run/attempt.ts` calls `@mariozechner/pi-agent-core` via `@mariozechner/pi-ai`
8. `subscribeEmbeddedPiSession()` in `src/agents/pi-embedded-subscribe.ts` streams output blocks back
9. `ReplyDispatcher` in `src/auto-reply/reply/reply-dispatcher.ts` delivers reply payloads via channel plugin's outbound adapter

**CLI Command → Gateway RPC:**

1. `openclaw.mjs` → `run-main.ts` → `route.ts` → lazy command registrar
2. Command creates `GatewayClient` from `src/gateway/client.ts`
3. Client sends typed JSON-RPC request per `src/gateway/protocol/`
4. Gateway server dispatches to handler in `src/gateway/server-methods.ts`
5. Response returned to CLI command

**State Management:**

- Config read from `~/.openclaw/openclaw.json`, validated with Zod, cached with reload support (`src/config/io.ts`)
- Session transcripts stored as JSONL under `~/.openclaw/sessions/` and `~/.openclaw/agents/<id>/sessions/`
- Plugin state in `~/.openclaw/plugins/`

## Key Abstractions

**ChannelPlugin:**

- Purpose: Adapter contract for a messaging platform (monitor, outbound, config, auth, pairing, etc.)
- Examples: `extensions/telegram/src/`, `extensions/discord/src/`, `extensions/signal/src/`
- Pattern: Objects implementing adapter interfaces from `src/channels/plugins/types.adapters.ts`; registered via plugin manifest

**OpenClawPluginApi (Plugin Runtime):**

- Purpose: Facade passed to plugins at runtime; provides access to config, channels, media, TTS, web search, model auth, system events
- Examples: `src/plugins/runtime/index.ts` (factory), consumed by `extensions/*/src/`
- Pattern: Created per plugin load; passed as `api` argument to plugin `init()` / lifecycle hooks

**ReplyDispatcher:**

- Purpose: Buffers, normalizes, and sequentially delivers reply payloads from an agent run
- Examples: `src/auto-reply/reply/reply-dispatcher.ts`
- Pattern: Created per inbound message; registered in global `dispatcher-registry.ts` so gateway drain waits for all in-flight deliveries before restart

**GatewayServer:**

- Purpose: Central runtime state holder — owns channel manager, session registry, node registry, plugin registry, cron service
- Examples: `src/gateway/server.impl.ts` → `startGatewayServer()`
- Pattern: Single long-lived process; config reloaded hot via `src/gateway/config-reload.ts`

**SessionKey:**

- Purpose: Stable identifier mapping a (agent, channel, account, peer) tuple to a conversation
- Examples: `src/routing/session-key.ts`
- Pattern: String like `<agentId>/<channelId>/<accountId>/<peerKind>/<peerId>`; used as both storage key and concurrency lane

## Entry Points

**`openclaw.mjs`:**

- Location: `openclaw.mjs`
- Triggers: Direct `node openclaw.mjs` or installed `openclaw` binary
- Responsibilities: Node version guard, compile cache, lazy ESM import of `src/cli/run-main.ts`

**`src/cli/run-main.ts`:**

- Location: `src/cli/run-main.ts`
- Triggers: Called from `openclaw.mjs`
- Responsibilities: Normalize argv, route CLI (container, profile, primary command), build Commander program, execute

**`src/cli/program/build-program.ts`:**

- Location: `src/cli/program/build-program.ts`
- Triggers: Called by `run-main.ts`
- Responsibilities: Construct Commander instance, register lazy command stubs, attach pre-action hooks

**`src/gateway/server.impl.ts` (`startGatewayServer`):**

- Location: `src/gateway/server.impl.ts`
- Triggers: `openclaw gateway run` command via `src/cli/gateway-cli.ts`
- Responsibilities: Load config, load plugins, start HTTP/WS server, bootstrap channels, start cron/heartbeat/maintenance timers

**`src/node-host/runner.ts`:**

- Location: `src/node-host/runner.ts`
- Triggers: Mobile app Node.js module or `openclaw nodes run`
- Responsibilities: Connect to gateway as a node, register capabilities, dispatch tool invocations

**`src/acp/server.ts` (`serveAcpGateway`):**

- Location: `src/acp/server.ts`
- Triggers: `openclaw acp` command
- Responsibilities: Bridge ACP stdio protocol to gateway WebSocket

## Error Handling

**Strategy:** Fail-fast with structured error objects; LLM turn failures use failover/retry with backoff

**Patterns:**

- Auth failures → `FailoverError` class in `src/agents/failover-error.ts`; triggers auth profile rotation via `src/agents/model-auth.ts`
- Config load failures → Zod validation errors surfaced via `doctor` command
- Gateway WS errors → `GatewayClient` reconnects with backoff; CLI commands surface structured error codes from `ConnectErrorDetailCodes`
- Unhandled rejections → captured by `src/infra/unhandled-rejections.ts`; logged and process exits on fatal

## Cross-Cutting Concerns

**Logging:** `src/logging/` (`createSubsystemLogger`, structured JSONL to `~/.openclaw/openclaw-YYYY-MM-DD.log`); `src/cli/log-level-option.ts` for CLI verbosity
**Validation:** Zod schemas in `src/config/` for all config; AJV validators generated from JSON schema in `src/gateway/protocol/`
**Authentication:** Multi-surface: gateway auth token (Bearer), device token (crypto keypair), OAuth flows per provider; resolved in `src/secrets/runtime.ts` and `src/gateway/startup-auth.ts`
**Secrets:** `SecretRef` indirection (`src/secrets/`) — config values may reference env vars or credential files; resolved at runtime
**Plugin Isolation:** Each extension is a pnpm workspace package under `extensions/`; loaded at runtime via `src/plugins/loader.ts` with manifest validation

---

_Architecture analysis: 2026-03-28_
