# Codebase Structure

**Analysis Date:** 2026-03-08

## Directory Layout

```
openclaw/
├── apps/                    # Native applications (macOS, iOS, Android)
│   ├── android/             # Android app (Kotlin, Jetpack Compose)
│   ├── ios/                 # iOS app (Swift, SwiftUI)
│   ├── macos/               # macOS menubar app (Swift, SwiftUI)
│   └── shared/              # Shared Swift package (OpenClawKit)
├── assets/                  # Static assets (images, icons)
├── docs/                    # Mintlify documentation site
├── extensions/              # Plugin workspace packages (~40 extensions)
│   ├── telegram/            # Telegram channel plugin
│   ├── discord/             # Discord channel plugin
│   ├── msteams/             # MS Teams channel plugin
│   ├── matrix/              # Matrix channel plugin
│   ├── voice-call/          # Voice call plugin
│   ├── memory-core/         # Memory plugin (core)
│   ├── memory-lancedb/      # Memory plugin (LanceDB backend)
│   ├── lobster/             # UI theming plugin
│   └── ...                  # Many more (see full list below)
├── packages/                # Internal workspace packages
│   ├── clawdbot/            # ClawdBot package
│   └── moltbot/             # MoltBot package
├── patches/                 # pnpm dependency patches
├── scripts/                 # Build, release, CI, and utility scripts
├── skills/                  # Bundled skills (prompt snippets)
├── src/                     # Core TypeScript source
│   ├── acp/                 # ACP protocol (agent communication)
│   ├── agents/              # AI agent system (Pi runner, tools, models, skills)
│   ├── auto-reply/          # Auto-reply templates and dispatch
│   ├── browser/             # Browser automation (CDP, Chrome extension)
│   ├── canvas-host/         # Canvas host server (A2UI)
│   ├── channels/            # Channel abstraction layer
│   ├── cli/                 # CLI program, commands, UI components
│   ├── commands/            # CLI command implementations
│   ├── compat/              # Compatibility shims
│   ├── config/              # Configuration (YAML, Zod schemas, sessions)
│   ├── context-engine/      # Context engine for prompt enrichment
│   ├── cron/                # Cron job scheduling
│   ├── daemon/              # Daemon/service management
│   ├── discord/             # Discord core channel implementation
│   ├── docs/                # Docs utilities
│   ├── gateway/             # Gateway server (HTTP, WS, RPC)
│   ├── hooks/               # Hook system (lifecycle, message, Gmail)
│   ├── i18n/                # Internationalization
│   ├── imessage/            # iMessage core channel implementation
│   ├── infra/               # Infrastructure utilities (ports, env, exec, update)
│   ├── line/                # LINE core channel implementation
│   ├── link-understanding/  # URL/link content extraction
│   ├── logging/             # Structured logging system
│   ├── markdown/            # Markdown processing utilities
│   ├── media/               # Media pipeline (audio, image, PDF)
│   ├── media-understanding/ # Media content analysis
│   ├── memory/              # Memory/embedding system
│   ├── node-host/           # Node execution host (mobile/remote tools)
│   ├── pairing/             # Device pairing protocol
│   ├── plugins/             # Plugin runtime, loading, registry
│   ├── plugin-sdk/          # Plugin SDK (stable API for extensions)
│   ├── process/             # Process management (exec, queue, lanes)
│   ├── providers/           # AI provider-specific code (Copilot, Gemini, etc.)
│   ├── routing/             # Message routing and account resolution
│   ├── scripts/             # Internal script utilities
│   ├── secrets/             # Secret management and resolution
│   ├── security/            # Security policies
│   ├── sessions/            # Session management utilities
│   ├── shared/              # Shared types and utilities
│   ├── signal/              # Signal core channel implementation
│   ├── slack/               # Slack core channel implementation
│   ├── telegram/            # Telegram core channel implementation
│   ├── terminal/            # Terminal UI (ANSI, tables, palette, prompts)
│   ├── test-helpers/        # Shared test utilities
│   ├── test-utils/          # Additional test utilities
│   ├── tts/                 # Text-to-speech
│   ├── tui/                 # Terminal UI mode
│   ├── types/               # Global type declarations (.d.ts)
│   ├── utils/               # General utilities
│   ├── web/                 # WhatsApp Web channel implementation
│   ├── whatsapp/            # WhatsApp utilities
│   └── wizard/              # Onboarding wizard
├── Swabble/                 # Swift CLI tool (voice/speech, separate Swift package)
├── test/                    # Top-level integration/e2e tests and fixtures
├── ui/                      # Web control UI (Vite app)
├── vendor/                  # Vendored dependencies
├── openclaw.mjs             # CLI binary wrapper (shebang entry)
├── tsdown.config.ts         # Build configuration (tsdown bundler)
├── vitest.config.ts         # Primary test configuration
├── vitest.*.config.ts       # Scoped test configs (channels, extensions, gateway, e2e, live)
├── tsconfig.json            # TypeScript configuration
├── package.json             # Root package manifest
└── pnpm-workspace.yaml      # pnpm workspace definition
```

## Directory Purposes

**`src/agents/`:**
- Purpose: Core AI agent system; the largest and most complex module
- Contains: Pi embedded runner (AI conversation loop), model catalog/config, tool definitions (bash, file, browser), sandbox/Docker execution, skills system, subagent spawning, system prompt construction, auth profile management, compaction
- Key files:
  - `pi-embedded-runner.ts` - Main AI agent run loop
  - `pi-embedded-subscribe.ts` - Stream response processing
  - `system-prompt.ts` - System prompt assembly
  - `pi-tools.ts` - Agent tool registration
  - `bash-tools.ts` - Shell execution tools
  - `models-config.ts` - Model provider configuration
  - `model-catalog.ts` - Model discovery
  - `sandbox.ts` - Docker sandbox management
  - `skills/` - Skills loading and management
  - `subagent-registry.ts` - Multi-agent orchestration

**`src/gateway/`:**
- Purpose: HTTP/WebSocket server that is the runtime backbone
- Contains: Server implementation, RPC method handlers, authentication, channel management, config reload, cron scheduling, OpenAI-compatible API, control UI serving
- Key files:
  - `server.impl.ts` - Gateway startup and assembly
  - `server-http.ts` - HTTP handler
  - `server-methods.ts` - Core RPC handlers
  - `server-channels.ts` - Channel lifecycle
  - `openai-http.ts` - OpenAI chat completions endpoint
  - `control-ui*.ts` - Web control panel

**`src/cli/`:**
- Purpose: CLI program definition and terminal interaction
- Contains: Commander.js program builder, CLI option handling, progress indicators, prompts, CLI routing
- Key files:
  - `program/build-program.ts` - Main program construction
  - `run-main.ts` - CLI bootstrap entry
  - `deps.ts` - Lazy dependency injection
  - `progress.ts` - Progress spinners/bars
  - `prompt.ts` - Interactive prompts

**`src/commands/`:**
- Purpose: All CLI command implementations
- Contains: Onboarding, configuration, doctor diagnostics, status, agent management, sessions, models, channels, health, dashboard, setup
- Key files:
  - `onboard*.ts` - Onboarding wizard commands
  - `configure*.ts` - Configuration commands
  - `doctor*.ts` - Diagnostic/repair commands
  - `status*.ts` - Status display commands
  - `agent*.ts` - Agent management commands

**`src/config/`:**
- Purpose: Configuration loading, validation, and persistence
- Contains: Zod schema definitions, config I/O, session store management, legacy migration, environment variable handling
- Key files:
  - `config.ts` - Core `loadConfig()`, `CONFIG_PATH`
  - `schema.ts` - Main Zod config schema
  - `types.ts` - TypeScript config types
  - `zod-schema.*.ts` - Scoped schema modules
  - `sessions.ts` - Session key/store management
  - `legacy-migrate.ts` - Config migration pipeline

**`src/infra/`:**
- Purpose: Foundational utilities used across all modules
- Contains: Port management, environment handling, exec approval system, file locking, update checker, heartbeat, device pairing, restart management, provider usage tracking, SSH/Tailscale integration
- Key files:
  - `env.ts` - Env var normalization
  - `ports.ts` - Port conflict detection
  - `exec-approvals.ts` - Agent command execution gating
  - `update-check.ts` - Version update detection
  - `restart.ts` - Gateway restart orchestration

**`src/channels/`:**
- Purpose: Channel abstraction and shared channel logic
- Contains: Channel registry, allowlists, typing indicators, draft streaming, command gating, thread bindings, message routing support
- Key files:
  - `registry.ts` - `CHAT_CHANNEL_ORDER`, channel metadata
  - `plugins/` - Plugin type definitions and registration

**`src/plugin-sdk/`:**
- Purpose: Stable API surface for extension authors
- Contains: Re-exports organized by domain (core, per-channel, utilities)
- Key files: `index.ts`, `core.ts`, `compat.ts`, per-channel files (`telegram.ts`, `discord.ts`, etc.)

**`extensions/`:**
- Purpose: Workspace packages implementing channel plugins and other capabilities
- Contains: 40+ extensions, each a separate npm package
- Full list: `acpx`, `bluebubbles`, `copilot-proxy`, `device-pair`, `diagnostics-otel`, `diffs`, `discord`, `feishu`, `googlechat`, `google-gemini-cli-auth`, `imessage`, `irc`, `line`, `llm-task`, `lobster`, `matrix`, `mattermost`, `memory-core`, `memory-lancedb`, `minimax-portal-auth`, `msteams`, `nextcloud-talk`, `nostr`, `open-prose`, `phone-control`, `qwen-portal-auth`, `shared`, `signal`, `slack`, `synology-chat`, `talk-voice`, `telegram`, `test-utils`, `thread-ownership`, `tlon`, `twitch`, `voice-call`, `whatsapp`, `zalo`, `zalouser`
- Pattern: Each has `package.json` with `openclaw.extensions` field pointing to entry file

**`apps/`:**
- Purpose: Native platform applications
- Contains: macOS (Swift/SwiftUI menubar app), iOS (Swift/SwiftUI), Android (Kotlin/Compose)
- Key locations:
  - `apps/macos/Sources/OpenClaw/` - macOS app source
  - `apps/ios/Sources/` - iOS app source (Chat, Voice, Gateway, Settings, etc.)
  - `apps/android/app/src/main/java/ai/openclaw/app/` - Android app source
  - `apps/shared/OpenClawKit/` - Shared Swift library

**`ui/`:**
- Purpose: Web-based control UI served by the gateway
- Contains: Vite-built web app with its own `package.json`

**`docs/`:**
- Purpose: Mintlify documentation site (docs.openclaw.ai)
- Contains: Markdown docs for channels, plugins, configuration, tools, platforms, etc.

**`Swabble/`:**
- Purpose: Standalone Swift CLI tool for voice/speech integration
- Contains: Swift package with SwabbleCore, SwabbleKit

## Key File Locations

**Entry Points:**
- `openclaw.mjs`: CLI binary wrapper (shebang, delegates to `dist/entry.js`)
- `src/entry.ts`: Process entry point (compiled to `dist/entry.js`)
- `src/index.ts`: Library entry point (compiled to `dist/index.js`)
- `src/cli/run-main.ts`: CLI bootstrap (`runCli()`)

**Configuration:**
- `package.json`: Root package manifest (dependencies, scripts, version)
- `pnpm-workspace.yaml`: Workspace package locations
- `tsconfig.json`: TypeScript config
- `tsdown.config.ts`: Build/bundle configuration
- `vitest.config.ts`: Primary test config
- `.oxlintrc.json`: Linting config
- `.oxfmtrc.jsonc`: Formatting config
- `.env.example`: Environment variable template

**Core Logic:**
- `src/agents/pi-embedded-runner.ts`: AI conversation loop
- `src/gateway/server.impl.ts`: Gateway server assembly
- `src/channels/registry.ts`: Channel definitions
- `src/config/config.ts`: Config loading
- `src/routing/resolve-route.ts`: Message routing

**Testing:**
- `vitest.config.ts`: Main test config
- `vitest.unit.config.ts`: Unit test scope
- `vitest.channels.config.ts`: Channel test scope
- `vitest.extensions.config.ts`: Extension test scope
- `vitest.gateway.config.ts`: Gateway test scope
- `vitest.e2e.config.ts`: E2E test scope
- `vitest.live.config.ts`: Live (real API) test scope
- `test/`: Top-level test helpers, fixtures, and integration tests

## Naming Conventions

**Files:**
- `kebab-case.ts`: All source files use kebab-case (e.g., `pi-embedded-runner.ts`, `server-methods.ts`)
- `*.test.ts`: Unit/integration tests colocated with source
- `*.e2e.test.ts`: End-to-end tests
- `*.live.test.ts`: Live tests (require real API keys)
- `*.runtime.ts`: Lazy-loaded runtime boundary modules (for dynamic import isolation)
- `types.*.ts`: Type definition files scoped by domain (e.g., `types.agents.ts`, `types.gateway.ts`)
- `zod-schema.*.ts`: Zod schema definition files scoped by domain

**Directories:**
- `kebab-case/`: All directories use kebab-case
- Channel directories at `src/` root: `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`, `src/line/`
- Extensions mirror channel names: `extensions/telegram/`, `extensions/discord/`, etc.

**Test Naming:**
- Complex test names use dot-separated descriptors: `server.auth.browser-hardening.test.ts`
- Descriptive scenario names: `pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`

## Where to Add New Code

**New CLI Command:**
- Implementation: `src/commands/<command-name>.ts`
- CLI wiring: Register in `src/cli/program/` (via `command-registry.ts` or `register.subclis.ts`)
- Tests: `src/commands/<command-name>.test.ts`

**New Channel Plugin:**
- Extension package: `extensions/<channel-name>/`
- Extension entry: `extensions/<channel-name>/src/channel.ts` implementing `ChannelPlugin`
- Package manifest: `extensions/<channel-name>/package.json` with `openclaw.extensions` field
- Plugin SDK surface: `src/plugin-sdk/<channel-name>.ts` (if SDK exports needed)
- Add to build: `tsdown.config.ts` `pluginSdkEntrypoints` array
- Docs: `docs/channels/<channel-name>.md`
- Labels: Update `.github/labeler.yml`

**New Agent Tool:**
- Tool definition: `src/agents/pi-tools.ts` or `src/agents/tools/`
- Tool implementation: `src/agents/bash-tools.ts` (exec), `src/agents/channel-tools.ts` (channel ops), etc.
- Tests: Colocated `*.test.ts`

**New Gateway RPC Method:**
- Handler: `src/gateway/server-methods/` or `src/gateway/server-methods.ts`
- Method registration: `src/gateway/server-methods-list.ts`
- Tests: Colocated `*.test.ts`

**New Config Option:**
- Schema: Add to appropriate `src/config/zod-schema.*.ts` file
- Types: Update corresponding `src/config/types.*.ts`
- Defaults: `src/config/defaults.ts`
- Tests: `src/config/config.*.test.ts`

**Shared Utilities:**
- Terminal/UI helpers: `src/terminal/`
- General utilities: `src/utils.ts` or `src/infra/`
- Shared types: `src/shared/`

**New Extension (non-channel):**
- Extension package: `extensions/<name>/`
- Follows same manifest pattern as channel plugins
- Add to `pnpm-workspace.yaml` (already covered by `extensions/*` glob)

## Special Directories

**`dist/`:**
- Purpose: Built/bundled output from `tsdown`
- Generated: Yes (by `pnpm build`)
- Committed: No (in `.gitignore`)

**`node_modules/`:**
- Purpose: Dependencies
- Generated: Yes (by `pnpm install`)
- Committed: No

**`patches/`:**
- Purpose: pnpm dependency patches
- Generated: No (manually authored)
- Committed: Yes

**`vendor/`:**
- Purpose: Vendored third-party code
- Generated: No
- Committed: Yes

**`skills/`:**
- Purpose: Bundled skill prompt files shipped with the package
- Generated: No (manually authored)
- Committed: Yes

**`.planning/`:**
- Purpose: Planning and analysis documents
- Generated: By tooling/agents
- Committed: Varies

**`src/canvas-host/a2ui/`:**
- Purpose: Bundled A2UI assets
- Generated: Yes (by `pnpm canvas:a2ui:bundle`)
- Committed: Yes (including `.bundle.hash`)

---

*Structure analysis: 2026-03-08*
