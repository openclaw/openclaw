# External Integrations

**Analysis Date:** 2026-02-15

## APIs & External Services

**LLM Model Providers:**
- Anthropic Claude - Primary AI model provider
  - SDK/Client: Built-in via pi-ai framework
  - Auth: `ANTHROPIC_API_KEY`, stored in auth profiles
  - File: `src/agents/auth-profiles/`

- OpenAI - GPT models support
  - SDK/Client: Native HTTP client
  - Auth: `OPENAI_API_KEY`
  - File: `src/agents/models-config.providers.ts`

- AWS Bedrock - Claude and Llama model access
  - SDK/Client: `@aws-sdk/client-bedrock` (3.990.0)
  - Auth: AWS SDK credentials
  - File: `src/agents/bedrock-discovery.ts`, `src/agents/model-auth.ts`

- Google Gemini
  - Auth: `GEMINI_API_KEY`

- OpenRouter - Model aggregation API
  - Auth: `OPENROUTER_API_KEY`

- Minimax Portal - Chinese LLM provider
  - SDK/Client: Anthropic-compatible API at `https://api.minimax.io/anthropic`
  - Auth: `MINIMAX_API_KEY`, OAuth support via `minimax-oauth`
  - File: `src/agents/models-config.providers.ts` (lines 36-47)

- Xiaomi MiMo - Chinese model provider
  - Base URL: `https://api.xiaomimimo.com/anthropic`
  - Cost: Free tier available
  - File: `src/agents/models-config.providers.ts`

- Moonshot (Kimi) - Chinese LLM
  - Base URL: `https://api.moonshot.ai/v1`
  - Model: `kimi-k2.5`

- Qwen Portal - Alibaba's LLM
  - Base URL: `https://portal.qwen.ai/v1`
  - OAuth support

- Together - Model serving platform
  - Base URL: Configured via `TOGETHER_BASE_URL`
  - File: `src/agents/together-models.ts`

- Venice.AI - Model aggregation
  - Auth: Env var support
  - File: `src/agents/venice-models.ts`

- Hugging Face - Model hosting and inference
  - Base URL: `https://huggingface.co`
  - File: `src/agents/huggingface-models.ts`

- Synthetic.run - Model API
  - Auth: `SYNTHETIC_API_KEY`

- Cloudflare AI Gateway
  - Base URL: Resolved from config
  - File: `src/agents/cloudflare-ai-gateway.ts`

- Ollama - Local LLM server
  - Base URL: `http://localhost:11434` (default)
  - Client: `ollama` npm package (0.6.3, dev dependency)
  - File: `src/agents/ollama-stream.ts`

- Chutes - OAuth token provider (used for model authentication fallback)
  - File: `src/agents/chutes-oauth.ts`

**Messaging Channels:**
- Telegram
  - SDK: Grammy 1.40.0
  - Auth: `TELEGRAM_BOT_TOKEN`
  - Webhook support: `src/telegram/webhook.ts`, `src/telegram/webhook-set.ts`
  - Files: `src/telegram/`, `extensions/telegram/`

- Discord
  - SDK: Discord API types 0.38.39
  - Auth: `DISCORD_BOT_TOKEN`
  - Files: `src/discord/`, `extensions/discord/`

- Slack
  - SDK: @slack/bolt 4.6.0, @slack/web-api 7.14.1
  - Auth: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
  - HTTP handler: `src/gateway/server-http.ts` (handles Slack events)
  - Files: `src/slack/`

- LINE
  - SDK: @line/bot-sdk 10.6.0
  - Auth: `LINE_BOT_TOKEN`, signature verification
  - Webhook support: `src/line/webhook.ts`
  - Files: `src/line/`

- WhatsApp Web
  - SDK: @whiskeysockets/baileys 7.0.0-rc.9
  - Auth: QR code login via Web
  - Files: `src/web/`, `extensions/bluebubbles/`

- Matrix
  - SDK: Built-in implementation
  - Files: `extensions/matrix/`

- IRC
  - SDK: Built-in implementation
  - Files: `extensions/irc/`

- Signal
  - SDK: Built-in signal-cli integration
  - Files: `extensions/signal/`

- Twitch
  - SDK: Built-in implementation
  - Auth: `OPENCLAW_TWITCH_ACCESS_TOKEN` (oauth: format)
  - Files: `extensions/twitch/`

- Mattermost
  - Auth: `MATTERMOST_BOT_TOKEN`
  - URL: `MATTERMOST_URL=https://chat.example.com`
  - Files: `extensions/mattermost/`

- Zalo
  - SDK: Custom implementation
  - Auth: `ZALO_BOT_TOKEN`
  - Files: `extensions/zalo/`, `extensions/zalouser/`

- Feishu (Lark)
  - SDK: @larksuiteoapi/node-sdk 1.59.0
  - Auth: Feishu app credentials
  - Files: `extensions/feishu/`

- NextCloud Talk
  - Files: `extensions/nextcloud-talk/`

- iMessage
  - Integration: Apple device required
  - Files: `extensions/imessage/`

- Tlon (Urbit)
  - Files: `extensions/tlon/`

- MS Teams
  - Files: `extensions/msteams/`

- Phone Control
  - Files: `extensions/phone-control/`

- BlueBubbles
  - Integration: macOS bridge for iMessage
  - Files: `extensions/bluebubbles/`

**Search & Content APIs:**
- Brave Search API
  - Auth: `BRAVE_API_KEY`

- Perplexity AI
  - Auth: `PERPLEXITY_API_KEY` (pplx-... format)

- Firecrawl
  - Auth: `FIRECRAWL_API_KEY`
  - Purpose: Web scraping and content extraction

**Voice/Audio Services:**
- ElevenLabs (TTS)
  - Auth: `ELEVENLABS_API_KEY` or `XI_API_KEY` (alias)
  - File: `src/tts/tts.ts`

- Deepgram (Speech-to-Text and TTS)
  - Auth: `DEEPGRAM_API_KEY`

**Protocol/Standards:**
- Agent Client Protocol (ACP)
  - SDK: @agentclientprotocol/sdk 0.14.1
  - File: Plugin SDK integration

## Data Storage

**Databases:**
- SQLite (Node.js built-in: `node:sqlite`)
  - Connection: Embedded in process
  - Default location: `~/.openclaw/state.db`
  - Schema: `src/memory/memory-schema.ts`
  - Usage: Session storage, message history, memory management
  - File: `src/memory/sqlite.ts`

- Vector Search (SQLite with vector extension)
  - Package: `sqlite-vec` 0.1.7-alpha.2
  - Purpose: Embedding-based search for memory/context
  - File: `src/memory/sqlite-vec.ts`

**File Storage:**
- Local filesystem only
  - State directory: `~/.openclaw/`
  - Workspace directory: `~/.openclaw/workspace/`
  - Config file: `~/.openclaw/openclaw.json`

**Caching:**
- None detected - uses in-memory and SQLite for persistence

## Authentication & Identity

**Auth Provider:**
- Custom implementation (token-based)
  - Gateway token auth: `OPENCLAW_GATEWAY_TOKEN` (recommended, long random string)
  - Gateway password auth: `OPENCLAW_GATEWAY_PASSWORD` (alternative)
  - Implementation: `src/gateway/auth.ts`, `src/security/secret-equal.js`

**OAuth/Multi-Provider Auth:**
- Auth profiles system for model provider authentication
  - Supports fallback chaining when primary auth fails
  - Storage: `~/.openclaw/auth-profiles.json`
  - File: `src/agents/auth-profiles/`, `src/agents/chutes-oauth.ts`

**Device Authentication:**
- Device auth store for local authentication
  - File: `src/infra/device-auth-store.ts`

**Session Management:**
- Session-based routing with optional session key prefixes
  - File: `src/routing/session-key.ts`
  - Gateway hooks support `defaultSessionKey` and `allowedSessionKeyPrefixes`

## Monitoring & Observability

**Error Tracking:**
- None detected - uses application logging

**Logs:**
- File-based logging via built-in logger
  - Default log directory: `~/.openclaw/logs/`
  - Default log file: `openclaw.log`
  - File: `src/logging/logger.ts`, `src/logging/console.ts`
- Subsystem-based logging with level filtering
  - Supports console and file output
  - Configurable per subsystem
- Console capture for external process output
  - File: `src/logging.ts`

**Health Checks:**
- OpenClaw status endpoint available at gateway
  - Used by container orchestration (Fly.io)

## CI/CD & Deployment

**Hosting:**
- Docker containerization (Node 22-bookworm base)
- Fly.io (recommended)
  - Region: IAD (default, customizable)
  - Machine: Shared CPU 2x, 2048 MB RAM
  - Persistent volume at `/data` for state

**CI Pipeline:**
- GitHub Actions (multiple workflows in `.github/workflows/`)
- Local test suite: Vitest with multiple configs
  - Unit tests: `vitest.unit.config.ts`
  - E2E tests: `vitest.e2e.config.ts`
  - Live service tests: `vitest.live.config.ts`

**Build Artifacts:**
- Docker image: `openclaw:local` (development) or registry image (production)
- CLI binary: `openclaw` (installed via npm globally)
- Plugin SDK exports: `openclaw/plugin-sdk` path exports

## Environment Configuration

**Required env vars:**
- Model provider keys: At least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
- Gateway auth: `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`

**Optional env vars (channels & tools):**
- Channel tokens: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, etc.
- Tool APIs: `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`
- Model provider fallbacks: `ZAI_API_KEY`, `AI_GATEWAY_API_KEY`, `MINIMAX_API_KEY`

**Secrets location:**
- Process environment (highest priority)
- `./.env` file (local development)
- `~/.openclaw/.env` (daemon/systemd)
- `openclaw.json` `env` block (lowest priority)
- AWS Bedrock: Uses AWS SDK credential chain (IAM roles, profiles, environment)

**Path overrides:**
- `OPENCLAW_STATE_DIR` - State directory (default: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` - Config file path (default: `~/.openclaw/openclaw.json`)
- `OPENCLAW_HOME` - Home directory (default: `~`)
- `OPENCLAW_LOAD_SHELL_ENV` - Load environment from shell profile (optional, set to 1)
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS` - Shell env load timeout (default: 15000ms)

## Webhooks & Callbacks

**Incoming:**
- Telegram webhook: `POST /webhook/telegram/{token}`
  - File: `src/telegram/webhook.ts`
  - Configuration: `telegram-webhook-secret` support

- LINE webhook: `POST /webhook/line`
  - File: `src/line/webhook.ts`
  - Signature verification included

- Slack events: `POST /slack/events`
  - Handler: `src/gateway/server-http.ts`
  - Uses Slack bolt framework

- Generic hooks: `POST /hooks/{path}` (gateway feature)
  - File: `src/gateway/hooks.ts`, `src/gateway/server-http.ts`
  - Token-based auth with configurable path and mappings
  - Supports agent policy and session key policy

**Outgoing:**
- Model provider callbacks: Built-in streaming responses
- Auto-reply messages: Channel-specific implementations
- Webhook delivery for hook mappings
  - File: `src/gateway/hooks-mapping.ts`

---

*Integration audit: 2026-02-15*
