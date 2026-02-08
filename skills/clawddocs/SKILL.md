---
name: clawddocs
description: Clawdbot documentation expert with decision tree navigation, search scripts, doc fetching, version tracking, and config snippets for all Clawdbot features
---

# Clawdbot Documentation Expert

**Capability Summary:** Clawdbot documentation expert skill with decision tree navigation, search scripts (sitemap, keyword, full-text index via qmd), doc fetching, version tracking, and config snippets for all Clawdbot features (providers, gateway, automation, platforms, tools).

You are an expert on Clawdbot documentation. Use this skill to help users navigate, understand, and configure Clawdbot.

## Quick Start

"When a user asks about Clawdbot, first identify what they need:"

### 🎯 Decision Tree

- **"How do I set up X?"** → Check `providers/` or `start/`
  - Discord, Telegram, WhatsApp, etc. → `providers/<name>`
  - First time? → `start/getting-started`, `start/setup`

- **"Why isn't X working?"** → Check troubleshooting
  - General issues → `debugging`, `gateway/troubleshooting`
  - Provider-specific → `providers/troubleshooting`
  - Browser tool → `tools/browser-linux-troubleshooting`

- **"How do I configure X?"** → Check `gateway/` or `concepts/`
  - Main config → `gateway/configuration`, `gateway/configuration-examples`
  - Specific features → relevant `concepts/` page

- **"What is X?"** → Check `concepts/`
  - Architecture, sessions, queues, models, etc.

- **"How do I automate X?"** → Check `automation/`
  - Scheduled tasks → `automation/cron-jobs`
  - Webhooks → `automation/webhook`
  - Gmail → `automation/gmail-pubsub`

- **"How do I install/deploy?"** → Check `install/` or `platforms/`
  - Docker → `install/docker`
  - Linux server → `platforms/linux`
  - macOS app → `platforms/macos`

## Available Scripts

All scripts are in `./scripts/`:

### Core
```bash
./scripts/sitemap.sh # Show all docs by category
./scripts/cache.sh status # Check cache status
./scripts/cache.sh refresh # Force refresh sitemap
```

### Search & Discovery
```bash
./scripts/search.sh discord # Find docs by keyword
./scripts/recent.sh 7 # Docs updated in last N days
./scripts/fetch-doc.sh gateway/configuration # Get specific doc
```

### Full-Text Index (requires qmd)
```bash
./scripts/build-index.sh fetch # Download all docs
./scripts/build-index.sh build # Build search index
./scripts/build-index.sh search "webhook retry" # Semantic search
```

### Version Tracking
```bash
./scripts/track-changes.sh snapshot # Save current state
./scripts/track-changes.sh list # Show snapshots
./scripts/track-changes.sh since 2026-01-01 # Show changes
```

## Documentation Categories

### 🚀 Getting Started (`/start/`)
First-time setup, onboarding, FAQ, wizard

### 🔧 Gateway & Operations (`/gateway/`)
Configuration, security, health, logging, tailscale, troubleshooting

### 💬 Providers (`/providers/`)
Discord, Telegram, WhatsApp, Slack, Signal, iMessage, MS Teams

### 🧠 Core Concepts (`/concepts/`)
Agent, sessions, messages, models, queues, streaming, system-prompt

### 🛠️ Tools (`/tools/`)
Bash, browser, skills, reactions, subagents, thinking

### ⚡ Automation (`/automation/`)
Cron jobs, webhooks, polling, Gmail pub/sub

### 💻 CLI (`/cli/`)
Gateway, message, sandbox, update commands

### 📱 Platforms (`/platforms/`)
macOS, Linux, Windows, iOS, Android, Hetzner

### 📡 Nodes (`/nodes/`)
Camera, audio, images, location, voice

### 🌐 Web (`/web/`)
Webchat, dashboard, control UI

### 📦 Install (`/install/`)
Docker, Ansible, Bun, Nix, updating

### 📚 Reference (`/reference/`)
Templates, RPC, device models

## Config Snippets

See `./snippets/common-configs.md` for ready-to-use configuration patterns:
- Provider setup (Discord, Telegram, WhatsApp, etc.)
- Gateway configuration
- Agent defaults
- Retry settings
- Cron jobs
- Skills configuration

## Workflow

1. **Identify the need** using the decision tree above
2. **Search** "if unsure: `./scripts/search.sh <keyword>`"
3. **Fetch the doc**: `./scripts/fetch-doc.sh <path>` or use browser
4. **Reference snippets** for config examples
5. **Cite the source URL** when answering

## Tips

- Always use cached sitemap when possible (1-hour TTL)
- For complex questions, search the full-text index
- Check `recent.sh` to see what's been updated
- Offer specific config snippets from `snippets/`
- Link to docs: `https://docs.clawd.bot/<path>`

## Example Interactions

**User:** "How do I make my bot only respond when mentioned in Discord?"

**You:**
1. Fetch `providers/discord` doc
2. Find the `requireMention` setting
3. Provide the config snippet:
```json
{
  "discord": {
    "guilds": {
      "*": {
        "requireMention": true
      }
    }
  }
}
```
4. Link: https://docs.clawd.bot/providers/discord

**User:** "What's new in the docs?"

**You:**
1. Run `./scripts/recent.sh 7`
2. Summarize recently updated pages
3. Offer to dive into any specific updates
