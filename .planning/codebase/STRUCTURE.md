# Codebase Structure

**Analysis Date:** 2026-03-28

## Directory Layout

```
openclaw/                          # Repo root
├── src/                           # Core TypeScript source (CLI + gateway)
│   ├── entry.ts                   # CLI process entry point (fast-path, respawn, profile)
│   ├── index.ts                   # Library entry point
│   ├── runtime.ts                 # Core runtime bootstrap
│   ├── library.ts                 # Public library surface
│   ├── cli/                       # CLI wiring: argument parsing, option handling, sub-commands
│   ├── commands/                  # Command implementations (agent, send, models, config, etc.)
│   ├── agents/                    # AI agent core: model selection, session, tools, providers
│   ├── channels/                  # Channel abstractions: routing, allowlists, session meta
│   ├── gateway/                   # Gateway server: HTTP, WebSocket, auth, sessions
│   ├── config/                    # Config schema (zod), IO, migrations, validation
│   ├── infra/                     # Infrastructure: filesystem, networking, OS utilities
│   ├── media/                     # Media pipeline: audio, image, video, ffmpeg
│   ├── terminal/                  # Terminal UI: palette, table, progress, ANSI
│   ├── tui/                       # Interactive TUI (chat interface)
│   ├── plugin-sdk/                # Plugin SDK public surface and runtime API
│   ├── extensions/                # Core extension implementations (loaded via plugin-sdk)
│   ├── routing/                   # Message routing logic (account lookup, session key)
│   ├── sessions/                  # Session lifecycle events and identifiers
│   ├── security/                  # Security audit, path checks, tool policy
│   ├── secrets/                   # Secret resolution, ref system, credential store
│   ├── hooks/                     # Hook system: install, fire-and-forget, Gmail watcher
│   ├── flows/                     # Onboarding/setup flows (channel setup, doctor)
│   ├── interactive/               # Interactive prompts (clack-prompter wrapper)
│   ├── wizard/                    # Setup wizard state machine
│   ├── pairing/                   # Device pairing: challenge, store, messages
│   ├── process/                   # Child process management: exec, kill-tree, command queue
│   ├── acp/                       # ACP (agent control protocol) client
│   ├── canvas-host/               # Canvas/A2UI host server and file resolver
│   ├── mcp/                       # MCP channel server bridge
│   ├── tts/                       # Text-to-speech providers and runtime
│   ├── image-generation/          # Image generation provider registry
│   ├── web-search/                # Web search provider registry
│   ├── context-engine/            # Context injection engine
│   ├── link-understanding/        # URL/link content extraction
│   ├── markdown/                  # Markdown rendering utilities
│   ├── polls/                     # Poll parameter handling
│   ├── shared/                    # Shared types/utilities used by both core and extensions
│   ├── types/                     # TypeScript ambient type declarations (*.d.ts)
│   └── utils/                     # Small pure utility functions
├── extensions/                    # Plugin workspace packages (one dir per plugin)
│   ├── openai/                    # OpenAI provider plugin (@openclaw/openai-provider)
│   ├── anthropic/                 # Anthropic provider plugin
│   ├── telegram/                  # Telegram channel plugin
│   ├── discord/                   # Discord channel plugin
│   ├── slack/                     # Slack channel plugin
│   ├── signal/                    # Signal channel plugin
│   ├── matrix/                    # Matrix channel plugin
│   ├── msteams/                   # Microsoft Teams channel plugin
│   ├── whatsapp/                  # WhatsApp channel plugin
│   ├── voice-call/                # Voice call channel plugin
│   ├── browser/                   # Browser tool plugin
│   ├── memory-core/               # Memory core engine plugin
│   ├── memory-lancedb/            # LanceDB memory backend plugin
│   ├── shared/                    # Shared code imported by multiple extensions
│   └── ...                        # ~80 total extension packages
├── apps/                          # Native app workspaces
│   ├── ios/                       # iOS app (Swift/SwiftUI)
│   │   └── Sources/               # Feature directories: Chat, Gateway, Onboarding, Settings, etc.
│   ├── android/                   # Android app (Kotlin/Jetpack Compose)
│   │   └── app/src/main/java/ai/openclaw/app/
│   └── macos/                     # macOS app (Swift/SwiftUI)
│       └── Sources/               # OpenClaw, OpenClawDiscovery, OpenClawIPC, OpenClawMacCLI, OpenClawProtocol
├── packages/                      # Internal pnpm workspace utility packages
│   ├── clawdbot/                  # Clawdbot package
│   ├── memory-host-sdk/           # Memory host SDK
│   └── moltbot/                   # Moltbot package
├── ui/                            # Web control UI (Vite + React)
│   └── src/                       # Frontend source
├── skills/                        # Bundled skills (Markdown prompt files, ~50+ skills)
├── test/                          # Cross-cutting test infrastructure
│   ├── helpers/                   # Shared test helpers (temp-home, gateway harness, etc.)
│   ├── mocks/                     # Shared mock implementations
│   ├── fixtures/                  # Test fixtures (JSON contracts, plugin inventories)
│   ├── scripts/                   # Test-only scripts
│   └── *.test.ts                  # Top-level integration and architecture tests
├── test-fixtures/                 # Static fixture data for tests
├── docs/                          # Documentation (Mintlify, served at docs.openclaw.ai)
├── scripts/                       # Build, release, check, and maintenance scripts
├── .agents/                       # Agent skills (maintainer workflows)
├── .github/                       # CI workflows, issue templates, labeler config
├── .planning/                     # GSD planning documents (codebase maps, phase plans)
├── dist/                          # Build output (compiled JS, generated; not edited)
├── dist-runtime/                  # Runtime-only build output
├── vendor/                        # Vendored source code
├── patches/                       # pnpm patches for dependencies
├── openclaw.mjs                   # CLI wrapper/launcher script
├── tsdown.config.ts               # Build config (tsdown/rollup)
├── tsconfig.json                  # TypeScript base config
├── package.json                   # Root package manifest + scripts
├── pnpm-workspace.yaml            # pnpm workspace definition
└── vitest.config.ts               # Primary Vitest config
```

## Directory Purposes

**`src/cli/`:**

- Purpose: CLI argument parsing, command registration, option handling, banners, and program wiring
- Contains: `program.ts` (root CLI program), per-command `*-cli.ts` files, config/plugins/secrets/models CLI modules
- Key files: `src/cli/program.ts`, `src/cli/run-main.ts`, `src/cli/progress.ts`, `src/cli/banner.ts`
- Depends on: `src/commands/`, `src/gateway/`, `src/config/`, `src/infra/`

**`src/commands/`:**

- Purpose: Business logic for each CLI command (agent, message, models, skills, cron, webhooks, etc.)
- Contains: Command handler implementations, command-specific types and utilities
- Key files: `src/commands/agent.ts`, `src/commands/agents.ts`, `src/commands/agent-via-gateway.ts`
- Note: Commands follow dependency injection via `createDefaultDeps` pattern

**`src/agents/`:**

- Purpose: AI agent core — model config, session lifecycle, tool execution, provider management, memory
- Contains: `pi-embedded-runner.ts` (agent session runner), `model-catalog.ts`, `pi-tools.ts`, skill loading, subagent registry, auth profiles
- Key files: `src/agents/pi-embedded-runner.ts`, `src/agents/model-selection.ts`, `src/agents/openclaw-tools.ts`

**`src/gateway/`:**

- Purpose: Gateway server — HTTP/WS server, channel management, auth, session control, config reload
- Contains: `server.ts` (main server), `server-http.ts`, `server-ws-runtime.ts`, `server-channels.ts`, credential management, probe endpoints
- Key files: `src/gateway/server.ts`, `src/gateway/server-startup.ts`, `src/gateway/credentials.ts`

**`src/config/`:**

- Purpose: Config schema definition (zod), IO, validation, legacy migrations, channel-specific type blocks
- Contains: `schema.ts`, `config.ts`, `io.ts`, `zod-schema.ts`, `legacy-migrate.ts`, per-channel `types.*.ts` files
- Key files: `src/config/schema.ts`, `src/config/config.ts`, `src/config/io.ts`

**`src/infra/`:**

- Purpose: Infrastructure layer — filesystem, networking, process management, OS detection, update checks
- Contains: Utilities for paths, ports, SSH, bonjour discovery, system presence, tailscale, restart logic
- Key files: `src/infra/env.ts`, `src/infra/fs-safe.ts`, `src/infra/ports.ts`, `src/infra/gateway-processes.ts`

**`src/media/`:**

- Purpose: Media pipeline — image processing, audio handling, ffmpeg execution, file context
- Contains: `src/media/ffmpeg-exec.ts`, `src/media/audio.ts`, `src/media/image-ops.ts`, inbound path policy
- Key files: `src/media/ffmpeg-exec.ts`, `src/media/host.ts`

**`src/terminal/`:**

- Purpose: Terminal output utilities — shared palette (never hardcode colors), ANSI helpers, table renderer, progress bars
- Contains: `palette.ts`, `table.ts`, `progress-line.ts`, `stream-writer.ts`, `safe-text.ts`, `links.ts`
- Key files: `src/terminal/palette.ts` (use for all TTY colors), `src/terminal/table.ts`

**`src/plugin-sdk/`:**

- Purpose: Plugin SDK public surface — APIs available to extension plugins and external developers
- Contains: `index.ts` (main SDK export), per-feature runtime modules (`channel-runtime.ts`, `provider-runtime.ts`, etc.)
- Key files: `src/plugin-sdk/index.ts`, `src/plugin-sdk/channel-contract.ts`, `src/plugin-sdk/provider-entry.ts`
- Note: Extensions import from `openclaw/plugin-sdk`; this resolves via jiti alias at runtime

**`src/extensions/`:**

- Purpose: Core extension implementations that ship with openclaw (not standalone packages)
- Contains: Channel/provider implementations loaded via plugin-sdk (`discord.ts`, `telegram.ts`, `openai.ts`, etc.)
- Note: Distinguished from `extensions/` workspace packages which are full npm packages

**`src/channels/`:**

- Purpose: Channel-agnostic abstractions — allowlists, account resolution, run state machine, typing, command gating
- Contains: `run-state-machine.ts`, `allowlists/`, `targets.ts`, `session.ts`, `command-gating.ts`
- Key files: `src/channels/run-state-machine.ts`, `src/channels/registry.ts`

**`src/shared/`:**

- Purpose: Types and utilities shared by core and extension code across architectural layers
- Contains: Device auth store, chat content types, node resolution, gateway bind URL, usage aggregates
- Key files: `src/shared/chat-envelope.ts`, `src/shared/device-auth-store.ts`

**`src/security/`:**

- Purpose: Security auditing, path validation, tool policy, dangerous config detection
- Contains: `audit.ts`, `scan-paths.ts`, `dangerous-tools.ts`, `skill-scanner.ts`, `safe-regex.ts`

**`src/secrets/`:**

- Purpose: Secret resolution — ref system, credential matrix, config IO, provider env vars
- Contains: `resolve.ts`, `plan.ts`, `configure.ts`, `runtime.ts`, `ref-contract.ts`

**`extensions/` (workspace packages):**

- Purpose: Standalone publishable plugin packages (LLM providers, messaging channels, tools)
- Structure: Each directory is a pnpm workspace package with its own `package.json` + `openclaw.plugin.json`
- Key files: `extensions/<name>/index.ts` (plugin entry), `extensions/<name>/package.json`
- Convention: Plugin entry declared in `openclaw.extensions` array in `package.json`

**`ui/`:**

- Purpose: Web control UI served by the gateway (Vite + React)
- Contains: `ui/src/` (React components), `ui/vite.config.ts`, `ui/package.json`
- Key files: `ui/src/`, `ui/index.html`

**`test/`:**

- Purpose: Cross-cutting test infrastructure — harnesses, mocks, and integration tests not owned by one module
- Contains: `test/helpers/` (shared helpers), `test/mocks/` (shared mocks), `test/fixtures/` (JSON contracts)
- Key files: `test/helpers/gateway-e2e-harness.ts`, `test/helpers/temp-home.ts`, `test/global-setup.ts`

**`skills/`:**

- Purpose: Bundled Markdown skill files shipped with openclaw (available without Clawhub)
- Contains: One directory per skill with Markdown prompt files
- Examples: `skills/github/`, `skills/coding-agent/`, `skills/ffmpeg/`

**`scripts/`:**

- Purpose: Build, release, lint boundary checks, and maintenance shell scripts / TypeScript scripts
- Contains: Architecture smell checks, plugin SDK boundary validators, release scripts, committer helper
- Key files: `scripts/committer`, `scripts/release-check.ts`, `scripts/check-architecture-smells.mjs`

## Key File Locations

**Entry Points:**

- `src/entry.ts`: CLI process entry (spawned by `openclaw.mjs` wrapper)
- `src/index.ts`: Library entry (for SDK consumers)
- `src/runtime.ts`: Core runtime module bootstrap
- `src/gateway/server.ts`: Gateway HTTP/WS server

**Configuration:**

- `src/config/schema.ts`: Zod config schema (canonical config structure)
- `src/config/config.ts`: Config loading and access
- `src/config/io.ts`: Config file read/write
- `tsconfig.json`: TypeScript base configuration
- `tsdown.config.ts`: Build configuration (produces `dist/`)
- `vitest.config.ts`: Primary unit test config

**Core Logic:**

- `src/agents/pi-embedded-runner.ts`: Agent session runner (the main agent loop)
- `src/agents/model-selection.ts`: Model selection and routing
- `src/agents/models-config.ts`: Model/provider configuration merging
- `src/agents/skills.ts`: Skill loading and workspace snapshot
- `src/channels/run-state-machine.ts`: Channel message run state machine
- `src/routing/resolve-route.ts`: Message routing resolution
- `src/gateway/server-startup.ts`: Gateway startup sequence

**Shared Utilities:**

- `src/terminal/palette.ts`: Color palette — use for all TTY output colors
- `src/terminal/table.ts`: Table renderer for status output
- `src/cli/progress.ts`: Progress bars and spinners (osc-progress + @clack/prompts)
- `src/infra/env.ts`: Environment variable utilities
- `src/infra/fs-safe.ts`: Safe filesystem operations

**Testing:**

- `test/helpers/gateway-e2e-harness.ts`: Full gateway E2E test harness
- `test/helpers/temp-home.ts`: Temporary home directory for isolated tests
- `test/global-setup.ts`: Global Vitest setup
- `test/setup.ts`: Per-file Vitest setup

## Naming Conventions

**Files:**

- `kebab-case` throughout: `model-selection.ts`, `gateway-processes.ts`
- Tests co-located with source: `model-selection.test.ts` next to `model-selection.ts`
- E2E tests: `*.e2e.test.ts`
- Live (real API) tests: `*.live.test.ts`
- Runtime-only modules (lazy loading boundary): `*.runtime.ts`
- Test helpers shared within a module: `*.test-helpers.ts` or `test-helpers.ts`
- Contract tests: `*.contract.test.ts`
- Coverage-focused tests: `*.coverage.test.ts`

**Multi-file modules:**

- Dot-separated namespacing: `pi-embedded-subscribe.handlers.tools.ts`
- Shared types split out: `server-methods.ts` + `server-methods-list.ts`
- Config types per channel: `src/config/types.discord.ts`, `src/config/types.telegram.ts`

**Directories:**

- `kebab-case` for all directories
- Feature domains get their own directory when they contain 3+ files
- Channel-specific code under `src/channels/` (core) or `extensions/<channel>/` (plugins)

**Exports:**

- Named exports preferred over default exports
- Barrel files (`index.ts`) used at package boundaries, not within deep module trees

## Where to Add New Code

**New CLI command:**

- Implement: `src/cli/<command>-cli.ts`
- Business logic: `src/commands/<command>.ts`
- Register in: `src/cli/program.ts` (or the relevant sub-program)
- Tests: `src/cli/<command>-cli.test.ts` and `src/commands/<command>.test.ts`

**New channel (core):**

- Implementation: `src/extensions/<channel>.ts` + supporting files
- Config types: `src/config/types.<channel>.ts`
- Config schema: add to `src/config/zod-schema.channels.ts`
- Plugin SDK registration: `src/plugin-sdk/<channel>-surface.ts` (if needed)
- Documentation: `docs/channels/<channel>.md`
- Update: `src/channels/channels-misc.test.ts`, `.github/labeler.yml`

**New channel (extension plugin):**

- Create workspace package: `extensions/<channel>/`
- Entry: `extensions/<channel>/index.ts`
- Manifest: `extensions/<channel>/package.json` with `openclaw.extensions` array
- Tests: `extensions/<channel>/*.test.ts`

**New LLM provider:**

- Extension package: `extensions/<provider>/`
- Entry: `extensions/<provider>/index.ts` (implement `ProviderPlugin`)
- Models: `extensions/<provider>/default-models.ts` or inline
- Config types: `src/config/types.models.ts` or extend provider schema
- Tests: include contract tests (`provider.contract.test.ts`)

**New agent tool:**

- Core tool: `src/agents/openclaw-tools.ts` or new `src/agents/<tool-name>.ts`
- Tool schema: `src/agents/schema/<tool>.ts`
- Tests: `src/agents/openclaw-tools.<tool-name>.test.ts`

**New infra utility:**

- Small utility: `src/infra/<utility>.ts` + `src/infra/<utility>.test.ts`
- If shared with extensions: `src/shared/<utility>.ts`

**New skill:**

- Directory: `skills/<skill-name>/`
- Entry: `skills/<skill-name>/README.md` (Markdown prompt)

**New config key:**

- Schema: `src/config/schema.ts` and corresponding `src/config/zod-schema.ts`
- Types: `src/config/types.ts` (or channel-specific `types.<channel>.ts`)
- Defaults: `src/config/defaults.ts`
- Migration: `src/config/legacy-migrate.ts` if replacing old key

**New terminal UI element:**

- Color: use existing token from `src/terminal/palette.ts`; do not hardcode ANSI codes
- Tables: use `src/terminal/table.ts`
- Progress/spinners: use `src/cli/progress.ts`

## Special Directories

**`dist/`:**

- Purpose: Compiled JavaScript output from `pnpm build`
- Generated: Yes (tsdown/rollup)
- Committed: No (gitignored)

**`dist-runtime/`:**

- Purpose: Runtime-only build subset
- Generated: Yes
- Committed: No

**`node_modules/`:**

- Purpose: pnpm-installed dependencies
- Generated: Yes
- Committed: No

**`.planning/`:**

- Purpose: GSD planning documents (codebase maps, phase plans)
- Generated: By GSD tooling
- Committed: Yes (used for AI-assisted development)

**`src/generated/`:**

- Purpose: Auto-generated TypeScript files (channel config metadata, etc.)
- Key file: `src/config/bundled-channel-config-metadata.generated.ts`
- Committed: Yes (checked in, regenerated by scripts)

**`src/canvas-host/a2ui/`:**

- Purpose: Bundled A2UI canvas application
- Key file: `src/canvas-host/a2ui/.bundle.hash`
- Regenerate: `pnpm canvas:a2ui:bundle` — commit hash as separate commit; never edit bundle directly

**`docs/zh-CN/`:**

- Purpose: Auto-generated Chinese i18n docs
- Generated: Yes, by `scripts/docs-i18n`
- Committed: Yes
- Note: Do not edit manually; update English docs and rerun pipeline

**`test-fixtures/`:**

- Purpose: Static JSON and data fixtures for tests
- Committed: Yes

**`patches/`:**

- Purpose: pnpm patches for dependencies requiring local modifications
- Committed: Yes
- Note: Patched dependencies must use exact versions (no `^`/`~`); changes require explicit approval

---

_Structure analysis: 2026-03-28_
