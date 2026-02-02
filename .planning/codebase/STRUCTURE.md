# Codebase Structure

**Analysis Date:** 2026-02-02

## Directory Layout

```
/home/gibson/openclaw/
├── src/                      # Main source code
│   ├── cli/                  # Command line interface
│   │   ├── program/         # Program building and command registry
│   │   └── deps.ts          # Dependency injection for CLI
│   ├── commands/            # Individual command implementations
│   ├── agents/              # AI agent management
│   │   ├── auth-profiles/   # Authentication profile management
│   │   ├── cli-runner.ts     # CLI tool execution runner
│   │   └── model-*.ts       # Model management and selection
│   ├── config/              # Configuration management
│   │   ├── sessions/        # Session configuration and storage
│   │   └── *.ts            # Config schemas, validation, I/O
│   ├── channels/            # Core channel implementations
│   │   ├── telegram/        # Telegram integration
│   │   ├── discord/        # Discord integration
│   │   ├── slack/          # Slack integration
│   │   ├── signal/         # Signal integration
│   │   ├── imessage/       # iMessage integration
│   │   └── whatsapp/       # WhatsApp integration
│   ├── routing/             # Message routing and agent assignment
│   ├── sessions/            # Session state and memory management
│   ├── gateway/            # Gateway runtime and connections
│   ├── infra/               # Infrastructure utilities
│   ├── auto-reply/         # Automated response handling
│   ├── hooks/              # Plugin hooks and extensibility
│   ├── plugins/            # Plugin system and registry
│   ├── media/              # Media processing and understanding
│   ├── agents/             # Agent implementations (shared)
│   ├── utils/              # Utility functions
│   └── types/              # TypeScript type definitions
├── extensions/             # Channel plugins (workspace packages)
│   ├── telegram/           # Telegram channel plugin
│   ├── discord/           # Discord channel plugin
│   ├── slack/             # Slack channel plugin
│   ├── signal/            # Signal channel plugin
│   ├── imessage/          # iMessage channel plugin
│   ├── whatsapp/          # WhatsApp channel plugin
│   ├── memory-*/          # Memory extension plugins
│   └── */                 # Other extension packages
├── apps/                  # Mobile apps
│   ├── ios/               # iOS app (Swift)
│   ├── android/           # Android app (Kotlin)
│   └── macos/             # macOS app (Swift)
├── vendor/                # Third-party integrations
│   └── a2ui/              # UI components
├── docs/                  # Documentation
├── scripts/               # Build and development scripts
├── tests/                 # Test files (collocated with source)
└── dist/                  # Built output
```

## Directory Purposes

**src/cli/**:
- Purpose: Command line interface layer
- Contains: Command registry, argument parsing, CLI dependencies
- Key files: `src/cli/program/command-registry.ts`, `src/cli/deps.ts`
- New feature: Add commands to `src/commands/` and register in command registry

**src/commands/**:
- Purpose: Business logic for each CLI command
- Contains: Individual command implementations
- Key files: `src/commands/agents.ts`, `src/commands/status.ts`
- New feature: Create command files following naming convention `[command-name].ts`

**src/agents/**:
- Purpose: AI agent management and execution
- Contains: Agent lifecycle, authentication, CLI tool execution
- Key files: `src/agents/cli-runner.ts`, `src/agents/auth-profiles.ts`
- New feature: Extend agent types in `src/agents/types.ts`

**src/config/**:
- Purpose: Configuration management and validation
- Contains: Schema validation, file I/O, session management
- Key files: `src/config/config.ts`, `src/config/types.ts`
- New feature: Add configuration schemas in `src/config/zod-schema.ts`

**src/channels/**:
- Purpose: Platform-specific message handling implementations
- Contains: Core channel implementations before plugin conversion
- Key files: `src/telegram/index.ts`, `src/slack/index.ts`
- New feature: New channels start here, then move to extensions

**src/routing/**:
- Purpose: Intelligent message routing and agent assignment
- Contains: Route resolution, binding management
- Key files: `src/routing/resolve-route.ts`, `src/routing/bindings.ts`
- New feature: Add new binding types in routing logic

**src/sessions/**:
- Purpose: Conversation state and memory management
- Contains: Session storage, compaction, memory management
- Key files: `src/sessions/session.ts`
- New feature: Extend session types in `src/sessions/types.ts`

**src/gateway/**:
- Purpose: Connection management and runtime orchestration
- Contains: Connection providers, runtime management, status
- Key files: `src/gateway/runtime.ts`
- New feature: Add new connection providers in `src/gateway/providers/`

**src/infra/**:
- Purpose: Common utilities and system integration
- Contains: Binary management, environment handling, ports
- Key files: `src/infra/env.ts`, `src/infra/binaries.ts`
- New feature: Add infrastructure utilities as needed

**extensions/**:
- Purpose: Channel plugins as workspace packages
- Contains: Platform-specific channel implementations
- Key files: `extensions/telegram/src/channel.ts`
- New feature: Add new channel packages following plugin SDK interface

**apps/**:
- Purpose: Mobile applications
- Contains: iOS, Android, macOS apps
- Key files: `apps/ios/Sources/OpenClaw/`, `apps/android/app/build.gradle.kts`
- New feature: Platform-specific features in respective app directories

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main CLI entry point
- `src/cli/program/build-program.ts`: CLI program building
- `openclaw.mjs`: CLI binary entry point

**Configuration:**
- `src/config/config.ts`: Configuration loading and validation
- `src/config/types.ts`: Configuration types
- `src/config/zod-schema.ts`: Configuration schema definitions

**Core Logic:**
- `src/routing/resolve-route.ts`: Message routing logic
- `src/agents/cli-runner.ts`: Agent execution
- `src/sessions/session.ts`: Session management

**Channel Implementations:**
- `src/telegram/index.ts`: Telegram core implementation
- `src/slack/index.ts`: Slack core implementation
- `extensions/telegram/src/channel.ts`: Telegram plugin interface

## Naming Conventions

**Files:**
- PascalCase for classes and types: `AgentRunner.ts`, `ConfigTypes.ts`
- camelCase for functions and variables: `resolveAgentRoute()`, `sessionKey`
- kebab-case for config files: `openclaw.config.json`
- snake_case for database tables/fields: `session_keys`

**Directories:**
- kebab-case for directory names: `auth-profiles`, `session-memory`
- plural for directories containing multiple items: `agents/`, `commands/`
- singular for single-item directories: `config/`, `routing/`

**Variables:**
- camelCase for local variables: `agentId`, `sessionKey`
- UPPER_CASE for constants: `DEFAULT_ACCOUNT_ID`, `MAIN_SESSION_KEY`
- descriptive names for configuration objects: `openClawConfig`

**Functions:**
- imperative verbs for functions: `resolveRoute()`, `loadConfig()`
- async functions return Promises: `sendMessage()`, `probeConnection()`

## Where to Add New Code

**New Channel:**
1. Core implementation: `src/[channel-name]/`
2. Plugin interface: `extensions/[channel-name]/src/channel.ts`
3. Tests: Collocated with source files
4. Configuration: Extend in `src/config/zod-schema.ts`

**New Agent Type:**
1. Agent runner: `src/agents/[agent-runner].ts`
2. Types: `src/agents/types.ts`
3. Configuration: Extend in `src/config/zod-schema.ts`
4. Tests: Collocated with source files

**New Command:**
1. Implementation: `src/commands/[command-name].ts`
2. Registration: `src/cli/program/command-registry.ts`
3. Dependencies: Use `createDefaultDeps()` for injection
4. Tests: Collocated with source files

**New Configuration Option:**
1. Types: `src/config/types.ts`
2. Schema: `src/config/zod-schema.ts`
3. Validation: `src/config/validation.ts`
4. Documentation: Update `docs/cli/config.md`

**New Memory Extension:**
1. Implementation: `extensions/memory-[type]/`
2. Plugin interface: Follow SDK in `openclaw/plugin-sdk`
3. Configuration: Extend in `src/config/zod-schema.ts`

## Special Directories

**extensions/**:
- Purpose: Workspace packages for channel plugins and extensions
- Generated: No, manually created
- Committed: Yes, all plugin code committed
- Structure: Each extension has its own `package.json` and `src/` directory

**dist/**:
- Purpose: Built output directory
- Generated: Yes, via `pnpm build` script
- Committed: Yes, distributed via npm
- Contents: Compiled JavaScript, assets, packaged apps

**vendor/**:
- Purpose: Third-party UI components and integrations
- Generated: No, manually managed
- Committed: Yes, vendored dependencies
- Structure: UI component libraries and integrations

**tests/**:
- Purpose: Collocated test files alongside source
- Generated: No, written manually
- Committed: Yes, test files committed
- Pattern: `*.test.ts` for unit tests, `*.e2e.test.ts` for integration tests

---

*Structure analysis: 2026-02-02*
