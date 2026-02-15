# Codebase Structure

**Analysis Date:** 2026-02-15

## Directory Layout

```
openclaw/
├── src/                        # Main TypeScript source
│   ├── index.ts               # CLI public API + entry point
│   ├── entry.ts               # Respawned process bootstrap
│   ├── runtime.ts             # Runtime environment abstraction
│   ├── logger.ts              # Logger setup
│   ├── logging.ts             # Console capture to structured logs
│   ├── version.ts             # Version info
│   ├── globals.ts             # Global state hooks
│   ├── extensionAPI.ts        # Plugin SDK exports
│   ├── channel-web.ts         # WebChat channel implementation
│   ├── utils.ts               # Shared utilities (phone normalization, etc.)
│   ├── polls.ts               # Poll/voting utilities
│   │
│   ├── cli/                   # Command-line interface
│   │   ├── program.ts         # Exports buildProgram()
│   │   ├── program/           # Program builder + commands registration
│   │   ├── run-main.ts        # Main CLI entry after bootstrap
│   │   ├── profile.ts         # CLI profile parsing (dev/qa/live)
│   │   ├── respawn-policy.ts  # Respawn guard logic
│   │   ├── windows-argv.ts    # Windows argument normalization
│   │   ├── prompt.ts          # Interactive prompts (yes/no)
│   │   ├── wait.ts            # Wait forever utilities
│   │   ├── ports.ts           # Port availability checking
│   │   └── deps.ts            # Default dependencies injection
│   │
│   ├── commands/              # Domain command implementations (~60+ commands)
│   │   ├── agent.ts           # Run single agent query
│   │   ├── agents.ts          # List/manage agents
│   │   ├── gateway.ts         # Start gateway daemon
│   │   ├── dashboard.ts       # Web dashboard
│   │   ├── onboard.ts         # Setup wizard
│   │   ├── configure.ts       # Config management
│   │   ├── doctor.ts          # Health checks + repairs
│   │   ├── health.ts          # System health report
│   │   ├── status.ts          # Gateway/daemon/channel status
│   │   ├── models.ts          # Model selection + auth
│   │   ├── channels.ts        # Channel configuration
│   │   ├── auth-choice*.ts    # Per-provider auth flows
│   │   ├── sandbox.ts         # Sandbox utilities
│   │   └── [other command implementations]
│   │
│   ├── config/                # Configuration system
│   │   ├── config.ts          # Exports config functions
│   │   ├── io.ts              # Read/write config files
│   │   ├── types.ts           # Config type definitions
│   │   ├── zod-schema.ts      # Zod validation schema
│   │   ├── validation.ts      # Config validation functions
│   │   ├── paths.ts           # Config file path resolution
│   │   ├── sessions.ts        # Session key + store management
│   │   ├── runtime-overrides.ts # Runtime config mutations
│   │   ├── legacy-migrate.ts  # Upgrade old config versions
│   │   └── agent-dirs.ts      # Agent workspace directories
│   │
│   ├── gateway/               # Gateway server + protocols
│   │   ├── server-http.ts     # HTTP server startup
│   │   ├── server-browser.ts  # Browser/canvas hosting
│   │   ├── server-model-catalog.ts # Model API endpoint
│   │   ├── assistant-identity.ts   # Bot identity management
│   │   ├── auth.ts            # Authentication handlers
│   │   ├── auth-rate-limit.ts # Rate limiting per auth
│   │   ├── live-image-probe.ts # Image availability checks
│   │   ├── protocol/          # Protocol definitions
│   │   │   ├── schema.ts      # Protocol message schemas
│   │   │   ├── client-info.ts # Client metadata
│   │   │   └── index.ts       # Exports
│   │   └── [e2e tests for gateway functionality]
│   │
│   ├── channels/              # Multi-protocol adapters
│   │   ├── registry.ts        # Channel registry + metadata
│   │   ├── channel-config.ts  # Per-channel configuration
│   │   ├── typing.ts          # Typing indicators
│   │   ├── ack-reactions.ts   # Message acknowledgment
│   │   ├── session.ts         # Session-channel mapping
│   │   ├── sender-identity.ts # Sender metadata parsing
│   │   ├── plugins/           # Plugin system for channels
│   │   ├── allowlists/        # Allowlist rules per channel
│   │   ├── telegram/          # Telegram Bot API adapter
│   │   ├── discord/           # Discord.js adapter
│   │   ├── slack/             # Slack Bolt adapter
│   │   ├── signal/            # Signal protocol adapter
│   │   ├── imessage/          # iMessage via daemon
│   │   ├── web/               # WebChat + HTTP webhooks
│   │   └── [other channel adapters]
│   │
│   ├── agents/                # AI agent execution engine
│   │   ├── pi-embedded-runner/      # Main agent loop + Pi framework integration
│   │   ├── pi-embedded-subscribe/   # Streaming response handlers
│   │   ├── pi-embedded-helpers/     # Error classification, formatting, sanitization
│   │   ├── pi-tools.ts              # Tool definitions for agents
│   │   ├── pi-tools.policy.ts       # Tool allowlist/blocklist
│   │   ├── tool-policy.ts           # Policy validation + enforcement
│   │   ├── bash-tools.ts            # Bash/shell tool execution
│   │   ├── bash-process.ts          # PTY process management
│   │   ├── cli-runner/              # CLI tool execution (Python, Node, etc.)
│   │   ├── auth-profiles/           # API key/OAuth management + rotation
│   │   ├── skills/                  # Custom agent skills
│   │   ├── sandbox/                 # Sandbox container management
│   │   ├── schema/                  # Tool schema definitions
│   │   ├── tools/                   # Tool implementations
│   │   ├── test-helpers/            # Test utilities for agent tests
│   │   ├── pi-extensions/           # Extensions via plugins
│   │   ├── identity.ts              # Agent identity config
│   │   ├── model-catalog.ts         # Available models + providers
│   │   ├── model-selection.ts       # Model picking logic
│   │   ├── system-prompt.ts         # System prompt building
│   │   ├── context.ts               # Agent context assembly
│   │   └── [many other agent utilities]
│   │
│   ├── sandbox/               # Tool sandbox execution
│   │   ├── sandbox.ts         # Docker/container orchestration
│   │   ├── sandbox-create-args.ts # Container creation args
│   │   ├── sandbox-paths.ts   # Path isolation + mounting
│   │   └── [sandbox utilities]
│   │
│   ├── sessions/              # Conversation history persistence
│   │   ├── [Session file I/O and repair utilities]
│   │
│   ├── memory/                # Vector-based memory search
│   │   ├── manager.ts         # Memory index lifecycle
│   │   ├── search-manager.ts  # Search query handler
│   │   └── types.ts           # Memory type definitions
│   │
│   ├── routing/               # Message routing
│   │   ├── [Routing logic between channels/agents]
│   │
│   ├── auto-reply/            # Auto-reply templates
│   │   ├── reply.ts           # Auto-reply engine
│   │   ├── templating.ts      # Template variable substitution
│   │
│   ├── providers/             # LLM provider implementations
│   │   ├── [Anthropic, OpenAI, Gemini, etc. adapters]
│   │
│   ├── infra/                 # Infrastructure utilities
│   │   ├── dotenv.ts          # .env file loading
│   │   ├── env.ts             # Environment normalization
│   │   ├── ports.ts           # Port availability + lsof
│   │   ├── binaries.ts        # Binary dependency checking
│   │   ├── errors.ts          # Error formatting
│   │   ├── is-main.ts         # Module entry detection
│   │   ├── path-env.ts        # PATH environment management
│   │   ├── runtime-guard.ts   # Node version checking
│   │   ├── unhandled-rejections.ts # Global rejection handlers
│   │   ├── warning-filter.ts  # Process warning suppression
│   │   ├── daemon-*.ts        # Daemon (launchd/systemd) management
│   │   └── [other infra utilities]
│   │
│   ├── process/               # Process management
│   │   ├── exec.ts            # Child process execution
│   │   ├── child-process-bridge.ts # IPC bridge
│   │   └── pty.ts             # PTY allocation
│   │
│   ├── terminal/              # Terminal UI utilities
│   │   ├── progress-line.ts   # Progress indicator
│   │   ├── restore.ts         # Terminal state restoration
│   │   ├── [TUI components]
│   │
│   ├── browser/               # Browser automation sandbox
│   │   ├── [Playwright automation for web tools]
│   │
│   ├── canvas-host/           # Canvas/drawing rendering
│   │   ├── [Canvas rendering for agent output]
│   │
│   ├── media/                 # Media processing
│   │   ├── [Image/video processing utilities]
│   │
│   ├── media-understanding/   # Vision model integration
│   │   ├── [Image analysis providers]
│   │
│   ├── link-understanding/    # URL + metadata extraction
│   │   ├── [URL parsing, content extraction]
│   │
│   ├── markdown/              # Markdown processing
│   │   ├── [Markdown parsing + conversion]
│   │
│   ├── shared/                # Shared utilities across layers
│   │   ├── chat-envelope.ts   # Message envelope format
│   │   ├── chat-content.ts    # Chat content type definitions
│   │   ├── frontmatter.ts     # YAML frontmatter parsing
│   │   ├── requirements.ts    # System requirement checking
│   │   ├── device-auth.ts     # Device pairing auth
│   │   └── [other shared types]
│   │
│   ├── types/                 # Central type definitions
│   │   ├── [Global type declarations]
│   │
│   ├── logging/               # Logging setup
│   │   ├── [Structured logging configuration]
│   │
│   ├── test-helpers/          # Test utilities (shared across test suites)
│   │   ├── [Test fixtures, mocks, harnesses]
│   │
│   ├── test-utils/            # Additional test utilities
│   │   ├── [Test data factories, helpers]
│   │
│   ├── plugin-sdk/            # Public plugin SDK
│   │   ├── index.ts           # Main plugin SDK exports
│   │   ├── account-id.ts      # Account ID utilities
│   │   └── [Plugin API definitions]
│   │
│   ├── plugins/               # Plugin runtime system
│   │   ├── runtime.ts         # Plugin loading + caching
│   │   ├── [Plugin utilities]
│   │
│   ├── macos/                 # macOS-specific (SwiftUI bridge)
│   ├── imessage/monitor/      # iMessage daemon monitor
│   ├── signal/monitor/        # Signal daemon monitor
│   ├── tui/                   # Terminal UI
│   ├── acp/                   # ACP protocol support
│   ├── hooks/                 # Config hook execution
│   ├── daemon/                # Daemon management
│   ├── cron/                  # Scheduled tasks
│   ├── compat/                # Legacy compatibility
│   ├── wizard/                # Onboarding wizard UI
│   ├── pairing/               # Device pairing flow
│   ├── security/              # Security utilities
│   ├── docs/                  # Documentation generation
│   └── scripts/               # Build + utility scripts
│
├── extensions/                # Plugin extensions (per-channel)
│   ├── telegram/              # Telegram plugins
│   ├── telegram-business/     # Telegram Business API
│   ├── nextcloud-talk/        # Nextcloud Talk integration
│   └── [other provider plugins]
│
├── vendor/                    # Vendored dependencies
│   └── a2ui/                  # UI framework
│
├── apps/                      # Platform-specific apps
│   ├── macos/                 # macOS native app (SwiftUI)
│   ├── ios/                   # iOS native app (SwiftUI)
│   ├── android/               # Android native app (Kotlin)
│   └── shared/                # Shared iOS/macOS code
│
├── ui/                        # Web dashboard UI
│   ├── [React/TypeScript web app]
│
├── docs/                      # Documentation (Mint framework)
│   └── [Markdown documentation]
│
├── skills/                    # Bundled agent skills
│   └── [Skill YAML definitions]
│
├── .agent/                    # Agent workflows (GSD format)
│   └── workflows/             # Workflow definitions
│
├── .agents/                   # Agent archives
│   ├── archive/               # Historical agents
│   └── skills/                # Skill snapshots
│
├── package.json               # NPM manifest + scripts
├── tsconfig.json              # TypeScript config
├── tsconfig.test.json         # Test-specific TS config
├── vitest.config.ts           # Unit test config
├── vitest.e2e.config.ts       # E2E test config
├── vitest.live.config.ts      # Live API test config
├── vitest.gateway.config.ts   # Gateway-specific tests
├── vitest.extensions.config.ts # Extension tests
├── Dockerfile                 # Docker build
├── docker-compose.yml         # Docker Compose for local dev
├── fly.toml                   # Fly.io deployment config
├── .env.example               # Example environment variables
├── CONTRIBUTING.md            # Contribution guide
├── CHANGELOG.md               # Release notes
└── README.md                  # Project README
```

## Directory Purposes

**src/**
- Purpose: All TypeScript source code
- Contains: CLI, commands, gateway, agents, channels, infrastructure, utilities
- Key files: `index.ts` (CLI entry), `entry.ts` (bootstrap)

**src/cli/**
- Purpose: Command-line interface parsing and execution
- Contains: Commander.js program builder, argument parsers, profiles
- Key files: `program.ts`, `run-main.ts`, `program/build-program.ts`

**src/commands/**
- Purpose: Individual command implementations
- Contains: ~60+ commands for agent, gateway, onboarding, configuration, health, etc.
- Key files: `agent.ts`, `gateway.ts`, `onboard.ts`, `doctor.ts`, `configure.ts`

**src/config/**
- Purpose: Configuration loading, validation, and management
- Contains: File I/O, Zod schema, validation, session key resolution
- Key files: `config.ts`, `io.ts`, `zod-schema.ts`, `validation.ts`

**src/gateway/**
- Purpose: HTTP/WebSocket server for multi-agent coordination
- Contains: Server startup, authentication, chat routing, model API
- Key files: `server-http.ts`, `protocol/schema.ts`, `auth.ts`

**src/channels/**
- Purpose: Multi-protocol messaging adapters
- Contains: Registry, per-channel handlers, typing indicators, allowlists
- Key files: `registry.ts`, `channel-config.ts`, subdirectories for each protocol

**src/agents/**
- Purpose: AI agent execution with Pi framework integration
- Contains: Agent runner, tool definitions, auth profiles, skills, sandbox
- Key files: `pi-embedded-runner/`, `pi-tools.ts`, `auth-profiles/`, `sandbox/`

**src/agents/pi-embedded-runner/**
- Purpose: Main agent execution loop
- Contains: Agent session initialization, model selection, message history handling
- Key files: `pi-embedded-runner.ts`, tests for auth rotation, context window

**src/agents/pi-embedded-subscribe/**
- Purpose: Stream handlers for agent responses
- Contains: Text/tool/error handlers, message emission, compaction logic
- Key files: `subscribe-embedded-pi-session.ts`, `handlers/`

**src/infra/**
- Purpose: Low-level system utilities
- Contains: Port management, dotenv, environment normalization, daemon management
- Key files: `ports.ts`, `dotenv.ts`, `env.ts`, `daemon-*.ts`

**src/shared/**
- Purpose: Shared types and utilities across layers
- Contains: Chat envelope format, chat content types, frontmatter parsing
- Key files: `chat-envelope.ts`, `chat-content.ts`

**src/plugin-sdk/**
- Purpose: Public API for plugin development
- Contains: Plugin interface definitions, account ID utilities
- Key files: `index.ts`, `account-id.ts`

**extensions/**
- Purpose: Channel provider plugins
- Contains: Per-provider plugin implementations (Telegram, Discord, Slack, etc.)
- Key files: `*/openclaw.plugin.json`, `*/index.ts`

**apps/**
- Purpose: Native platform applications
- Contains: macOS (SwiftUI), iOS (SwiftUI), Android (Kotlin), shared iOS/macOS code
- Key files: `macos/Sources/`, `ios/Sources/`, `android/app/`

**ui/**
- Purpose: Web dashboard frontend
- Contains: React/TypeScript web application
- Key files: `package.json`, `src/`, build configuration

**docs/**
- Purpose: User-facing documentation
- Contains: Markdown documentation (Mint framework)
- Key files: `*.md` files organized by topic

## Key File Locations

**Entry Points:**
- `src/entry.ts`: Respawned process bootstrap + CLI delegation
- `src/index.ts`: Main module exports + CLI entry point
- `openclaw.mjs`: Binary entry point (npm bin)

**Configuration:**
- `src/config/zod-schema.ts`: Full config validation schema
- `src/config/paths.ts`: Config file path resolution
- `tsconfig.json`: TypeScript compilation config
- `package.json`: Project metadata + scripts
- `.env.example`: Environment variable template

**Core Logic:**
- `src/gateway/server-http.ts`: Gateway HTTP server
- `src/agents/pi-embedded-runner/pi-embedded-runner.ts`: Agent execution
- `src/channels/registry.ts`: Channel registration + routing
- `src/config/config.ts`: Config loading facade
- `src/cli/program/build-program.ts`: CLI command registration

**Testing:**
- `vitest.config.ts`: Main unit test config
- `vitest.e2e.config.ts`: End-to-end test config
- `vitest.live.config.ts`: Live API test config
- `src/**/*.test.ts`: Co-located unit tests
- `src/**/*.e2e.test.ts`: Integration/E2E tests

**Protocol & Types:**
- `src/gateway/protocol/schema.ts`: Protocol message schemas
- `src/shared/chat-envelope.ts`: Message envelope format
- `src/shared/chat-content.ts`: Message content types
- `src/types/`: Central type definitions

## Naming Conventions

**Files:**
- `[feature].ts`: Main implementation
- `[feature].test.ts`: Unit tests (co-located)
- `[feature].e2e.test.ts`: E2E/integration tests
- `[feature].live.test.ts`: Live API tests (require real credentials)
- `index.ts`: Barrel export file for directory
- `types.ts`: Type definitions for a module
- `[feature]-helpers.ts`: Helper functions for a feature
- `[feature]-manager.ts`: Manager/coordinator class

**Directories:**
- `src/[domain]/`: Domain modules (agents, channels, gateway, etc.)
- `src/[domain]/[subdomain]/`: Sub-feature organization
- `extensions/[provider]/`: Plugin for specific provider
- `apps/[platform]/`: Platform-specific code (macos, ios, android)

**Functions & Classes:**
- `camelCase`: Functions and variables
- `PascalCase`: Classes and types
- `SCREAMING_SNAKE_CASE`: Constants

**Interfaces & Types:**
- `[Feature]Config`: Configuration types
- `[Feature]Manager`: Manager/coordinator classes
- `[Feature]Registry`: Registry pattern classes
- `[Feature]Handler`: Event/message handlers

## Where to Add New Code

**New Feature (Domain-Level):**
- Primary code: Create `src/[feature-name]/` directory with `index.ts` barrel export
- Core implementation: `src/[feature-name]/[core-logic].ts`
- Tests: `src/[feature-name]/[core-logic].test.ts` and `.e2e.test.ts`
- Add command if user-facing: `src/commands/[feature-name].ts`
- Export from `src/[feature-name]/index.ts`

**New Channel Adapter:**
- Implementation: `src/channels/[protocol]/` (e.g., `src/channels/matrix/`)
- Types: `src/channels/[protocol]/types.ts`
- Handler: `src/channels/[protocol]/handler.ts` or `index.ts`
- Update `src/channels/registry.ts` to register channel
- Create plugin: `extensions/[protocol]/` with `openclaw.plugin.json` and entry
- Tests: `src/channels/[protocol]/*.test.ts`

**New Agent Tool:**
- Tool definition: `src/agents/tools/[tool-name].ts`
- Register in: `src/agents/pi-tools.ts` in the tool factory function
- Schema: Add to `src/agents/schema/` if complex
- Tests: `src/agents/[tool-name].test.ts` and `.e2e.test.ts`
- Documentation: Add to tool-display.json for UI rendering

**New Command:**
- Implementation: `src/commands/[command-name].ts`
- Export: Add to `src/commands/` (implicitly discovered by program builder)
- Register: Builder in `src/cli/program/` scans `src/commands/`
- Tests: `src/commands/[command-name].e2e.test.ts`
- Helpers: `src/commands/[command-name]-helpers.ts` for shared logic

**New Provider (API integration):**
- Implementation: `src/providers/[provider-name].ts`
- Auth handling: `src/commands/auth-choice.apply.[provider].ts`
- Model discovery: `src/agents/models-config.providers.ts`
- Tests: `src/providers/[provider-name].test.ts`

**Utilities:**
- Shared helpers: `src/utils.ts` or new `src/utils/[category].ts`
- Infrastructure: `src/infra/[utility].ts`
- Test helpers: `src/test-helpers/[helper-name].ts`
- Shared types: `src/shared/[type-name].ts` or `src/types/`

## Special Directories

**src/test-helpers/**
- Purpose: Shared test utilities
- Generated: No
- Committed: Yes
- Usage: Imported by test files via `src/test-helpers/[helper].ts`

**src/scripts/**
- Purpose: Build and utility scripts
- Generated: No
- Committed: Yes
- Usage: Run via `pnpm` scripts defined in `package.json`

**dist/**
- Purpose: Compiled JavaScript output
- Generated: Yes (via `pnpm build`)
- Committed: No (gitignored)
- Usage: Published to npm

**node_modules/**
- Purpose: Installed dependencies
- Generated: Yes (via `pnpm install`)
- Committed: No (gitignored)
- Usage: Runtime dependencies

**.git/**
- Purpose: Git repository metadata
- Generated: Yes (via `git init`)
- Committed: No (system directory)

---

*Structure analysis: 2026-02-15*
