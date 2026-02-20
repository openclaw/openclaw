---
type: research
title: "OpenClaw Codebase Exploration"
created: 2026-02-19
tags:
  - codebase
  - structure
  - reference
related:
  - "[[SKILL.md]]"
---

# OpenClaw Codebase Exploration

## Project Overview

OpenClaw is a WhatsApp gateway CLI (Baileys web) with Pi RPC agent capabilities. It is a TypeScript ESM monorepo managed with pnpm, targeting Node 22+. The project provides a multi-channel messaging gateway with AI agent orchestration, supporting channels like WhatsApp, Telegram, Discord, Slack, Signal, iMessage, LINE, and many more via extensions.

- **Version**: 2026.2.6-3
- **License**: MIT
- **Package Manager**: pnpm 10.23.0
- **Runtime**: Node 22+ (Bun also supported for dev/test)
- **Language**: TypeScript (ESM, strict mode)
- **Linting/Formatting**: Oxlint + Oxfmt
- **Testing**: Vitest with V8 coverage (70% thresholds)

---

## Top-Level Directory Structure

```
openclaw-github/
├── AGENTS.md              # Repository guidelines and conventions
├── CHANGELOG.md           # Release changelog
├── CONTRIBUTING.md         # Contribution guidelines
├── Dockerfile*            # Container images (main, sandbox, sandbox-browser)
├── LICENSE                # MIT license
├── README.md              # Project readme
├── SECURITY.md            # Security policy
├── apps/                  # Native applications (macOS, iOS, Android)
├── assets/                # Static assets
├── docs/                  # Mintlify documentation site
├── extensions/            # Plugin extension packages (31 extensions)
├── fly.toml               # Fly.io deployment config
├── git-hooks/             # Git hook scripts
├── openclaw.mjs           # CLI bootstrap entry point
├── package.json           # Root package manifest
├── packages/              # Shared workspace packages
├── patches/               # pnpm patch files
├── pnpm-workspace.yaml    # Workspace configuration
├── render.yaml            # Render deployment config
├── scripts/               # Build, test, and utility scripts
├── skills/                # Agent skill definitions (51 skills)
├── src/                   # Main source code (~50 subsystems)
├── Swabble/               # Swabble integration
├── test/                  # E2E tests, mocks, and setup
├── tsconfig.json          # TypeScript configuration
├── tsdown.config.ts       # Build tool config
├── ui/                    # Web UI (Lit components)
├── vendor/                # Vendored dependencies
├── vitest.*.config.ts     # Test configuration files
└── zizmor.yml             # GitHub Actions security config
```

### Monorepo Workspaces (pnpm-workspace.yaml)

```
- .             (root — main CLI/library)
- ui            (web UI)
- packages/*    (shared packages)
- extensions/*  (channel/feature plugins)
```

---

## Source Code: `src/` Subsystems (~50 directories)

### Agent & Command Infrastructure

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/agents/` | Core agent lifecycle, configuration, workspace setup, identity resolution | `agent-scope.ts`, `agent-paths.ts`, `workspace.ts` | ~459 .ts files |
| `src/commands/` | Core command implementations: agent execution, delivery, auth | `agent.ts`, `agent.delivery.ts`, `agent-via-gateway.ts` | ~231 .ts files |
| `src/cli/` | CLI argument parsing, command registration, program builder | `channels-cli.ts`, `argv.ts`, `run-main.ts` | ~171 .ts files |
| `src/gateway/` | Main gateway server: auth, identity, channel routing, Tailscale | `server.ts`, `assistant-identity.ts`, `auth.ts` | ~195 .ts files |
| `src/routing/` | Message routing, session key resolution, agent routes | `resolve-route.ts`, `session-key.ts`, `bindings.ts` | ~5 .ts files |
| `src/sessions/` | Session management: level/model overrides, send policies | `send-policy.ts`, `model-overrides.ts`, `level-overrides.ts` | ~7 .ts files |
| `src/daemon/` | Service process management (LaunchAgent, systemd, Windows Task) | `constants.ts`, `service-runtime.ts`, `runtime-parse.ts` | ~30 .ts files |

### Messaging Channels

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/channels/` | Abstract channel plugin system, adapters, registry | `dock.ts`, `plugins/types.plugin.ts`, `registry.ts` | ~101 .ts files |
| `src/telegram/` | Telegram bot framework (Bot API, webhooks) | `send.ts`, `monitor.ts`, `webhook.ts` | ~88 .ts files |
| `src/web/` | WhatsApp web provider (Baileys), QR login, media | `login-qr.ts`, `accounts.ts`, `media.ts` | ~78 .ts files |
| `src/discord/` | Discord integration (Carbon framework) | `send.ts`, `monitor.ts`, `accounts.ts` | ~67 .ts files |
| `src/slack/` | Slack workspace integration (Socket Mode, Bolt) | `send.ts`, `actions.ts`, `monitor.ts` | ~65 .ts files |
| `src/line/` | LINE Messaging API bot | `monitor.ts`, `send.ts`, `flex-templates.ts` | ~34 .ts files |
| `src/signal/` | Signal messenger provider | `monitor.ts`, `send.ts`, `send-reactions.ts` | ~24 .ts files |
| `src/imessage/` | iMessage channel via BlueBubbles | `monitor.ts`, `accounts.ts`, `send.ts` | ~17 .ts files |
| `src/whatsapp/` | WhatsApp-specific utilities (normalization) | `normalize.ts` | ~2 .ts files |
| `src/pairing/` | Channel account pairing with QR codes | `pairing-store.ts`, `pairing-messages.ts` | ~5 .ts files |

### AI & Intelligence

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/providers/` | LLM provider integrations (Copilot, Qwen OAuth, etc.) | `github-copilot-auth.ts`, `qwen-portal-oauth.ts` | ~8 .ts files |
| `src/memory/` | Conversational memory with embeddings, SQLite backend | `manager.ts`, `search-manager.ts`, `types.ts` | ~43 .ts files |
| `src/auto-reply/` | Automatic reply system: chunking, templates, dispatch | `chunk.ts`, `envelope.ts`, `reply-dispatcher.ts` | ~209 .ts files |
| `src/media-understanding/` | Image/media analysis via various providers | `apply.ts`, `format.ts`, `types.ts` | ~37 .ts files |
| `src/link-understanding/` | URL detection and link content extraction | `apply.ts`, `detect.ts`, `runner.ts` | ~7 .ts files |
| `src/tts/` | Text-to-speech synthesis (edge-tts) | `tts.ts` | ~2 .ts files |

### Infrastructure & Utilities

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/infra/` | Event streaming, archiving, backoff, diagnostics | `agent-events.ts`, `archive.ts`, `diagnostic-events.ts` | ~186 .ts files |
| `src/config/` | Config loading, validation, path resolution, schemas | `config.ts`, `types.ts`, `zod-schema.*.ts` | ~134 .ts files |
| `src/plugins/` | Plugin system: manifest, HTTP routes, runtime | `manifest-registry.ts`, `http-path.ts`, `runtime.ts` | ~37 .ts files |
| `src/hooks/` | Integration hooks (Gmail, Soul Evil, bundled hooks) | `gmail-ops.ts`, `soul-evil.ts`, `bundled-dir.ts` | ~33 .ts files |
| `src/cron/` | Scheduled job execution with cron expressions | `delivery.ts`, `schedule.ts`, `types.ts` | ~42 .ts files |
| `src/security/` | Audit trails, ACL management, content validation | `audit.ts`, `windows-acl.ts`, `external-content.ts` | ~13 .ts files |
| `src/logging/` | Log parsing, state management, transport config | `logger.ts`, `parse-log-line.ts`, `state.ts` | ~15 .ts files |
| `src/process/` | Child process management, signal bridging | `child-process-bridge.ts`, `command-queue.ts` | ~9 .ts files |

### UI & Display

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/tui/` | Terminal user interface, slash commands | `commands.ts`, `tui-status-summary.ts` | ~39 .ts files |
| `src/terminal/` | Terminal formatting, links, CLI output rendering | `links.ts`, `prompt.ts` | ~12 .ts files |
| `src/canvas-host/` | WebSocket canvas host for real-time rendering | `server.ts`, `a2ui.ts` | ~4 .ts files |
| `src/browser/` | Browser automation via Playwright/CDP | `bridge-server.ts`, `cdp.helpers.ts`, `client-actions.ts` | ~81 .ts files |
| `src/markdown/` | Markdown parsing (code spans, tables, fences) | `tables.ts`, `code-spans.ts`, `fences.ts` | ~8 .ts files |

### Media & Files

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/media/` | MIME detection, file storage, extension resolution | `mime.ts`, `store.ts`, `fetch.ts` | ~19 .ts files |

### Platform-Specific

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/macos/` | macOS-specific relay and gateway daemon | `relay.ts`, `gateway-daemon.ts` | ~4 .ts files |
| `src/node-host/` | Node.js runtime host configuration | `config.ts`, `runner.ts` | ~3 .ts files |

### ACP & Protocol

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/acp/` | Agent Communication Protocol server | `server.ts`, `translator.js`, `types.ts` | ~13 .ts files |

### Onboarding & Setup

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/wizard/` | Onboarding wizard with config finalization | `onboarding.finalize.ts`, `onboarding.types.ts` | ~10 .ts files |

### Shared & Compatibility

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/compat/` | Legacy compatibility layer | `legacy-names.ts` | ~1 .ts file |
| `src/shared/` | Shared text utilities | (minimal exports) | ~2 .ts files |
| `src/utils/` | General utilities: account IDs, usage formatting | `message-channel.ts`, `delivery-context.ts`, `usage-format.ts` | ~16 .ts files |
| `src/plugin-sdk/` | Public plugin SDK type exports | `index.ts` | ~2 .ts files |

### Testing Support

| Directory | Purpose | Key Files | Approx Size |
|-----------|---------|-----------|-------------|
| `src/test-helpers/` | Testing utilities and helpers | (test support modules) | ~2 .ts files |
| `src/test-utils/` | Test utilities and mocks (channel plugin stubs) | `channel-plugins.ts` | ~2 .ts files |
| `src/types/` | TypeScript type declarations for external packages | `*.d.ts` | ~9 .ts files |
| `src/docs/` | Documentation generation (slash commands doc) | `slash-commands-doc.test.ts` | ~1 .ts file |
| `src/scripts/` | Utility scripts | (build/setup scripts) | ~1 .ts file |

### Root-Level `src/` Files

| File | Purpose |
|------|---------|
| `src/entry.ts` | Main CLI initialization and process setup |
| `src/index.ts` | Library export and programmatic API |
| `src/globals.ts` | Global application state |
| `src/logger.ts` | Logging infrastructure setup |
| `src/logging.ts` | Logging configuration |
| `src/runtime.ts` | Runtime environment setup |
| `src/utils.ts` | Core utility functions |
| `src/version.ts` | Version information |
| `src/polls.ts` | Polling functionality |
| `src/extensionAPI.ts` | Extension API definition |

---

## Extensions Registry (31 packages)

### Messaging Channel Extensions

| Extension | Package Name | Integration |
|-----------|-------------|-------------|
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

### Infrastructure & Utility Extensions

| Extension | Package Name | Purpose |
|-----------|-------------|---------|
| `extensions/copilot-proxy` | @openclaw/copilot-proxy | Copilot Proxy provider plugin |
| `extensions/diagnostics-otel` | @openclaw/diagnostics-otel | OpenTelemetry diagnostics exporter |
| `extensions/llm-task` | @openclaw/llm-task | JSON-only LLM task plugin |
| `extensions/lobster` | @openclaw/lobster | Typed pipelines + resumable approvals workflow tool |
| `extensions/memory-core` | @openclaw/memory-core | Core memory search plugin |
| `extensions/memory-lancedb` | @openclaw/memory-lancedb | LanceDB-backed long-term memory with auto-recall/capture |
| `extensions/open-prose` | @openclaw/open-prose | OpenProse VM skill pack (slash command + telemetry) |
| `extensions/voice-call` | @openclaw/voice-call | Voice call plugin |

### OAuth & Authentication Extensions

| Extension | Package Name | Purpose |
|-----------|-------------|---------|
| `extensions/google-antigravity-auth` | @openclaw/google-antigravity-auth | Google Antigravity OAuth provider |
| `extensions/google-gemini-cli-auth` | @openclaw/google-gemini-cli-auth | Gemini CLI OAuth provider |
| `extensions/minimax-portal-auth` | @openclaw/minimax-portal-auth | MiniMax Portal OAuth provider |
| `extensions/qwen-portal-auth` | @openclaw/qwen-portal-auth | Qwen Portal OAuth provider |

---

## Skills Catalog (51 skills)

### Communication & Messaging
| Skill | Purpose |
|-------|---------|
| `skills/bluebubbles/` | Send/manage iMessages via BlueBubbles |
| `skills/discord/` | Discord messaging: send, react, manage channels/threads |
| `skills/imsg/` | iMessage/SMS CLI for chats, history, watching, sending |
| `skills/slack/` | React, pin/unpin in Slack channels or DMs |
| `skills/voice-call/` | Start voice calls via Twilio, Telnyx, Plivo |
| `skills/wacli/` | WhatsApp messaging and history search |
| `skills/himalaya/` | Email via IMAP/SMTP CLI |

### Notes & Knowledge Management
| Skill | Purpose |
|-------|---------|
| `skills/apple-notes/` | Apple Notes via memo CLI |
| `skills/bear-notes/` | Bear notes via grizzly CLI |
| `skills/obsidian/` | Obsidian vaults (plain Markdown) |
| `skills/notion/` | Notion API for pages, databases, blocks |
| `skills/session-logs/` | Search and analyze session logs |
| `skills/things-mac/` | Things 3 task manager via CLI |

### Coding & Development
| Skill | Purpose |
|-------|---------|
| `skills/coding-agent/` | Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent |
| `skills/github/` | GitHub via gh CLI (issues, PRs, API) |
| `skills/skill-creator/` | Create/update AgentSkills |
| `skills/oracle/` | Bundle prompt + files for one-shot model request |

### AI & LLM Tools
| Skill | Purpose |
|-------|---------|
| `skills/gemini/` | Gemini CLI for Q&A, summaries, generation |
| `skills/openai-image-gen/` | Image generation via OpenAI Images API |
| `skills/nano-banana-pro/` | Image generation via Gemini 3 Pro Image |
| `skills/summarize/` | Summarize URLs, podcasts, local files |
| `skills/model-usage/` | Per-model usage cost tracking |

### Audio & Voice
| Skill | Purpose |
|-------|---------|
| `skills/openai-whisper/` | Local speech-to-text with Whisper CLI |
| `skills/openai-whisper-api/` | Audio transcription via OpenAI API |
| `skills/sherpa-onnx-tts/` | Local TTS via sherpa-onnx |
| `skills/sag/` | ElevenLabs TTS |
| `skills/songsee/` | Audio spectrograms and visualizations |

### Media & Documents
| Skill | Purpose |
|-------|---------|
| `skills/nano-pdf/` | Edit PDFs with natural-language instructions |
| `skills/video-frames/` | Extract video frames/clips via ffmpeg |
| `skills/gifgrep/` | GIF search and management |

### Smart Home & Devices
| Skill | Purpose |
|-------|---------|
| `skills/blucli/` | Bluesound/NAD player control |
| `skills/camsnap/` | RTSP/ONVIF camera capture |
| `skills/eightctl/` | Eight Sleep pod control |
| `skills/openhue/` | Philips Hue light/scene control |
| `skills/peekaboo/` | macOS UI capture and automation |

### Music & Entertainment
| Skill | Purpose |
|-------|---------|
| `skills/spotify-player/` | Spotify playback/search |
| `skills/sonoscli/` | Sonos speaker control |
| `skills/twitch/` | Twitch streaming interaction |
| `skills/gog/` | Google Workspace CLI (Gmail, Calendar, Drive) |

### Productivity & Tasks
| Skill | Purpose |
|-------|---------|
| `skills/apple-reminders/` | Apple Reminders via remindctl CLI |
| `skills/clawhub/` | Skill marketplace (search, install, publish) |
| `skills/foodorder/` | Foodora food ordering |
| `skills/ordercli/` | Order tracking (Foodora-focused) |
| `skills/trello/` | Trello board management |

### System & Infrastructure
| Skill | Purpose |
|-------|---------|
| `skills/1password/` | 1Password CLI integration |
| `skills/healthcheck/` | Host security hardening |
| `skills/tmux/` | Remote tmux session control |
| `skills/mcporter/` | MCP server interaction |

### Utilities & Tools
| Skill | Purpose |
|-------|---------|
| `skills/blogwatcher/` | Blog/RSS feed monitoring |
| `skills/canvas/` | HTML display on connected OpenClaw nodes |
| `skills/goplaces/` | Google Places API queries |
| `skills/local-places/` | Local places search |
| `skills/weather/` | Weather forecasts |

---

## Key Entry Points

### 1. `openclaw.mjs` — CLI Bootstrap
- Shebang entry point (`#!/usr/bin/env node`)
- Enables Node.js compile cache for performance
- Dynamically imports compiled `dist/entry.js` or `dist/entry.mjs`
- Defined as the `bin` entry in package.json

### 2. `src/entry.ts` — Main Initialization
- Sets up process title and normalizes environment
- Installs warning filters and rejection handlers
- Respawns process with suppressed experimental warnings if needed
- Parses CLI profiles and applies environment overrides
- Delegates to main CLI runner

### 3. `src/index.ts` — Library API
- Exports `buildProgram` (CLI Command tree)
- Exports `createDefaultDeps` (dependency injection factory)
- Exports config/session management, channel utilities
- Usable both as CLI tool and npm library

### 4. `src/cli/program.ts` → `src/cli/program/build-program.ts` — Program Builder
- Constructs full Commander.js program tree
- Registers all subcommands via `registerProgramCommands`
- Configures help system and pre-action hooks

---

## Key Architectural Patterns

### Dependency Injection via `createDefaultDeps`

**Location**: `src/cli/deps.ts`

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

- Factory function returns plain object mapping channel IDs to send implementations
- No IoC container — simple object-based DI
- `createOutboundSendDeps()` adapts CliDeps to OutboundSendDeps for infra layer
- Very testable with stub implementations

### Channel Abstraction

**Core Type**: `src/channels/plugins/types.plugin.ts`

Each channel is a `ChannelPlugin` implementing a standardized interface with optional adapters:
- `config` — Load/resolve accounts, check config
- `outbound` — Send text/media
- `onboarding` — Setup wizard flow
- `security` — Auth checks
- `gateway` — RPC methods
- `status` — Health check
- 15+ more optional adapters

**Registry**: `src/channels/registry.ts` — Central channel registry

Built-in channels: Telegram, WhatsApp, Discord, Google Chat, Slack, Signal, iMessage. Extension channels (Matrix, Zalo, MS Teams, etc.) implement the same interface.

### Plugin Loading Mechanism

**Loader**: `src/plugins/loader.ts`

1. `loadOpenClawPlugins(config, workspaceDir, logger)` is called
2. Discovers plugins via `discoverOpenClawPlugins()`
3. For each plugin: loads module via `createJiti()`, validates schema, calls `register()` or `activate()`
4. Registers hooks, commands, tools, and gateway methods
5. Sets active registry via `setActivePluginRegistry()`

**Plugin Definition** (`src/plugins/types.ts`):
```typescript
type OpenClawPluginDefinition = {
  id: string;
  version?: string;
  description?: string;
  register?: (api: PluginApi) => void | Promise<void>;
  activate?: (api: PluginApi) => void | Promise<void>;
  configSchema?: OpenClawPluginConfigSchema;
  tools?: OpenClawPluginToolFactory[];
  hooks?: Record<PluginHookName, PluginHookHandler[]>;
};
```

### Hook System (Dual-Layer)

**Layer 1 — Plugin Hooks** (`src/plugins/hooks.ts`):
- Lifecycle hooks: `beforeAgentStart`, `messageReceived`, `messageSending`, `beforeToolCall`, `afterToolCall`, `sessionStart`, `sessionEnd`, `gatewayStart`, `gatewayStop`
- Hook runner sorts by priority, runs in parallel, catches errors
- Both fire-and-forget and value-returning hooks

**Layer 2 — Internal Hooks** (`src/hooks/internal-hooks.ts`):
- Event-driven system: event types `command`, `session`, `agent`, `gateway`
- Handlers registered by `type:action` (e.g., `command:new`)
- Used for bootstrap hooks, cron triggers, command processing

**Hook Configuration** (`src/config/types.hooks.ts`):
- Config-driven webhook mappings with match patterns, actions, wake modes, channel targeting, model overrides, transforms

### Config & Secrets Management

**Approach**: Redaction-based (no encryption)

**Location**: `src/config/redact-snapshot.ts`

- Sensitive fields detected by pattern matching (`/token/i`, `/password/i`, `/secret/i`, `/api.?key/i`)
- Three redaction layers: `redactConfigObject()`, `redactRawText()`, `restoreRedactedValues()`
- Secrets stored in plaintext; security depends on filesystem permissions
- Gateway HTTP responses use redacted values; writes restore originals from loaded config

---

## Testing Patterns

### Framework & Configuration
- **Framework**: Vitest with V8 coverage
- **Config**: `vitest.config.ts` — pool: "forks", maxWorkers: 16 local / 3 CI, testTimeout: 120s
- **Coverage thresholds**: 70% lines/functions/statements, 55% branches
- **Setup**: `test/setup.ts` — installs warning filters, creates isolated test directories, stubs channel plugins

### Colocated Tests
- Source files: `src/**/*.ts`
- Test files: `src/**/*.test.ts` (colocated alongside source)
- E2E tests: `*.e2e.test.ts` (separate config)
- Live tests: `*.live.test.ts` (require real API keys)

### Test Utilities
- `src/test-utils/channel-plugins.ts` — `createTestRegistry()`, `createStubPlugin()`, `createStubOutbound()`
- `withTempStateDir()` helper for isolated filesystem state
- Mock Baileys library for WhatsApp simulation (`test/mocks/baileys.ts`)

### E2E Tests (`test/`)
- Spawn actual gateway processes
- Ephemeral home/state directories with unique tokens and ports
- HTTP requests to running gateway instances
- 120s timeout per test
- Docker-based tests for integration scenarios

### Test Scripts
```bash
pnpm test              # Unit tests (vitest)
pnpm test:coverage     # With V8 coverage
pnpm test:e2e          # E2E tests
pnpm test:live         # Live tests (real keys)
pnpm test:docker:all   # All Docker-based tests
```

---

## Documentation Patterns

### Mintlify Docs (`docs/`)

**Tech Stack**: Mintlify (hosted at docs.openclaw.ai)

**Structure** (~44 subdirectories):
```
docs/
├── assets/          # Images, logos
├── automation/      # Automation/cron features
├── channels/        # 30+ channel-specific docs
├── cli/             # 43 CLI command docs
├── concepts/        # 30 conceptual guides
├── debug/           # Debugging guides
├── diagnostics/     # Diagnostics features
├── experiments/     # Experimental features
├── gateway/         # Gateway architecture & security
├── help/            # Help & troubleshooting
├── hooks/           # Hooks system documentation
├── install/         # 21 installation guides (OS-specific)
├── nodes/           # Node-based deployments
├── platforms/       # Platform-specific (macOS, iOS, Android)
├── plugins/         # Plugin development
├── providers/       # 24 LLM provider setup guides
├── reference/       # API references
├── security/        # Security guides
├── start/           # Getting started
├── tools/           # Tool documentation
├── web/             # Web UI documentation
├── zh-CN/           # Chinese (Simplified) translations
└── .i18n/           # i18n pipeline config
```

### Documentation Conventions
- Internal links: root-relative, no `.md`/`.mdx` (e.g., `[Config](/configuration)`)
- Cross-references: anchors on root-relative paths (e.g., `[Hooks](/configuration#hooks)`)
- External links: full `https://docs.openclaw.ai/...` URLs
- Content must be generic — no personal device names/paths
- i18n: `zh-CN` is generated; pipeline via `scripts/docs-i18n`

---

## Build & Development

### Key Commands
```bash
pnpm install           # Install dependencies
pnpm build             # Type-check and build
pnpm check             # Lint + format (Oxlint + Oxfmt)
pnpm test              # Run tests
pnpm dev               # Run CLI in dev mode
pnpm openclaw          # Run CLI via dev script
pnpm ui:build          # Build web UI
pnpm ui:dev            # Web UI dev server
```

### Build Pipeline
1. `pnpm canvas:a2ui:bundle` — Bundle A2UI canvas
2. `tsdown` — TypeScript compilation
3. `pnpm build:plugin-sdk:dts` — Generate plugin SDK types
4. Various post-build scripts (copy hooks, write build info, CLI compat)

### Naming Conventions
- **OpenClaw** for product/app/docs headings
- **openclaw** for CLI command, package/binary, paths, config keys
- Commits via `scripts/committer "<msg>" <file...>`
- Release channels: stable (tagged), beta (prerelease), dev (main HEAD)

---

## Summary Statistics

- **~50 src/ subsystems** spanning agent management, messaging channels, AI/intelligence, infrastructure, and UI
- **31 extensions** (19 messaging channels, 8 infrastructure/utility, 4 OAuth)
- **51 skills** across communication, notes, coding, AI, audio, media, smart home, music, productivity, system, and utilities
- **2,000+ TypeScript source files** in src/
- **44 documentation subdirectories** with 24 LLM provider guides and 30+ channel docs
