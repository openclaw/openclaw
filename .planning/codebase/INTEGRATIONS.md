# External Integrations

**Analysis Date:** 2026-03-17

## APIs & External Services

**LLM Providers (Core):**

- OpenAI (GPT-4, GPT-4 Turbo, etc.)
  - SDK/Client: `@mariozechner/pi-ai` (embedded)
  - Auth: `OPENAI_API_KEY` environment variable
  - Manifest: `extensions/openai/openclaw.plugin.json`
  - Services: Chat completions, embeddings (text-embedding-3-small/large), image generation, audio transcription, TTS
  - Config location: `src/providers/openai.ts` (via Pi framework)

- Anthropic (Claude)
  - SDK/Client: `@mariozechner/pi-ai` (embedded)
  - Auth: `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` environment variables
  - Manifest: `extensions/anthropic/openclaw.plugin.json`
  - Setup token support: Claude setup-token paste flow
  - Config location: via Pi framework

- Google (Gemini)
  - SDK/Client: `@mariozechner/pi-ai` (embedded)
  - Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variables
  - Manifest: `extensions/google/openclaw.plugin.json`
  - OAuth support: Google Gemini CLI OAuth
  - Services: Chat, embeddings, video understanding, image generation
  - Config location: via Pi framework

- AWS Bedrock
  - SDK/Client: `@aws-sdk/client-bedrock` 3.1009.0
  - Auth: AWS credentials (via SDK)
  - Extension: `extensions/amazon-bedrock/`
  - Models: Multiple foundation models through Bedrock

**Additional LLM Providers:**

- Mistral AI, Qwen, Minimax, Moonshot, ModelStudio, OpenRouter, GitHub Copilot, Ollama, NVIDIA, Hugging Face, Open Prose, Kimi, Kilocode, Byteplus, CloudFlare AI Gateway, OpenCode (Go and JS variants)
- Location: Each has own extension in `extensions/`
- Auth: Per-provider (API keys, OAuth, etc.)

**Messaging Channels:**

- **Discord** - `extensions/discord/`
  - SDK/Client: discord-api-types, custom gateway integration
  - Auth: Bot token via `DISCORD_BOT_TOKEN`
  - Features: Message routing, voice, thread management, reactions, embeds
  - Runtime: `src/plugins/runtime/runtime-discord*.ts`

- **Telegram** - `extensions/telegram/`
  - SDK/Client: grammy 1.41.1 + @grammyjs/runner
  - Auth: Bot token via `TELEGRAM_BOT_TOKEN`
  - Features: Message handling, inline keyboards, media uploads
  - Runtime: `src/plugins/runtime/runtime-telegram*.ts`
  - Throttling: @grammyjs/transformer-throttler

- **Slack** - `extensions/slack/`
  - SDK/Client: @slack/bolt 4.6.0, @slack/web-api 7.15.0
  - Auth: Bot token, app-level token via environment
  - Features: Message routing, file handling, slash commands

- **WhatsApp** - `extensions/whatsapp/`
  - SDK/Client: @whiskeysockets/baileys 7.0.0-rc.9
  - Auth: WhatsApp Web session management
  - Features: WhatsApp Web protocol bridging

- **Signal** - `extensions/signal/`
  - Integration for Signal messaging protocol

- **Matrix** - `extensions/matrix/`
  - SDK/Client: @matrix-org/matrix-sdk-crypto-nodejs
  - Integration for Matrix protocol

- **LINE** - `extensions/line/`
  - SDK/Client: @line/bot-sdk 10.6.0
  - Auth: LINE channel access token

- **Feishu (Lark)** - `extensions/feishu/`
  - SDK/Client: @larksuiteoapi/node-sdk 1.59.0
  - Auth: Feishu app credentials

- **Google Chat** - `extensions/googlechat/`

- **Mattermost** - `extensions/mattermost/`

- **Nextcloud Talk** - `extensions/nextcloud-talk/`

- **Synology Chat** - `extensions/synology-chat/`

- **IRC** - `extensions/irc/`

- **Nostr** - `extensions/nostr/`

- **Twitch** - `extensions/twitch/`

- **Tlon (Urbit)** - `extensions/tlon/`

- **Zalo** - `extensions/zalo/` (and zalouser)

- **Blueubbles** - `extensions/bluebubbles/` (macOS Messages bridge)

- **Device Pair** - `extensions/device-pair/` (multi-device support)

- **Voice Call** - `extensions/voice-call/`

- **ACPX** - `extensions/acpx/` (Assistant Control Protocol)

- **Copilot Proxy** - `extensions/copilot-proxy/`

- **Lobster** - `extensions/lobster/`

- **LLM Task** - `extensions/llm-task/` (LLM task execution)

## Data Storage

**Databases:**

- SQLite (Node.js built-in `node:sqlite`)
  - Connection: Single-process file-based at `~/.openclaw/data/` (default)
  - Client: `src/memory/sqlite.ts` (wrapper around Node's sqlite module)
  - Purpose: Main application state, config, session storage
  - Schema: `src/memory/memory-schema.ts` (vector storage tables)

- LanceDB 0.26.2
  - Connection: Vector database for embeddings
  - Purpose: Semantic search, memory indexing
  - Integration: `src/memory/manager.ts`, `@lancedb/lancedb`
  - Schema: Vector table with embeddings managed by `MemoryIndexManager`

- sqlite-vec 0.1.7-alpha.2
  - SQLite extension for vector operations
  - Used in conjunction with sqlite for vector search

**File Storage:**

- Local filesystem only
  - Default: `~/.openclaw/` (configuration, credentials, sessions)
  - Build output: `dist/` (local)
  - Workspace: `~/.openclaw/workspace/` (per-agent)
  - Media cache: Local temporary storage

**Caching:**

- In-memory caching via Node.js Maps (code-level caching)
- No external cache service (Redis, Memcached)
- File system caching for embeddings and memory indices

## Authentication & Identity

**Auth Providers:**

**OpenAI OAuth:**

- Method: Browser OAuth flow for Codex (`openai-codex` provider)
- Implementation: `src/commands/openai-codex-oauth.ts`
- Reference: `extensions/openai/openclaw.plugin.json`

**Google OAuth:**

- Method: Browser OAuth for Gemini
- Implementation: `src/providers/google-shared.ts`
- Reference: `extensions/google/openclaw.plugin.json`

**Anthropic Setup Token:**

- Method: setup-token paste flow (proprietary Anthropic auth)
- Reference: `extensions/anthropic/openclaw.plugin.json`

**Custom Authentication:**

- Gateway auth: `src/gateway/auth.ts`
- Rate limiting: `src/gateway/auth-rate-limit.ts`
- Session management: `src/config/sessions/`
- Authorization policies: `src/gateway/auth-mode-policy.ts`

**API Key Management:**

- Environment variable injection for provider credentials
- Secure credential storage: `~/.openclaw/credentials/`
- Secret runtime snapshot: `src/secrets/runtime.js`
- Config-driven credential mapping via `src/plugins/bundled-provider-auth-env-vars.ts`

## Monitoring & Observability

**Error Tracking:**

- None configured (custom error handling)
- Error propagation via gateway protocol
- Local logging via `src/logging/`

**Logs:**

- In-process logging via tslog 4.10.2
- Subsystem loggers: `src/logging/subsystem.ts`
- Structured logging with context
- Diagnostic events: `src/infra/diagnostic-events.ts`
- Unified logs (macOS): queried via `scripts/clawlog.sh`

**Diagnostics:**

- OpenTelemetry support: `extensions/diagnostics-otel/` (plugin SDK export)
- Doctor command: `openclaw doctor` (health checks)
- Health monitoring: `src/gateway/channel-health-monitor.ts`
- Gateway readiness probes: `src/gateway/server/readiness.ts`

**System Events:**

- Heartbeat events: `src/infra/heartbeat-events.ts`
- Agent events: `src/infra/agent-events.ts`
- System event queue: `src/infra/system-events.ts`

## CI/CD & Deployment

**Hosting:**

- Multi-platform:
  - macOS app (distributed via Sparkle)
  - iOS app (TestFlight via Xcode)
  - Android app (Play Store)
  - CLI npm package (npm registry)
  - Docker images (Docker Hub via `docker-release.yml`)

**CI Pipeline:**

- GitHub Actions (`.github/workflows/`)
  - `ci.yml` - Main test/build pipeline
  - `docker-release.yml` - Docker image builds
  - `openclaw-npm-release.yml` - npm publish (trusted publishing)
  - `codeql.yml` - Security scanning
  - `auto-response.yml` - GitHub issue/PR automation
  - `stale.yml` - Stale issue management

**npm Publishing:**

- GitHub trusted publishing (no NPM_TOKEN required)
- Separate flow for `@openclaw/*` scoped packages (maintainer-only auth)
- npm dist-tag: `latest` (stable), `beta` (prerelease)

**Deployment Targets:**

- Self-hosted: macOS app, CLI, Docker
- Cloud: Slack, Discord, Telegram, WhatsApp (message routing)
- Mobile: iOS, Android (local agents)

## Environment Configuration

**Required env vars (provider-specific):**

- `OPENAI_API_KEY` - OpenAI
- `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` - Anthropic
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` - Google
- `DISCORD_BOT_TOKEN` - Discord
- `TELEGRAM_BOT_TOKEN` - Telegram
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` - Slack
- `LINE_CHANNEL_ACCESS_TOKEN` - LINE
- AWS credentials (for Bedrock)
- Per-channel provider tokens as needed

**System env vars:**

- `OPENCLAW_SKIP_CHANNELS` - Skip channel initialization
- `OPENCLAW_PROFILE` - dev/production profile
- `OPENCLAW_TEST_PROFILE` - Test execution profile
- `NODE_ENV` - Node environment
- `DEBUG` - Debug logging

**Config location:**

- `~/.openclaw/config.json` - Main config file
- `.env` files - Supported but not recommended (use secure credential storage)
- CLI flags - Override config

**Secrets location:**

- `~/.openclaw/credentials/` - Web provider credentials
- Environment variables (for deploy)
- Encrypted storage via operating system (macOS Keychain, etc.)
- Not in version control (`.gitignore`)

## Webhooks & Callbacks

**Incoming Webhooks:**

- Gateway HTTP endpoints: `src/gateway/server.impl.ts`
- Webhook mode for channels: `src/gateway/channel-health-policy.ts`
- Message handling: `src/gateway/server-channels.ts`
- Protocol: ACP (Agent Control Protocol) over WebSocket + HTTP

**Outgoing Webhooks:**

- Cron-based jobs: `src/gateway/server-cron.ts`
- SSRF-guarded outbound calls: `src/infra/outbound/`
- Message action runner: `src/infra/outbound/message-action-runner.ts`
- Tool invocation hooks: `src/gateway/tools-invoke-http.ts`

**Hook System:**

- Global hooks: `src/plugins/hook-runner-global.js`
- Channel lifecycle hooks: `src/hooks/`
- Plugin hook registration: `src/gateway/server-methods.js`

## Plugin Extension Points

**Plugin System:**

- Plugin SDK: `src/plugin-sdk/` (exported to npm as `openclaw/plugin-sdk`)
- Runtime: `src/plugins/runtime/index.js`
- Registry: `src/plugins/registry.ts`
- Hook runners: `src/plugins/hook-runner-*.ts`
- Extensions directory: `extensions/` (bundled plugins)

**Bundled Providers:**

- Anthropic, Google, OpenAI, Amazon Bedrock core support
- 50+ additional provider extensions
- Channel plugins for all messaging platforms

---

_Integration audit: 2026-03-17_
