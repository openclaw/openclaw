# External Integrations

**Analysis Date:** 2026-03-08

## AI/LLM Providers

OpenClaw is a multi-provider AI gateway. Provider configuration lives in `src/agents/models-config.providers.ts` with model catalogs and auth resolution.

**OpenAI-compatible:**
- OpenAI - Primary provider, chat completions + responses API
  - SDK/Client: Custom HTTP via `undici` + streaming (`src/agents/pi-embedded-runner.ts`)
  - Gateway endpoint: `src/gateway/openai-http.ts` (OpenAI-compatible API)
  - OpenAI Responses API: `src/gateway/openresponses-http.ts`
  - WebSocket streaming: `src/agents/openai-ws-connection.ts`, `src/agents/openai-ws-stream.ts`
  - Auth: API key via config or env var

**OpenAI Codex:**
- Codex models (gpt-5.3-codex, gpt-5.4) via OpenAI Codex provider
  - Config: `src/agents/models-config.providers.ts` (CODEX_PROVIDER)

**Anthropic:**
- Via Pi SDK (`@mariozechner/pi-ai`)
  - Auth: API key, auth profiles with cooldown/rotation (`src/agents/auth-profiles.ts`)

**Google (Gemini):**
- Provider helpers: `src/providers/google-shared.*.ts`
- Google Gemini CLI auth extension: `extensions/google-gemini-cli-auth/`
  - Auth: API key or OAuth

**GitHub Copilot:**
- Token exchange: `src/providers/github-copilot-token.ts`
- Model catalog: `src/providers/github-copilot-models.ts`
- Auth: `src/providers/github-copilot-auth.ts`
  - Auth: OAuth token exchange from Copilot CLI auth

**AWS Bedrock:**
- Discovery: `src/agents/bedrock-discovery.ts`
  - SDK: `@aws-sdk/client-bedrock`
  - Auth: AWS SDK env vars (resolved via `resolveAwsSdkEnvVarName`)

**Ollama (Local):**
- Stream handler: `src/agents/ollama-stream.ts`
- Auto-discovery: `src/agents/models-config.providers.ollama-autodiscovery.test.ts`
  - Auth: None (local, marker: `OLLAMA_LOCAL_AUTH_MARKER`)

**MiniMax:**
- Portal auth extension: `extensions/minimax-portal-auth/`
- VLM: `src/agents/minimax-vlm.ts`
  - Base URL: `https://api.minimax.io/anthropic`
  - Auth: OAuth marker (`MINIMAX_OAUTH_MARKER`)

**Qwen (Alibaba):**
- Portal auth: `extensions/qwen-portal-auth/`
- OAuth: `src/providers/qwen-portal-oauth.ts`
  - Auth: OAuth marker (`QWEN_OAUTH_MARKER`)

**Other LLM Providers:**
- Kilocode: `src/providers/kilocode-shared.ts`, `src/agents/kilocode-models.ts`
- HuggingFace: `src/agents/huggingface-models.ts`
- Together AI: `src/agents/together-models.ts`
- Venice AI: `src/agents/venice-models.ts`
- BytePlus/Volcengine: `src/agents/byteplus-models.ts`
- Doubao: `src/agents/doubao-models.ts`
- Moonshot: `src/agents/moonshot.live.test.ts`
- Chutes: `src/agents/chutes-oauth.ts`
- OpenCode Zen: `src/agents/opencode-zen-models.ts`

**AI Gateway Proxies:**
- Cloudflare AI Gateway: `src/agents/cloudflare-ai-gateway.ts`
- Vercel AI Gateway: `src/agents/vercel-ai-gateway.ts`

**Local LLM:**
- node-llama-cpp: `src/memory/node-llama.ts` (peer dep, optional)

## Messaging Channels (Core)

**Telegram:**
- SDK: grammy 1.41.1, @grammyjs/runner, @grammyjs/transformer-throttler
- Code: `src/telegram/`
- Features: Bot commands, webhooks, inline keyboards, audio, polls
- Webhook: `src/telegram/webhook.ts`
- Auth: Bot token

**Discord:**
- SDK: @buape/carbon (beta), discord-api-types
- Code: `src/discord/`
- Voice: @discordjs/voice + opusscript
- Auth: Bot token

**Slack:**
- SDK: @slack/bolt 4.6.0, @slack/web-api 7.14.1
- Code: `src/slack/`
- Auth: Bot token + app credentials

**Signal:**
- Code: `src/signal/`
- Auth: Signal account registration

**WhatsApp (Web):**
- SDK: @whiskeysockets/baileys 7.0.0-rc.9
- Code: `src/web/` (WhatsApp Web protocol)
- Auth: QR code pairing (`src/web/login-qr.ts`)

**iMessage:**
- Code: `src/imessage/`
- macOS-only integration

**LINE:**
- SDK: @line/bot-sdk 10.6.0
- Code: `src/line/`
- Auth: Channel access token

## Messaging Channels (Extensions)

Each extension lives in `extensions/<name>/` with its own `package.json`:

- **MS Teams:** `extensions/msteams/`
- **Matrix:** `extensions/matrix/` (uses `@matrix-org/matrix-sdk-crypto-nodejs`)
- **Feishu/Lark:** `extensions/feishu/` (uses `@larksuiteoapi/node-sdk`)
- **Google Chat:** `extensions/googlechat/`
- **IRC:** `extensions/irc/`
- **Mattermost:** `extensions/mattermost/`
- **Twitch:** `extensions/twitch/`
- **Nostr:** `extensions/nostr/`
- **Tlon (Urbit):** `extensions/tlon/`
- **Zalo:** `extensions/zalo/`, `extensions/zalouser/`
- **Synology Chat:** `extensions/synology-chat/`
- **Nextcloud Talk:** `extensions/nextcloud-talk/`
- **BlueBubbles:** `extensions/bluebubbles/` (iMessage bridge)
- **Voice Call:** `extensions/voice-call/`
- **Lobster:** `extensions/lobster/`
- **Open Prose:** `extensions/open-prose/`

## Agent Client Protocol (ACP)

- SDK: `@agentclientprotocol/sdk` 0.15.0
- Code: `src/acp/` (client, server, session mapper, translator, policy)
- Control plane: `src/acp/control-plane/`
- Persistent bindings: `src/acp/persistent-bindings.ts`
- Extension: `extensions/acpx/`

## Data Storage

**SQLite (via sqlite-vec):**
- Vector embeddings: `src/memory/sqlite-vec.ts`, `src/memory/sqlite.ts`
- Used for semantic memory/search with MMR reranking (`src/memory/mmr.ts`)

**File System:**
- Config: `~/.openclaw/` (YAML config files)
- Sessions: `~/.openclaw/sessions/` (JSONL session logs)
- Agent state: `~/.openclaw/agents/<agentId>/`
- Credentials: `~/.openclaw/credentials/`
- Memory indexes: Managed by memory subsystem

**Caching:**
- In-process caching with TTL (`src/config/cache-utils.ts`)
- Bootstrap cache: `src/agents/bootstrap-cache.ts`
- No external cache service (Redis etc.)

## Embeddings / Memory

**Embedding Providers:**
- OpenAI embeddings: `src/memory/embeddings-openai.ts`
- Google/Gemini embeddings: `src/memory/embeddings-gemini.ts`
- Mistral embeddings: `src/memory/embeddings-mistral.ts`
- Voyage embeddings: `src/memory/embeddings-voyage.ts`
- Ollama embeddings: `src/memory/embeddings-ollama.ts`
- Remote HTTP: `src/memory/embeddings-remote-fetch.ts`
- Batch processing: `src/memory/batch-*.ts` (OpenAI, Gemini, Voyage, HTTP)

**Memory Core:**
- Extension: `extensions/memory-core/`
- LanceDB extension: `extensions/memory-lancedb/`
- Manager: `src/memory/manager.ts` (sync, search, reindex)
- QMD (query/scope): `src/memory/qmd-*.ts`

## Authentication & Identity

**Gateway Auth:**
- Token-based: `src/gateway/auth.ts`
- Device auth: `src/gateway/device-auth.ts`
- Rate limiting: `src/gateway/auth-rate-limit.ts`
- Role policy: `src/gateway/role-policy.ts`
- Probe auth: `src/gateway/probe-auth.ts`

**Pairing:**
- Setup code pairing: `src/pairing/setup-code.ts`
- Pairing store: `src/pairing/pairing-store.ts`
- Challenge-response: `src/pairing/pairing-challenge.ts`

**Web Login:**
- Credential storage: `~/.openclaw/credentials/`
- Browser auth: `src/gateway/connection-auth.ts`
- Ed25519 signing: `@noble/ed25519` (UI auth)

**AI Provider Auth:**
- Auth profiles with rotation/cooldown: `src/agents/auth-profiles.ts`
- Env var resolution: `src/agents/model-auth.ts`
- Secret refs: `src/secrets/` (resolve, apply, audit)
- GitHub Copilot token exchange: `src/providers/github-copilot-token.ts`
- OAuth flows: Qwen (`src/providers/qwen-portal-oauth.ts`), Chutes (`src/agents/chutes-oauth.ts`), MiniMax, Google Gemini CLI

## Browser Automation

**Playwright:**
- Core: `playwright-core` 1.58.2
- CDP proxy: `src/browser/cdp.ts`, `src/browser/cdp-proxy-bypass.ts`
- Chrome management: `src/browser/chrome.ts`
- Session/tab management: `src/browser/session-tab-registry.ts`
- Bridge server: `src/browser/bridge-server.ts`
- AI integration: `src/browser/pw-ai.ts`
- Extension relay: `src/browser/extension-relay.ts`

## Text-to-Speech

- Core: `src/tts/tts.ts`, `src/tts/tts-core.ts`
- node-edge-tts: Microsoft Edge TTS
- Extension: `extensions/talk-voice/` (voice synthesis)
- Opus encoding: `opusscript`

## Hooks System

- Code: `src/hooks/`
- Bundled hooks: `src/hooks/bundled/*/handler.ts`
- Gmail integration: `src/hooks/gmail.ts`, `src/hooks/gmail-watcher.ts`
- URL import: `src/hooks/import-url.ts`
- Module loader: `src/hooks/module-loader.ts`

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry, Bugsnag, etc.)

**Logging:**
- tslog 4.10.2 (`src/logger.ts`)
- Subsystem loggers: `src/logging/subsystem.ts`
- WebSocket logging: `src/gateway/ws-log.ts`
- macOS unified logs: `scripts/clawlog.sh`

**Diagnostics:**
- OpenTelemetry extension: `extensions/diagnostics-otel/`
- Health endpoints: `/healthz` (liveness), `/readyz` (readiness)
- Channel health monitor: `src/gateway/channel-health-monitor.ts`
- Doctor command: CLI diagnostic tool

## CI/CD & Deployment

**CI Pipeline:**
- GitHub Actions (`.github/workflows/ci.yml`)
- Runs on Blacksmith runners (16 vCPU Ubuntu 24.04)
- Jobs: docs-scope detection, lint, format, typecheck, build, test, coverage
- Platform-specific: macOS, Windows, Android builds
- Docker release: `.github/workflows/docker-release.yml`
- Install smoke tests: `.github/workflows/install-smoke.yml`
- CodeQL analysis: `.github/workflows/codeql.yml`
- Stale issue management: `.github/workflows/stale.yml`

**Hosting/Deployment:**
- Fly.io: `fly.toml` (shared-cpu-2x, 2GB RAM, persistent volume)
- Render: `render.yaml` (Docker, starter plan)
- Docker: `Dockerfile` (multi-stage, Node 22 Bookworm), `docker-compose.yml`
- Podman: `setup-podman.sh`, `openclaw.podman.env`
- macOS app: Sparkle auto-update (`appcast.xml`)
- npm: Published as `openclaw` package

**Sandbox:**
- Docker-based sandbox: `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `Dockerfile.sandbox-common`
- Agent sandbox config: `src/agents/sandbox.ts`

## Service Discovery

- mDNS/Bonjour: `@homebridge/ciao` for local network discovery
- Server discovery: `src/gateway/server-discovery.ts`
- Tailscale integration: `src/gateway/server-tailscale.ts`

## Webhooks & Callbacks

**Incoming:**
- Telegram webhook: `src/telegram/webhook.ts`
- OpenAI-compatible chat completions: `src/gateway/openai-http.ts`
- OpenAI Responses API: `src/gateway/openresponses-http.ts`
- Plugin HTTP handlers: `src/gateway/server-http.ts`
- Gmail webhook: `src/hooks/gmail-watcher.ts`
- ACP server: `src/acp/server.ts`

**Outgoing:**
- Hook fire-and-forget: `src/hooks/fire-and-forget.ts`
- Subagent announcements: `src/agents/subagent-announce-dispatch.ts`
- Channel message delivery (all messaging platforms)

## Environment Configuration

**Required env vars (varies by deployment):**
- `OPENCLAW_GATEWAY_TOKEN` - Gateway auth token
- `OPENCLAW_STATE_DIR` - State directory path
- `OPENCLAW_WORKSPACE_DIR` - Workspace directory
- AI provider API keys (per provider, resolved via `src/agents/model-auth.ts`)
- Channel bot tokens (Telegram, Discord, Slack, etc.)

**Secrets location:**
- `~/.openclaw/credentials/` - Web provider credentials
- Config file secret refs: `src/secrets/` (resolve from env vars, files, or config)
- Auth profiles: `src/agents/auth-profiles.ts` (runtime rotation store)

**Config files:**
- `~/.openclaw/config.yaml` - Main configuration
- `~/.openclaw/models.json` - Discovered model catalog
- Agent-specific configs in agent directories

---

*Integration audit: 2026-03-08*
