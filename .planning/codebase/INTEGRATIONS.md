# External Integrations

**Analysis Date:** 2026-03-28

## AI / LLM Providers

Each provider is a bundled plugin under `extensions/<provider>/` using the Plugin SDK. Auth resolves from environment variables via `src/plugins/bundled-provider-auth-env-vars.generated.ts`.

**Anthropic:**

- Extension: `extensions/anthropic/`
- Auth env: `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`
- Vertex variant: `extensions/anthropic-vertex/` via `@anthropic-ai/vertex-sdk` ^0.14.4
  - Auth: GCP Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`) or service account JSON

**OpenAI:**

- Extension: `extensions/openai/`
- SDK: `openai` ^6.33.0
- Auth env: `OPENAI_API_KEY`
- Includes: standard chat, image generation, speech (TTS), media understanding, Codex (OAuth)
- OpenAI Codex OAuth flow: `extensions/openai-codex-auth/`, `src/commands/openai-codex-oauth.ts`

**Google (Gemini):**

- Extension: `extensions/google/`
- Auth env: `GEMINI_API_KEY`, `GOOGLE_API_KEY`
- Vertex variant: uses `@anthropic-ai/vertex-sdk` + GCP ADC

**AWS Bedrock:**

- Extension: `extensions/amazon-bedrock/`
- SDK: `@aws-sdk/client-bedrock` ^3.1019.0
- Auth: AWS credentials (standard AWS SDK credential chain)

**GitHub Copilot:**

- Extension: `extensions/github-copilot/`, `extensions/copilot-proxy/`
- Auth env: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
- OAuth login: `extensions/openai-codex-auth/`, `src/plugin-sdk/github-copilot-login.ts`

**Other AI Providers (all via extensions):**

- Groq: `extensions/groq/` - Auth: `GROQ_API_KEY`
- Mistral: `extensions/mistral/` - Auth: `MISTRAL_API_KEY`
- DeepSeek: `extensions/deepseek/` - Auth: `DEEPSEEK_API_KEY`
- xAI (Grok): `extensions/xai/` - Auth: `XAI_API_KEY`
- Together AI: `extensions/together/` - Auth: `TOGETHER_API_KEY`
- OpenRouter: `extensions/openrouter/` - Auth: `OPENROUTER_API_KEY`
- Perplexity: `extensions/perplexity/` - Auth: `PERPLEXITY_API_KEY`
- Ollama: `extensions/ollama/` - Auth: `OLLAMA_API_KEY` (optional for local)
- HuggingFace: `extensions/huggingface/` - Auth: `HUGGINGFACE_HUB_TOKEN`, `HF_TOKEN`
- NVIDIA: `extensions/nvidia/` - Auth: `NVIDIA_API_KEY`
- Fal: `extensions/fal/` - Auth: `FAL_KEY`
- Venice: `extensions/venice/` - Auth: `VENICE_API_KEY`
- Chutes: `extensions/chutes/` - Auth: `CHUTES_API_KEY`, `CHUTES_OAUTH_TOKEN`
- Cloudflare AI Gateway: `extensions/cloudflare-ai-gateway/` - Auth: `CLOUDFLARE_AI_GATEWAY_API_KEY`
- Vercel AI Gateway: `extensions/vercel-ai-gateway/` - Auth: `AI_GATEWAY_API_KEY`
- LiteLLM: `extensions/litellm/` - Auth: `LITELLM_API_KEY`
- BytePlus: `extensions/byteplus/` - Auth: `BYTEPLUS_API_KEY`
- VolcEngine: `extensions/volcengine/` - Auth: `VOLCANO_ENGINE_API_KEY`
- MiniMax: `extensions/minimax/` - Auth: `MINIMAX_API_KEY`, `MINIMAX_OAUTH_TOKEN`
- Moonshot: `extensions/moonshot/` - Auth: `MOONSHOT_API_KEY`
- Kimi / Kimi Coding: `extensions/kimi/`, `extensions/kimi-coding/` - Auth: `KIMI_API_KEY`, `KIMICODE_API_KEY`
- ModelStudio: `extensions/modelstudio/` - Auth: `MODELSTUDIO_API_KEY`
- Qianfan: `extensions/qianfan/` - Auth: `QIANFAN_API_KEY`
- SGLang: `extensions/sglang/` - Auth: `SGLANG_API_KEY`
- vLLM: `extensions/vllm/` - Auth: `VLLM_API_KEY`
- Microsoft Azure OpenAI (Foundry): `extensions/microsoft-foundry/` - Auth: `AZURE_OPENAI_API_KEY`
- Kilocode: `extensions/kilocode/` - Auth: `KILOCODE_API_KEY`
- ZAI: `extensions/zai/` - Auth: `ZAI_API_KEY`, `Z_AI_API_KEY`
- Xiaomi: `extensions/xiaomi/` - Auth: `XIAOMI_API_KEY`
- OpenCode / OpenCode Go: `extensions/opencode/`, `extensions/opencode-go/` - Auth: `OPENCODE_API_KEY`

## Messaging Channel Integrations

All channels are plugins. Core channels use bundled extensions; community channels may use external extensions.

**Telegram:**

- Extension: `extensions/telegram/`
- SDK: `grammy` ^1.41.1 + `@grammyjs/runner` + `@grammyjs/transformer-throttler`
- Auth: Bot token (raw token configured in gateway)
- Config docs: `docs/channels/telegram.md`

**Discord:**

- Extension: `extensions/discord/`
- SDK: `@buape/carbon` + `discord-api-types` + `@discordjs/voice`
- Auth: Bot token; guild allowlist via `channels.discord.guilds` config (JSON object, not dotted path)
- Supports Discord webhooks for delivery (`extensions/discord/src/monitor/reply-delivery.ts`)
- Config docs: `docs/channels/discord.md`

**Slack:**

- Extension: `extensions/slack/`
- SDK: `@slack/bolt` + `@slack/web-api`
- Auth: Bot token + signing secret
- Config docs: `docs/channels/slack.md`

**WhatsApp (Web):**

- Extension: `extensions/whatsapp/`
- SDK: `@whiskeysockets/baileys` (native build required)
- Auth: QR code scan (WhatsApp Web protocol, no official API)
- Config docs: `docs/channels/whatsapp.md`

**Matrix:**

- Extension: `extensions/matrix/`
- SDK: `matrix-js-sdk` 41.2.0 + `@matrix-org/matrix-sdk-crypto-nodejs` (native build)
- Auth: Access token or password (homeserver URL + credentials)
- Config docs: `docs/channels/matrix.md`

**Signal:**

- Extension: `extensions/signal/`
- Auth: Signal account (via signal-cli bridge)
- Config docs: `docs/channels/signal.md`

**Microsoft Teams:**

- Extension: `extensions/msteams/`
- Auth: Azure AD bot credentials
- Config docs: `docs/channels/msteams.md` (if present)

**LINE:**

- SDK: `@line/bot-sdk` ^10.6.0 (core dependency)
- Extension: `extensions/line/`

**Zalo / ZaloUser:**

- Extensions: `extensions/zalo/`, `extensions/zalouser/`

**Feishu:**

- Extension: `extensions/feishu/`

**Mattermost:**

- Extension: `extensions/mattermost/`

**Twitch:**

- Extension: `extensions/twitch/`

**IRC:**

- Extension: `extensions/irc/`

**Nostr:**

- Extension: `extensions/nostr/`

**Google Chat:**

- Extension: `extensions/googlechat/`

**Nextcloud Talk:**

- Extension: `extensions/nextcloud-talk/`

**Synology Chat:**

- Extension: `extensions/synology-chat/`

**Tlon:**

- Extension: `extensions/tlon/`
- SDK: `@tloncorp/api` + `@tloncorp/tlon-skill` (native build)

**iMessage (via BlueBubbles):**

- Extension: `extensions/bluebubbles/`
- Plugin SDK seams: `src/plugin-sdk/bluebubbles.ts`, `src/plugin-sdk/bluebubbles-policy.ts`
- Config docs: `docs/channels/imessage.md`

**iMessage (macOS native):**

- Core source: `src/imessage/`
- Requires macOS + Messages app access

**Voice Call:**

- Extension: `extensions/voice-call/`

**Phone Control:**

- Extension: `extensions/phone-control/`

**Web (WebSocket):**

- Core source: `src/web/`, `src/channel-web.ts`
- Control UI served via gateway HTTP server; clients connect over WebSocket

## Data Storage

**Databases:**

- SQLite (Node.js built-in `node:sqlite`) - Memory search storage (`extensions/memory-core/src/memory/`)
  - Vector extension: `sqlite-vec` 0.1.7 for similarity queries
  - Config: `agents.defaults.memorySearch.local.vector.enabled` + optional `extensionPath`
- LanceDB (`@lancedb/lancedb` ^0.27.1) - Optional vector store (`extensions/memory-lancedb/`)
  - For long-term memory with auto-recall/capture

**File Storage:**

- Local filesystem only
- Config: `~/.openclaw/openclaw.json`
- Credentials: `~/.openclaw/credentials/`
- Sessions: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Logs: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (structured), `/tmp/openclaw-gateway.log` (stdout)

**Caching:**

- In-memory only (no external cache service)

## Authentication & Identity

**Auth Provider:**

- Custom (no third-party auth service)
- API key authentication for the local gateway: `OPENCLAW_API_KEY` env var
- Provider-specific keys stored as SecretRef in config
- Credentials stored at `~/.openclaw/credentials/` (web provider login)
- Device pairing uses QR codes (`src/pairing/`, `qrcode-terminal`)

## Search & Web Tools

**Web Search:**

- Brave Search: `extensions/brave/` - Auth: `BRAVE_API_KEY`
- Exa: `extensions/exa/` - Auth: `EXA_API_KEY`
- Tavily: `extensions/tavily/` - Auth: `TAVILY_API_KEY`
- Firecrawl: `extensions/firecrawl/` - Auth: `FIRECRAWL_API_KEY`
- DuckDuckGo: `extensions/duckduckgo/` (no API key)
- Perplexity: `extensions/perplexity/`
- Linq: `extensions/linq/`

**Browser Automation:**

- Playwright Core: `playwright-core` 1.58.2 (`extensions/browser/src/browser/`)
- Used for web scraping, screenshot capture, page interaction

## Monitoring & Observability

**Error Tracking:**

- None (no external error tracking service detected)

**OpenTelemetry (optional plugin):**

- Extension: `extensions/diagnostics-otel/`
- SDKs: `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-logs-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto`
- Export endpoint: configurable via env (standard OTLP endpoint)

**Logs:**

- Structured file logging via `tslog` (`src/logging/logger.ts`)
- Log files: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- macOS unified logs: query via `scripts/clawlog.sh`
- Gateway stdout/stderr: `/tmp/openclaw-gateway.log`

## Network & Discovery

**Tailscale:**

- Used for gateway network discovery and remote access
- Integration: `src/infra/tailscale.ts`, `src/shared/tailscale-status.ts`
- No SDK; invokes `tailscale status` CLI and parses JSON output

**Bonjour/mDNS (local network discovery):**

- SDK: `@homebridge/ciao` ^1.3.5
- Used for local gateway discovery (`src/infra/bonjour-discovery.ts`, `src/infra/bonjour-ciao.ts`)

**SSRF Protection:**

- Custom SSRF guard via `undici` (`src/infra/net/ssrf.ts`, `src/infra/net/fetch-guard.ts`)

## Protocol Standards

**MCP (Model Context Protocol):**

- SDK: `@modelcontextprotocol/sdk` 1.28.0
- Server and client support (`src/mcp/`)
- MCP channels: Docker test in `scripts/e2e/mcp-channels-docker.sh`

**ACP (Agent Client Protocol):**

- SDK: `@agentclientprotocol/sdk` 0.17.0
- Server: `src/acp/server.startup.ts`

## CI/CD & Deployment

**Hosting:**

- Local gateway (self-hosted); no cloud hosting requirement for core
- macOS: launchctl LaunchAgent `com.openclaw.gateway`
- Linux: direct process (no systemd user session on tested Ubuntu snapshot)
- Cloud example: Fly.io (`flawd-bot` app, managed separately)

**CI Pipeline:**

- GitHub Actions (`.github/workflows/`)
- Trusted publishing for npm (no `NPM_TOKEN` for core)
- Docker-based E2E tests: `scripts/e2e/*.sh`
- Parallels VM smoke tests: macOS, Windows, Linux (`scripts/e2e/parallels-*.sh`)

**Deployment Targets:**

- npm package: `openclaw` (CLI + gateway)
- macOS app: `.app` bundle via `scripts/package-mac-app.sh`
- iOS: via Xcode / `scripts/ios-beta-release.sh`
- Android: Gradle AAB via `apps/android/scripts/build-release-aab.ts`

## Webhooks & Callbacks

**Incoming (gateway HTTP endpoints):**

- Telegram: optional webhook mode (port configurable; `extensions/telegram/src/channel.ts`)
- Discord: webhook delivery for replies (`extensions/discord/src/monitor/reply-delivery.ts`)
- Gateway WebSocket: clients connect to gateway for control UI and CLI bridge
- Plugin HTTP handlers registered via Plugin SDK (`src/plugins/` loader enforces no-raw-register policy per `pnpm lint:plugins:no-register-http-handler`)

**Outgoing:**

- AI provider API calls (all providers)
- Channel API calls (Telegram Bot API, Discord API, Slack API, etc.)
- Webhook delivery for Discord replies

## Environment Configuration

**Required env vars (by use case):**

- Gateway auth: `OPENCLAW_API_KEY`
- AI providers: per-provider key (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`)
- Messaging channels: tokens set during `openclaw onboard` (stored in config, not env)
- GCP/Vertex: `GOOGLE_APPLICATION_CREDENTIALS` (service account JSON path) or ADC

**Secrets location:**

- `~/.openclaw/openclaw.json` (SecretRef entries pointing to env vars or literal values)
- `~/.openclaw/credentials/` (OAuth tokens from `openclaw login`)
- Never committed; strict JSON format validated at startup

---

_Integration audit: 2026-03-28_
