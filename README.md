<p align="center">
  <pre align="center">
 ██╗██████╗  ██████╗ ███╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗
 ██║██╔══██╗██╔═══██╗████╗  ██║██╔════╝██║     ██╔══██╗██║    ██║
 ██║██████╔╝██║   ██║██╔██╗ ██║██║     ██║     ███████║██║ █╗ ██║
 ██║██╔══██╗██║   ██║██║╚██╗██║██║     ██║     ██╔══██║██║███╗██║
 ██║██║  ██║╚██████╔╝██║ ╚████║╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
  </pre>
</p>

<p align="center">
  <strong>AI CRM, hosted locally on your Mac.</strong>
</p>

<p align="center">
  Chat with your database. Automate outreach. Enrich leads. All from a single prompt.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ironclaw"><img src="https://img.shields.io/npm/v/ironclaw?style=for-the-badge&color=000" alt="npm version"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://ironclaw.sh">Website</a> · <a href="https://docs.openclaw.ai">Docs</a> · <a href="https://github.com/openclaw/openclaw">OpenClaw Framework</a> · <a href="https://discord.gg/clawd">Discord</a> · <a href="https://clawhub.com">Skills Store</a>
</p>

---

## Install

**Runtime: Node 22+**

```bash
npm i -g ironclaw
ironclaw onboard --install-daemon
```

Opens at `localhost:3100`. That's it.

Three steps total:

```
1. npm i -g ironclaw
2. ironclaw onboard
3. ironclaw gateway start
```

---

## What is Ironclaw?

Ironclaw is a personal AI agent and CRM that runs locally on your machine. It connects to every messaging channel you use, manages structured data through DuckDB, browses the web with your Chrome profile, and gives you a full web UI for pipeline management, analytics, and document management.

Built on [OpenClaw](https://github.com/openclaw/openclaw) with **Vercel AI SDK v6** as the LLM orchestration layer.

**One prompt does everything:**

- "Find YC W26 founders building AI companies" → scrapes YC directory + LinkedIn, returns 127 matches
- "Enrich all contacts with LinkedIn and email" → fills in profiles with 98% coverage
- "Send personalized messages to qualified leads" → crafts and sends custom outreach
- "Show me pipeline stats for this quarter" → generates interactive charts from live data
- "Set up weekly follow-up sequences for all leads" → creates automation rules that run in the background

---

## Use Cases

### Find Leads

Type a prompt, Ironclaw scrapes the web using your actual Chrome profile (all your auth sessions, cookies, history). It logs into LinkedIn, browses YC batches, pulls company data. No separate login, no API keys for browsing.

### Enrich Data

Point it at your contacts table. It fills in LinkedIn URLs, email addresses, education, company info. Enrichment runs in bulk with real-time progress.

### Send Outreach

Personalized LinkedIn messages, cold emails, follow-up sequences. Each message is customized per lead. You see status (Sent, Sending, Queued) in real time.

### Analyze Pipeline

Ask for analytics in plain English. Ironclaw queries your DuckDB workspace and generates interactive Recharts dashboards inline. Pipeline funnels, outreach activity charts, conversion rates, donut breakdowns.

### Automate Everything

Cron jobs that run on schedule. Follow-up if no reply after 3 days. Move leads to Qualified when they reply. Weekly pipeline reports every Monday. Alert on high-intent replies.

---

## Core Capabilities

### Uses Your Chrome Profile

Unlike other AI tools, Ironclaw copies your existing Chrome profile with all your auth sessions, cookies, and history. It logs into LinkedIn, scrapes YC batches, and sends messages as you. No separate browser login needed.

### Chat with Your Database

Ask questions in plain English. Ironclaw translates to SQL, queries your local DuckDB, and returns structured results. Like having a data analyst on speed dial.

```
You: "How many founders have we contacted from YC W26?"

→ SELECT "Status", COUNT(*) as count FROM v_founders GROUP BY "Status";

You've contacted 67 of 200 founders. 31 are qualified, 13 converted.
Reply rate is 34%.
```

### Coding Agent with Diffs

Ironclaw writes code. Review changes in a rich diff viewer before applying. Config changes, automation scripts, data transformations. All with diffs you approve.

### Your Second Brain

Full access to your Mac: files, apps, documents. It remembers context across sessions via persistent memory files. Learns your preferences. Proactively handles tasks during heartbeat checks.

---

## Web UI (Dench)

The web app runs at `localhost:3100` and includes:

- **Chat panel** with streaming responses, chain-of-thought reasoning display, and markdown rendering
- **Workspace sidebar** with file manager tree, knowledge base, and database viewer
- **Object tables** powered by TanStack, with sorting, filtering, row selection, and bulk operations
- **Entry detail modals** with field editing and media previews
- **Kanban boards** with drag-and-drop that auto-update as leads reply
- **Interactive report cards** with chart panels (bar, line, area, pie, donut, funnel, scatter, radar) and filter bars
- **Document editor** with embedded live charts
- **Media viewer** supporting images, video, audio, and PDFs

---

## Multi-Channel Inbox

One agent, every channel. Connect any messaging platform. Your AI agent responds everywhere, managed from a single terminal.

| Channel             | Setup                                                         |
| ------------------- | ------------------------------------------------------------- |
| **WhatsApp**        | `ironclaw channels login` + set `channels.whatsapp.allowFrom` |
| **Telegram**        | Set `TELEGRAM_BOT_TOKEN` or `channels.telegram.botToken`      |
| **Slack**           | Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`                     |
| **Discord**         | Set `DISCORD_BOT_TOKEN` or `channels.discord.token`           |
| **Signal**          | Requires `signal-cli` + `channels.signal` config              |
| **iMessage**        | Via BlueBubbles (recommended) or legacy macOS integration     |
| **Microsoft Teams** | Configure Teams app + Bot Framework                           |
| **Google Chat**     | Chat API integration                                          |
| **Matrix**          | Extension channel                                             |
| **WebChat**         | Built-in, uses Gateway WebSocket directly                     |

```
  WhatsApp · Telegram · Slack · Discord
  Signal · iMessage · Teams · WebChat
               │
               ▼
  ┌────────────────────────────┐
  │     Ironclaw Gateway       │
  │   ws://127.0.0.1:18789    │
  └─────────────┬──────────────┘
                │
    ┌───────────┼───────────┐
    │           │           │
    ▼           ▼           ▼
  AI SDK     Web UI       CLI
  Engine     (Dench)    (ironclaw)
```

---

## Integrations

Import your data from anywhere: Google Drive, Notion, Salesforce, HubSpot, Gmail, Calendar, Obsidian, Slack, LinkedIn, Asana, Monday, ClickUp, PostHog, Sheets, Apple Notes, GitHub, and 50+ more via the Skills Store.

---

## Skills Platform

Extend your agent with a single command. Browse skills from [skills.sh](https://skills.sh) and [ClawHub](https://clawhub.com).

```bash
npx skills add vercel-labs/agent-browser
```

Popular skills:

| Skill                   | Description                                                | Installs |
| ----------------------- | ---------------------------------------------------------- | -------- |
| `crm-automation`        | CRM workflow automation, lead scoring, pipeline management | 18.2K    |
| `linkedin-outreach`     | Automated LinkedIn prospecting and follow-up sequences     | 14.8K    |
| `lead-enrichment`       | Enrich contacts with LinkedIn, email, and company data     | 12.1K    |
| `email-sequences`       | Multi-step cold email campaigns with personalization       | 9.7K     |
| `agent-browser`         | Browser automation and web scraping for agents             | 35.8K    |
| `web-design-guidelines` | Best practices for modern web design                       | 99.4K    |
| `frontend-design`       | Expert frontend engineering patterns                       | 68.9K    |
| `typescript-expert`     | Advanced TypeScript patterns and best practices            | 15.1K    |

Or write your own. Skills are just a `SKILL.md` file with instructions + optional scripts.

---

## Analytics & Reports

Ask "show me pipeline analytics" and get interactive charts generated from your live DuckDB data.

- **Outreach Activity** — area charts tracking LinkedIn and email volume over time
- **Pipeline Breakdown** — donut charts showing lead distribution by status
- **Conversion Funnel** — stage-by-stage conversion rates with overall percentage
- **Deal Pipeline** — bar charts, funnel views, revenue by stage
- **Custom Reports** — save as `.report.json` files that render as live dashboards

Reports use the `report-json` format and render inline in chat as interactive Recharts components.

---

## Kanban Pipeline

Drag-and-drop kanban boards that auto-update as leads reply. Ironclaw moves cards through your pipeline automatically.

Columns like New Lead → Contacted → Qualified → Demo Scheduled → Closed map to your sales process. Each card shows the lead name, company, and last action taken.

---

## Documents, Reports & Cron Jobs

### Documents

Rich markdown documents with embedded live charts. SOPs, playbooks, onboarding guides. Documents nest under objects or stand alone in the file tree.

### Cron Jobs

Scheduled automations that run in the background:

| Job                    | Schedule       | Description                          |
| ---------------------- | -------------- | ------------------------------------ |
| Weekly pipeline report | `0 9 * * MON`  | Auto-generates pipeline summary      |
| Lead enrichment sync   | Every 6h       | Enriches new contacts                |
| Email follow-up check  | Every 30m      | Checks for replies needing follow-up |
| Inbox digest           | `0 8,18 * * *` | Morning and evening inbox summary    |
| Competitor monitoring  | `0 6 * * *`    | Tracks competitor activity           |
| CRM backup to S3       | `0 2 * * *`    | Nightly workspace backup             |

```bash
ironclaw cron list
```

---

## Gateway

The Gateway is the local-first WebSocket control plane that routes everything:

- **Sessions** — main sessions for DMs, isolated sessions for group chats, sub-agent sessions for background tasks
- **Channels** — route inbound messages from any platform to the right session
- **Tools** — browser control, canvas, nodes, cron, messaging, file operations
- **Events** — webhooks, Gmail Pub/Sub, cron triggers, heartbeats
- **Multi-agent routing** — route channels/accounts/peers to isolated agents with separate workspaces

### Session Model

- `main` — direct 1:1 chats with persistent context
- `group` — isolated per-group sessions with mention gating
- `isolated` — sub-agent sessions for background tasks (cron jobs, spawned work)

### Security

- **DM pairing** enabled by default. Unknown senders get a pairing code.
- Approve with `ironclaw pairing approve <channel> <code>`
- Non-main sessions can be sandboxed in Docker
- Run `ironclaw doctor` to audit DM policies

---

## Companion Apps

- **macOS** — menu bar app with Voice Wake, Push-to-Talk, Talk Mode overlay, WebChat, and debug tools
- **iOS** — Canvas, Voice Wake, Talk Mode, camera, screen recording, Bonjour pairing
- **Android** — Canvas, Talk Mode, camera, screen recording, optional SMS

---

## Configuration

Config lives at `~/.openclaw/openclaw.json`:

Supports all latest and greatest mainstream LLM models. BYOK.

---

## Chat Commands

Send these in any connected channel:

| Command                       | Description                     |
| ----------------------------- | ------------------------------- |
| `/status`                     | Session status (model + tokens) |
| `/new` or `/reset`            | Reset the session               |
| `/compact`                    | Compact session context         |
| `/think <level>`              | Set thinking level              |
| `/verbose on\|off`            | Toggle verbose output           |
| `/usage off\|tokens\|full`    | Per-response usage footer       |
| `/restart`                    | Restart the gateway             |
| `/activation mention\|always` | Group activation toggle         |

---

## DuckDB Workspace

All structured data lives in a local DuckDB database. Objects, fields, entries, relations. EAV pattern with auto-generated PIVOT views so you query like normal tables:

```sql
SELECT * FROM v_leads WHERE "Status" = 'New' ORDER BY created_at DESC LIMIT 50;
SELECT "Status", COUNT(*) FROM v_leads GROUP BY "Status";
```

Features:

- Custom objects with typed fields (text, email, phone, number, boolean, date, enum, relation, user)
- Full-text search
- Bulk import/export (CSV, Parquet)
- Automatic view generation
- Kanban support with drag-and-drop

---

## Quick Start

```bash
# Install
npm i -g ironclaw

# Run onboarding wizard
ironclaw onboard --install-daemon

# Start the gateway
ironclaw gateway start

# Open the web UI
open http://localhost:3100

# Talk to your agent from CLI
ironclaw agent --message "Summarize my inbox" --thinking high

# Send a message
ironclaw message send --to +1234567890 --message "Hello from Ironclaw"
```

---

## From Source

```bash
git clone https://github.com/kumarabhirup/ironclaw.git
cd ironclaw

pnpm install
pnpm build

pnpm dev onboard --install-daemon
```

Web UI development:

```bash
cd apps/web
pnpm install
pnpm dev
```

---

## Project Structure

```
src/              Core CLI, commands, gateway, agent, media pipeline
apps/web/         Next.js web UI (Dench)
apps/ios/         iOS companion node
apps/android/     Android companion node
apps/macos/       macOS menu bar app
extensions/       Channel plugins (MS Teams, Matrix, Zalo, voice-call)
docs/             Documentation
scripts/          Build, deploy, and utility scripts
skills/           Workspace skills
```

---

## Development

```bash
pnpm install          # Install deps
pnpm build            # Type-check + build
pnpm check            # Lint + format check
pnpm test             # Run tests (vitest)
pnpm test:coverage    # Tests with coverage
pnpm dev              # Dev mode (auto-reload)
```

---

## Upstream

Ironclaw is built on [OpenClaw](https://github.com/openclaw/openclaw). To sync with upstream:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
git merge upstream/main
```

---

## Open Source

MIT Licensed. Fork it, extend it, make it yours.

<p align="center">
  <a href="https://github.com/DenchHQ/ironclaw"><img src="https://img.shields.io/github/stars/DenchHQ/ironclaw?style=for-the-badge" alt="GitHub stars"></a>
</p>
