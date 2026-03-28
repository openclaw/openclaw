# Technology Stack

**Analysis Date:** 2026-03-26

## Languages

**Primary:**

- TypeScript ES2023 - All source code
- JavaScript (Node.js ESM) - Runtime and build scripts

**Secondary:**

- Swift - macOS/iOS app development (`apps/macos/`, `apps/ios/`)
- Kotlin - Android app development (`apps/android/`)
- HTML/CSS/JavaScript - Web UI (`ui/`)

## Runtime

**Environment:**

- Node.js 22.14.0+ (minimum version)
- Bun (optional, for TypeScript execution)

**Package Manager:**

- pnpm 10.32.1 (workspace-based)
- Lockfile: `pnpm-lock.yaml` (present and required)

## Frameworks & Core Libraries

**Web/HTTP:**

- `express` ^5.2.1 - HTTP server and middleware (`src/browser/server.ts`)
- `hono` 4.12.8 - Lightweight HTTP framework
- `ws` ^8.20.0 - WebSocket server (`src/gateway/server/ws-connection.ts`)

**LLM & Agent Framework:**

- `@mariozechner/pi-agent-core` 0.61.1 - Pi agent core runtime
- `@mariozechner/pi-ai` 0.61.1 - Pi AI streaming and model integration
- `@mariozechner/pi-coding-agent` 0.61.1 - Coding agent
- `@mariozechner/pi-tui` 0.61.1 - Terminal UI for agents
- `@modelcontextprotocol/sdk` 1.27.1 - Model Context Protocol SDK

**Cloud & LLM Providers:**

- `@anthropic-ai/vertex-sdk` ^0.14.4 - Google Vertex AI with Anthropic models (`src/agents/anthropic-vertex-stream.ts`)
- `@aws-sdk/client-bedrock` ^3.1014.0 - AWS Bedrock LLM access

**Testing:**

- `vitest` ^4.1.0 - Test runner (pool: "forks", strict env isolation)
- `@vitest/coverage-v8` ^4.1.0 - Coverage reporting (V8, 70% thresholds)
- `jsdom` - DOM testing environment

**Build & Development:**

- `typescript` - TypeScript compiler (ESM, strict mode)
- `oxlint` - Fast linting (Rust-based)
- `oxfmt` - Formatting (Rust-based)
- `tsdown` - TypeScript bundler
- `jiti` ^2.6.1 - Just-in-time module loader for lazy imports
- `tsx` - TypeScript executor

**CLI & TUI:**

- `commander` ^14.0.3 - CLI argument parsing (`src/cli/`)
- `@clack/prompts` ^1.1.0 - Interactive CLI prompts
- `chalk` ^5.6.2 - Terminal color output
- `cli-highlight` ^2.1.11 - Code highlighting in terminal
- `osc-progress` ^0.3.0 - CLI progress bars

**Media & Content Processing:**

- `sharp` ^0.34.5 - Image processing and transformation (`src/agents/tool-images.test.ts`)
- `playwright-core` 1.58.2 - Browser automation (headless Chrome/Firefox)
- `pdfjs-dist` ^5.5.207 - PDF parsing and rendering
- `@mozilla/readability` ^0.6.0 - Web content extraction
- `node-edge-tts` ^1.2.10 - Text-to-speech (Edge TTS)

**Data & Storage:**

- Built-in `node:sqlite` (Node.js native module) - SQLite database (`src/memory/sqlite.ts`)
- `sqlite-vec` 0.1.7 - SQLite vector extension for embeddings (`src/memory/sqlite-vec.ts`)
- `jszip` ^3.10.1 - ZIP file handling
- `tar` 7.5.12 - TAR archive handling

**Data Processing:**

- `zod` ^4.3.6 - Schema validation and parsing (all extensions use this)
- `@sinclair/typebox` 0.34.48 - JSON schema generation and validation
- `ajv` ^8.18.0 - JSON schema validator
- `json5` ^2.2.3 - JSON5 parsing
- `yaml` ^2.8.3 - YAML parsing
- `markdown-it` ^14.1.1 - Markdown parsing

**Channel Integration Libraries:**

- `@line/bot-sdk` ^10.6.0 - LINE Messaging API (`extensions/line/`)
- `@agentclientprotocol/sdk` 0.16.1 - Agent Client Protocol support

**Utilities:**

- `uuid` ^13.0.0 - UUID generation
- `undici` ^7.24.5 - HTTP client (alternative to node-fetch)
- `ipaddr.js` ^2.3.0 - IP address parsing
- `linkedom` ^0.18.12 - Lightweight DOM implementation
- `file-type` 21.3.4 - File type detection
- `croner` ^10.0.1 - Cron scheduling
- `chokidar` ^5.0.0 - File system watcher
- `dotenv` ^17.3.1 - Environment variable loading
- `tslog` ^4.10.2 - Structured logging
- `gaxios` 7.1.4 - Google HTTP client
- `qrcode-terminal` ^0.12.0 - Terminal QR code generation
- `long` ^5.3.2 - 64-bit integer support
- `@homebridge/ciao` ^1.3.5 - mDNS/Bonjour support

**Terminal UI:**

- `lit` - Web components library (dev dependency, UI)
- `@lit-labs/signals` ^0.2.0 - Reactive state management
- `@lit/context` ^1.1.6 - Context API for Lit components

**Process Management:**

- `@lydell/node-pty` 1.2.0-beta.3 - Pseudo-terminal support (native bindings)

## Configuration

**Environment:**

- Configuration via `.env` file (local) or `~/.openclaw/.env` (daemon mode)
- Path precedence: process env → `./.env` → `~/.openclaw/.env` → `openclaw.json` env block
- Config file: `~/.openclaw/openclaw.json` or path override via `OPENCLAW_CONFIG_PATH`

**Build Configuration:**

- `tsconfig.json` - TypeScript compiler options (ES2023, strict mode, module aliases)
- `.oxlintrc.json` - Oxlint rules
- `.oxfmtrc.jsonc` - Oxfmt formatting rules
- `knip.config.ts` - Dead code detection
- `.pre-commit-config.yaml` - Git hooks (format, lint, type checks)
- `vitest*.config.ts` - Multiple test configurations (unit, gateway, channels, live, e2e)

**Package Management:**

- `.npmrc` - npm/pnpm configuration (hoisted linker for TS 7 compatibility)
- `package.json` scripts include: build, test, lint, format, type-check, docs

## Platform Requirements

**Development:**

- Node.js 22.14.0+
- pnpm 10.32.1
- TypeScript 5+
- Oxlint, Oxfmt (Rust-based tooling)

**Production:**

- Node.js runtime (22.14.0+)
- SQLite database (built-in)
- Network access to external APIs (LLM providers, messaging platforms)

**Platform Targets:**

- `dist/` - Built JavaScript (ESM)
- `apps/macos/` - Native macOS app (Swift/SwiftUI)
- `apps/ios/` - Native iOS app (Swift)
- `apps/android/` - Native Android app (Kotlin/Gradle)
- `ui/` - Web UI (Lit + Vite)

---

_Stack analysis: 2026-03-26_
