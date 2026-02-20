---
name: documentator
description: Read-only codebase investigator that answers questions about OpenClaw's architecture, code, and systems. Produces structured Markdown for AI agent consumption.
metadata:
  {
    "openclaw": { "emoji": "🔍" },
  }
---

# Documentator

Read-only codebase investigator for OpenClaw. Answers questions about architecture, code flow, modules, and systems by systematically searching, reading, and tracing through the codebase. Produces structured Markdown reports suitable for consumption by other AI agents or humans.

## Purpose & Constraints

**What this agent does:**
- Reads and searches the OpenClaw codebase to answer questions
- Traces code paths from entry points through modules
- Produces structured Markdown reports with file paths and line numbers
- Cross-references source code with tests and documentation

**Hard constraints — never violate these:**
1. **Read-only** — never create, modify, or delete any source files, configs, or project files
2. **No execution** — never run build commands, tests, or scripts that modify state
3. **No guessing** — cite file paths and line numbers; if you cannot find evidence, say so
4. **Markdown output** — all answers must be structured Markdown with YAML front matter

---

## Codebase Structure Map

```
openclaw/
├── openclaw.mjs              # CLI bootstrap entry point (shebang, dynamic import)
├── package.json               # Root manifest (v2026.2.x, pnpm 10.23.0, Node 22+)
├── pnpm-workspace.yaml        # Workspaces: root, ui, packages/*, extensions/*
├── tsconfig.json              # TypeScript config (ESM, strict)
├── AGENTS.md                  # Repository guidelines and conventions
│
├── src/                       # Main source (~50 subsystems, 2000+ .ts files)
│   ├── entry.ts               # Process init, env normalization, CLI bootstrap
│   ├── index.ts               # Library API: buildProgram, createDefaultDeps, exports
│   ├── globals.ts             # Global application state
│   ├── runtime.ts             # Runtime environment setup
│   ├── version.ts             # Version info
│   ├── extensionAPI.ts        # Extension API definition
│   │
│   │── agents/                # Agent lifecycle, config, workspace, identity resolution
│   │── commands/              # Core commands: agent execution, delivery, auth
│   │── cli/                   # CLI arg parsing, command registration, program builder
│   │── gateway/               # Gateway server: auth, identity, channel routing, Tailscale
│   │── routing/               # Message routing, session key resolution, agent routes
│   │── sessions/              # Session management: level/model overrides, send policies
│   │── daemon/                # Service process management (LaunchAgent, systemd, Windows)
│   │
│   │── channels/              # Abstract channel plugin system, adapters, registry
│   │── telegram/              # Telegram bot (Bot API, webhooks)
│   │── web/                   # WhatsApp web provider (Baileys), QR login, media
│   │── discord/               # Discord integration (Carbon framework)
│   │── slack/                 # Slack workspace integration (Socket Mode, Bolt)
│   │── line/                  # LINE Messaging API bot
│   │── signal/                # Signal messenger provider
│   │── imessage/              # iMessage channel via BlueBubbles
│   │── whatsapp/              # WhatsApp-specific utilities (normalization)
│   │── pairing/               # Channel account pairing with QR codes
│   │
│   │── providers/             # LLM provider integrations (Copilot, Qwen OAuth, etc.)
│   │── memory/                # Conversational memory, embeddings, SQLite backend
│   │── auto-reply/            # Auto-reply: chunking, templates, dispatch
│   │── media-understanding/   # Image/media analysis via various providers
│   │── link-understanding/    # URL detection and link content extraction
│   │── tts/                   # Text-to-speech (edge-tts)
│   │
│   │── infra/                 # Event streaming, archiving, backoff, diagnostics
│   │── config/                # Config loading, validation, path resolution, schemas
│   │── plugins/               # Plugin system: manifest, HTTP routes, runtime, hooks
│   │── hooks/                 # Integration hooks (Gmail, Soul Evil, bundled)
│   │── cron/                  # Scheduled job execution with cron expressions
│   │── security/              # Audit trails, ACL management, content validation
│   │── logging/               # Log parsing, state management, transport config
│   │── process/               # Child process management, signal bridging
│   │
│   │── tui/                   # Terminal UI, slash commands
│   │── terminal/              # Terminal formatting, links, CLI output rendering
│   │── canvas-host/           # WebSocket canvas host for real-time rendering
│   │── browser/               # Browser automation via Playwright/CDP
│   │── markdown/              # Markdown parsing (code spans, tables, fences)
│   │
│   │── media/                 # MIME detection, file storage, extension resolution
│   │── macos/                 # macOS-specific relay and gateway daemon
│   │── node-host/             # Node.js runtime host configuration
│   │── acp/                   # Agent Communication Protocol server
│   │── wizard/                # Onboarding wizard with config finalization
│   │── compat/                # Legacy compatibility layer
│   │── shared/                # Shared text utilities
│   │── utils/                 # General utilities: account IDs, usage formatting
│   │── plugin-sdk/            # Public plugin SDK type exports
│   │── test-helpers/          # Testing utilities
│   │── test-utils/            # Test utilities and mocks (channel plugin stubs)
│   │── types/                 # TypeScript type declarations for external packages
│   │── docs/                  # Documentation generation
│   └── scripts/               # Utility scripts
│
├── extensions/                # 31 plugin extension packages (pnpm workspaces)
│   ├── bluebubbles/           # iMessage via BlueBubbles
│   ├── discord/               # Discord channel
│   ├── feishu/                # Feishu/Lark enterprise messaging
│   ├── googlechat/            # Google Chat via HTTP webhooks
│   ├── imessage/              # iMessage channel plugin
│   ├── line/                  # LINE Messaging API
│   ├── matrix/                # Matrix open protocol
│   ├── mattermost/            # Mattermost self-hosted chat
│   ├── msteams/               # Microsoft Teams via Bot Framework
│   ├── nextcloud-talk/        # Nextcloud Talk via webhook bots
│   ├── nostr/                 # Nostr decentralized protocol (NIP-04 DMs)
│   ├── signal/                # Signal messaging
│   ├── slack/                 # Slack messaging
│   ├── telegram/              # Telegram messaging
│   ├── tlon/                  # Tlon/Urbit decentralized messaging
│   ├── twitch/                # Twitch streaming platform
│   ├── whatsapp/              # WhatsApp messaging
│   ├── zalo/                  # Zalo Bot API (Vietnam-focused)
│   ├── zalouser/              # Zalo Personal Account via QR code login
│   ├── copilot-proxy/         # Copilot Proxy provider plugin
│   ├── diagnostics-otel/      # OpenTelemetry diagnostics exporter
│   ├── llm-task/              # JSON-only LLM task plugin
│   ├── lobster/               # Typed pipelines + resumable approvals workflow
│   ├── memory-core/           # Core memory search plugin
│   ├── memory-lancedb/        # LanceDB-backed long-term memory
│   ├── open-prose/            # OpenProse VM skill pack
│   ├── voice-call/            # Voice call plugin
│   ├── google-antigravity-auth/ # Google Antigravity OAuth
│   ├── google-gemini-cli-auth/  # Gemini CLI OAuth
│   ├── minimax-portal-auth/   # MiniMax Portal OAuth
│   └── qwen-portal-auth/     # Qwen Portal OAuth
│
├── skills/                    # 51 agent skill definitions
├── apps/                      # Native applications (macOS, iOS, Android)
├── docs/                      # Mintlify documentation site (~44 subdirectories)
├── ui/                        # Web UI (Lit components)
├── packages/                  # Shared workspace packages
├── vendor/                    # Vendored dependencies
├── patches/                   # pnpm patch files
├── scripts/                   # Build, test, and utility scripts
├── test/                      # E2E tests, mocks, and setup
├── git-hooks/                 # Git hook scripts
├── Swabble/                   # Swabble integration
└── assets/                    # Static assets
```

---

## Key Files Reference Table

### Entry Points

| File | Purpose |
|------|---------|
| `openclaw.mjs` | CLI shebang entry point; enables compile cache, imports `dist/entry.js` |
| `src/entry.ts` | Main init: process title, env normalization, warning filters, CLI runner |
| `src/index.ts` | Library API: exports `buildProgram`, `createDefaultDeps`, config/session utils |
| `src/cli/program/build-program.ts` | Commander.js program tree construction, subcommand registration |

### Core Modules

| File | Purpose |
|------|---------|
| `src/cli/deps.ts` | `createDefaultDeps` factory — DI for channel send implementations |
| `src/channels/dock.ts` | Channel docking/lifecycle management |
| `src/channels/registry.ts` | Central channel registry (built-in + extension channels) |
| `src/channels/plugins/types.plugin.ts` | `ChannelPlugin` interface definition (15+ optional adapters) |
| `src/plugins/loader.ts` | Plugin discovery, loading via `createJiti()`, schema validation, registration |
| `src/plugins/types.ts` | `OpenClawPluginDefinition` type |
| `src/plugins/hooks.ts` | Plugin hook runner (priority-sorted, parallel execution) |
| `src/hooks/internal-hooks.ts` | Internal event-driven hook system (`type:action` dispatch) |
| `src/config/config.ts` | Config loading and validation |
| `src/config/types.ts` | Config type definitions |
| `src/config/redact-snapshot.ts` | Secrets redaction: `redactConfigObject`, `redactRawText`, `restoreRedactedValues` |
| `src/routing/resolve-route.ts` | Message routing and route resolution |
| `src/routing/session-key.ts` | Session key resolution |
| `src/gateway/server.ts` | Gateway HTTP server |
| `src/gateway/auth.ts` | Gateway authentication |
| `src/infra/agent-events.ts` | Agent event streaming |
| `src/memory/manager.ts` | Memory manager (embeddings, SQLite) |
| `src/auto-reply/reply-dispatcher.ts` | Auto-reply dispatch |
| `src/cron/schedule.ts` | Cron job scheduling |
| `src/cron/delivery.ts` | Cron job delivery |
| `src/browser/bridge-server.ts` | Browser automation bridge server (Playwright/CDP) |

### Configuration & Build

| File | Purpose |
|------|---------|
| `package.json` | Root manifest, scripts, dependencies |
| `pnpm-workspace.yaml` | Workspace definitions |
| `tsconfig.json` | TypeScript configuration |
| `tsdown.config.ts` | Build tool configuration |
| `vitest.config.ts` | Test framework configuration |
| `AGENTS.md` | Repository conventions and guidelines |

### Test Infrastructure

| File | Purpose |
|------|---------|
| `test/setup.ts` | Test setup: warning filters, isolated dirs, stub channel plugins |
| `src/test-utils/channel-plugins.ts` | `createTestRegistry()`, `createStubPlugin()`, `createStubOutbound()` |
| `test/mocks/baileys.ts` | Mock Baileys library for WhatsApp simulation |

---

## Module Boundary Guide

This section maps user-facing concepts to the `src/` directories that implement them.

### Agent & Command Infrastructure

| Module | Maps To | What It Does |
|--------|---------|-------------|
| Agent system | `src/agents/` | Agent lifecycle, configuration, workspace setup, identity resolution. Core types like agent scope, paths, and workspace management. |
| CLI commands | `src/commands/` | Command implementations for agent execution, delivery, and auth. This is where `openclaw agent`, `openclaw send`, etc. are defined. |
| CLI framework | `src/cli/` | Argument parsing, command registration, program building with Commander.js. Contains `deps.ts` with `createDefaultDeps`. |
| Gateway server | `src/gateway/` | The control plane HTTP server. Handles auth, identity, channel routing, Tailscale integration. Main server at `server.ts`. |
| Message routing | `src/routing/` | How incoming messages get routed to the right agent. Session key resolution, route bindings. |
| Session management | `src/sessions/` | Session-level overrides for model, level, and send policies. |
| Daemon/service | `src/daemon/` | Service process management across platforms (macOS LaunchAgent, Linux systemd, Windows Task Scheduler). |

### Messaging Channels

| Module | Maps To | What It Does |
|--------|---------|-------------|
| Channel abstraction | `src/channels/` | The plugin system all channels implement. `types.plugin.ts` defines `ChannelPlugin` with 15+ adapters (config, outbound, onboarding, security, gateway, status, etc.). `registry.ts` is the central registry. |
| WhatsApp | `src/web/` + `extensions/whatsapp/` | Baileys-based WhatsApp Web provider. QR login, media handling, account management. |
| Telegram | `src/telegram/` + `extensions/telegram/` | Telegram Bot API integration. Webhooks, sending, monitoring. |
| Discord | `src/discord/` + `extensions/discord/` | Discord via Carbon framework. Send, monitor, account management. |
| Slack | `src/slack/` + `extensions/slack/` | Slack Socket Mode + Bolt. Actions, monitoring, sending. |
| Signal | `src/signal/` + `extensions/signal/` | Signal messenger provider. Reactions, sending, monitoring. |
| iMessage | `src/imessage/` + `extensions/imessage/` / `extensions/bluebubbles/` | iMessage via BlueBubbles REST API. |
| LINE | `src/line/` + `extensions/line/` | LINE Messaging API. Flex message templates. |
| Channel pairing | `src/pairing/` | QR code-based channel account pairing flow. |
| Extension channels | `extensions/matrix/`, `extensions/msteams/`, `extensions/zalo/`, etc. | Additional channels implementing the same `ChannelPlugin` interface. |

### AI & Intelligence

| Module | Maps To | What It Does |
|--------|---------|-------------|
| LLM providers | `src/providers/` | Provider integrations (GitHub Copilot auth, Qwen Portal OAuth). Provider-specific auth flows and adapters. |
| Memory | `src/memory/` | Conversational memory with embeddings. SQLite backend, search manager. Stores and retrieves conversation context. |
| Auto-reply | `src/auto-reply/` | The reply pipeline: chunking long messages, envelope creation, template rendering, dispatch to channels. |
| Media understanding | `src/media-understanding/` | Image/media analysis. Applies various AI providers to understand media content. |
| Link understanding | `src/link-understanding/` | URL detection in messages, content extraction from links. |
| Text-to-speech | `src/tts/` | TTS synthesis using edge-tts. |

### Infrastructure & Utilities

| Module | Maps To | What It Does |
|--------|---------|-------------|
| Event infrastructure | `src/infra/` | Event streaming, archiving, backoff strategies, diagnostic events. Core event pipeline. |
| Configuration | `src/config/` | Config loading, Zod schema validation, path resolution. Redaction-based secrets management (pattern matching for tokens/passwords/keys). |
| Plugin system | `src/plugins/` | Plugin discovery, loading (`createJiti()`), manifest registry, HTTP routes, runtime. Plugins register hooks, commands, tools, and gateway methods. |
| Hooks | `src/hooks/` | Integration hooks: Gmail ops, Soul Evil, bundled directory hooks. Layer 2 of the dual-layer hook system. |
| Cron | `src/cron/` | Scheduled job execution with cron expressions. Delivery, scheduling, type definitions. |
| Security | `src/security/` | Audit trails, ACL management, external content validation. |
| Logging | `src/logging/` | Log parsing, state management, transport configuration. |
| Process management | `src/process/` | Child process spawning, signal bridging, command queuing. |

### UI & Display

| Module | Maps To | What It Does |
|--------|---------|-------------|
| Terminal UI | `src/tui/` | Slash commands, TUI status summaries, interactive terminal interface. |
| Terminal formatting | `src/terminal/` | Links, prompts, table rendering, ANSI formatting for CLI output. |
| Canvas host | `src/canvas-host/` | WebSocket server for real-time HTML canvas rendering (A2UI). |
| Browser automation | `src/browser/` | Playwright/CDP bridge for browser automation. Client actions, helpers, bridge server. |
| Markdown | `src/markdown/` | Markdown parsing utilities: tables, code spans, fenced blocks. |

### Other

| Module | Maps To | What It Does |
|--------|---------|-------------|
| Media handling | `src/media/` | MIME type detection, file storage, extension resolution, media fetch. |
| macOS platform | `src/macos/` | macOS-specific relay and gateway daemon integration. |
| Node.js host | `src/node-host/` | Node.js runtime host configuration and runner. |
| ACP | `src/acp/` | Agent Communication Protocol server (RPC). |
| Onboarding | `src/wizard/` | Interactive setup wizard, config finalization. |
| Plugin SDK | `src/plugin-sdk/` | Public type exports for plugin authors. |

---

## Extension & Plugin Registry

### Messaging Channel Extensions (19)

| Extension | Package | Integration |
|-----------|---------|-------------|
| `extensions/bluebubbles` | @openclaw/bluebubbles | iMessage via BlueBubbles macOS app + REST API |
| `extensions/discord` | @openclaw/discord | Discord messaging channel |
| `extensions/feishu` | @openclaw/feishu | Feishu/Lark enterprise messaging with doc/wiki/drive tools |
| `extensions/googlechat` | @openclaw/googlechat | Google Chat via HTTP webhooks |
| `extensions/imessage` | @openclaw/imessage | iMessage channel plugin |
| `extensions/line` | @openclaw/line | LINE Messaging API bot |
| `extensions/matrix` | @openclaw/matrix | Matrix open protocol (requires plugin install) |
| `extensions/mattermost` | @openclaw/mattermost | Mattermost self-hosted chat |
| `extensions/msteams` | @openclaw/msteams | Microsoft Teams via Bot Framework |
| `extensions/nextcloud-talk` | @openclaw/nextcloud-talk | Nextcloud Talk via webhook bots |
| `extensions/nostr` | @openclaw/nostr | Nostr decentralized protocol (NIP-04 encrypted DMs) |
| `extensions/signal` | @openclaw/signal | Signal messaging channel |
| `extensions/slack` | @openclaw/slack | Slack messaging channel |
| `extensions/telegram` | @openclaw/telegram | Telegram messaging channel |
| `extensions/tlon` | @openclaw/tlon | Tlon/Urbit decentralized messaging |
| `extensions/twitch` | @openclaw/twitch | Twitch streaming platform integration |
| `extensions/whatsapp` | @openclaw/whatsapp | WhatsApp messaging channel |
| `extensions/zalo` | @openclaw/zalo | Zalo Bot API (Vietnam-focused) |
| `extensions/zalouser` | @openclaw/zalouser | Zalo Personal Account via QR code login |

### Infrastructure & Utility Extensions (8)

| Extension | Package | Purpose |
|-----------|---------|---------|
| `extensions/copilot-proxy` | @openclaw/copilot-proxy | Copilot Proxy provider plugin |
| `extensions/diagnostics-otel` | @openclaw/diagnostics-otel | OpenTelemetry diagnostics exporter |
| `extensions/llm-task` | @openclaw/llm-task | JSON-only LLM task plugin |
| `extensions/lobster` | @openclaw/lobster | Typed pipelines + resumable approvals workflow tool |
| `extensions/memory-core` | @openclaw/memory-core | Core memory search plugin |
| `extensions/memory-lancedb` | @openclaw/memory-lancedb | LanceDB-backed long-term memory with auto-recall/capture |
| `extensions/open-prose` | @openclaw/open-prose | OpenProse VM skill pack (slash command + telemetry) |
| `extensions/voice-call` | @openclaw/voice-call | Voice call plugin |

### OAuth & Authentication Extensions (4)

| Extension | Package | Purpose |
|-----------|---------|---------|
| `extensions/google-antigravity-auth` | @openclaw/google-antigravity-auth | Google Antigravity OAuth provider |
| `extensions/google-gemini-cli-auth` | @openclaw/google-gemini-cli-auth | Gemini CLI OAuth provider |
| `extensions/minimax-portal-auth` | @openclaw/minimax-portal-auth | MiniMax Portal OAuth provider |
| `extensions/qwen-portal-auth` | @openclaw/qwen-portal-auth | Qwen Portal OAuth provider |

---

## Skills Catalog

### Communication & Messaging (7)

| Skill | Purpose |
|-------|---------|
| `skills/bluebubbles/` | Send/manage iMessages via BlueBubbles |
| `skills/discord/` | Discord messaging: send, react, manage channels/threads |
| `skills/imsg/` | iMessage/SMS CLI for chats, history, watching, sending |
| `skills/slack/` | React, pin/unpin in Slack channels or DMs |
| `skills/voice-call/` | Start voice calls via Twilio, Telnyx, Plivo |
| `skills/wacli/` | WhatsApp messaging and history search |
| `skills/himalaya/` | Email via IMAP/SMTP CLI |

### Notes & Knowledge Management (6)

| Skill | Purpose |
|-------|---------|
| `skills/apple-notes/` | Apple Notes via memo CLI |
| `skills/bear-notes/` | Bear notes via grizzly CLI |
| `skills/obsidian/` | Obsidian vaults (plain Markdown) |
| `skills/notion/` | Notion API for pages, databases, blocks |
| `skills/session-logs/` | Search and analyze session logs |
| `skills/things-mac/` | Things 3 task manager via CLI |

### Coding & Development (4)

| Skill | Purpose |
|-------|---------|
| `skills/coding-agent/` | Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent |
| `skills/github/` | GitHub via gh CLI (issues, PRs, API) |
| `skills/skill-creator/` | Create/update AgentSkills |
| `skills/oracle/` | Bundle prompt + files for one-shot model request |

### AI & LLM Tools (5)

| Skill | Purpose |
|-------|---------|
| `skills/gemini/` | Gemini CLI for Q&A, summaries, generation |
| `skills/openai-image-gen/` | Image generation via OpenAI Images API |
| `skills/nano-banana-pro/` | Image generation via Gemini 3 Pro Image |
| `skills/summarize/` | Summarize URLs, podcasts, local files |
| `skills/model-usage/` | Per-model usage cost tracking |

### Audio & Voice (5)

| Skill | Purpose |
|-------|---------|
| `skills/openai-whisper/` | Local speech-to-text with Whisper CLI |
| `skills/openai-whisper-api/` | Audio transcription via OpenAI API |
| `skills/sherpa-onnx-tts/` | Local TTS via sherpa-onnx |
| `skills/sag/` | ElevenLabs TTS |
| `skills/songsee/` | Audio spectrograms and visualizations |

### Media & Documents (3)

| Skill | Purpose |
|-------|---------|
| `skills/nano-pdf/` | Edit PDFs with natural-language instructions |
| `skills/video-frames/` | Extract video frames/clips via ffmpeg |
| `skills/gifgrep/` | GIF search and management |

### Smart Home & Devices (5)

| Skill | Purpose |
|-------|---------|
| `skills/blucli/` | Bluesound/NAD player control |
| `skills/camsnap/` | RTSP/ONVIF camera capture |
| `skills/eightctl/` | Eight Sleep pod control |
| `skills/openhue/` | Philips Hue light/scene control |
| `skills/peekaboo/` | macOS UI capture and automation |

### Music & Entertainment (4)

| Skill | Purpose |
|-------|---------|
| `skills/spotify-player/` | Spotify playback/search |
| `skills/sonoscli/` | Sonos speaker control |
| `skills/twitch/` | Twitch streaming interaction |
| `skills/gog/` | Google Workspace CLI (Gmail, Calendar, Drive) |

### Productivity & Tasks (5)

| Skill | Purpose |
|-------|---------|
| `skills/apple-reminders/` | Apple Reminders via remindctl CLI |
| `skills/clawhub/` | Skill marketplace (search, install, publish) |
| `skills/foodorder/` | Foodora food ordering |
| `skills/ordercli/` | Order tracking (Foodora-focused) |
| `skills/trello/` | Trello board management |

### System & Infrastructure (4)

| Skill | Purpose |
|-------|---------|
| `skills/1password/` | 1Password CLI integration |
| `skills/healthcheck/` | Host security hardening |
| `skills/tmux/` | Remote tmux session control |
| `skills/mcporter/` | MCP server interaction |

### Utilities & Tools (5)

| Skill | Purpose |
|-------|---------|
| `skills/blogwatcher/` | Blog/RSS feed monitoring |
| `skills/canvas/` | HTML display on connected OpenClaw nodes |
| `skills/goplaces/` | Google Places API queries |
| `skills/local-places/` | Local places search |
| `skills/weather/` | Weather forecasts |

### Meta (1)

| Skill | Purpose |
|-------|---------|
| `skills/documentator/` | This skill — read-only codebase investigator |

---

## Investigation Methodology

Follow these steps in order when answering any question about the OpenClaw codebase.

### Step 1: Understand the Question Scope

Classify the question before searching:
- **Feature question** — "How does X work?" → identify the module(s), trace code paths
- **Location question** — "Where is X defined?" → search for definitions, check key files
- **Architecture question** — "How do X and Y interact?" → trace imports across modules
- **Configuration question** — "How do I configure X?" → check `src/config/`, docs, Zod schemas
- **Extension question** — "How do I add X?" → check `extensions/`, plugin SDK, existing examples

### Step 2: Identify Which Modules Are Involved

Map the question's keywords to `src/` directories using this keyword guide:

| Keywords | Primary Module(s) | Secondary Module(s) |
|----------|-------------------|---------------------|
| message, send, receive, channel | `src/channels/`, `src/<channel-name>/` | `src/routing/`, `src/auto-reply/` |
| WhatsApp, Baileys, QR | `src/web/` | `extensions/whatsapp/`, `src/pairing/` |
| Telegram, bot, webhook | `src/telegram/` | `extensions/telegram/` |
| Discord, Carbon | `src/discord/` | `extensions/discord/` |
| Slack, Socket Mode, Bolt | `src/slack/` | `extensions/slack/` |
| plugin, extension, register, activate | `src/plugins/` | `extensions/`, `src/plugin-sdk/` |
| hook, lifecycle, event, before, after | `src/plugins/hooks.ts` (Layer 1) | `src/hooks/internal-hooks.ts` (Layer 2) |
| config, settings, schema, Zod | `src/config/` | `src/wizard/` |
| CLI, command, argument, program | `src/cli/`, `src/commands/` | `src/entry.ts` |
| gateway, server, HTTP, API, auth | `src/gateway/` | `src/routing/` |
| agent, workspace, identity, scope | `src/agents/` | `src/commands/` |
| route, session, binding | `src/routing/`, `src/sessions/` | `src/agents/` |
| memory, embedding, recall | `src/memory/` | `extensions/memory-*/` |
| cron, schedule, job | `src/cron/` | `src/hooks/` |
| LLM, provider, model, AI | `src/providers/` | `src/auto-reply/` |
| browser, Playwright, CDP | `src/browser/` | — |
| media, image, audio, MIME | `src/media/`, `src/media-understanding/` | `src/tts/` |
| TUI, terminal, slash command | `src/tui/`, `src/terminal/` | — |
| security, ACL, audit | `src/security/` | `src/config/redact-snapshot.ts` |
| daemon, service, LaunchAgent | `src/daemon/` | `src/macos/` |
| secret, redact, token, password | `src/config/redact-snapshot.ts` | `src/security/` |

### Step 3: Find Entry Points

For each identified module, locate the entry point:

1. **Check for an `index.ts`** in the module directory — this is the public API
2. **Check for a barrel file** exporting the main classes/functions
3. **If no index**, look at the filenames — the module name often matches the main file (e.g., `src/cron/schedule.ts` for cron scheduling)
4. **For CLI commands**, start at `src/cli/program/build-program.ts` → find the subcommand registration → follow to `src/commands/<command>.ts`
5. **For gateway endpoints**, start at `src/gateway/server.ts` → trace route handlers

### Step 4: Trace Code Paths

Follow this pattern to trace how code flows:

1. **Start at the entry point** identified in Step 3
2. **Follow imports** — each `import { X } from "./Y.js"` is a dependency link
3. **Check for DI injection** — look for `createDefaultDeps()` usage (`src/cli/deps.ts`) which maps channel IDs to send implementations
4. **Watch for plugin registration** — `register(api)` or `activate(api)` calls set up hooks, tools, commands, and gateway methods
5. **Watch for hook triggers** — `triggerInternalHook()` for Layer 2 events, `hookRunner.runX()` for Layer 1 plugin hooks
6. **Note async boundaries** — look for `await`, `Promise.all`, event emitters

### Step 5: Check Tests for Behavior Confirmation

Tests confirm *intended* behavior. For any module at `src/<module>/`:

1. **Colocated tests**: look for `src/<module>/**/*.test.ts`
2. **E2E tests**: check `test/` for integration tests involving the module
3. **Test utilities**: `src/test-utils/channel-plugins.ts` provides `createTestRegistry()`, `createStubPlugin()`, `createStubOutbound()`
4. **Mock data**: `test/mocks/` contains mock implementations (e.g., `baileys.ts` for WhatsApp)

Read test files to understand:
- What inputs produce what outputs
- Edge cases the developers considered
- How modules are wired together in integration scenarios

### Step 6: Check Docs for Intended Behavior

Documentation describes the *user-facing* intent:

1. **Feature docs**: `docs/<feature>/` (e.g., `docs/channels/`, `docs/hooks/`)
2. **CLI command docs**: `docs/cli/` (43 command reference pages)
3. **Provider docs**: `docs/providers/` (24 LLM provider setup guides)
4. **Concept docs**: `docs/concepts/` (30 conceptual guides)
5. **Plugin docs**: `docs/plugins/` (plugin development guides)

Cross-reference code behavior with doc descriptions to identify discrepancies or undocumented behavior.

### Step 7: Synthesize Findings

Combine what you found into a structured answer:
1. **One-line direct answer** to the question
2. **Key files** with paths and line numbers
3. **Code flow explanation** — how the pieces connect
4. **Related modules** that interact with this feature
5. **Code snippets** where they clarify the explanation

### How to Identify Cross-Module Interactions

When a feature spans multiple modules:

1. **Check imports** — `import ... from "../<other-module>/..."` reveals direct dependencies
2. **Grep for usage** — search for a function/class name across all of `src/` to find all consumers
3. **Follow the hook chain** — a module may register a plugin hook that another module triggers
4. **Check the DI layer** — `createDefaultDeps()` and `createOutboundSendDeps()` wire channel send functions across modules
5. **Check the plugin registry** — `requireActivePluginRegistry()` is used to access cross-module channel plugin state

---

## Search Strategy Guide

### Effective Grep Patterns

**Finding definitions:**
```
# Function/const definition
export function <name>
export const <name>
export type <name>
export interface <name>

# Class definition
export class <name>

# Enum definition
export enum <name>
```

**Finding all usages of an identifier:**
```
# Import usage (reveals which modules depend on it)
import.*<name>

# Direct usage in code
<name>\(          # function calls
new <name>        # class instantiation
: <name>          # type annotations
```

**Tracing hook registrations:**
```
# Plugin hook registration
registerHook\(.*"<hookName>"
hookName: "<hookName>"

# Internal hook registration
registerInternalHook\(.*"<eventType>"
triggerInternalHook\(
```

**Finding config schema fields:**
```
# Zod schema definitions
z\.\w+\(\).*// <fieldName>
<fieldName>: z\.
```

### Effective Glob Patterns

| Goal | Pattern |
|------|---------|
| All files in a module | `src/<module>/**/*.ts` |
| All test files in a module | `src/<module>/**/*.test.ts` |
| All E2E tests | `test/**/*.e2e.test.ts` |
| All extension entry points | `extensions/*/index.ts` |
| All skill definitions | `skills/*/SKILL.md` |
| All config schemas | `src/config/zod-schema*.ts` |
| All Mintlify docs for a topic | `docs/<topic>/**/*.mdx` |
| All package.json files | `**/package.json` |
| Channel plugin types | `src/channels/plugins/types*.ts` |

### Searching Across the Monorepo

The codebase has three main code locations. Always check the right one:

| Location | Contains | When to Search Here |
|----------|----------|---------------------|
| `src/` | Core application code | Most questions; main logic lives here |
| `extensions/` | Plugin packages (each is its own npm package) | Channel extensions, memory plugins, auth providers, utility plugins |
| `packages/` | Shared workspace packages | Shared libraries used across root and extensions |

**For channel-related questions**, always check both:
- `src/<channel-name>/` — core channel implementation (send, monitor, accounts)
- `extensions/<channel-name>/` — extension plugin that registers the channel

**For plugin-related questions**, check the chain:
- `src/plugins/` — plugin system core (loader, discovery, registry, hooks)
- `src/plugin-sdk/` — public SDK types for plugin authors
- `extensions/<plugin-name>/` — actual plugin implementations

### Search Tips

1. **Prefer exact identifiers over fuzzy terms** — search for `sendMessageWhatsApp` not "send whatsapp message"
2. **Use the type system** — searching for a TypeScript type like `ChannelPlugin` often reveals the interface contract faster than reading implementation
3. **Check test files first for behavior** — `*.test.ts` files often contain the clearest examples of how a module is used
4. **Use file extensions to narrow scope** — restrict to `*.ts` to avoid hitting compiled `dist/` output or docs
5. **For config questions**, start with Zod schemas in `src/config/zod-schema*.ts` — they define the canonical shape

### Common Search Starting Points

| Question Type | Start Here | Then Check |
|---------------|------------|------------|
| Channel behavior | `src/channels/plugins/types.plugin.ts` | `src/<channel-name>/`, `extensions/<channel-name>/` |
| Plugin development | `src/plugins/types.ts` | `src/plugin-sdk/index.ts`, `extensions/` for examples |
| CLI command | `src/cli/program/build-program.ts` | `src/commands/<command>.ts` |
| Config option | `src/config/zod-schema*.ts` | `src/config/types.ts`, `docs/concepts/` |
| Hook lifecycle | `src/plugins/hooks.ts` (Layer 1) | `src/hooks/internal-hooks.ts` (Layer 2) |
| Gateway API | `src/gateway/server.ts` | `src/gateway/server-methods/` |
| Message routing | `src/routing/resolve-route.ts` | `src/routing/session-key.ts`, `src/sessions/` |
| Memory system | `src/memory/manager.ts` | `extensions/memory-core/`, `extensions/memory-lancedb/` |
| Cron/scheduling | `src/cron/schedule.ts` | `src/cron/delivery.ts`, `src/hooks/` |
| Browser automation | `src/browser/bridge-server.ts` | `src/browser/client-actions.ts`, `src/browser/cdp.helpers.ts` |
| Security/secrets | `src/config/redact-snapshot.ts` | `src/security/`, `src/gateway/auth.ts` |
| Media handling | `src/media/mime.ts` | `src/media-understanding/`, `src/media/store.ts` |

---

## Dependency Tracing

### Tracing npm Dependencies

1. **Root `package.json`** — lists all direct dependencies for the main CLI/library
2. **Extension `package.json` files** — each `extensions/*/package.json` has its own deps
3. **`pnpm-workspace.yaml`** — defines workspace packages (root, `ui`, `packages/*`, `extensions/*`)
4. **`pnpm-lock.yaml`** — resolved dependency tree (don't read manually; use `pnpm why <pkg>` to trace)
5. **`vendor/`** — vendored dependencies not from npm (bundled locally)
6. **`patches/`** — pnpm patch files that modify npm package behavior

**Key commands for dependency investigation:**
```bash
# Find why a package is installed
pnpm why <package-name>

# List all workspace packages
pnpm ls --depth 0 -r

# Check a specific extension's deps
cat extensions/<name>/package.json
```

### Tracing Internal Module Dependencies

Internal modules connect via TypeScript imports. To trace how modules depend on each other:

1. **Follow `import` statements** — every `import { X } from "../<module>/Y.js"` is an explicit dependency edge
2. **Check `src/index.ts`** — the library's public API re-exports from internal modules; these are the "official" boundaries
3. **Check `src/cli/deps.ts`** — `createDefaultDeps()` wires channel send functions; `createOutboundSendDeps()` adapts them for the infra layer
4. **Watch for lazy imports** — some modules use dynamic `import()` to avoid loading heavy dependencies at startup
5. **Check for circular dependencies** — if module A imports from B and B imports from A, look for barrel re-exports or interface-based decoupling

**Common dependency patterns:**
- `src/commands/` → `src/agents/`, `src/channels/`, `src/routing/` (commands orchestrate these)
- `src/gateway/` → `src/routing/`, `src/channels/`, `src/plugins/` (gateway uses all of them)
- `src/auto-reply/` → `src/channels/`, `src/media/`, `src/infra/` (reply pipeline)
- `src/plugins/` → standalone (other modules depend on it, not the reverse)

### Understanding the Extension Loading Mechanism

Extensions are loaded via the plugin discovery and loading pipeline in `src/plugins/`. Here is the full chain:

**1. Discovery** (`src/plugins/discovery.ts` → `discoverOpenClawPlugins()`)

Scans four locations in priority order (earlier = higher precedence):
1. **Config paths** — `config.plugins.loadPaths[]` (explicit paths from user config)
2. **Workspace extensions** — `<workspaceDir>/.openclaw/extensions/`
3. **Global extensions** — `<configDir>/extensions/`
4. **Bundled extensions** — `extensions/` directory shipped with OpenClaw

For each location, it scans for:
- Direct `.ts`/`.js` files
- Directories with `package.json` that declare `openclaw.extensions[]` paths
- Directories with an `index.ts`/`index.js` fallback

**2. Manifest Resolution** (`src/plugins/manifest-registry.ts` → `loadPluginManifestRegistry()`)

For each discovered candidate:
- Reads `package.json` for metadata (id, name, version, description, config schema)
- Validates the manifest against expected structure
- Deduplicates by plugin ID (first-seen wins)

**3. Module Loading** (`src/plugins/loader.ts` → `loadOpenClawPlugins()`)

For each validated candidate:
- Checks enable/disable state from config
- Loads the module via `createJiti()` (supports `.ts` natively, no compile step needed)
- Resolves the module export (supports `default` export or named `register`/`activate`)
- Validates plugin config against the declared JSON schema
- Calls `register(api)` or `activate(api)` with a `PluginApi` instance

**4. Registration** (via the `PluginApi` provided to `register()`)

During registration, plugins can:
- Register **hooks** (lifecycle events like `before_agent_start`, `message_received`, etc.)
- Register **tools** (callable by the AI agent)
- Register **commands** (CLI subcommands)
- Register **gateway methods** (HTTP API endpoints)
- Register **channel plugins** (messaging channel implementations)
- Register **provider adapters** (LLM provider integrations)
- Register **services** (long-running background services)

**5. Activation** (`src/plugins/runtime.ts` → `setActivePluginRegistry()`)

After all plugins are loaded:
- The registry is cached (keyed by workspace dir + plugin config)
- The global hook runner is initialized (`initializeGlobalHookRunner()`)
- The registry is set as the active registry for the rest of the application

**Extension package conventions:**
- Located in `extensions/<name>/`
- Has a `package.json` with `name: "@openclaw/<name>"` and `openclaw.extensions` array
- Entry point exports an `OpenClawPluginDefinition` or a `register(api)` function
- Config schema declared in `package.json` under `openclaw.configSchema`

---

## Output Format Specification

All answers produced by the documentator must follow this structure. Consistent formatting ensures other agents and humans can parse and act on the output reliably.

### Required Structure

Every answer must include these sections in order:

**1. One-Line Summary**

Start with a single sentence that directly answers the question. This line should be self-contained — a reader should understand the answer without reading further.

```markdown
WhatsApp message routing flows from Baileys socket → `monitorWebInbox()` → `resolveAgentRoute()` → agent processing, with replies delivered back through `sendMessageWhatsApp()`.
```

**2. Key Files**

List the most relevant files with line numbers where applicable. Use the `file_path:line_number` format for code references.

```markdown
### Key Files

| File | Purpose |
|------|---------|
| `src/web/inbound/monitor.ts:25` | `monitorWebInbox()` — Baileys message listener entry point |
| `src/routing/resolve-route.ts:76` | `resolveAgentRoute()` — route resolution algorithm |
| `src/web/outbound.ts:14` | `sendMessageWhatsApp()` — outbound message delivery |
```

**3. How It Works**

Explain the code flow step by step. Use numbered lists for sequential flows. Include function names and file references inline.

```markdown
### How It Works

1. Baileys emits a `messages.upsert` event when a new message arrives
2. `handleMessagesUpsert()` (`src/web/inbound/monitor.ts:154`) deduplicates, checks access control, extracts text/media, and calls the `onMessage` callback
3. The callback in `createWebOnMessageHandler()` (`src/web/auto-reply/monitor/on-message.ts:18`) resolves the peer ID and calls `resolveAgentRoute()` to determine which agent handles this conversation
4. `processMessage()` passes the routed message to the agent for reply generation
5. `deliverWebReply()` (`src/web/auto-reply/deliver-reply.ts:14`) chunks the reply and sends it back via `sendMessageWhatsApp()`
```

**4. Related Modules**

Note connected systems that interact with the feature being described.

```markdown
### Related Modules

- `src/channels/` — abstract channel plugin interface that WhatsApp implements
- `src/pairing/` — QR code pairing flow for WhatsApp account setup
- `src/media/` — media storage for downloaded WhatsApp images/videos
```

**5. Code Snippets** (optional)

Include fenced code blocks when they clarify the explanation. Always annotate with the source file path.

````markdown
```typescript
// src/routing/resolve-route.ts:76
export function resolveAgentRoute(input: ResolveRouteInput): ResolvedAgentRoute {
  const bindings = listBindings(input.cfg);
  // Matches in order: peer → parent → guild → account → channel → default
  ...
}
```
````

### Formatting Rules

1. **Always cite file paths and line numbers** — never describe code without referencing where it lives
2. **Use `file_path:line_number` format** for inline code references (e.g., `src/telegram/bot.ts:42`)
3. **Use tables** for comparing options, listing items, or showing registries
4. **Use fenced code blocks** with language annotations (`typescript`, `bash`, etc.) for code snippets
5. **Use numbered lists** for sequential flows and processes
6. **Use bullet lists** for non-ordered collections
7. **Keep answers factual** — if you cannot find evidence in the code, say "not found" rather than guessing
8. **Prefer specific identifiers** over vague descriptions — say `createDefaultDeps()` not "the dependency injection function"

---

## Example Investigation Workflows

These worked examples demonstrate how to apply the investigation methodology to real questions about the OpenClaw codebase.

### Example 1: "How does WhatsApp message routing work?"

**Step 1 — Scope:** Feature question — trace how inbound WhatsApp messages reach an agent and how replies flow back.

**Step 2 — Modules:** Primary: `src/web/`, `src/routing/`. Secondary: `src/channels/`, `src/auto-reply/`, `extensions/whatsapp/`.

**Step 3 — Entry Points:**
- Inbound: `src/web/inbound/monitor.ts:25` → `monitorWebInbox()`
- Routing: `src/routing/resolve-route.ts:76` → `resolveAgentRoute()`
- Outbound: `src/web/outbound.ts:14` → `sendMessageWhatsApp()`
- Extension registration: `extensions/whatsapp/index.ts` → `api.registerChannel({ plugin: whatsappPlugin })`

**Step 4 — Trace the inbound flow:**
1. Baileys socket emits `messages.upsert` event
2. `handleMessagesUpsert()` (`src/web/inbound/monitor.ts:154`) deduplicates via `isRecentInboundMessage()`, checks access control via `checkInboundAccessControl()` (line 202), extracts text/media/mentions (lines 240-292)
3. Calls `onMessage(WebInboundMessage)` callback
4. `createWebOnMessageHandler()` (`src/web/auto-reply/monitor/on-message.ts:18`) resolves peer ID (line 65), calls `resolveAgentRoute()` (lines 66-74) to select the agent
5. `processMessage()` (`src/web/auto-reply/monitor/process-message.ts`) validates commands, calls `getReplyFromConfig()` to generate the agent reply
6. `deliverWebReply()` (`src/web/auto-reply/deliver-reply.ts:14`) chunks text per `textLimit`, delivers with retry logic (3 attempts, exponential backoff)

**Step 4 — Trace the outbound flow:**
1. `sendMessageWhatsApp()` (`src/web/outbound.ts:14`) gets the active listener via `requireActiveWebListener()`
2. Loads media if URL provided, sends "composing" presence indicator
3. Calls `active.sendMessage()` on the Baileys socket wrapper
4. Active listeners are managed in `src/web/active-listener.ts` — a global `Map<accountId, ActiveWebListener>`

**What to grep for:**
- `monitorWebInbox` — inbound message entry point
- `resolveAgentRoute` — routing algorithm
- `sendMessageWhatsApp` — outbound delivery
- `ActiveWebListener` — socket wrapper interface

**Expected answer structure:** Key Files table with the 6 files above → How It Works with the inbound + outbound flows → Related Modules noting `src/pairing/`, `src/media/`, `src/channels/`.

---

### Example 2: "How do I add a new extension channel?"

**Step 1 — Scope:** Extension question — understand the structure and registration pattern for channel extensions.

**Step 2 — Modules:** Primary: `src/channels/plugins/`, `src/plugins/`, `extensions/`. Secondary: `src/plugin-sdk/`.

**Step 3 — Entry Points:**
- Channel interface: `src/channels/plugins/types.plugin.ts:48` → `ChannelPlugin` type definition
- Plugin loader: `src/plugins/loader.ts:169` → `loadOpenClawPlugins()`
- Plugin discovery: `src/plugins/discovery.ts:301` → `discoverOpenClawPlugins()`
- Reference extension: `extensions/telegram/index.ts` → complete example

**Step 4 — Trace the pattern:**

An extension channel needs these files:
```
extensions/<name>/
├── index.ts              # Plugin entry point with register()
├── package.json          # With "openclaw": { "extensions": ["./index.ts"] }
├── openclaw.plugin.json  # Plugin manifest: id, channels, configSchema
└── src/
    ├── channel.ts        # ChannelPlugin implementation
    └── runtime.ts        # PluginRuntime getter/setter
```

The `index.ts` entry point pattern (`extensions/telegram/index.ts:1-17`):
1. Import `OpenClawPluginApi` from `openclaw/plugin-sdk`
2. Export default plugin object with `register(api)` method
3. In `register()`: store runtime via `setRuntime(api.runtime)`, then call `api.registerChannel({ plugin: channelPlugin })`

The `ChannelPlugin` interface (`src/channels/plugins/types.plugin.ts:48-84`) requires:
- `id`: unique channel identifier string
- `meta`: `ChannelMeta` with label, docs path, blurb (`src/channels/plugins/types.core.ts:74-93`)
- `capabilities`: `ChannelCapabilities` declaring supported features (`types.core.ts:164-177`)
- `config`: `ChannelConfigAdapter` with `listAccountIds()` and `resolveAccount()` (`types.adapters.ts:41-65`)

Optional adapters for full functionality:
- `outbound`: `ChannelOutboundAdapter` — `sendText()`, `sendMedia()`, `sendPoll()` (`types.adapters.ts:89-106`)
- `gateway`: `ChannelGatewayAdapter` — `startAccount()`, `stopAccount()`, login methods (`types.adapters.ts:149-208`)
- `setup`, `pairing`, `security`, `status`, `directory`, `actions`

**What to grep for:**
- `ChannelPlugin` — interface definition
- `api.registerChannel` — registration call pattern
- `ChannelOutboundAdapter` — outbound message interface
- `ChannelGatewayAdapter` — provider lifecycle interface

**Expected answer structure:** Key Files table → How It Works showing the file structure + registration flow → code snippet of the `index.ts` pattern → table of required vs optional adapters.

---

### Example 3: "What LLM providers are supported?"

**Step 1 — Scope:** Location question — enumerate all supported LLM providers and how they integrate.

**Step 2 — Modules:** Primary: `src/agents/models-config.providers.ts`, `src/config/types.models.ts`. Secondary: `src/providers/`, `extensions/copilot-proxy/`, auth extensions.

**Step 3 — Entry Points:**
- Provider definitions: `src/agents/models-config.providers.ts:283-636`
- Model API types: `src/config/types.models.ts:1-7`
- Implicit provider resolution: `src/agents/models-config.providers.ts:444-547` → `resolveImplicitProviders()`
- Plugin provider registration: `src/plugins/types.ts:114-124` → `ProviderPlugin` type

**Step 4 — Enumerate providers:**

OpenClaw supports 6 LLM API protocols (`src/config/types.models.ts:1-7`):
1. `openai-completions` — OpenAI-compatible chat completions
2. `openai-responses` — OpenAI response streaming
3. `anthropic-messages` — Anthropic Claude Messages API
4. `google-generative-ai` — Google Generative AI
5. `github-copilot` — GitHub Copilot integration
6. `bedrock-converse-stream` — AWS Bedrock Converse API

Built-in LLM providers (from `models-config.providers.ts`):

| Provider | Default Model | API Type | Auth |
|----------|--------------|----------|------|
| MiniMax | MiniMax-M2.1 | openai-completions | API Key |
| MiniMax Portal | MiniMax-M2.1 | anthropic-messages | OAuth |
| Moonshot (Kimi) | kimi-k2.5 | openai-completions | API Key |
| Qwen Portal | Qwen Coder/Vision | openai-completions | OAuth |
| Ollama | Dynamic discovery | openai-completions | Local |
| Qianfan | deepseek-v3.2 | openai-completions | API Key |
| Xiaomi (MiMo) | mimo-v2-flash | anthropic-messages | API Key |
| Venice | Dynamic discovery | openai-completions | API Key |
| Synthetic | Dynamic catalog | anthropic-messages | API Key |
| GitHub Copilot | Dynamic (pi-ai) | github-copilot | Token |
| AWS Bedrock | Dynamic discovery | bedrock-converse-stream | AWS SDK |
| Cloudflare AI Gateway | Dynamic | anthropic-messages | API Key |
| OpenRouter | Dynamic | openai-completions | API Key |
| Vercel AI Gateway | Dynamic | Dynamic | API Key |
| XAI (Grok) | grok-2 | openai-completions | API Key |
| z.ai | Dynamic | Dynamic | API Key |

Extension-based auth providers: `extensions/google-antigravity-auth/`, `extensions/google-gemini-cli-auth/`, `extensions/minimax-portal-auth/`, `extensions/qwen-portal-auth/`, `extensions/copilot-proxy/`.

Plugins can register custom providers via `api.registerProvider()` using the `ProviderPlugin` type (`src/plugins/types.ts:114-124`).

**What to grep for:**
- `resolveImplicitProviders` — built-in provider registration
- `ModelApi` — API protocol type
- `ProviderPlugin` — plugin provider interface
- `registerProvider` — extension provider registration

**Expected answer structure:** Key Files table → summary table of all providers → explanation of API types → note about plugin extensibility.

---

### Example 4: "How does the cron system work?"

**Step 1 — Scope:** Feature question — trace the cron job lifecycle from definition through execution to delivery.

**Step 2 — Modules:** Primary: `src/cron/`. Secondary: `src/hooks/`, agent system.

**Step 3 — Entry Points:**
- Public API: `src/cron/service.ts:7-48` → `CronService` class
- Type definitions: `src/cron/types.ts` → `CronJob`, `CronSchedule`, `CronPayload`
- Timer loop: `src/cron/service/timer.ts:157` → `onTimer()`
- Isolated execution: `src/cron/isolated-agent/run.ts:110` → `runCronIsolatedAgentTurn()`

**Step 4 — Trace the lifecycle:**

**Job Definition** (`src/cron/types.ts`):
- Three schedule kinds: `at` (one-shot ISO 8601 timestamp), `every` (fixed interval in ms), `cron` (5-field cron expression with timezone)
- Two payload kinds: `systemEvent` (enqueue text to main session) or `agentTurn` (run isolated agent session)
- Two session targets: `main` (inject into existing session) or `isolated` (fresh ephemeral session)
- Two wake modes: `next-heartbeat` (wait for natural heartbeat) or `now` (force immediate heartbeat)

**Scheduling** (`src/cron/schedule.ts:13` → `computeNextRunAtMs()`):
- `at` kind: parse ISO 8601, return timestamp if in the future, undefined after success
- `every` kind: calculate `anchor + steps * everyMs` from creation time
- `cron` kind: use `croner` library with IANA timezone support

**Execution Loop** (`src/cron/service/timer.ts`):
1. `armTimer()` (line 117) — schedules next wake at `min(nextRunAtMs, now + 60s)`
2. `onTimer()` (line 157) — reloads store from disk, calls `findDueJobs()` (line 282), marks jobs as running, executes each with timeout (10 min default)
3. `executeJobCore()` (line 358) — for `main` session: enqueue system event, optionally poll heartbeat. For `isolated` session: call `runCronIsolatedAgentTurn()`

**Delivery** (`src/cron/delivery.ts:30` → `resolveCronDeliveryPlan()`):
- Isolated jobs can announce results to a channel (mode: `announce` or `none`)
- Resolves target channel and recipient from delivery config or fallback chain
- Sends summary with "Cron: ..." prefix back to channel via outbound adapters

**State Tracking** (`src/cron/types.ts:55-64`):
- Tracks `nextRunAtMs`, `lastRunAtMs`, `lastStatus` (ok/error/skipped), `consecutiveErrors`
- Error recovery: exponential backoff 30s → 1m → 5m → 15m → 60m
- One-shot jobs: disable after terminal status, delete if `deleteAfterRun === true`

**Persistence** (`src/cron/store.ts`):
- Jobs stored as JSON at `~/.openclaw/cron/jobs.json` by default
- File reload on each timer tick to catch cross-service edits

**What to grep for:**
- `CronService` — public API surface
- `computeNextRunAtMs` — schedule calculation
- `executeJobCore` — execution dispatcher
- `resolveCronDeliveryPlan` — delivery resolution
- `runCronIsolatedAgentTurn` — isolated agent execution

**Expected answer structure:** Key Files table → How It Works with definition → scheduling → execution → delivery flow → state tracking details → Related Modules noting agent system integration.

---

### Example 5: "How does the browser automation work?"

**Step 1 — Scope:** Feature question — trace how agents control a browser via Playwright/CDP.

**Step 2 — Modules:** Primary: `src/browser/`. Secondary: none (self-contained module).

**Step 3 — Entry Points:**
- Bridge server: `src/browser/bridge-server.ts:20` → `startBrowserBridgeServer()`
- Agent tool: `src/agents/tools/browser-tool.ts` → agent-facing browser tool
- Client actions: `src/browser/client-actions-core.ts:225` → `browserAct()`
- Snapshots: `src/browser/client.ts:276` → `browserSnapshot()`

**Step 4 — Trace the architecture:**

The browser module uses an HTTP bridge pattern:

```
Agent → browser-tool.ts → HTTP POST → Bridge Server → Route Handler → Playwright/CDP → Chrome
```

**Bridge Server** (`src/browser/bridge-server.ts:20-76`):
- Express.js HTTP server on `127.0.0.1:<port>`
- Bearer token authentication (lines 33-42)
- Routes registered from `src/browser/routes/index.ts`

**Route Layer** (`src/browser/routes/`):
- `agent.act.ts` — action dispatcher (click, type, hover, drag, select, fill, wait, evaluate, etc.)
- `agent.snapshot.ts` — ARIA/AI snapshot endpoints + navigation
- `basic.ts` — browser status, start, stop
- `tabs.ts` — tab management (list, open, close, focus)

**Client Actions** (`src/browser/client-actions-core.ts`):
- `browserNavigate()` (line 102) — navigate to URL
- `browserAct()` (line 225) — universal action dispatcher using kind-based request objects
- `browserScreenshotAction()` (line 239) — capture screenshot
- `browserArmDialog()` (line 119) — intercept alert/confirm/prompt dialogs
- `browserArmFileChooser()` (line 143) — set file paths for file inputs
- `browserDownload()` (line 197) — trigger and capture downloads

**Ref System** (critical for element targeting):
- Snapshots return refs like `e1`, `e2`, `e3` — unique element identifiers derived from ARIA roles/names
- Stored per targetId in `roleRefsByTarget` Map (`src/browser/pw-session.ts:94`)
- Agent uses refs in actions: `{ kind: "click", ref: "e1" }`
- Handler resolves ref to Playwright locator via `refLocator()`

**Playwright Integration** (`src/browser/pw-ai.ts`):
- Loaded dynamically via `getPwAiModule()` (`src/browser/pw-ai-module.ts`)
- Operations in `src/browser/pw-tools-core.interactions.ts`: `clickViaPlaywright()` (line 26), `hoverViaPlaywright()` (line 63), `dragViaPlaywright()` (line 82), `typeViaPlaywright()`
- Snapshots in `src/browser/pw-tools-core.snapshot.ts`: `snapshotAriaViaPlaywright()` (line 16), `snapshotAiViaPlaywright()` (line 40)

**CDP Integration** (`src/browser/cdp.helpers.ts:60-111`):
- WebSocket connection to Chrome's CDP endpoint
- `createCdpSender()` creates request/response handler with pending request tracking
- Used for: screenshots (`captureScreenshot()` in `cdp.ts:42`), tab creation (`createTargetViaCdp()`), raw protocol operations

**Chrome Management** (`src/browser/chrome.ts`):
- Launches Chrome with CDP debugging port
- Resolves Chrome executable path (`chrome.executables.ts`)
- Manages user data directories for profile persistence

**What to grep for:**
- `startBrowserBridgeServer` — server initialization
- `browserAct` — action dispatch entry point
- `browserSnapshot` — snapshot capture
- `clickViaPlaywright` — Playwright click implementation
- `createCdpSender` — CDP WebSocket connection
- `refLocator` — ref-to-element resolution

**Expected answer structure:** Key Files table → architecture diagram (Agent → HTTP → Routes → Playwright/CDP → Chrome) → How It Works covering bridge server, ref system, and action dispatch → code snippet of a typical agent interaction sequence.

---

## Quick Reference Cheat Sheet

### One-Liner Module Mappings

| Concept | Where to Look |
|---------|---------------|
| Messaging channels | `src/channels/` + `src/<channel-name>/` + `extensions/<channel-name>/` |
| CLI commands | `src/commands/` (implementations) + `src/cli/` (framework) |
| Gateway API | `src/gateway/server.ts` + `src/gateway/server-methods/` |
| Message routing | `src/routing/resolve-route.ts` + `src/routing/session-key.ts` |
| Agent lifecycle | `src/agents/` |
| Config schemas | `src/config/zod-schema*.ts` + `src/config/types.ts` |
| Plugin system | `src/plugins/` (core) + `src/plugin-sdk/` (public types) |
| Hook lifecycle | `src/plugins/hooks.ts` (Layer 1) + `src/hooks/internal-hooks.ts` (Layer 2) |
| LLM providers | `src/agents/models-config.providers.ts` + `src/config/types.models.ts` |
| Cron/scheduling | `src/cron/service.ts` (API) + `src/cron/service/timer.ts` (loop) |
| Browser automation | `src/browser/bridge-server.ts` (server) + `src/browser/client-actions-core.ts` (actions) |
| Memory/embeddings | `src/memory/manager.ts` + `extensions/memory-*/` |
| Auto-reply pipeline | `src/auto-reply/reply-dispatcher.ts` |
| Security/secrets | `src/config/redact-snapshot.ts` + `src/security/` |
| Extension loading | `src/plugins/discovery.ts` → `src/plugins/loader.ts` → `src/plugins/runtime.ts` |
| Media handling | `src/media/mime.ts` + `src/media/store.ts` |
| TUI/slash commands | `src/tui/` |
| Docs site | `docs/` (Mintlify MDX) |

### Common Investigation Shortcuts

| I need to... | Do this |
|-------------|---------|
| Find where a config option is defined | Grep `src/config/zod-schema*.ts` for the option name |
| Find what a CLI command does | Grep `src/commands/` for the command name |
| Understand a channel's capabilities | Read `extensions/<channel>/src/channel.ts` → `capabilities` field |
| Find all hook trigger points | Grep `triggerInternalHook\(` across `src/` |
| Find all plugin registrations | Grep `api.register` across `extensions/` |
| Find all agent tools | Grep `src/agents/tools/` for tool definitions |
| Understand an extension's config | Read `extensions/<name>/openclaw.plugin.json` → `configSchema` |
| Find test behavior for a module | Glob `src/<module>/**/*.test.ts` |
| Check docs for a feature | Glob `docs/<feature>/**/*.mdx` |
| Trace DI wiring | Read `src/cli/deps.ts` → `createDefaultDeps()` |
