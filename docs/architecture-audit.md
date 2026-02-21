# Moltbot Architecture Audit

A comprehensive analysis of the Moltbot codebase: architecture, modules, features, security model, and lessons for building a more secure and private personal assistant.

---

## 1. High-Level Architecture

Moltbot is a **multi-channel AI personal assistant gateway** built in TypeScript (ESM). It bridges messaging platforms (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, LINE, and more via plugins) with LLM backends, providing a single self-hosted agent that can be reached from any surface.

### Core Architecture Pattern

```
[Messaging Channels]  -->  [Gateway Server]  -->  [Agent Runtime (Pi)]  -->  [LLM Providers]
   WhatsApp (Baileys)        WebSocket + HTTP       Tool execution            Anthropic
   Telegram (grammy)         Auth / Routing          Sandbox (Docker)          OpenAI
   Discord (Carbon)          Session mgmt            Memory (SQLite+Vec)       Google
   Slack (Bolt)              Config reload           Browser control           Bedrock
   Signal                    Hooks system            File I/O                  Ollama
   iMessage                  Plugin loader           Web search/fetch          Local (llama.cpp)
   LINE                      Cron scheduler          Sub-agents                + more via plugins
   + Extensions              Control UI              Skills system
```

### Runtime Model

- **Node.js 22+** is the production runtime (ESM modules, `dist/` output)
- **Bun** is supported for development (scripts, tests, dev execution)
- The CLI entry point is `moltbot.mjs` -> `src/index.ts` -> `src/cli/program.ts`
- The gateway is a persistent WebSocket + HTTP server that manages all channels, agents, and sessions

---

## 2. Module Organization

### 2.1 Source Tree (`src/`)

The codebase contains ~52 top-level directories under `src/`, organized by domain:

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `cli/` | CLI wiring, Commander program, flag parsing | `program/build-program.ts`, `deps.ts` |
| `commands/` | CLI command implementations | health, status, sessions, agents |
| `gateway/` | WebSocket/HTTP gateway server (~122 TS files) | `server.impl.ts`, `auth.ts`, `server-chat.ts` |
| `agents/` | AI agent runtime, tools, system prompts (~200+ files) | `pi-embedded-runner.ts`, `system-prompt.ts`, `bash-tools.ts` |
| `routing/` | Message routing and session key resolution | `resolve-route.ts`, `bindings.ts`, `session-key.ts` |
| `channels/` | Channel abstraction layer and plugin framework | `plugins/types.ts`, `dock.ts`, `registry.ts` |
| `config/` | Configuration schema, loading, validation, migration | `config.ts`, `types.ts`, `zod-schema.ts` |
| `security/` | Security audit engine, filesystem checks, external content | `audit.ts`, `audit-extra.ts`, `external-content.ts`, `fix.ts` |
| `memory/` | Semantic memory with vector embeddings | `manager.ts`, `sqlite-vec.ts`, `hybrid.ts` |
| `media/` | Media pipeline (fetch, store, transcode, MIME detection) | `fetch.ts`, `store.ts`, `mime.ts`, `audio.ts` |
| `hooks/` | Hook system (Gmail, webhooks, lifecycle, SOUL.md) | `hooks.ts`, `gmail.ts`, `soul-evil.ts` |
| `browser/` | Browser automation (Playwright/CDP) | `cdp.ts`, `pw-session.ts`, `pw-tools-core.ts` |
| `plugins/` | Plugin loader, runtime, API surface | `types.ts`, `services.ts`, `http-registry.ts` |
| `plugin-sdk/` | Public plugin SDK re-exports | `index.ts` (374 lines of re-exports) |
| `auto-reply/` | Inbound message processing, command detection, dispatch | `reply.ts`, `dispatch.ts`, `commands-registry.ts` |
| `sessions/` | Session management, transcript events, model overrides | `transcript-events.ts`, `send-policy.ts` |
| `providers/` | LLM provider-specific code (GitHub Copilot, Qwen, Google) | `github-copilot-auth.ts` |
| `infra/` | Infrastructure utilities (ports, binaries, dotenv, errors) | `ports.ts`, `binaries.js`, `env.ts` |
| `terminal/` | Terminal UI (tables, palette, links) | `table.ts`, `palette.ts` |
| `tui/` | Terminal User Interface (interactive mode) | - |
| `tts/` | Text-to-speech integration | - |
| `sandbox/` (in agents) | Docker sandboxing for tool execution | `docker.ts`, `manage.ts`, `tool-policy.ts` |
| `cron/` | Scheduled jobs and wake events | - |
| `daemon/` | Daemon/service management | - |

### 2.2 Channel Implementations

Each messaging channel has a dedicated directory:

| Channel | Directory | Protocol/Library |
|---------|-----------|-----------------|
| WhatsApp | `src/web/` | Baileys (Web API) |
| Telegram | `src/telegram/` | grammy |
| Discord | `src/discord/` | Carbon (discord-api-types) |
| Slack | `src/slack/` | @slack/bolt + @slack/web-api |
| Signal | `src/signal/` | Signal CLI bridge |
| iMessage | `src/imessage/` | AppleScript/BlueBubbles |
| LINE | `src/line/` | @line/bot-sdk |

### 2.3 Extensions (`extensions/`)

29 extension directories for additional channels and capabilities:

- **Channel extensions**: `msteams`, `matrix`, `zalo`, `zalouser`, `googlechat`, `nostr`, `twitch`, `nextcloud-talk`, `tlon`
- **AI provider extensions**: `google-antigravity-auth`, `google-gemini-cli-auth`, `qwen-portal-auth`, `copilot-proxy`
- **Capability extensions**: `voice-call`, `memory-core`, `memory-lancedb`, `open-prose`, `lobster`, `diagnostics-otel`, `llm-task`
- **Duplicated core channels** (for plugin packaging): `discord`, `telegram`, `slack`, `signal`, `imessage`, `whatsapp`, `line`, `bluebubbles`

### 2.4 Native Apps

| Platform | Directory | Technology |
|----------|-----------|-----------|
| macOS | `apps/macos/` | SwiftUI (Observation framework) |
| iOS | `apps/ios/` | SwiftUI + XcodeGen |
| Android | `apps/android/` | Kotlin + Gradle |

### 2.5 Skills System

The `skills/` directory contains 54 skill definitions that extend agent capabilities via SKILL.md files that the agent reads on demand. This is a lightweight extension mechanism layered on top of the system prompt.

---

## 3. Gateway Architecture

The gateway (`src/gateway/`) is the heart of the system - a WebSocket + HTTP server with 122 TypeScript files.

### Key Components

- **`server.impl.ts`**: Main gateway startup, orchestrates all subsystems
- **`auth.ts`**: Authentication via token, password, Tailscale whois, or device tokens; uses `timingSafeEqual` for constant-time comparison
- **`server-chat.ts`**: Agent event handler, bridges inbound messages to the Pi agent runtime
- **`server-channels.ts`**: Channel manager, connects/disconnects messaging channels
- **`server-broadcast.ts`**: Event broadcast to connected WebSocket clients
- **`config-reload.ts`**: Live config reload without restart
- **`server-cron.ts`**: Cron scheduling service
- **`server-discovery.ts`**: mDNS/Bonjour discovery for LAN pairing
- **`server-tailscale.ts`**: Tailscale Serve/Funnel exposure
- **`server-lanes.ts`**: Concurrency lane management for parallel agent sessions
- **`openai-http.ts`**: OpenAI-compatible HTTP API endpoint
- **`server-browser.ts`**: Browser control server integration
- **`control-ui.ts`**: Web-based control panel

### Bind Modes

The gateway supports multiple bind modes:
- **loopback** (127.0.0.1) - default, safest
- **lan** (0.0.0.0) - for LAN access
- **tailnet** - bind to Tailscale IP only
- **auto** - prefer loopback, fallback to LAN

### Protocol

The gateway speaks a WebSocket protocol with JSON-RPC-style method dispatch. Methods are registered in `server-methods.ts` / `server-methods-list.ts`. Plugins can register additional gateway methods.

---

## 4. Agent Runtime

The agent system is built on top of **Pi** (`@mariozechner/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) - an embedded LLM agent framework.

### 4.1 Agent Lifecycle

1. **Inbound message** arrives on any channel
2. **Routing** (`src/routing/resolve-route.ts`) resolves: agentId, channel, accountId, sessionKey
3. **Auto-reply** (`src/auto-reply/`) processes commands, directives, triggers
4. **Pi embedded runner** (`src/agents/pi-embedded-runner.ts`) invokes the LLM with:
   - System prompt (built dynamically from agent config, workspace files, skills)
   - Conversation history (from session transcript)
   - Available tools (filtered by policy)
5. **Streaming response** is chunked and delivered back to the originating channel
6. **Session state** is persisted (transcript, usage)

### 4.2 Tool System

The agent has a rich set of built-in tools:

| Tool | Purpose |
|------|---------|
| `read`, `write`, `edit`, `apply_patch` | File I/O |
| `grep`, `find`, `ls` | File search |
| `exec`, `process` | Shell command execution (with PTY support) |
| `web_search`, `web_fetch` | Web research (Brave API) |
| `browser` | Full browser automation (Playwright/CDP) |
| `canvas` | Interactive Canvas UI |
| `nodes` | Paired device control (camera, screen) |
| `cron` | Scheduled tasks and reminders |
| `message` | Cross-channel messaging |
| `sessions_list/history/send/spawn` | Multi-session and sub-agent management |
| `session_status` | Usage and session status display |
| `image` | Image analysis |
| `memory_search`, `memory_get` | Semantic memory recall |
| `gateway` | Self-management (restart, config, update) |

### 4.3 Tool Policy

Tools are governed by a multi-layer policy system:

1. **Global tool policy** in config (`tools.allow`, `tools.deny`)
2. **Per-agent tool policy** (agent-specific allow/deny lists)
3. **Sandbox tool policy** (Docker sandbox restricts certain tools)
4. **Group tool policy** (different tools allowed per group/channel)
5. **Elevated mode** (gated tool execution requiring approval)
6. **Plugin tool policy** (plugins can register tools with allowlist constraints)

### 4.4 Model Support

Multi-provider model support with failover:

- **Anthropic** (Claude models)
- **OpenAI** (GPT models, including reasoning models)
- **Google** (Gemini models)
- **AWS Bedrock** (discovery-based)
- **Ollama** (local models)
- **Node-llama-cpp** (local llama.cpp)
- **GitHub Copilot** (via token exchange)
- **Minimax** (VLM support)
- **Venice**, **Z.AI**, **Chutes** (additional providers)
- **Auth profiles** with rotation, cooldowns, and failover (`src/agents/auth-profiles/`)
- **Model catalog** with alias resolution and fuzzy matching

### 4.5 Sub-Agent System

Moltbot supports spawning sub-agents with:
- Independent sessions and session keys
- Configurable model overrides
- Announce-back to parent session when done
- Per-agent workspace isolation
- Sub-agent registry with persistence

---

## 5. Routing and Session Management

### 5.1 Route Resolution

The routing system (`src/routing/resolve-route.ts`) implements a priority-based binding matcher:

1. **Peer binding** (exact peer match - DM or group by ID)
2. **Guild binding** (Discord server)
3. **Team binding** (Slack workspace)
4. **Account binding** (specific channel account)
5. **Channel binding** (wildcard account match)
6. **Default** (falls back to default agent)

### 5.2 Session Keys

Session keys encode: `agentId:channel:accountId:peer` with configurable DM scoping:
- `main` - all DMs share one session
- `per-peer` - each DM sender gets their own session
- `per-channel-peer` - per-channel per-peer isolation
- `per-account-channel-peer` - full isolation

### 5.3 Identity Links

Cross-channel identity linking allows recognizing the same user across platforms (e.g., same person on Telegram and Discord shares session context).

---

## 6. Security Model

### 6.1 Security Audit Engine

Moltbot includes a **built-in security audit** (`moltbot security audit`) that checks:

**Gateway Security:**
- Bind mode vs. authentication configuration
- Token strength (minimum 24 chars recommended)
- Tailscale Funnel exposure warnings
- Control UI insecure auth detection
- Device auth disable detection
- Trusted proxy configuration
- TLS configuration

**Filesystem Security:**
- State directory permissions (world/group writable detection)
- Config file permissions (token leakage via readable config)
- Symlink detection on critical paths
- Include file permission verification
- Deep filesystem scan of state directory
- Plugin trust verification

**Channel Security:**
- Open DM policy detection (critical severity)
- Missing sender allowlists
- DM scope warnings (shared sessions across users)
- Discord slash command restrictions
- Slack slash command access groups
- Telegram group command allowlists
- Wildcard allowlist detection

**Additional Checks:**
- Logging redaction configuration
- Elevated exec wildcard allowlists
- Hooks hardening
- Secrets in config detection
- Model hygiene (small model risk assessment)
- Attack surface summary
- Exposure matrix analysis
- Synced folder detection (iCloud/Dropbox on state dir)
- Browser CDP remote HTTP warnings

### 6.2 Authentication

- **Gateway auth**: Token-based (recommended) or password-based
- **Timing-safe comparison** using `crypto.timingSafeEqual`
- **Tailscale whois** integration for tailnet-authenticated requests
- **Device tokens** for mobile/desktop app pairing
- **Loopback detection** for local-only access

### 6.3 Prompt Injection Defenses

- **External content wrapping** (`src/security/external-content.ts`):
  - Suspicious pattern detection (regex-based)
  - Content boundary markers (`<<<EXTERNAL_UNTRUSTED_CONTENT>>>`)
  - Security warning injection before untrusted content
  - Source tagging (email, webhook, API)
- **Chat sanitization** (`src/gateway/chat-sanitize.ts`)
- **Tool result guard** (`src/agents/session-tool-result-guard.ts`)

### 6.4 Sandbox (Docker)

- Full Docker-based sandboxing for tool execution
- Configurable workspace access (none/ro/rw)
- Agent workspace mounting
- Browser bridge support within sandbox
- Elevated mode with approval workflow
- Sandbox tool policy enforcement
- Container pruning and lifecycle management

### 6.5 Access Control

- **Channel allowlists**: Per-channel DM and group allowlists
- **Pairing system**: QR code and approval-based device pairing
- **Access groups**: `commands.useAccessGroups` gates slash command access
- **Elevated mode**: Gated shell execution requiring explicit approval
- **Group policy**: `open`, `allowlist`, `disabled` per channel
- **Mention gating**: Groups can require @mention before responding
- **Command gating**: Control commands restricted to authorized senders

### 6.6 Secret Detection

- `detect-secrets` integration for CI/CD secret scanning
- `.secrets.baseline` maintained for false-positive management
- Config-level secret detection in security audit
- Logging redaction for tool summaries (`logging.redactSensitive`)

---

## 7. Plugin System

### 7.1 Plugin Architecture

Plugins are loaded via `jiti` (TypeScript-aware dynamic importer) and have access to a rich API:

```typescript
type MoltbotPluginApi = {
  registerTool(tool, opts?)        // Register agent tools
  registerHook(events, handler)    // Register lifecycle hooks
  registerHttpHandler(handler)     // Register HTTP middleware
  registerHttpRoute({path, handler}) // Register HTTP routes
  registerChannel(registration)     // Register messaging channels
  registerGatewayMethod(method, handler) // Register WS methods
  registerCli(registrar)           // Register CLI commands
  registerService(service)         // Register background services
  registerProvider(provider)       // Register LLM providers
  registerCommand(command)         // Register direct commands
  on(hookName, handler)            // Register lifecycle hooks
}
```

### 7.2 Plugin Lifecycle Hooks

15 lifecycle events plugins can intercept:

- `before_agent_start` / `agent_end`
- `before_compaction` / `after_compaction`
- `message_received` / `message_sending` / `message_sent`
- `before_tool_call` / `after_tool_call` / `tool_result_persist`
- `session_start` / `session_end`
- `gateway_start` / `gateway_stop`

### 7.3 Channel Plugin SDK

The channel plugin SDK (`src/plugin-sdk/index.ts`) exposes a comprehensive set of adapters:

- `ChannelConfigAdapter` - Configuration management
- `ChannelGatewayAdapter` - Gateway integration
- `ChannelMessagingAdapter` - Message send/receive
- `ChannelOutboundAdapter` - Outbound message formatting
- `ChannelPairingAdapter` - Device/user pairing
- `ChannelSecurityAdapter` - Security policies
- `ChannelStatusAdapter` - Health/status reporting
- `ChannelSetupAdapter` - Interactive setup wizard
- `ChannelAuthAdapter` - Authentication
- `ChannelStreamingAdapter` - Response streaming
- `ChannelThreadingAdapter` - Thread/topic support
- `ChannelMentionAdapter` - @mention handling
- `ChannelHeartbeatAdapter` - Keepalive/heartbeat
- `ChannelGroupAdapter` - Group/guild management
- `ChannelDirectoryAdapter` - Contact directory
- `ChannelCommandAdapter` - Native command support
- `ChannelElevatedAdapter` - Elevated mode integration
- `ChannelMessageActionAdapter` - Message actions (reactions, polls, etc.)

### 7.4 Plugin Isolation (Limitations)

**Plugins run in the same process** - there is no sandboxing, resource isolation, or permission boundary between plugins and the core. A malicious plugin has full access to:
- All configuration (including tokens/secrets)
- All tool execution capabilities
- All messaging channels
- The filesystem

---

## 8. Memory System

### 8.1 Architecture

The memory system (`src/memory/`) provides persistent semantic search:

- **SQLite** with **sqlite-vec** extension for vector storage
- **Hybrid search**: combines BM25 keyword search with vector similarity
- **Embedding providers**: OpenAI, Gemini, or local (node-llama-cpp)
- **File watching**: `chokidar` watches memory files for real-time re-indexing
- **Session transcript indexing**: Agent conversations can be indexed for recall
- **Chunk-based**: Markdown files are chunked for granular search

### 8.2 Memory Sources

- `MEMORY.md` and `memory/*.md` files in workspace
- Session transcripts (optional)
- Agent-specific memory directories

---

## 9. Configuration System

### 9.1 Schema and Validation

- **Zod schemas** for full config validation
- **JSON5** config file format (supports comments)
- **Config includes** (`$include` key) for modular config
- **Environment variable substitution** in config values
- **Legacy migration** system (3-part migration with rules engine)
- **Live reload** without gateway restart
- **Backup rotation** for config file changes

### 9.2 Configuration Scope

The config covers:

- Gateway settings (bind, port, auth, TLS, Tailscale)
- Channel configurations (per-channel, per-account)
- Agent definitions (multi-agent support)
- Model configuration (providers, aliases, auth profiles)
- Tool policies (allow/deny, elevated, sandbox)
- Session settings (DM scope, identity links, history limits)
- Hooks configuration
- Memory configuration
- Browser control settings
- Skills configuration
- Logging and diagnostics
- Plugin configuration

---

## 10. Features Summary

### Core Capabilities
- Multi-channel messaging gateway (9+ built-in channels, 10+ extensions)
- AI agent with 20+ built-in tools
- Multi-model support with provider failover
- Sub-agent spawning and orchestration
- Docker sandboxing for tool execution
- Browser automation (Playwright/CDP)
- Semantic memory with vector search
- Cron scheduling and reminders
- Skills system for extensible agent behaviors
- Plugin system with 15 lifecycle hooks
- macOS/iOS/Android native apps
- TUI (Terminal User Interface)
- Text-to-speech
- Device pairing (QR, mDNS, Tailscale)
- Live config reload
- Built-in security audit
- Canvas UI (A2UI)
- OpenAI-compatible HTTP API
- Node host system (paired devices: camera, screen)
- Media pipeline (images, audio, documents, PDFs)

### Persona System
- `SOUL.md` - configurable agent persona
- `SOUL_EVIL.md` - alternate persona with probability/schedule triggers
- Workspace bootstrap files (TOOLS.md, MEMORY.md, etc.)
- Per-agent system prompt customization

---

## 11. Limitations and Concerns

### 11.1 Security Limitations

1. **No plugin sandboxing**: Plugins execute in the same process with full access to all resources. A single malicious plugin can exfiltrate all credentials, manipulate messages, or execute arbitrary code.

2. **Config file stores secrets**: API tokens, passwords, and gateway auth tokens live in the same JSON5 config file. While the audit warns about file permissions, there is no encrypted-at-rest storage.

3. **No end-to-end encryption for sessions**: Session transcripts are stored as plaintext JSONL files on disk. Anyone with filesystem access can read all conversation history.

4. **Regex-based prompt injection defense**: The external content protection uses pattern matching (`detectSuspiciousPatterns`), which is inherently bypassable. The boundary-marker approach is better but still relies on the LLM respecting the markers.

5. **DM session sharing by default**: `session.dmScope` defaults to `main`, meaning multiple DM senders share the same conversation context. The audit detects this but it remains the default.

6. **No per-message authentication**: Once a sender is on an allowlist, all messages from that sender are trusted equally. There is no message-level signing or verification.

7. **Gateway auth is optional**: Running without auth is possible (and common in loopback mode), but exposes the full API to any local process.

8. **Elevated mode trust model**: The elevated exec approval system gates commands, but a compromised agent session could potentially craft convincing approval requests.

### 11.2 Architectural Limitations

1. **Monolithic gateway**: All channels, agents, plugins, and services run in a single Node.js process. A crash in any channel adapter can take down the entire system.

2. **File-based persistence**: Sessions, config, and memory all use filesystem storage (JSONL, SQLite, JSON5). No option for database-backed storage for multi-instance deployment.

3. **Single-machine design**: The gateway assumes it runs on one machine. Horizontal scaling or multi-instance deployment is not supported.

4. **Large codebase complexity**: The `src/gateway/` alone has 122 files, `src/agents/` has 200+. The total codebase is substantial for a single project, increasing maintenance burden.

5. **Tight coupling to Pi framework**: The agent runtime is deeply integrated with the `@mariozechner/pi-*` packages. Switching agent frameworks would require significant refactoring.

6. **WhatsApp via web client**: The WhatsApp integration uses Baileys (web protocol), which is an unofficial API that can break with WhatsApp updates and may violate ToS.

### 11.3 Privacy Limitations

1. **No data retention policies**: There is no built-in mechanism to automatically purge old session transcripts, memory entries, or media files.

2. **Third-party LLM dependency**: All conversations are sent to cloud LLM providers (Anthropic, OpenAI, Google) unless using local models (Ollama/llama.cpp). The privacy story depends entirely on the provider's data handling.

3. **Media stored unencrypted**: Downloaded media files (images, audio, documents) are stored as-is on the filesystem.

4. **No audit trail for data access**: While the security audit checks configuration, there is no runtime audit trail of who accessed what data through the agent.

5. **Memory system indexes conversations**: The vector memory system can index session transcripts, creating a searchable corpus of all conversations without explicit user consent flows.

---

## 12. Lessons for a Secure and Private Personal Assistant

### 12.1 What Moltbot Does Well (Adopt These Patterns)

1. **Built-in security audit** (`moltbot security audit`): The self-assessment capability with severity levels, specific check IDs, and remediation advice is excellent. Every personal assistant should have this.

2. **Multi-layer tool policy**: The cascading allow/deny lists (global -> agent -> sandbox -> group -> elevated) provide defense-in-depth for tool execution.

3. **Docker sandboxing**: Running tool execution in isolated containers is the right approach for untrusted code execution.

4. **External content wrapping**: The boundary-marker approach for untrusted content (emails, webhooks) is a pragmatic defense against prompt injection.

5. **Timing-safe auth**: Using `crypto.timingSafeEqual` for token comparison prevents timing attacks.

6. **Configurable DM session scoping**: The ability to isolate conversations per-peer prevents context leakage between users.

7. **Channel-agnostic abstraction**: The plugin SDK's adapter pattern cleanly separates channel-specific logic from core functionality.

8. **Live config reload**: Changing security policies without restart minimizes downtime and friction for hardening.

9. **Tailscale integration**: Using Tailscale Serve for secure remote access without exposing ports is a smart default.

10. **Comprehensive channel security**: Per-channel DM/group policies, allowlists, mention gating, and pairing provide granular access control.

### 12.2 Areas to Improve (Lessons Learned)

1. **Encrypt secrets at rest**: Use OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) or encrypted config files instead of plaintext JSON5. Consider `age` or `sops` for config encryption.

2. **Add plugin sandboxing**: Run plugins in isolated V8 contexts (like Cloudflare Workers), separate processes, or Wasm sandboxes. Provide a capability-based API where plugins must declare permissions.

3. **Encrypt session transcripts**: Use per-session encryption keys derived from user credentials. Consider append-only encrypted logs.

4. **Implement data retention policies**: Auto-purge conversations older than N days, with configurable retention per agent/channel. Provide data export and deletion commands.

5. **Add runtime audit logging**: Log all tool executions, message sends, and config changes to a tamper-evident audit trail. This is distinct from conversation logs.

6. **Multi-process architecture**: Consider running channels and agents in separate worker processes. A crash in one channel should not affect others.

7. **Require auth by default**: Ship with auth enabled by default, even for loopback. Generate a random token on first run.

8. **LLM-layer prompt injection defense**: Beyond regex patterns, implement:
   - Input/output classifiers for injection detection
   - Structured tool call validation
   - Response consistency checks
   - Rate limiting on sensitive tool invocations

9. **Local-first model support**: Improve the local model story (Ollama, llama.cpp) for users who cannot send data to cloud providers. Make it a first-class configuration path.

10. **Consent and transparency**: Add explicit user consent flows for memory indexing, session transcript retention, and media storage. Show users what data is stored and provide clear deletion paths.

11. **Per-message signing**: For multi-user scenarios, consider signing inbound messages with channel-specific credentials to prevent spoofing.

12. **Dependency minimization**: The project has ~50 direct dependencies. Each dependency is an attack surface. Regularly audit with tools like `npm audit` and `socket.dev`.

13. **Immutable infrastructure**: Consider shipping as a container image with read-only filesystem (as noted in SECURITY.md) as the primary deployment method rather than global npm install.

---

## 13. Dependency Analysis

### Critical Dependencies

| Dependency | Purpose | Security Relevance |
|-----------|---------|-------------------|
| `@whiskeysockets/baileys` | WhatsApp Web protocol | Unofficial API, security of protocol parsing |
| `grammy` | Telegram Bot API | Handles incoming webhooks |
| `@buape/carbon` | Discord API | Handles incoming events |
| `@slack/bolt` | Slack API | Handles incoming events + OAuth |
| `playwright-core` | Browser automation | Full browser control, high-privilege |
| `sharp` | Image processing | Native addon, C++ code |
| `sqlite-vec` | Vector search | Native addon |
| `@lydell/node-pty` | PTY for shell | Direct system access |
| `ws` | WebSocket | Gateway transport |
| `express` / `hono` | HTTP server | Gateway HTTP endpoints |
| `jiti` | Dynamic TypeScript loader | Plugin loading, code execution |
| `node-llama-cpp` | Local LLM inference | Optional, native addon |

### Patched Dependencies

The `pnpm.patchedDependencies` mechanism is used (via `patches/` directory), and overrides pin `@sinclair/typebox`, `hono`, and `tar` to specific versions for security or compatibility.

---

## 14. Testing Infrastructure

- **Vitest** with V8 coverage (70% threshold for lines/branches/functions/statements)
- **Unit tests**: Colocated `*.test.ts` files
- **E2E tests**: `*.e2e.test.ts` with Docker-based integration tests
- **Live tests**: Real API key tests behind `CLAWDBOT_LIVE_TEST=1`
- **Docker test suite**: Onboarding, gateway network, QR import, doctor, plugins
- **Parallel test runner**: `scripts/test-parallel.mjs`
- **Multiple vitest configs**: unit, e2e, extensions, gateway, live

---

## 15. Conclusion

Moltbot is a remarkably comprehensive personal assistant platform with sophisticated security awareness (the built-in security audit is particularly noteworthy). Its multi-channel approach, plugin system, and tool policy engine represent mature engineering.

The primary areas for improvement in building a more secure and private successor are:

1. **Defense-in-depth for plugins** (sandboxing, capability-based permissions)
2. **Encryption at rest** (secrets, sessions, media)
3. **Data lifecycle management** (retention, deletion, consent)
4. **Process isolation** (channels and agents in separate workers)
5. **Local-first AI** (better support for private, on-device inference)
6. **Runtime audit trail** (tamper-evident logging of all privileged actions)

The architectural patterns around channel abstraction, tool policy cascading, and security auditing are solid foundations to build upon.
