# Nexus Agent

> **Where all threads meet.**

Nexus Agent is the autonomous agent layer for the Nexus AI ecosystem. It provides heartbeat reasoning, scheduled tasks, event hooks, and multi-channel communication — all running on your own hardware, locked behind Tailscale.

Forked from [OpenClaw](https://github.com/openclaw/openclaw), rebranded and customized for the Nexus infrastructure.

## Features

- **Heartbeat reasoning loop** — evaluates system health every 15 minutes
- **Scheduled tasks** — morning briefings, GitHub Scout, health digests
- **Event hooks** — reflexes that fire on system events
- **Telegram chat** — full conversational interface via grammY
- **Discord notifications** — alerts and summaries via webhooks
- **WebUI dashboard** — browser-based control panel
- **Tailscale-only networking** — zero public attack surface

## Architecture

```
                    WorkstationPrime
                          |
                          | (JARVIS / Claude Code)
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
   NexusServer <------> NexusBody <------> Supabase
                                           |
   NEXUS-AGENT <---------------------------+
   (this repo)
   Port 18789, Tailscale-only
```

## Quick Start

### Requirements

- **Node.js 22+**
- **pnpm** (preferred) or npm
- **Tailscale** mesh network

### Install

```bash
git clone https://github.com/Johnny3116/Nexus-Agent.git
cd Nexus-Agent

pnpm install
pnpm build
```

### Configure

Copy `.env.example` to `.env` and fill in your keys:

```env
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
GITHUB_TOKEN=ghp_...
TAILSCALE_IP=100.x.x.x
NEXUS_CORE_URL=http://100.x.x.x:8000
SUPABASE_URL=https://...
SUPABASE_KEY=eyJ...
```

### Run

```bash
# Guided setup
pnpm nexus-agent onboard --install-daemon

# Start gateway
pnpm nexus-agent gateway --port 18789

# Check health
pnpm nexus-agent doctor
```

### Docker

```bash
docker-compose up -d
docker-compose logs -f
```

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build TypeScript
pnpm gateway:watch    # Dev mode with hot reload
```

## Channels

| Channel  | Purpose        | Implementation |
| -------- | -------------- | -------------- |
| Telegram | Full chat      | grammY         |
| Discord  | Notifications  | discord.js     |
| WebUI    | Dashboard      | Lit + Vite     |

## Scheduled Tasks

| Task             | Schedule     | Description                                         |
| ---------------- | ------------ | --------------------------------------------------- |
| heartbeat        | Every 15 min | System health evaluation                            |
| morning-briefing | 7:30 AM      | Overnight summary, pending items                    |
| github-scout     | 2:00 AM      | Search trending repos, analyze, generate project.md |
| health-digest    | 6:00 PM      | Daily summary if warnings accumulated               |

## Security

- **Tailscale-only** — port 18789 never exposed publicly
- **Approval queue** — destructive actions require human approval
- **No email/calendar/social** — by design
- **Secrets in .env** — never committed

## Color Palette (Nexus-Iris)

```css
--nx-idle: #8b5cf6;     /* Purple */
--nx-think: #06b6d4;    /* Cyan */
--nx-speak: #fafaf9;    /* White */
--nx-error: #ef4444;    /* Red */
--nx-bg: #08090d;       /* Deep space */
```

## Links

- **This repo:** https://github.com/Johnny3116/Nexus-Agent
- **Original:** https://github.com/openclaw/openclaw
- **V4 repo:** https://github.com/Johnny3116/Nexus-V4

## License

[MIT](LICENSE)

---

*Nexus Agent - Where all threads meet*
