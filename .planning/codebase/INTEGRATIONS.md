# External Integrations

**Analysis Date:** 2026-03-26

## APIs & External Services

**Language Models (LLM Providers):**

- Anthropic Claude - Direct and via Google Vertex AI
  - SDK: `@anthropic-ai/vertex-sdk` (Vertex) or vendor-specific
  - Auth: `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEYS` (comma-separated for rotation)
  - Config: `extensions/anthropic/`, `extensions/anthropic-vertex/`

- OpenAI (GPT models)
  - Auth: `OPENAI_API_KEY` or `OPENAI_API_KEYS` (multiple keys for rotation)
  - WebSocket streaming: `src/agents/openai-ws-stream.ts`, `openai-ws-connection.ts`
  - HTTP endpoint support via `src/gateway/openai-http.js`

- Google Gemini
  - Auth: `GEMINI_API_KEY` or `GEMINI_API_KEYS`
  - Schema cleaning: `src/agents/schema/clean-for-gemini.ts`

- AWS Bedrock
  - SDK: `@aws-sdk/client-bedrock` (v3.1014.0)
  - Discovery: `src/agents/bedrock-discovery.js`
  - Extension: `extensions/amazon-bedrock/`

- Cloudflare AI Gateway
  - Provider ID: `cloudflare-ai-gateway`
  - Auth: `CLOUDFLARE_AI_GATEWAY_API_KEY`
  - Default model: `claude-sonnet-4-5`

- Vercel AI Gateway
  - Provider ID: `vercel-ai-gateway`
  - Default model: `anthropic/claude-opus-4.6`

- Additional Providers (82 extensions total covering):
  - DeepSeek, Mistral, Groq, HuggingFace, Together, Qwen, Moonshot, Kimi Coding, OpenRouter, xAI, Deepgram (speech), Perplexity, ZAI, Ollama, Vllm, ModelStudio, BytePlus, VolcEngine

**Web Search & Content:**

- Brave Web Search API
  - Auth: `BRAVE_API_KEY`
  - Extension: `extensions/brave/`

- DuckDuckGo (built-in, no API key)
  - Extension: `extensions/duckduckgo/`

- Perplexity API
  - Auth: `PERPLEXITY_API_KEY` (format: `pplx-...`)
  - Extension: `extensions/perplexity/`

- Tavily Search API
  - Extension: `extensions/tavily/`

- Exa Search
  - Extension: `extensions/exa/`

- FireCrawl
  - Auth: `FIRECRAWL_API_KEY`
  - Extension: `extensions/firecrawl/`

**Voice & TTS:**

- ElevenLabs Text-to-Speech
  - Auth: `ELEVENLABS_API_KEY` or `XI_API_KEY` (alias)
  - Extension: `extensions/elevenlabs/`
  - Library: `node-edge-tts` (Edge TTS fallback)

- Deepgram Speech-to-Text
  - Auth: `DEEPGRAM_API_KEY`
  - Extension: `extensions/deepgram/`

**Image Generation & Processing:**

- FAL AI (image generation)
  - Extension: `extensions/fal/`

- image-generation runtime: `src/image-generation/`
  - Supports: OpenAI DALL-E, Azure, custom endpoints

## Messaging Channels

**Core Channels (built-in):**

- **Telegram** - `src/telegram/`, `extensions/telegram/`
  - Auth: `TELEGRAM_BOT_TOKEN`

- **Discord** - `src/discord/`, `extensions/discord/`
  - Auth: `DISCORD_BOT_TOKEN` (raw token, no prefix)

- **Slack** - `src/slack/`, `extensions/slack/`
  - Auth: `SLACK_BOT_TOKEN` (format: `xoxb-...`), `SLACK_APP_TOKEN` (format: `xapp-...`)

- **WhatsApp Web** - `src/web/`, `src/markdown/whatsapp.ts`
  - Browser-based automation (playwright-core)

- **Signal** - `extensions/signal/`
  - SignalCliRest protocol integration

**Channel Extensions (82 plugins, key ones):**

- **iMessage** - `extensions/imessage/` (macOS Bluetooth integration)
- **LINE** - `extensions/line/` (SDK: `@line/bot-sdk` v10.6.0)
- **Matrix** - `extensions/matrix/` (open protocol)
- **Mattermost** - `extensions/mattermost/` + fallback env: `MATTERMOST_BOT_TOKEN`, `MATTERMOST_URL`
- **MSTeams** - `extensions/msteams/`
- **IRC** - `extensions/irc/` (raw IRC protocol)
- **Twitch Chat** - `extensions/twitch/` + env: `OPENCLAW_TWITCH_ACCESS_TOKEN`
- **Zalo** - `extensions/zalo/` (Vietnamese messaging)
- **Zalo User** - `extensions/zalouser/` (user-mode Zalo)
- **Voice Call** - `extensions/voice-call/`
- **BlueBubbles** - `extensions/bluebubbles/` (iMessage relay)
- **Tlon (Urbit)** - `extensions/tlon/`
- **Feishu** - `extensions/feishu/` (Lark)
- **Google Chat** - `extensions/googlechat/`
- **NextCloud Talk** - `extensions/nextcloud-talk/`
- **Nostr** - `extensions/nostr/` (decentralized protocol)
- **Synology Chat** - `extensions/synology-chat/`
- **XMPP/Chutes** - `extensions/chutes/`

## Data Storage

**Primary Database:**

- SQLite (Node.js native `node:sqlite` module)
  - Location: `~/.openclaw/` (configurable via `OPENCLAW_STATE_DIR`)
  - Vector support: `sqlite-vec` 0.1.7 for embeddings
  - Manager: `src/memory/qmd-manager.ts`
  - Schema: `src/memory/memory-schema.ts`
  - Search: `src/memory/manager-search.ts`

**Session Storage:**

- Pi session logs: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Gateway sessions: `~/.openclaw/sessions/`

**File Storage:**

- Local filesystem only (no cloud storage integration)
- Temporary paths via `openclaw/plugin-sdk/temp-path`
- JSON store: `openclaw/plugin-sdk/json-store` (file-based)

**Cache:**

- In-process (no external cache service)
- Chokidar-based file watching: `chokidar` ^5.0.0

## Authentication & Identity

**Gateway Auth:**

- Token-based: `OPENCLAW_GATEWAY_TOKEN` (environment variable)
- Password-based: `OPENCLAW_GATEWAY_PASSWORD` (alternative, not simultaneously)
- WebSocket authentication: `src/gateway/server/http-auth.ts`

**External OAuth/API Keys:**

- All provider API keys stored in `.env` or `~/.openclaw/.env`
- Credential storage: `~/.openclaw/credentials/` (web provider creds)
- Secret management: Direct env vars or config file entries (no vault integration)

**Device Pairing:**

- QR code generation: `qrcode-terminal` ^0.12.0 (`src/pairing/`)
- mDNS/Bonjour support: `@homebridge/ciao` ^1.3.5
- Extension: `extensions/device-pair/`

## Monitoring & Observability

**Logging:**

- `tslog` ^4.10.2 - Structured logging with levels
- Channel-specific: `src/channels/logging.ts`
- Log exports/templates: `src/terminal/` (ANSI formatting)

**Error Tracking:**

- None detected (no Sentry, Bugsnag, etc.)
- Error handling via try-catch and validation (Zod)
- Test error fixtures: `src/agents/live-model-errors.ts`

**Diagnostics:**

- OpenTelemetry support: `extensions/diagnostics-otel/`
- Config schema validation: `src/agents/models-config.ts`
- System prompt reporting: `src/agents/system-prompt-report.ts`

## CI/CD & Deployment

**Source Control:**

- GitHub: `https://github.com/openclaw/openclaw`

**Hosting:**

- CLI: npm package (`openclaw`)
- macOS app: Distributed via Sparkle updates (`appcast.xml`)
- Installers: Sibling repo `../openclaw.ai` (`public/install.sh`, `install-cli.sh`, `install.ps1`)
- Gateway runs locally or on VM (exe.dev infrastructure mentioned in docs)

**CI Pipeline:**

- GitHub Actions (referenced in test configs)
- Pre-commit hooks: Oxlint, Oxfmt, TypeScript checks (`prek install`)

**Build Artifacts:**

- `dist/` - Built JavaScript (ESM modules)
- Binary: `openclaw.mjs` (CLI entry point)
- Docs: Generated in `docs/.generated/`
- SDK API: Plugin SDK baseline in `docs/.generated/`

## Environment Configuration

**Required env vars (conditional on enabled features):**

- `OPENCLAW_GATEWAY_TOKEN` - Gateway auth (recommended for non-loopback)
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` - At least one LLM
- `TELEGRAM_BOT_TOKEN` - For Telegram channel
- `DISCORD_BOT_TOKEN` - For Discord channel
- `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` - For Slack channel

**Optional overrides:**

- `OPENCLAW_STATE_DIR` - Config/session directory (default: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` - Config file path (default: `~/.openclaw/openclaw.json`)
- `OPENCLAW_HOME` - Home directory (default: `~`)
- `OPENCLAW_LOAD_SHELL_ENV` - Import env from login shell
- `OPENCLAW_LOAD_SHELL_ENV_TIMEOUT_MS` - Shell env load timeout (default: 15000)

**Secrets Location:**

- Environment files: `.env` (local dev) or `~/.openclaw/.env` (daemon mode)
- Config file: `~/.openclaw/openclaw.json` (yaml or json5)
- Never committed (covered by `.gitignore` and `detect-secrets`)

## Webhooks & Callbacks

**Incoming:**

- Channel-specific webhook endpoints (Telegram, Discord, Slack, LINE, etc.)
- `src/channels/web/` - Web channel transport
- `src/routing/` - Message routing and handling

**Outgoing:**

- Auto-reply hooks: `src/auto-reply/`
- Custom webhook support: `openclaw/plugin-sdk/webhook-path`
- Channel send result tracking: `openclaw/plugin-sdk/channel-send-result`

## Tool Integration

**Agent Tools Runtime:**

- Model context protocol (MCP) SDK support: `@modelcontextprotocol/sdk` 1.27.1
- Tool execution: `src/agents/pi-tools.*.test.ts` (tool filtering, gating, etc.)
- Tool images: `src/agents/tool-images.test.ts` (image rendering in tool context)
- WhatsApp-specific gating: `src/agents/pi-tools.whatsapp-login-gating.test.ts`

**Browser & Automation:**

- Playwright headless browser: `playwright-core` 1.58.2
- Navigation guard: `src/browser/pw-session.create-page.navigation-guard.ts`
- Screenshot support: `src/browser/screenshot.test.ts`

---

_Integration audit: 2026-03-26_
