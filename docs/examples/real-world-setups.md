---
summary: "Real-world OpenClaw setups and use cases from production users"
read_when:
  - Looking for inspiration on what to build
  - Planning an OpenClaw deployment
  - Wondering what's possible with OpenClaw
title: "Real-World Setups"
---

# Real-World OpenClaw Setups

Practical examples of how people use OpenClaw in production. These are not toy demos — they are running 24/7 and handling real tasks.

## Personal AI Chief of Staff

**Stack:** Hetzner VPS + Discord + Telegram + Voice Calls + Google Workspace

A single OpenClaw instance acting as a personal command center:

- **Morning briefing** (cron, 7 AM): Calendar events, urgent emails, weather, news digest — delivered to Discord
- **Email triage** (heartbeat): Scans inbox every 30 minutes, flags urgent items, drafts replies
- **Calendar management**: Creates events, checks conflicts, sends reminders via Telegram
- **Voice calls**: Initiates outbound calls for reminders or quick check-ins using ElevenLabs
- **Financial tracking**: Monitors crypto prices, runs technical analysis, posts alerts to a dedicated channel
- **Health tracking**: Logs daily metrics, supplements, exercise — generates weekly reports
- **Memory system**: Daily notes in `memory/YYYY-MM-DD.md`, curated long-term memory in `MEMORY.md`

**Key config patterns:**

- Heartbeat every 30 minutes with a `HEARTBEAT.md` checklist
- Isolated cron jobs for heavy analysis (uses Opus for quality)
- Cheaper models (Haiku/Flash) for frequent, simple tasks
- Discord channels organized by topic (#health, #finance, #crypto)

## Business Lead Capture Agent

**Stack:** VPS + Landing Page + Discord Webhook + Email (Resend)

An AI agent that handles inbound leads for a service business:

- **Landing page** with contact form (custom Python backend)
- **Form submission triggers**: Save to JSON → auto-reply email → notify owner via Discord webhook → fire Google Ads conversion tag
- **Lead qualification**: Agent reviews submissions and drafts personalized follow-up emails
- **Traffic monitoring**: Daily stats report (views, unique visitors, form submissions) posted to Discord
- **Ad campaign management**: Tracks Google Ads performance, suggests keyword optimizations

**Architecture:**

```
Visitor → Landing Page → Form Submit
                            ↓
                    Python Backend
                    ├── Save to JSON
                    ├── Auto-reply (Resend API)
                    ├── Notify owner (Discord webhook)
                    └── Conversion tracking (Google Ads tag)
```

## Multi-Channel Family Hub

**Stack:** Raspberry Pi + WhatsApp + Telegram + Google Calendar

A shared family assistant running on a Pi:

- **Shared grocery list**: Family members add items via WhatsApp, agent maintains the list
- **Calendar coordination**: "When is everyone free this weekend?" queries across multiple calendars
- **Meal planning**: Suggests recipes based on what's in the grocery list
- **Reminders**: School pickups, appointments, bill payments — delivered to the right family member
- **Quiet hours**: Gateway-enforced silence from 10 PM to 7 AM (no midnight notifications)

## Developer Productivity Agent

**Stack:** Mac + Discord + GitHub + Browser Relay

An agent that assists with daily development work:

- **PR reviews**: Summarizes open PRs, highlights breaking changes
- **Issue triage**: Scans new issues, categorizes by severity, suggests assignments
- **Documentation**: Generates docs from code changes, keeps README up to date
- **Deployment monitoring**: Watches CI/CD pipelines, alerts on failures
- **Research**: Searches docs, Stack Overflow, and GitHub discussions to answer technical questions
- **Browser automation**: Uses Chrome Extension relay to interact with web-based tools

## Trading Scanner

**Stack:** VPS + Exchange APIs + Discord

Automated market monitoring and analysis:

- **Price alerts**: Monitors crypto/stock prices, alerts on significant moves
- **Technical analysis**: RSI, MACD, EMA calculations on scheduled intervals
- **Option chain scanning**: Fetches and analyzes options data for opportunities
- **News correlation**: Cross-references price moves with breaking news
- **Paper trading**: Tracks simulated trades to validate strategies before going live

**Cron setup:**

```bash
# Crypto scan every 2 hours
openclaw cron add --name "crypto-scan" --every "2h" --session isolated \
  --message "Analyze current crypto market..." --announce --channel discord

# Quick price check every 30 minutes (cheap model)
openclaw cron add --name "price-radar" --every "30m" --session isolated \
  --message "Check BTC/ETH prices and alert on >3% moves" \
  --model haiku --announce
```

## Tips from These Setups

1. **Batch periodic checks into heartbeat** instead of creating many small cron jobs
2. **Use isolated cron for heavy analysis** — keeps main session clean and allows model overrides
3. **Organize Discord channels by topic** — easier to find information later
4. **Keep HEARTBEAT.md small** — it runs every cycle and burns tokens proportionally
5. **Use cheaper models for frequent tasks** — Haiku at $0.25/M input is 50x cheaper than Opus
6. **Always have a watchdog** — schedulers can stall; a simple cron check prevents silent failures
7. **Daily memory files + curated MEMORY.md** — raw logs for detail, curated file for context that matters
