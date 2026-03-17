# Technology Stack

**Analysis Date:** 2026-03-17

## Languages

**Primary:**

- TypeScript 5.9.3 - Source code, plugins, extensions
- JavaScript (ES2023 target) - Runtime, built output

**Secondary:**

- Swift - macOS/iOS applications (`apps/macos`, `apps/ios`)
- Kotlin - Android application (`apps/android`)
- Bash/Shell - Build scripts and CLI wrappers

## Runtime

**Environment:**

- Node.js 22.16.0+ (required - `engines.node` in `package.json`)
- Supports Bun for TypeScript execution and package management

**Package Manager:**

- pnpm 10.23.0 (primary)
- npm (fallback, supported for production installs)
- Bun (supported for development and testing)
- Lockfile: `pnpm-lock.yaml` (present, required)

## Frameworks

**Core Web/Server:**

- Hono 4.12.7 - HTTP server framework (Web provider)
- Express 5.2.1 - HTTP server support
- ws 8.19.0 - WebSocket support

**Testing:**

- Vitest 4.1.0 - Unit and integration test runner
  - V8 coverage with 70% threshold (`vitest.*.config.ts` configs)
  - Multiple configs: `vitest.unit.config.ts`, `vitest.gateway.config.ts`, `vitest.e2e.config.ts`, `vitest.live.config.ts`
- Playwright Core 1.58.2 - Browser automation

**Build/Dev Tools:**

- tsdown 0.21.2 - TypeScript bundler
- oxlint 1.55.0 - Fast linter
- oxfmt 0.40.0 - Code formatter
- tsx 4.21.0 - TypeScript execution

## Key Dependencies

**Critical Infrastructure:**

- @modelcontextprotocol/sdk 1.27.1 - MCP server support
- @agentclientprotocol/sdk 0.16.1 - Agent communication
- jiti 2.6.1 - Dynamic module loading (used for plugin-sdk aliases)

**Database & Storage:**

- node:sqlite (built-in, Node 22+) - Embedded database via `requireNodeSqlite()` in `src/memory/sqlite.ts`
- @lancedb/lancedb 0.26.2 - Vector database for embeddings
- sqlite-vec 0.1.7-alpha.2 - SQLite vector search extension
- sharps 0.34.5 - Image processing

**Messaging/Channels:**

- grammy 1.41.1 + @grammyjs/runner, @grammyjs/transformer-throttler - Telegram bot framework
- discord-api-types 0.38.42 - Discord API types
- @discordjs/voice 0.19.1 - Discord voice support
- @slack/bolt 4.6.0 + @slack/web-api 7.15.0 - Slack integration
- @line/bot-sdk 10.6.0 - LINE messaging
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp Web protocol
- @larksuiteoapi/node-sdk 1.59.0 - Feishu integration
- @matrix-org/matrix-sdk-crypto-nodejs - Matrix protocol support

**AI/ML Provider SDKs:**

- @aws-sdk/client-bedrock 3.1009.0 - AWS Bedrock (models)
- @mariozechner/pi-ai, pi-agent-core, pi-coding-agent, pi-tui 0.58.0 - Embedded Pi framework for agents

**Utilities:**

- chalk 5.6.2 - Terminal colors
- commander 14.0.3 - CLI argument parsing
- zod 4.3.6 - Schema validation
- ajv 8.18.0 - JSON schema validation
- @sinclair/typebox 0.34.48 - TypeScript schema generation
- yaml 2.8.2 - YAML parsing
- markdown-it 14.1.1 - Markdown parsing
- linkedom 0.18.12 - DOM parsing (headless)
- jszip 3.10.1 - ZIP file handling
- tar 7.5.11 - TAR archive handling
- pdfjs-dist 5.5.207 - PDF reading
- file-type 21.3.2 - File type detection
- croner 10.0.1 - Cron scheduling
- chokidar 5.0.0 - File watching
- undici 7.24.1 - HTTP client (no external deps)
- osc-progress 0.3.0 - CLI progress indicators

**Speech/TTS:**

- node-edge-tts 1.2.10 - Microsoft Edge TTS
- opusscript 0.1.1 - Opus audio codec

**Networking:**

- @homebridge/ciao 1.3.5 - mDNS/Bonjour
- https-proxy-agent 8.0.0 - HTTPS proxy support
- ipaddr.js 2.3.0 - IP address utilities

**Monitoring:**

- tslog 4.10.2 - Structured logging
- diagnostics-otel (internal plugin SDK export) - OpenTelemetry support

## Configuration

**Environment:**

- Loaded from `~/.openclaw/config.json` (user home)
- Overridable via CLI flags and environment variables
- Config validation via Zod schemas (`src/config/`)
- Secrets stored in `~/.openclaw/credentials/` (web provider) and environment

**Build:**

- `tsconfig.json` - TypeScript strict mode, ES2023 target, ESM output
- `tsdown.config.ts` - Code bundling configuration
- `pnpm` overrides in `package.json` for dependency version pinning
- Workspace packages: `extensions/*` and `ui/`

**Type Checking:**

- TypeScript 5.9.3 in strict mode
- Path aliases via `tsconfig.json` paths: `openclaw/plugin-sdk/*`
- Native ESM with `"type": "module"` in package.json

## Platform Requirements

**Development:**

- Node 22.16.0+
- Bun (optional, preferred for dev scripts)
- pnpm 10.23.0+
- Git (for version info and configuration)

**macOS-Specific:**

- Xcode (for building apps/macos)
- swiftformat 0.50+ (for Swift formatting)
- swiftlint (for Swift linting)

**iOS-Specific:**

- Xcode 15+
- SwiftUI (Observation framework preferred)
- xcodegen (for project generation)

**Android-Specific:**

- Android SDK (gradle, SDK tools)
- Kotlin support

**Linux:**

- Standard Linux development tools
- Docker support for test environments

**Production:**

- Node 22+ runtime
- Native SQLite support (built into Node)
- Optional: Docker (for containerized deployment)

---

_Stack analysis: 2026-03-17_
