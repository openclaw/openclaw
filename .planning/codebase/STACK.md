# Technology Stack

**Analysis Date:** 2026-03-08

## Languages

**Primary:**
- TypeScript (ESM, strict mode) - Core CLI, gateway, agents, all extensions (`src/`, `extensions/`, `ui/`)
- Swift - macOS menubar app (`apps/macos/Sources/`) and iOS app (`apps/ios/Sources/`)
- Kotlin - Android app (`apps/android/`)

**Secondary:**
- JavaScript (ESM) - Build scripts (`scripts/*.mjs`), CLI entry shim (`openclaw.mjs`)
- Bash - Packaging, E2E test harnesses, CI helpers (`scripts/*.sh`)
- Python - Minimal; `pyproject.toml` present at root (likely for skill/tooling support)

## Runtime

**Environment:**
- Node.js 22+ (required: `engines.node >= 22.12.0`)
- Bun - Preferred for TypeScript execution in dev (scripts, dev server, tests)
- Node remains the production runtime for built output (`dist/`)

**Package Manager:**
- pnpm 10.23.0 (pinned via `packageManager` field in `package.json`)
- Lockfile: `pnpm-lock.yaml` (present)
- Bun also supported; keep `pnpm-lock.yaml` and Bun patching in sync

## Frameworks

**Core:**
- Express 5.2.1 - HTTP gateway server (`src/gateway/`)
- grammy 1.41.1 - Telegram bot framework (`src/telegram/`)
- @slack/bolt 4.6.0 - Slack bot framework (`src/slack/`)
- @buape/carbon (beta) - Discord bot framework (`src/discord/`)
- @discordjs/voice 0.19.0 - Discord voice connections
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp Web protocol (`src/web/`)
- @line/bot-sdk 10.6.0 - LINE messaging (`src/line/`, `extensions/line/`)
- @larksuiteoapi/node-sdk 1.59.0 - Feishu/Lark integration (`extensions/feishu/`)
- commander 14.0.3 - CLI argument parsing (`src/cli/`)

**AI/Agent:**
- @mariozechner/pi-agent-core 0.55.3 - Pi agent core
- @mariozechner/pi-ai 0.55.3 - Pi AI SDK
- @mariozechner/pi-coding-agent 0.55.3 - Pi coding agent
- @mariozechner/pi-tui 0.55.3 - Pi TUI
- @agentclientprotocol/sdk 0.15.0 - Agent Client Protocol (ACP)

**Testing:**
- Vitest 4.0.18 - Test runner with V8 coverage
- @vitest/coverage-v8 4.0.18 - Coverage provider (70% threshold target)
- Playwright 1.58.2 - Browser automation + E2E testing (via `playwright-core`)
- @vitest/browser-playwright 4.0.18 - Browser-based Vitest tests (UI workspace)

**Build/Dev:**
- tsdown 0.21.0 - TypeScript bundler (Rollup-based, config: `tsdown.config.ts`)
- tsx 4.21.0 - TypeScript execution for scripts
- TypeScript 5.9.3 - Type checking
- @typescript/native-preview 7.0.0-dev - Experimental native TS checker (`pnpm tsgo`)
- oxlint 1.51.0 - Linter (with type-aware mode)
- oxfmt 0.36.0 - Formatter
- Vite 7.3.1 - UI dev server and bundler (`ui/vite.config.ts`)

**UI (Control Panel):**
- Lit 3.3.2 - Web components framework (`ui/src/`)
- @lit/context 1.1.6 - Context API for Lit
- @lit-labs/signals 0.2.0 - Signals integration
- signal-utils 0.21.1 - Signal utilities
- DOMPurify 3.3.2 - HTML sanitization
- marked 17.0.4 - Markdown rendering

## Key Dependencies

**Critical:**
- zod 4.3.6 - Schema validation (config, API payloads)
- @sinclair/typebox 0.34.48 - JSON Schema / type generation (pinned via override)
- ajv 8.18.0 - JSON Schema validation
- ws 8.19.0 - WebSocket server/client
- undici 7.22.0 - HTTP client
- sharp 0.34.5 - Image processing
- dotenv 17.3.1 - Environment variable loading

**Infrastructure:**
- sqlite-vec 0.1.7-alpha.2 - SQLite vector search (memory/embeddings)
- node-llama-cpp 3.16.2 - Local LLM inference (peer dep)
- @lydell/node-pty 1.2.0-beta.3 - PTY for terminal/agent shell
- chokidar 5.0.0 - File system watching
- croner 10.0.1 - Cron scheduling
- tslog 4.10.2 - Structured logging
- jiti 2.6.1 - Runtime TypeScript/ESM loader (plugin resolution)
- pdfjs-dist 5.5.207 - PDF parsing
- @mozilla/readability 0.6.0 - Web content extraction
- linkedom 0.18.12 - Server-side DOM
- jszip 3.10.1 - ZIP file handling
- tar 7.5.10 - Tar archive handling (pinned via override)
- yaml 2.8.2 - YAML parsing

**Media/Audio:**
- opusscript 0.1.1 - Opus audio encoding
- node-edge-tts 1.2.10 - Text-to-speech
- @homebridge/ciao 1.3.5 - mDNS/Bonjour discovery

**Peer Dependencies (optional):**
- @napi-rs/canvas 0.1.89 - Canvas rendering
- node-llama-cpp 3.16.2 - Local LLM inference

## Workspaces

**pnpm workspace structure** (`pnpm-workspace.yaml`):
- `.` - Root package (core CLI + gateway)
- `ui` - Control panel UI (Lit + Vite)
- `packages/*` - Internal packages (`packages/clawdbot`, `packages/moltbot`)
- `extensions/*` - Plugin extensions (40+ extensions)

## Configuration

**Environment:**
- `.env` files supported via `dotenv` (existence noted; contents never read)
- Config stored at `~/.openclaw/` (credentials, sessions, agent state)
- State directory configurable via `OPENCLAW_STATE_DIR`
- Workspace directory via `OPENCLAW_WORKSPACE_DIR`

**Build:**
- `tsconfig.json` - TypeScript config (target: ES2023, module: NodeNext, strict: true)
- `tsconfig.plugin-sdk.dts.json` - Plugin SDK declaration generation
- `tsdown.config.ts` - Build config (multi-entry: core, plugin-sdk, hooks, channels)
- `vitest.config.ts` + 7 scoped configs - Test configurations (unit, e2e, gateway, channels, extensions, live)
- `knip.config.ts` - Dead code detection

**Path Aliases:**
- `openclaw/plugin-sdk` → `./src/plugin-sdk/index.ts`
- `openclaw/plugin-sdk/*` → `./src/plugin-sdk/*.ts`

## Platform Requirements

**Development:**
- Node.js 22.12.0+
- pnpm 10.23.0 (via corepack)
- Bun (recommended for dev TypeScript execution)
- macOS: Xcode + SwiftFormat + SwiftLint (for native apps)
- Android: Gradle + Kotlin (for Android app)

**Production:**
- Node.js 22+ (Debian Bookworm base image for Docker)
- Docker/Podman supported (`Dockerfile`, `docker-compose.yml`, `Dockerfile.sandbox`)
- Deployment targets: Fly.io (`fly.toml`), Render (`render.yaml`), Docker, self-hosted
- macOS menubar app (Sparkle auto-update, notarized)
- iOS app (Xcode, XcodeGen)
- Android app (Gradle, Kotlin)

## pnpm Overrides

Pinned transitive dependencies for security/compatibility:
- `hono` → 4.12.5
- `fast-xml-parser` → 5.3.8
- `@sinclair/typebox` → 0.34.48
- `tar` → 7.5.10
- `qs` → 6.14.2
- `tough-cookie` → 4.1.3
- `minimatch` → 10.2.4

## Native Build Dependencies

Required native compilation (`onlyBuiltDependencies`):
- `@lydell/node-pty` - Terminal PTY
- `@matrix-org/matrix-sdk-crypto-nodejs` - Matrix E2E encryption
- `@napi-rs/canvas` - Canvas rendering
- `@whiskeysockets/baileys` - WhatsApp protocol (protobuf)
- `sharp` - Image processing
- `protobufjs` - Protocol Buffers
- `esbuild` - Build tooling
- `node-llama-cpp` - Local LLM

---

*Stack analysis: 2026-03-08*
