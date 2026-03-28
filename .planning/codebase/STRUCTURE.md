# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

```
/home/user/Roscoebot/
├── src/                          # Core TypeScript application
│   ├── entry.ts                  # Process bootstrap and CLI dispatch
│   ├── index.ts                  # Library exports and legacy CLI entry
│   ├── library.ts                # Public API barrel export
│   ├── auto-reply/               # Conversation and command handling
│   ├── agents/                   # Agent spawning, tool execution, streaming
│   ├── channels/                 # Core channel abstraction
│   ├── cli/                      # CLI command handlers
│   ├── config/                   # Configuration loading, schemas, validation
│   ├── infra/                    # Infrastructure utilities (IO, processes, net)
│   ├── plugin-sdk/               # Public SDK for extensions
│   ├── plugins/                  # Plugin runtime and loading
│   ├── routing/                  # Message routing and session management
│   ├── memory/                   # Knowledge base and embeddings
│   ├── browser/                  # Chrome/Playwright automation
│   └── [other modules]           # TTS, media, shell, hooks, etc.
│
├── extensions/                   # Plugin packages (channels, providers, tools)
│   ├── discord/                  # Discord channel plugin
│   ├── telegram/                 # Telegram channel plugin
│   ├── anthropic/                # Anthropic provider plugin
│   ├── [80+ more extensions]     # Additional channels, tools, integrations
│   └── package.json              # Workspace root for extensions
│
├── apps/                         # Native applications
│   ├── ios/                      # iOS app (Swift/UIKit)
│   ├── android/                  # Android app (Kotlin)
│   ├── macos/                    # macOS app (Swift/SwiftUI)
│   └── shared/                   # Shared mobile utilities
│
├── ui/                           # Web UI for browser automation
│   ├── src/
│   │   ├── ui/                   # React components
│   │   ├── i18n/                 # Internationalization
│   │   └── main.ts               # Entry point
│   ├── vite.config.ts            # Build configuration
│   └── package.json
│
├── dist/                         # Compiled output (generated)
│
├── test/                         # Shared test fixtures and helpers
│   ├── fixtures/                 # Test data files
│   └── helpers/                  # Common test utilities
│
├── test-fixtures/                # Additional test data
│
├── docs/                         # Documentation (Mintlify)
│   ├── channels/                 # Channel documentation
│   ├── cli/                      # CLI command docs
│   ├── concepts/                 # Architecture concepts
│   ├── install/                  # Installation guides
│   └── [other guides]
│
├── scripts/                      # Build and utility scripts
│
├── .planning/                    # GSD analysis output
│
└── Configuration files:
    ├── package.json              # Root npm workspace
    ├── tsconfig.json             # TypeScript configuration
    ├── vitest.config.ts          # Test runner configuration
    ├── oxlint.json               # Linting rules
    └── [other configs]
```

## Directory Purposes

**`src/`:**

- Purpose: Core application logic and TypeScript source
- Contains: Entry points, CLI commands, business logic, channel abstractions
- Key files: `entry.ts`, `index.ts`, `library.ts`

**`src/auto-reply/`:**

- Purpose: Conversation handling, command dispatch, and reply generation
- Contains: Command registry, command execution, agent invocation, templating
- Key files: `src/auto-reply/commands-registry.ts`, `src/auto-reply/reply/agent-runner-execution.ts`, `src/auto-reply/chunk.ts`

**`src/agents/`:**

- Purpose: AI agent spawning, tool execution, and response streaming
- Contains: ACP (Anthropic Control Plane) spawning, tool call handling, streaming projection
- Key files: `src/agents/acp-spawn.ts`, `src/agents/agent-command.ts`, `src/agents/apply-patch.ts`

**`src/channels/`:**

- Purpose: Core channel abstraction and shared channel logic
- Contains: Channel config, inbound normalization, account management, allowlists, plugins
- Key files: `src/channels/channel-config.ts`, `src/channels/plugins/contracts/`

**`src/cli/`:**

- Purpose: CLI command implementations and argument parsing
- Contains: Command routing, argument validators, output formatters, sub-commands
- Key files: `src/cli/run-main.ts`, `src/cli/route.ts`, `src/cli/argv.ts`

**`src/config/`:**

- Purpose: Configuration schema, I/O, validation, and state management
- Contains: YAML/JSON parsing, Zod schemas, environment substitution, legacy migrations, session storage
- Key files: `src/config/io.ts`, `src/config/schema.ts`, `src/config/validation.ts`, `src/config/zod-schema.ts`

**`src/infra/`:**

- Purpose: Cross-cutting infrastructure utilities
- Contains: File I/O, process management, network utilities, TLS, error handling, logging setup
- Key files: `src/infra/archive.ts`, `src/infra/bonjour.ts`, `src/infra/backup-create.ts`

**`src/plugin-sdk/`:**

- Purpose: Public API contracts for extension development
- Contains: Channel setup/runtime contracts, provider setup, config helpers, allowlist management
- Key files: Barrel exports like `channel-setup.ts`, `runtime.ts`, `core.ts`

**`src/plugins/`:**

- Purpose: Plugin loading and runtime initialization
- Contains: Plugin resolution, extension loading, channel instantiation
- Key files: `src/plugins/runtime/` subdirectory

**`src/routing/`:**

- Purpose: Message routing and session management
- Contains: Route resolution logic, session key derivation, account lookup, allowlist matching
- Key files: `src/routing/resolve-route.ts`, `src/routing/session-key.ts`

**`src/memory/`:**

- Purpose: Knowledge base, embeddings, and vector search
- Contains: Backend config (OpenAI, Gemini, local), batch embedding, search managers
- Key files: `src/memory/backend-config.ts`, `src/memory/batch-*.ts`

**`src/browser/`:**

- Purpose: Web automation via Chrome/Playwright
- Contains: Chrome launch, Playwright session management, CDP proxy, client actions
- Key files: `src/browser/pw-session.ts`, `src/browser/server.ts`, `src/browser/chrome.ts`

**`extensions/*/`:**

- Purpose: Extension packages (channels, providers, tools, hooks)
- Contains: Channel implementation (`src/channel.ts`), setup config, tests
- Pattern: Each extension has `package.json`, `src/api.ts` (optional public barrel), `openclaw.plugin.json`

**`ui/`:**

- Purpose: Web UI for browser automation control
- Contains: React components, styling, internationalization
- Key files: `ui/src/ui/` (components), `ui/vite.config.ts`

**`apps/*/`:**

- Purpose: Native mobile/desktop applications
- Contains: iOS (Swift/UIKit), Android (Kotlin), macOS (SwiftUI)

**`docs/`:**

- Purpose: User documentation (Mintlify)
- Contains: Channel guides, CLI docs, concepts, installation
- Note: Read-only for updates; use Mintlify web editor or follow i18n pipeline

**`test/`, `test-fixtures/`:**

- Purpose: Shared test utilities and fixture data
- Contains: Mock helpers, test data, common setup

## Key File Locations

**Entry Points:**

- `src/entry.ts`: Process bootstrap (respawn logic, env setup)
- `src/index.ts`: CLI routing and legacy library exports
- `src/cli/run-main.ts`: Main CLI dispatch and error handling
- `src/library.ts`: Public API for library consumers

**Configuration:**

- `src/config/io.ts`: Config file loading and writing (main entry)
- `src/config/schema.ts`: Config schema definition
- `src/config/zod-schema.ts`: Zod validation schemas (generated/maintained)
- `src/config/validation.ts`: Validation logic and error formatting
- `src/config/defaults.ts`: Default values for all config sections

**Core Logic:**

- `src/auto-reply/commands-registry.ts`: Command registration and dispatch
- `src/auto-reply/reply/agent-runner-execution.ts`: Agent spawning and execution
- `src/agents/acp-spawn.ts`: ACP process spawning and lifecycle
- `src/routing/resolve-route.ts`: Message routing to account/agent
- `src/channels/channel-config.ts`: Channel configuration loading

**Testing:**

- `src/**/*.test.ts`: Unit tests (co-located with source)
- `src/**/*.e2e.test.ts`: End-to-end tests
- `test/fixtures/`: Shared fixture data (configs, mocks)

## Naming Conventions

**Files:**

- `[feature].ts`: Main implementation
- `[feature].test.ts`: Vitest unit tests
- `[feature].e2e.test.ts`: End-to-end tests
- `[feature].setup.ts`: Plugin setup-time code
- `[feature].runtime.ts`: Plugin runtime code
- `[feature]-cli.ts`: CLI command implementation
- `api.ts`: Public barrel export for a module

**Directories:**

- Lowercase, hyphenated (e.g., `auto-reply`, `plugin-sdk`)
- `src/[feature]/test-helpers/`: Test utilities for a subsystem
- `extensions/[id]/`: Plugin package (one per extension)

**Types & Interfaces:**

- PascalCase: `Channel`, `ChannelInbound`, `ChannelConfig`
- Interfaces for contracts: `ChannelSetup`, `ChannelRuntime`
- Types for schemas: `Config`, `GatewayConfig`

**Functions & Variables:**

- camelCase: `loadConfig`, `resolveRoute`, `spawnAgent`
- Constants: `UPPERCASE_WITH_UNDERSCORES`

## Where to Add New Code

**New Feature (e.g., new CLI command):**

- Primary code: `src/cli/[feature]-cli.ts`
- Types: `src/config/types.gateway.ts` or similar (if config needed)
- Config schema: `src/config/zod-schema.*.ts`
- Tests: `src/cli/[feature]-cli.test.ts`

**New Channel/Extension:**

- Create: `extensions/[channel-id]/`
- Copy structure from `extensions/discord/` or similar
- Main file: `extensions/[channel-id]/src/channel.ts`
- Setup file: `extensions/[channel-id]/src/channel.setup.ts`
- Runtime file: `extensions/[channel-id]/src/channel.runtime.ts`
- Config: `extensions/[channel-id]/openclaw.plugin.json`

**New Provider (e.g., LLM, TTS, embedding):**

- Create plugin package: `extensions/[provider-id]/`
- Setup module exports provider contracts
- Located alongside existing provider plugins (e.g., `extensions/anthropic/`)

**New Tool/Hook:**

- Add to plugin or core
- Plugin tools: `extensions/[plugin]/src/` with setup export
- Core tools: `src/agents/tools/` (less common)
- Hooks: `src/hooks/bundled/` for built-in hooks

**Utilities & Helpers:**

- Shared algorithms: `src/shared/` (e.g., `src/shared/text/`)
- App-specific helpers: `src/utils/` (e.g., `src/utils/mask-api-key.ts`)
- Infrastructure: `src/infra/` (e.g., `src/infra/archive.ts`)

## Special Directories

**`src/acp/`, `src/agents/auth-profiles/`, `src/agents/pi-*`:**

- Purpose: Agent Control Plane integration and Pi (embedded) support
- Status: Core agent runtime infrastructure
- Committed: Yes

**`src/plugin-sdk-internal/`:**

- Purpose: Internal SDK contracts (not public)
- Status: Do not import from extensions; use `openclaw/plugin-sdk/*` instead
- Committed: Yes

**`dist/`:**

- Purpose: Compiled JavaScript output
- Status: Generated by `pnpm build`
- Committed: No (in .gitignore)

**`node_modules/`:**

- Purpose: Installed dependencies
- Status: Generated by `pnpm install`
- Committed: No

**`.planning/`:**

- Purpose: GSD (Codex) analysis documents
- Status: Auto-generated by `/gsd:map-codebase`
- Committed: No (ignored)

**`.agents/`, `.pi/`, `.superpowers/`:**

- Purpose: Agent and skill configurations
- Status: Local development configuration
- Committed: Partially (checked into repo with some paths)

## Import Boundaries

**Extension Production Code:**

- **Allowed**: `openclaw/plugin-sdk/*`, local `api.ts` / `runtime-api.ts`
- **Forbidden**: `src/**`, `src/plugin-sdk-internal/**`, sibling `extensions/*/src/**`

**Core Code:**

- **Allowed**: All `src/**` paths
- **Caution**: Do not mix static and dynamic imports of same module (use `.runtime.ts` boundary for lazy loading)

**Test Files:**

- **Allowed**: Import any file for test fixtures; co-locate with source

## Monorepo Structure

**Workspace:** `pnpm` monorepo with shared dependencies in root `package.json`

**Workspace Packages:**

- Root package: `openclaw` (CLI and core)
- Extension packages: `@openclaw/[id]` or approved suffixes (`-provider`, `-plugin`, `-speech`, `-sandbox`, `-media-understanding`)
- Each extension has its own `package.json`
- Lock file: `pnpm-lock.yaml` (kept in sync; supports Bun patching)

---

_Structure analysis: 2026-03-26_
