# CLAUDE.md — Nexus Agent

> **Where all threads meet.**

## What Is This?

**Nexus Agent** is a fork of [OpenClaw](https://github.com/openclaw/openclaw), rebranded and customized for the Nexus AI ecosystem. It provides the autonomous agent layer — heartbeat reasoning, scheduled tasks, event hooks, and multi-channel communication — while integrating with the existing Nexus infrastructure.

This is **not** a rebuild. We forked OpenClaw, stripped the lobster branding, applied Nexus identity, and locked it to Tailscale for security. All OpenClaw functionality remains intact.

-----

## Branding

| Element                  | Value                                                        |
| ------------------------ | ------------------------------------------------------------ |
| Name                     | Nexus Agent                                                  |
| Emoji                    | (spider)                                                     |
| Tagline                  | "Where all threads meet."                                    |
| Aesthetic                | Nexus-Iris (purple/cyan gradients, dark mode, goth/feminine) |
| Old references to remove | "lobster", "EXFOLIATE", "OpenClaw", "Molty", "Clawd"         |

### Color Palette (Nexus-Iris)

```css
--nx-idle: #8b5cf6;        /* Purple - idle/default */
--nx-think: #06b6d4;       /* Cyan - thinking/processing */
--nx-speak: #fafaf9;       /* White - speaking/active */
--nx-speak-glow: #fbbf24;  /* Gold accent */
--nx-error: #ef4444;       /* Red - error/alert */
--nx-bg: #08090d;          /* Deep space black */
--nx-surface: #0f1117;     /* Card backgrounds */
--nx-surface-2: #161922;   /* Elevated surfaces */
--nx-border: #232838;      /* Subtle borders */
--nx-text: #e0e3ec;        /* Primary text */
--nx-text-dim: #6b7394;    /* Secondary text */
```

-----

## Architecture — How It Fits

```
                    WorkstationPrime
                          |
                          | (JARVIS / Claude Code)
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
   NexusServer <------> NexusBody <------> Supabase
   |                     |                 |
   |                     +-- nexus-core    |
   |                     +-- nexus-chat    |
   |                     +-- nexus-coding  |
   |                     +-- nexus-tools   |
   |                                       |
   +-- NEXUS-AGENT <-----------------------+
       (this repo)
       Port 18789
       Tailscale-only
```

**Nexus Agent runs on NexusServer** (Docker) and provides:

- Heartbeat reasoning loop (every 15 min)
- Scheduled tasks (morning briefing, GitHub Scout, health checks)
- Event hooks (reflexes)
- Telegram full chat interface
- Discord notifications
- WebUI dashboard

**It talks to:**

- NexusBody's nexus-core (:8000) for health checks
- Supabase for shared memory/state
- OpenAI GPT-4o for reasoning
- Telegram for mobile chat
- Discord for notifications

-----

## Machine Topology

| Machine              | Role                              | Nexus Agent Relevance                           |
| -------------------- | --------------------------------- | ----------------------------------------------- |
| **NexusServer**      | Tailscale gateway, Docker host    | **Runs nexus-agent container**                  |
| **NexusBody**        | V4 runtime, Ollama, GPU workloads | Agent polls health via Tailscale                |
| **WorkstationPrime** | Dev hub, Claude Code              | Development environment                         |
| **Supabase**         | Cloud DB (Nexus-AI project)       | Shared memory, github_queue, automation_history |

-----

## Security Model

### Tailscale-Only Networking

```yaml
# Gateway binds to Tailscale IP, not 0.0.0.0
gateway:
  bind: "100.x.x.x"  # NexusServer's Tailscale IP
  port: 18789
```

### Windows Firewall (NexusServer)

```powershell
# Block public access
New-NetFirewallRule -DisplayName "Nexus Agent Block Public" `
  -Direction Inbound -LocalPort 18789 -Protocol TCP -Action Block

# Allow only Tailscale subnet
New-NetFirewallRule -DisplayName "Nexus Agent Tailscale Only" `
  -Direction Inbound -LocalPort 18789 -Protocol TCP `
  -RemoteAddress 100.64.0.0/10 -Action Allow
```

### Why This Works

- No prompt injection via external channels — there ARE no external channels
- All inbound traffic must originate from within the Tailscale mesh
- Outbound still works (GitHub API, OpenAI, etc.) but through your controlled network

-----

## Key Directories

```
nexus-agent/
├── src/                    # Core TypeScript source
│   ├── telegram/           # Telegram channel (grammY)
│   ├── discord/            # Discord channel (discord.js)
│   ├── channels/           # All channel implementations
│   └── ...
├── ui/                     # WebUI (React)
├── apps/                   # macOS/iOS/Android companions
├── skills/                 # Bundled skills
├── packages/               # Monorepo packages
├── docs/                   # Documentation
├── config/                 # User config location reference
│   ├── SOUL.md             # Personality (shared with V4)
│   └── HEARTBEAT.md        # What to check each tick
├── .env                    # API keys (never committed)
├── docker-compose.yml      # Container config
├── package.json            # Node dependencies
└── CLAUDE.md               # This file
```

### Config Paths (Runtime)

```
~/.nexus-agent/             # Main config directory
~/.nexus-agent/nexus-agent.json   # Main config file
~/.nexus-agent/workspace/   # Agent workspace
~/.nexus-agent/workspace/SOUL.md
~/.nexus-agent/workspace/HEARTBEAT.md
~/.nexus-agent/credentials/ # Channel auth tokens
```

-----

## Environment Variables

Create `.env` in repo root (never commit):

```env
# LLM — GPT-4o for reasoning
OPENAI_API_KEY=sk-...

# Telegram — full chat interface
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Discord — notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# GitHub — Scout (higher rate limits)
GITHUB_TOKEN=ghp_...

# Tailscale
TAILSCALE_IP=100.x.x.x

# Nexus Integration
NEXUS_CORE_URL=http://100.x.x.x:8000
SUPABASE_URL=https://rstbgkobyoqdhwjxulqg.supabase.co
SUPABASE_KEY=eyJ...
```

-----

## Personality — SOUL.md

Nexus Agent uses the **same SOUL.md as Nexus V4**. This ensures consistent personality across:

- nexus-core conversations
- nexus-agent autonomous actions
- Telegram chat
- Discord notifications
- GitHub Scout reports

The soul.md lives in `~/.nexus-agent/workspace/SOUL.md` at runtime.

Key personality traits:

- Loyal to John (Johnny3116)
- Technical and efficient
- Witty but professional
- Security-first mindset
- Does NOT access email, calendar, or social media
- Spider/Arachne aesthetic

-----

## HEARTBEAT.md — What to Check

Every 15 minutes, the agent wakes up and evaluates:

```markdown
## Mesh Health
- Can I reach NexusBody over Tailscale?
- Can I reach NexusServer services?
- Any Tailscale peer dropouts?

## System Resources
- CPU > 90% sustained?
- RAM > 85%?
- Disk > 90%?
- GPU temp > 85C? (NexusBody only)

## Services
- Ollama responding? (NexusBody :11434)
- nexus-core responding? (NexusBody :8000)
- Bridge responding? (NexusServer :3035)

## Pending Work
- Items in github_queue awaiting review?
- Approval queue items older than 24h?

## Response Rules
- ALL pass -> log "HEARTBEAT_OK", stay silent
- ANY fail -> evaluate severity -> notify if warranted
- CRITICAL -> notify immediately
- WARNING -> batch into daily digest
```

-----

## Scheduled Tasks

| Task             | Schedule     | Description                                         |
| ---------------- | ------------ | --------------------------------------------------- |
| heartbeat        | Every 15 min | HEARTBEAT.md evaluation                             |
| morning-briefing | 7:30 AM      | Overnight summary, pending items                    |
| github-scout     | 2:00 AM      | Search trending repos, analyze, generate project.md |
| health-digest    | 6:00 PM      | Daily summary if warnings accumulated               |

-----

## Telegram Commands

Full chat is enabled — talk naturally. Also supports:

| Command                | Action                            |
| ---------------------- | --------------------------------- |
| `/status`              | System health, last heartbeat     |
| `/scout`               | Run GitHub Scout now              |
| `/tasks`               | View pending/running tasks        |
| `/approve <id>`        | Approve queued destructive action |
| `/reject <id>`         | Reject queued action              |
| `/silence <duration>`  | Mute notifications temporarily    |
| `/hooks`               | List event hooks                  |
| `/crons`               | List scheduled tasks              |

-----

## GitHub Scout — What It Does

1. Searches GitHub for topics:
   - "autonomous AI agent"
   - "local-first LLM"
   - "VRM avatar"
   - "FastAPI agentic"
   - "homelab AI"
   - "prompt injection defense"
2. For each interesting repo:
   - Clone to temp directory
   - Analyze README, dependencies, license
   - Run security checks (npm audit, pip audit, secrets scan)
   - Generate structured `project.md`
3. Write to Supabase `github_queue` table
4. Notify via Discord/Telegram with summary

-----

## Refactor Status

### Completed

- [x] Forked to Johnny3116/Nexus-Agent
- [x] Updated repo name and description
- [x] Changed lobster emoji to spider emoji (partial)

### In Progress

- [ ] Global replace: OpenClaw -> Nexus
- [ ] Global replace: openclaw -> nexus-agent
- [ ] Remove "lobster way" -> "Where all threads meet."
- [ ] Remove "EXFOLIATE" references
- [ ] Update README.md header
- [ ] Swap CSS colors to Nexus-Iris palette
- [ ] Update config paths (~/.openclaw/ -> ~/.nexus-agent/)
- [ ] Rename openclaw.mjs -> nexus-agent.mjs

### Not Started

- [ ] Tailscale-lock gateway config
- [ ] Create SOUL.md (copy from V4)
- [ ] Create HEARTBEAT.md
- [ ] Set up Telegram bot
- [ ] Configure Discord webhook
- [ ] Add github-scout skill
- [ ] Docker deployment on NexusServer

-----

## Integration with V4

Nexus Agent is a **sibling service** to V4, not a replacement:

| Layer         | V4 Services  | Nexus Agent              |
| ------------- | ------------ | ------------------------ |
| Conversation  | nexus-chat   | Telegram chat            |
| Coding        | nexus-coding | —                        |
| Tools         | nexus-tools  | Skills (OpenClaw format) |
| Avatar        | nexus-vtube  | —                        |
| Autonomy      | —            | Heartbeat, cron, hooks   |
| Notifications | notifier.py  | Discord + Telegram       |

**Shared resources:**

- Supabase (Nexus-AI project)
- SOUL.md personality
- Tailscale mesh

**Communication:**

- Nexus Agent polls nexus-core health endpoint
- Both write to Supabase tables
- Discord webhook is shared (same channel)

-----

## Commands Reference

### Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build TypeScript
pnpm gateway:watch    # Dev mode with hot reload
```

### Running

```bash
pnpm nexus-agent onboard --install-daemon  # Guided setup
pnpm nexus-agent gateway --port 18789      # Start gateway
pnpm nexus-agent doctor                    # Check config health
```

### Docker

```bash
docker-compose up -d          # Start container
docker-compose logs -f        # Tail logs
docker-compose down           # Stop
```

-----

## Critical Rules

1. **Tailscale-only** — Never expose port 18789 publicly
2. **No email/calendar/social** — By design, Nexus Agent does not access these
3. **Approval queue** — Destructive actions wait for human approval
4. **Same personality** — Use V4's SOUL.md, not a separate one
5. **Secrets in .env** — Never commit API keys

-----

## Quick Links

- **This repo:** https://github.com/Johnny3116/Nexus-Agent
- **Original:** https://github.com/openclaw/openclaw
- **V4 repo:** https://github.com/Johnny3116/Nexus-V4
- **OpenClaw docs:** https://docs.openclaw.ai

-----

## Session Continuity

When starting a new session (mobile or desktop), paste this file first. It contains everything needed to understand the project context.

For V4 work, use the V4 CLAUDE.md instead.
For nexus-agent work, use this file.

-----

*Nexus Agent - Where all threads meet*
