# External Integrations

**Analysis Date:** 2026-02-02

## APIs & External Services

**Messaging Platforms:**
- WhatsApp - Web client via @whiskeysockets/baileys
- Slack - Bot integration via @slack/bolt
- Discord - Bot API integration with discord-api-types
- Telegram - Bot API via grammy
- Signal - Custom implementation with signal-utils
- LINE - Bot SDK via @line/bot-sdk
- Google Chat - Custom implementation
- iMessage - macOS integration
- Bluebubbles - Android messaging
- Matrix - Bot SDK integration
- Mattermost - Slack-compatible platform
- MS Teams - Enterprise messaging
- Nextcloud Talk - Self-hosted messaging
- Twitch - Live streaming platform
- Voice Call - Real-time voice communication

**AI/ML Providers:**
- OpenAI - GPT models via openai@6.17.0
- Anthropic - Claude models via dedicated SDK
- Google AI - Gemini models via Google APIs
- Mistral AI - Custom implementation
- AWS Bedrock - AWS LLM services
- Groq - Fast AI inference
- Ollama - Local LLM hosting
- OpenRouter - API aggregation

**Social Platforms:**
- Twitter/X - Integration via extensions
- Nostr - Decentralized social protocol
- Tlon - Matrix-based social network
- Zalo - Vietnamese messaging platform

## Data Storage

**Databases:**
- SQLite - Primary database for core application
- SQLite-vec - Vector search for embeddings
- LanceDB @lancedb/lancedb 0.23.0 - Vector database for memory extensions

**File Storage:**
- Local filesystem - Primary storage
- AWS S3 - Cloud storage via AWS SDK
- WebDAV - Network file system support

**Caching:**
- In-memory caching for sessions
- File-based caching for media
- Database caching for embeddings

## Authentication & Identity

**Auth Provider:**
- Custom OAuth implementation
- Multiple API key support (OpenAI, Anthropic, Google, etc.)
- JWT tokens for internal authentication
- Discord bot tokens
- Slack bot tokens
- LINE channel access tokens

**Environment Variables:**
- OPENAI_API_KEY - OpenAI authentication
- ANTHROPIC_API_KEY - Anthropic authentication
- GOOGLE_API_KEY - Google AI authentication
- DISCORD_BOT_TOKEN - Discord bot authentication
- SLACK_BOT_TOKEN - Slack bot authentication
- OPENROUTER_API_KEY - OpenRouter authentication

## Monitoring & Observability

**Error Tracking:**
- Custom audit logging in src/security/audit.ts
- Structured logging with tslog
- Integration with OpenTelemetry via extensions/diagnostics-otel

**Logs:**
- tslog^4.10.2 - Structured logging
- File-based logging for sessions
- Terminal output with progress indicators
- Audit trail for security events

## CI/CD & Deployment

**Hosting:**
- Self-hosted via Node.js runtime
- macOS app bundle distribution
- Android APK via Google Play
- iOS app via Apple App Store
- Web UI served locally or via hosting platform

**CI Pipeline:**
- GitHub Actions for automated testing
- Docker support for E2E testing
- Pre-commit hooks via prek
- Multi-platform builds (macOS, Android, iOS)

## Environment Configuration

**Required env vars:**
- API keys for AI services
- Bot tokens for messaging platforms
- Database credentials for SQLite
- Gateway configuration
- Logging levels

**Secrets location:**
- ~/.openclaw/credentials/ - Web provider credentials
- Environment variables - Runtime configuration
- Config files - Persistent settings

## Webhooks & Callbacks

**Incoming:**
- Slack slash commands and events
- Discord interactions and commands
- Telegram webhook updates
- LINE webhook messages
- WhatsApp webhooks
- Voice call WebSocket connections
- Custom HTTP endpoints for agent actions

**Outgoing:**
- Message delivery confirmations
- Reaction events
- Status updates
- Agent action results
- File upload completions

---

*Integration audit: 2026-02-02*
