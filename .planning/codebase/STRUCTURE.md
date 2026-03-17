# Codebase Structure

**Analysis Date:** 2026-03-17

## Directory Layout

```
openclaw/
├── src/                         # Core TypeScript source
│   ├── entry.ts                 # CLI entry point
│   ├── index.ts                 # Library exports
│   ├── library.ts               # Re-export public APIs
│   ├── runtime.ts               # Runtime environment setup
│   ├── logger.ts                # Logging utilities
│   ├── globals.ts               # Global state
│   ├── agents/                  # Agent orchestration & AI execution
│   ├── acp/                     # Agent Control Protocol (ACP) server/client
│   ├── auto-reply/              # Message templating & reply generation
│   ├── browser/                 # Browser CLI implementation
│   ├── canvas-host/             # A2UI bundle hosting
│   ├── channels/                # Channel transport abstraction
│   ├── cli/                     # CLI command structure & options
│   ├── commands/                # Top-level command implementations
│   ├── config/                  # Configuration loading & validation
│   ├── context-engine/          # Context/memory handling
│   ├── cron/                    # Scheduled task execution
│   ├── daemon/                  # Background process management
│   ├── gateway/                 # WebSocket gateway server
│   ├── hooks/                   # Extensible hook system
│   ├── i18n/                    # Internationalization strings
│   ├── image-generation/        # Image generation provider adapters
│   ├── infra/                   # Infrastructure utilities (net, TLS, env, errors)
│   ├── interactive/             # Interactive prompt handling
│   ├── link-understanding/      # Link metadata extraction
│   ├── logging/                 # Logging subsystem
│   ├── markdown/                # Markdown parsing/formatting
│   ├── media/                   # Media handling (upload, transcoding)
│   ├── media-understanding/     # Image/video analysis providers
│   ├── memory/                  # Conversation memory & context
│   ├── node-host/               # Node.js child process hosting
│   ├── pairing/                 # Device pairing logic
│   ├── plugin-sdk/              # Plugin SDK types & utilities
│   ├── plugins/                 # Plugin registry & loading
│   ├── process/                 # Child process management
│   ├── providers/               # Provider-specific adapters
│   ├── routing/                 # Route resolution (channel → agent)
│   ├── secrets/                 # Credential management
│   ├── security/                # Security checks
│   ├── sessions/                # Session state & overrides
│   ├── shared/                  # Shared utilities (text, net)
│   ├── terminal/                # Terminal UI (colors, prompts, tables)
│   ├── test-helpers/            # Testing utilities
│   ├── test-utils/              # Additional test tools
│   ├── tts/                     # Text-to-speech providers
│   ├── tui/                     # Terminal UI components
│   ├── types/                   # Global type definitions
│   ├── utils/                   # General utilities
│   ├── web-search/              # Web search integration
│   ├── whatsapp/                # WhatsApp Web integration
│   └── wizard/                  # Setup/onboarding wizards
├── extensions/                  # Plugin packages (channels, providers, integrations)
│   ├── anthropic/               # Anthropic (Claude) provider
│   ├── discord/                 # Discord channel
│   ├── google/                  # Google services (Gemini, search)
│   ├── openai/                  # OpenAI provider
│   ├── telegram/                # Telegram channel
│   ├── slack/                   # Slack channel
│   ├── signal/                  # Signal channel
│   ├── imessage/                # iMessage channel
│   └── [70+ more]               # Other channels & providers
├── ui/                          # React/Vue web UI
│   ├── src/
│   │   ├── main.ts              # UI entry point
│   │   ├── local-storage.ts     # Browser storage management
│   │   └── ui/                  # UI components
│   └── vite.config.ts           # Vite build config
├── apps/                        # Native mobile apps
│   ├── ios/                     # iOS Swift/SwiftUI app
│   ├── android/                 # Android Kotlin app
│   ├── macos/                   # macOS Swift/SwiftUI app
│   └── shared/                  # Cross-platform shared code
├── dist/                        # Built JavaScript output
├── docs/                        # Public documentation (Mintlify)
├── test/                        # Integration & e2e tests
│   ├── e2e/                     # End-to-end test suites
│   └── fixtures/                # Test data
├── test-fixtures/               # Shared test data
├── scripts/                     # Build & utility scripts
├── skills/                      # Agent skills definitions
├── .github/                     # GitHub workflows & config
├── package.json                 # Root workspace package
├── pnpm-workspace.yaml          # pnpm monorepo config
├── tsconfig.json                # TypeScript config
├── vitest.config.ts             # Test runner config
└── openclaw.mjs                 # CLI entrypoint wrapper
```

## Directory Purposes

**src/**

- Purpose: All core application TypeScript source code
- Contains: Entry points, business logic, infrastructure
- Key files: `entry.ts` (CLI), `index.ts` (library exports), `runtime.ts` (env setup)

**src/agents/**

- Purpose: Agent orchestration, model selection, auth profiles, spawned agents
- Contains: Agent command handler (`agent-command.ts`), model catalog, auth store, PI agent integration
- Key files: `agent-command.ts` (main handler), `model-selection.ts` (model picking), `auth-profiles.ts` (credential mgmt)

**src/acp/**

- Purpose: Agent Control Protocol server and client for inter-agent communication
- Contains: WebSocket server, spawning policy, session management
- Key files: `server.ts` (ACP server), `client.ts` (ACP client), `spawn.ts` (spawn logic)

**src/channels/**

- Purpose: Shared channel logic, message parsing, routing attributes
- Contains: Channel config, allowlist rules, account snapshots, command gating
- Key files: `allowlist-match.ts` (allowlist matching), `command-gating.ts` (command restrictions)

**src/cli/**

- Purpose: Command-line interface wiring and option definitions
- Contains: Argument parsing, command registration, CLI deps injection
- Key files: `argv.ts` (arg parsing), `run-main.ts` (CLI dispatcher)

**src/commands/**

- Purpose: Top-level command implementations (agent, gateway, channels, models, setup, onboard)
- Contains: Each command as a subdirectory
- Structure: One directory per command (e.g., `src/commands/agent/`, `src/commands/setup/`)

**src/config/**

- Purpose: Configuration loading, caching, validation, persistence
- Contains: Config types, I/O, JSON5 parser, schema validation
- Key files: `config.ts` (re-exports), `io.ts` (load/save), `types.ts` (TypeScript interfaces), `validation.ts` (schema checks)
- Subdir `sessions/`: Session store file management

**src/gateway/**

- Purpose: WebSocket server, multi-channel aggregation, real-time routing
- Contains: Server initialization, WebSocket connection handling, channel integration
- Key files: `server/ws-connection.ts` (WebSocket handler), `server-channels.ts` (channel dispatch)

**src/logging/**

- Purpose: Structured logging with subsystem prefixes
- Contains: Subsystem logger factory, test helpers
- Key files: `subsystem.ts` (logger creation)

**src/providers/**

- Purpose: Provider-specific utilities and adapters
- Contains: OAuth helpers, model listing utilities
- Key files: Model and auth helpers for specific providers

**src/routing/**

- Purpose: Determine which agent should handle an inbound message
- Contains: Route resolution engine, session key generation, binding logic
- Key files: `resolve-route.ts` (main routing), `session-key.ts` (session ID generation), `bindings.ts` (binding rules)

**src/sessions/**

- Purpose: Session state management, transcripts, overrides
- Contains: Session entry types, model/auth/verbose overrides, transcript events
- Key files: Not in this dir directly; see `src/config/sessions/` for file storage

**src/terminal/**

- Purpose: Terminal UI components (colors, tables, prompts)
- Contains: Color palette, table formatting, interactive prompts
- Key files: `palette.ts` (color theme), `table.ts` (table formatting)

**extensions/**

- Purpose: Plugin packages (channels, LLM providers, integrations)
- Contains: One directory per extension
- Structure: Each extension is an npm package with `src/channel.ts` (channels) or provider-specific exports
- Examples: `extensions/discord/` (Discord channel), `extensions/anthropic/` (Claude provider)

**ui/**

- Purpose: React/Vue web browser UI
- Contains: React components, styles, i18n
- Key files: `src/main.ts` (entry), `src/ui/` (components)

**apps/**

- Purpose: Native mobile and desktop applications
- Contains: iOS (Swift/SwiftUI), Android (Kotlin), macOS (Swift/SwiftUI), shared logic
- Structure: Separate Xcode + Android Studio projects

**dist/**

- Purpose: Built JavaScript output (generated)
- Contains: Compiled TypeScript, bundled plugins
- Generated: By `pnpm build`

**test/**

- Purpose: Integration and end-to-end tests
- Contains: Test suites organized by feature area
- Key files: Files matching `*.test.ts`, `*.e2e.test.ts`

**scripts/**

- Purpose: Build scripts, deployment utilities, development tools
- Contains: Bash scripts for setup, bundling, releases

**skills/**

- Purpose: Agent skills definitions and implementations
- Contains: JSON definitions of available agent capabilities

## Key File Locations

**Entry Points:**

- `openclaw.mjs`: CLI entrypoint wrapper (Node version check, module cache, dist loader)
- `src/entry.ts`: Main CLI entry point (runs CLI or daemon)
- `src/index.ts`: Library exports (public API for `const openclaw = require('openclaw')`)

**Configuration:**

- `src/config/config.ts`: Re-export barrel for config module
- `src/config/io.ts`: Config file loading/saving
- `src/config/types.ts`: Config TypeScript interfaces
- `src/config/validation.ts`: Config schema validation

**Core Logic:**

- `src/agents/agent-command.ts`: Main agent execution handler
- `src/agents/model-selection.ts`: Model selection logic
- `src/agents/auth-profiles.ts`: Auth credential management
- `src/routing/resolve-route.ts`: Route resolution engine
- `src/gateway/server/ws-connection.ts`: WebSocket message handler
- `src/channels/allowlist-match.ts`: Allowlist validation

**Testing:**

- `vitest.config.ts`: Main test config
- `vitest.unit.config.ts`: Unit test runner
- `vitest.e2e.config.ts`: E2E test runner
- `src/**/*.test.ts`: Unit tests (colocated with source)
- `test/*.e2e.test.ts`: Integration/e2e tests

## Naming Conventions

**Files:**

- Kebab-case: `model-selection.ts`, `auth-profiles.ts`, `agent-command.ts`
- Suffixes: `.test.ts` (unit), `.e2e.test.ts` (integration), `.types.ts` (types-only)
- Index files: `index.ts` in directories for re-exports (barrel pattern)

**Directories:**

- Kebab-case: `src/agents/`, `src/auth-profiles/`, `src/image-generation/`
- Feature directories: Named by domain (channels, agents, config, routing, etc.)
- Subdirs in large dirs: Organized by concern (e.g., `src/agents/auth-profiles/`, `src/gateway/server/`)

**Functions/Types:**

- camelCase: `resolveRoute()`, `loadConfig()`, `normalizeAgentId()`
- Types: PascalCase: `ResolvedAgentRoute`, `RoutePeer`, `SessionEntry`
- Constants: UPPER_SNAKE_CASE: `DEFAULT_AGENT_ID`, `MIN_NODE_VERSION`

## Where to Add New Code

**New Feature (e.g., new LLM provider):**

- Primary code: `extensions/<provider-name>/src/` (new extension package)
- Tests: `extensions/<provider-name>/src/**/*.test.ts` (colocated)
- Config types: `src/config/types.ts` (add to config schema)
- Exports: `package.json` under `.exports` (if it's part of plugin-sdk)

**New Channel Integration:**

- Primary code: `extensions/<channel-name>/src/channel.ts` (transport implementation)
- Config: `src/channels/` (allowlist, command gating rules if shared)
- Tests: `extensions/<channel-name>/src/**/*.test.ts`

**New Command (e.g., `openclaw foo`):**

- Implementation: `src/commands/foo/index.ts`
- CLI registration: Edit `src/cli/` to register command with commander
- Tests: `src/commands/foo/*.test.ts`

**New Utility/Helper:**

- Shared helpers: `src/utils/` (general-purpose utilities)
- Subsystem helpers: `src/<subsystem>/test-helpers/` (domain-specific test utilities)
- Shared text utils: `src/shared/text/`
- Shared net utils: `src/shared/net/`

**New Permission/Allowlist Rule:**

- Implementation: `src/channels/allowlist-match.ts` or `src/channels/command-gating.ts`
- Tests: Colocated `.test.ts`

## Special Directories

**node_modules/**

- Purpose: Installed npm dependencies
- Generated: By `pnpm install`
- Committed: No (git-ignored)

**dist/**

- Purpose: Built JavaScript output
- Generated: By `pnpm build`
- Committed: No (git-ignored)

**~/.openclaw/** (runtime, not in repo)

- Purpose: User config and runtime state
- Structure:
  - `config.json5`: Main config file
  - `sessions/`: Agent conversation state (one JSON file per session)
  - `auth-profiles/`: LLM/channel provider credentials
  - `agents/`: Agent-specific directories
  - `plugins/`: User-installed plugin packages
  - `credentials/`: Channel login tokens (web provider)

**skills/** (committed)

- Purpose: Agent skills definitions
- Contents: JSON definitions of available agent capabilities
- Used by: Agents during skill discovery

**extensions/** (committed)

- Purpose: Bundled plugins (channels, providers)
- Structure: npm workspace packages
- Used: Loaded at runtime via plugin registry

**test-fixtures/** (committed)

- Purpose: Shared test data (images, documents, JSON samples)
- Used: Referenced in test files

**.planning/codebase/** (planning only)

- Purpose: GSD mapping documents
- Contents: ARCHITECTURE.md, STRUCTURE.md, STACK.md, TESTING.md, CONVENTIONS.md, CONCERNS.md
- Generated: By gsd-map-codebase command

---

_Structure analysis: 2026-03-17_
