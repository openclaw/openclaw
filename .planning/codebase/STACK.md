# Technology Stack

**Analysis Date:** 2026-02-15

## Languages

**Primary:**
- TypeScript 5.9.3 - Core application, CLI, gateway, extensions
- JavaScript (Node.js modules) - Runtime execution
- Swift - iOS/macOS client applications (`apps/ios/`, `apps/macos/`)
- Kotlin - Android application (`apps/android/`)
- Bash - Build scripts and deployment configuration

**Secondary:**
- YAML - Configuration files and GitHub Actions workflows
- JSON/JSON5 - Configuration and data serialization

## Runtime

**Environment:**
- Node.js >= 22.12.0 (primary runtime)
- Bun 1.3.0 (package manager/build tool)

**Package Manager:**
- Bun 1.3.0 (primary)
- pnpm (fallback for ARM/Synology architectures via `OPENCLAW_PREFER_PNPM=1`)
- Lockfile: `bun.lock` (primary), `pnpm-lock.yaml` (fallback)

## Frameworks

**Core:**
- Express 5.2.1 - HTTP server and REST API framework
- Zod 4.3.6 - Runtime type validation and schema definition
- AJV 8.18.0 - JSON Schema validation

**CLI/Terminal:**
- Commander 14.0.3 - CLI argument parsing
- Clack Prompts 1.0.1 - Interactive CLI prompts
- Chalk 5.6.2 - Terminal color output

**Messaging/Channels:**
- Grammy 1.40.0 - Telegram bot framework
- @slack/bolt 4.6.0 - Slack bot framework
- @slack/web-api 7.14.1 - Slack API client
- @line/bot-sdk 10.6.0 - LINE messaging API
- Discord API types 0.38.39 - Discord type definitions
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp Web client
- @larksuiteoapi/node-sdk 1.59.0 - Feishu (Lark) enterprise platform

**Agent/AI:**
- @mariozechner/pi-agent-core 0.52.12 - AI agent core framework
- @mariozechner/pi-ai 0.52.12 - AI model integration
- @mariozechner/pi-coding-agent 0.52.12 - Coding-specific agent
- @mariozechner/pi-tui 0.52.12 - Terminal UI framework

**Database/Storage:**
- node:sqlite (built-in) - Embedded SQL database
- sqlite-vec 0.1.7-alpha.2 - Vector search for embeddings
- LinkedOM 0.18.12 - DOM implementation for HTML parsing
- jszip 3.10.1 - ZIP file handling

**Media/Document Processing:**
- sharp 0.34.5 - Image processing (JPEG, PNG, WebP)
- pdfjs-dist 5.4.624 - PDF parsing and rendering
- @mozilla/readability 0.6.0 - Web article text extraction
- file-type 21.3.0 - File type detection
- Playwright-core 1.58.2 - Browser automation (headless)
- node-edge-tts 1.2.10 - Text-to-speech synthesis

**Utilities:**
- Tar 7.5.7 - Archive extraction
- YAML 2.8.2 - YAML parsing
- JSON5 2.2.3 - JSON5 parser (JSON with comments)
- Chokidar 5.0.0 - File system watching
- Croner 10.0.1 - Cron job scheduling
- Proper-lockfile 4.1.2 - File locking
- Markdown-it 14.1.1 - Markdown parsing
- cli-highlight 2.1.11 - Code syntax highlighting
- Long 5.3.2 - 64-bit integer handling (protobuf)
- Signal-utils 0.21.1 - Lit signals library
- TSLog 4.10.2 - Logging framework

**Build/Development:**
- tsdown 0.20.3 - TypeScript bundler
- Rolldown 1.0.0-rc.4 - High-performance bundler
- tsx 4.21.0 - TypeScript executor
- JITI 2.6.1 - Just-in-time module loader
- @typescript/native-preview 7.0.0-dev - TypeScript native bindings

**Testing:**
- Vitest 4.0.18 - Unit and integration test framework
- @vitest/coverage-v8 4.0.18 - Code coverage reporting
- Ollama 0.6.3 - Local LLM integration for testing

**Linting/Formatting:**
- oxlint 1.47.0 - Rust-based fast linter
- oxlint-tsgolint 0.12.2 - TypeScript Go lint rules
- oxfmt 0.32.0 - Rust-based formatter
- Markdownlint 2 - Markdown linting (via dlx)

**Observability:**
- @agentclientprotocol/sdk 0.14.1 - Agent client protocol integration

**Cloud/Infrastructure:**
- @aws-sdk/client-bedrock 3.990.0 - AWS Bedrock API for Claude/Llama models
- @homebridge/ciao 1.3.5 - mDNS/Bonjour service discovery
- https-proxy-agent 7.0.6 - HTTPS proxy support

**Frontend (UI):**
- Lit 3.3.2 - Lightweight web components
- @lit/context 1.1.6 - Context API for Lit
- @lit-labs/signals 0.2.0 - Reactive signals for Lit

**Peer Dependencies (Optional):**
- @napi-rs/canvas 0.1.89 - Canvas rendering (if using graphics)
- node-llama-cpp 3.15.1 - Local LLM inference (if using local models)

## Configuration

**Environment:**
- Loaded from process env → `./.env` → `~/.openclaw/.env` → `openclaw.json`
- Built-in Node.js SQLite support (requires Node >= 22.12.0)
- Configuration file: `~/.openclaw/openclaw.json` (JSON format)

**Key Configurations:**
- `OPENCLAW_GATEWAY_TOKEN` - Gateway authentication token
- `OPENCLAW_GATEWAY_PASSWORD` - Alternative authentication
- Model API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
- Channel tokens: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`
- State directory: `OPENCLAW_STATE_DIR` (default: `~/.openclaw`)

**Build Configuration:**
- `tsconfig.json` - TypeScript compilation settings (ES2023, NodeNext modules)
- `tsconfig.plugin-sdk.dts.json` - Plugin SDK declaration generation
- `vitest.unit.config.ts` - Unit test configuration
- `vitest.e2e.config.ts` - E2E test configuration
- `vitest.live.config.ts` - Live service test configuration
- `.oxlintrc.json` - Linter rules (oxlint)
- `.oxfmtrc.jsonc` - Formatter rules (oxfmt)

## Platform Requirements

**Development:**
- Node.js >= 22.12.0
- Bun 1.3.0 (or pnpm as fallback)
- TypeScript 5.9.3
- Git with configured hooks

**Production:**
- Docker (Node 22-bookworm base image)
- Fly.io (optional cloud deployment)
  - Shared CPU 2x VM
  - 2048 MB memory
  - Persistent volume mount at `/data`
- Non-root user execution (runs as `node` user for security)

**Mobile:**
- iOS 14+ (Swift with Xcode)
- Android (Kotlin with Gradle)
- macOS (Swift with Xcode)

---

*Stack analysis: 2026-02-15*
