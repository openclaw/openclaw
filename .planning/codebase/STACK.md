# Technology Stack

**Analysis Date:** 2026-03-28

## Languages

**Primary:**

- TypeScript (ESM) - All core source code under `src/`, extensions under `extensions/`, packages under `packages/`
- JavaScript (ESM) - Build and utility scripts under `scripts/`, entry point `openclaw.mjs`

**Secondary:**

- Swift - macOS app (`apps/macos/`), iOS app (`apps/ios/`), shared kit (`apps/shared/OpenClawKit/`)
- Kotlin - Android app (`apps/android/`)

## Runtime

**Environment:**

- Node.js >= 22.14.0 (required; keeps Node + Bun paths working)
- Bun (preferred for TypeScript execution in dev, scripts, and tests; `bun <file.ts>`)

**Package Manager:**

- pnpm (workspace monorepo)
- Lockfile: `pnpm-lock.yaml` present
- Bun also supported; both lockfile/patching must stay in sync when touching deps

## Frameworks

**Core:**

- `commander` ^14.0.3 - CLI argument parsing (`src/cli/`)
- `express` ^5.2.1 - HTTP server used in media pipeline (`src/media/server.ts`)
- `hono` 4.12.9 (pinned override) - Web framework (used in web provider and control UI)
- `ws` ^8.20.0 - WebSocket server/client for gateway protocol (`src/gateway/`)
- `zod` ^4.3.6 - Config schema validation (`src/config/zod-schema.*.ts`)
- `@sinclair/typebox` 0.34.48 (pinned override) - Tool input schema definitions

**Testing:**

- `vitest` ^4.1.2 - Test runner (multiple configs: `vitest.unit.config.ts`, `vitest.gateway.config.ts`, `vitest.e2e.config.ts`, `vitest.channels.config.ts`, `vitest.extensions.config.ts`, `vitest.live.config.ts`, `vitest.contracts.config.ts`)
- `@vitest/coverage-v8` ^4.1.2 - V8 coverage provider

**Build/Dev:**

- `tsdown` 0.21.7 (devDep) - TypeScript bundler, invoked via `scripts/tsdown-build.mjs`
- `tsx` ^4.21.0 - TypeScript execution for scripts (`node --import tsx`)
- `typescript` ^6.0.2 - Type checking (`pnpm tsgo` uses `@typescript/native-preview`)
- `@typescript/native-preview` 7.0.0-dev.20260326.1 - Fast type check (`pnpm tsgo`)
- `jiti` ^2.4.2 - Runtime module resolution alias for `openclaw/plugin-sdk` in plugin installs

**Linting/Formatting:**

- `oxlint` ^1.57.0 - Linting (`pnpm lint`)
- `oxfmt` 0.42.0 - Formatting (`pnpm format`)
- `oxlint-tsgolint` ^0.17.4 - TypeScript-specific lint rules

**UI:**

- `lit` ^3.3.2 + `@lit/context` + `@lit-labs/signals` - Web component UI (`ui/`)
- `signal-utils` 0.21.1 - Signal utilities for reactive UI

## Key Dependencies

**Critical:**

- `@modelcontextprotocol/sdk` 1.28.0 - MCP server/client integration (`src/mcp/`)
- `@agentclientprotocol/sdk` 0.17.0 - ACP server integration (`src/acp/`)
- `@mariozechner/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui` 0.63.1 - Embedded agent runtime (`src/agents/pi-embedded-runner/`)
- `matrix-js-sdk` 41.2.0 - Matrix protocol support (core + `extensions/matrix/`)
- `grammy` ^1.41.1 - Telegram Bot API client (`extensions/telegram/`)
- `@whiskeysockets/baileys` - WhatsApp Web protocol (`extensions/whatsapp/`)
- `@slack/bolt` + `@slack/web-api` - Slack API (`extensions/slack/`)
- `@buape/carbon` + `discord-api-types` - Discord API (`extensions/discord/`)
- `@line/bot-sdk` ^10.6.0 - LINE messaging API (core dependency)

**Infrastructure:**

- `undici` ^7.24.6 - HTTP fetch with SSRF protection (`src/infra/net/`)
- `@homebridge/ciao` ^1.3.5 - Bonjour/mDNS service discovery (`src/infra/bonjour-discovery.ts`)
- `chokidar` ^5.0.0 - File system watching
- `croner` ^10.0.1 - Cron job scheduling (`src/cron/schedule.ts`)
- `sqlite-vec` 0.1.7 - SQLite vector extension for semantic memory search
- Node.js built-in `node:sqlite` - SQLite database (used in `extensions/memory-core/`)
- `@lancedb/lancedb` ^0.27.1 - Vector database for long-term memory (`extensions/memory-lancedb/`)
- `tslog` ^4.10.2 - Structured logging (`src/logging/logger.ts`)
- `sharp` ^0.34.5 - Image processing
- `pdfjs-dist` ^5.5.207 - PDF parsing
- `playwright-core` 1.58.2 - Browser automation (`extensions/browser/`)
- `@lydell/node-pty` 1.2.0-beta.3 (native build) - PTY/terminal sessions
- `node-edge-tts` ^1.2.10 - Text-to-speech (Edge TTS)
- `@mozilla/readability` ^0.6.0 + `linkedom` ^0.18.12 - Web content extraction
- `markdown-it` ^14.1.1 - Markdown rendering
- `jszip` ^3.10.1 - ZIP file handling
- `yaml` ^2.7.0 - YAML config parsing
- `json5` ^2.2.3 - JSON5 config file support
- `uuid` ^13.0.0 - UUID generation
- `ajv` ^8.18.0 - JSON schema validation
- `qrcode-terminal` ^0.12.0 - QR code display for device pairing
- `dotenv` ^17.3.1 - Environment variable loading

**AI Provider SDKs:**

- `@anthropic-ai/vertex-sdk` ^0.14.4 - Anthropic on Google Vertex AI (`src/agents/anthropic-vertex-stream.ts`)
- `@aws-sdk/client-bedrock` ^3.1019.0 - AWS Bedrock (`extensions/amazon-bedrock/`)
- `openai` ^6.33.0 (in `extensions/memory-lancedb/` and `extensions/openai/`) - OpenAI API client

## Configuration

**Environment:**

- Config file: `~/.openclaw/openclaw.json` (strict JSON, validated by Zod schema)
- Environment variables for API keys (see provider env vars in `src/plugins/bundled-provider-auth-env-vars.generated.ts`)
- Credentials stored at `~/.openclaw/credentials/` (web provider login)
- Sessions stored at `~/.openclaw/sessions/` (Pi agent sessions)
- `.env` files loaded via `dotenv`

**Build:**

- `tsconfig.json` - TypeScript compiler options (module: NodeNext, target: es2023, strict mode)
- `tsconfig.plugin-sdk.dts.json` - Plugin SDK declaration file generation
- `scripts/tsdown-build.mjs` - Main build driver
- `scripts/runtime-postbuild.mjs` - Post-build runtime fixups
- Output: `dist/`

## Platform Requirements

**Development:**

- Node.js >= 22.14.0
- pnpm (workspace install: `pnpm install`)
- Bun (preferred for TypeScript execution and test runs)
- Pre-commit hooks: `prek install`

**Production:**

- Node.js >= 22.14.0 (for running `dist/`)
- macOS app: built via `scripts/package-mac-app.sh` (requires Xcode + SwiftFormat)
- iOS: Xcode + xcodegen (`scripts/ios-configure-signing.sh`)
- Android: Gradle (`apps/android/`)
- Deployment: Gateway runs as local process (macOS: launchctl `com.openclaw.gateway`); no external cloud requirement

---

_Stack analysis: 2026-03-28_
