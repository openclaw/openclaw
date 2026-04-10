# Investment Agent Team — Fork Setup Guide

This fork extends OpenClaw with a 5-agent investment research team that collaborates through Slack channels. Each agent has a specialized role, its own Slack bot, and an isolated workspace with personality, skills, and an append-only memory.

## What this fork adds

### The team

| Agent | Role | Primary Channel |
|-------|------|-----------------|
| **Orchestrator** | Portfolio manager. Triages signals, dispatches work, publishes canonical decisions. | `#portfolio-daily`, `#portfolio-weekly`, `#dispatch`, `#watchlist` |
| **Scout** | Market intelligence. Detects and reports facts, runs scheduled scans, rebuilds morning watchlist. | `#market-signals`, `#watchlist`, `#weekly-outlook` |
| **Analyst** | Fundamental research. Builds source-backed investment theses; posts pointers to files. | `#research` |
| **Quant** | Technical and quantitative analysis. Compute-first; saves large artifacts to files. | `#quant-signals` |
| **Devil's Advocate** | Risk and contrarian. Stress-tests theses with measurable kill conditions; asks follow-ups in any specialist channel. | `#contrarian` (+ read-everywhere) |

Dispatch happens in `#dispatch`. No agent executes trades. All handoffs are channel-visible.

### Canonical state lives in channels, not files

- **Watchlist** → `#watchlist` (Scout rebuilds each morning; Orchestrator mutates during the day).
- **Decisions** → `#portfolio-daily` (Orchestrator publishes decisions as the record).

There is no `watchlist.md` and no `recent-decisions.md`. Every agent reads the tails of these two channels on startup.

### Files added

```
agent-team/
  agents/
    orchestrator/   # SOUL.md, AGENTS.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, skills/
    scout/
    analyst/
    quant/
    devils-advocate/
  shared-skills/
    channel-directory/
    source-and-confidence/
    approved-sources/
    agent-communication-protocol/
    receive-and-execute-work/
    file-layout-discipline/
    a2a-artifact-pull/
    emotion-regulation/
    finance-focused/
  shared-state/portfolio/
    channel-map.md, positions.md, team-memory.md,
    operating-protocol.md, lifecycle-patterns.md,
    conflict-resolution.md, error-handling.md, dispatch-template.md
  config/
    openclaw.json               # ${ENV_VAR} interpolation for secrets + channel IDs
    .env.example                # Environment template
    scheduled-jobs.json         # Cron map for Scout scheduled skills
    slack-app-manifest.example.json
    slack-rollout-checklist.md
  scripts/
    sync-agent-workspaces.sh    # Bash deploy (--clean supported)
    sync-agent-workspaces.ps1   # PowerShell deploy (-Clean supported)
```

### Config approach

All secrets and Slack channel IDs are referenced in `openclaw.json` via `${ENV_VAR}` interpolation. Nothing sensitive is hardcoded. Real values live on the VM at `~/.openclaw/.env`.

## Prerequisites

- A Linux VM (or any Linux host) with Node 22+ and OpenClaw installed globally (`sudo npm i -g openclaw@latest`).
- **5 Slack Socket Mode apps** (one per agent), each with:
  - Socket Mode enabled.
  - An app-level token (`xapp-`) with `connections:write`.
  - A bot token (`xoxb-`) with scopes: `chat:write`, `app_mentions:read`, `channels:history`, `channels:read`, `reactions:write`, `reactions:read`, `files:read`, `files:write`.
  - The Orchestrator additionally needs: `im:history`, `im:read`, `im:write`.
  - Event subscriptions: `message.channels`, `app_mention`, `reaction_added` (Orchestrator also: `message.im`).
- **11 Slack channels** created: `#market-signals`, `#research`, `#quant-signals`, `#contrarian`, `#dispatch`, `#portfolio-daily`, `#portfolio-weekly`, `#themes`, `#agents`, `#watchlist`, `#weekly-outlook`.

See `config/slack-app-manifest.example.json` for a manifest template and `config/slack-rollout-checklist.md` for the full rollout.

## Setup

### 1. Clone and configure

```bash
git clone <your-fork-url>
cd openclaw
cp agent-team/config/.env.example agent-team/config/.env
```

Edit `agent-team/config/.env` and fill in every value — 5 bot+app token pairs, the gateway token, and all 11 channel IDs:

```
OPENCLAW_GATEWAY_TOKEN=<openssl rand -hex 24>

SLACK_ORCHESTRATOR_BOT_TOKEN=xoxb-...
SLACK_ORCHESTRATOR_APP_TOKEN=xapp-...
SLACK_SCOUT_BOT_TOKEN=xoxb-...
SLACK_SCOUT_APP_TOKEN=xapp-...
SLACK_ANALYST_BOT_TOKEN=xoxb-...
SLACK_ANALYST_APP_TOKEN=xapp-...
SLACK_QUANT_BOT_TOKEN=xoxb-...
SLACK_QUANT_APP_TOKEN=xapp-...
SLACK_DEVILS_ADVOCATE_BOT_TOKEN=xoxb-...
SLACK_DEVILS_ADVOCATE_APP_TOKEN=xapp-...

SLACK_CHANNEL_MARKET_SIGNALS=C0...
SLACK_CHANNEL_RESEARCH=C0...
SLACK_CHANNEL_QUANT_SIGNALS=C0...
SLACK_CHANNEL_CONTRARIAN=C0...
SLACK_CHANNEL_DISPATCH=C0...
SLACK_CHANNEL_PORTFOLIO_DAILY=C0...
SLACK_CHANNEL_PORTFOLIO_WEEKLY=C0...
SLACK_CHANNEL_THEMES=C0...
SLACK_CHANNEL_AGENTS=C0...
SLACK_CHANNEL_WATCHLIST=C0...
SLACK_CHANNEL_WEEKLY_OUTLOOK=C0...
```

### 2. Deploy

```bash
# First-time deploy
./agent-team/scripts/sync-agent-workspaces.sh

# Clean deploy (wipes ~/.openclaw/workspace-*/ and ~/.openclaw/skills/, preserves .env + openclaw.json)
./agent-team/scripts/sync-agent-workspaces.sh --clean
```

PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agent-team/scripts/sync-agent-workspaces.ps1 -All -IncludeSharedSkills -IncludeSharedState -IncludeConfig
powershell -NoProfile -ExecutionPolicy Bypass -File agent-team/scripts/sync-agent-workspaces.ps1 -All -Clean -IncludeSharedSkills -IncludeSharedState -IncludeConfig
```

The sync script:
- Copies `openclaw.json` → `~/.openclaw/openclaw.json`
- Copies `scheduled-jobs.json` → `~/.openclaw/scheduled-jobs.json` (if present)
- Copies `.env` → `~/.openclaw/.env` (first run only)
- Deploys all 5 agent workspaces to `~/.openclaw/workspace-<agentId>/`
- Copies shared state into each workspace's `shared/`
- Creates each workspace's `files/` + `files/index.md` boilerplate on first run
- Copies shared skills to `~/.openclaw/skills/`
- Restarts the gateway (bash version)

### 3. Verify

```bash
openclaw channels status --probe
```

All 5 Slack accounts should show connected, and all 11 channels should be resolvable.

### 4. Invite bots to channels

- **Orchestrator**: all 11 channels (including `#watchlist`, `#weekly-outlook`).
- **Scout**: `#market-signals`, `#dispatch`, `#watchlist`, `#weekly-outlook`, `#agents`.
- **Analyst**: `#research`, `#market-signals`, `#dispatch`, `#watchlist`, `#agents`.
- **Quant**: `#quant-signals`, `#research`, `#dispatch`, `#watchlist`, `#agents`.
- **Devil's Advocate**: `#contrarian`, `#research`, `#quant-signals`, `#market-signals`, `#dispatch`, `#watchlist`, `#weekly-outlook`, `#agents`.

### 5. Register scheduled jobs

After deploy, register the scheduled-jobs map (or use the `scheduled-tasks` MCP surface):

```bash
# The sync script deploys ~/.openclaw/scheduled-jobs.json.
# Registration depends on your openclaw CLI version; see project docs.
```

The scheduled job set fires Scout's morning watchlist, pre-market / mid-day / post-market scans, daily earnings tracker, and Sunday weekly outlook. All cron expressions use America/New_York.

### 6. Test

- DM the Orchestrator in Slack → pairing code.
- In `#dispatch`, ask the Orchestrator to run `explicit_dispatch` against Scout for a manual `build_morning_watchlist` and watch the flow through `#watchlist`.
- Trigger `compute_technical_signals` on Quant for a couple of watchlist names and watch the pointer + JSON flow into `#quant-signals`.
- Trigger `thesis_stress_test` on Devil's Advocate against an Analyst thesis and verify the follow-up question flow via `follow_up_questions` in `#research`.

## Updating

```bash
# On the VM
git pull
./agent-team/scripts/sync-agent-workspaces.sh             # additive
./agent-team/scripts/sync-agent-workspaces.sh --clean     # full clean resync
```

`--clean` never touches `~/.openclaw/.env`. It does rewrite `~/.openclaw/openclaw.json` from the source config each run.

## Architecture notes

- **A2A is enabled for artifact pull only.** `agentToAgent.enabled: true`, but the hard team rule is: A2A is ONLY for pulling finished artifacts from another agent's `files/` folder after a Slack pointer has been posted. Tasking, discussion, and coordination stay in Slack. See `shared-skills/a2a-artifact-pull/SKILL.md`.
- **No trade execution.** No agent has tooling to execute trades. Humans make all execution decisions.
- **Orchestrator is the only dispatcher.** Via `explicit_dispatch` — one question, one specialist, one reply channel, one deadline.
- **Channel-visible handoffs.** All tasking goes through `#dispatch`. Follow-up questions go in the specialist's own channel via `follow_up_questions`.
- **Canonical state = channels.** `#watchlist` replaces `watchlist.md`; `#portfolio-daily` replaces `recent-decisions.md`. Every agent reads these two channel tails on startup.
- **Per-agent MEMORY.md.** Append-only session log. Read tail at startup. Every 5 sessions (or after a weekend gap) also scan the `files/index.md` tail.
- **Per-agent files discipline.** Each workspace keeps `files/YYYY-MM-DD/<category>-<slug>.<ext>` plus `files/index.md`. Large artifacts live here; Slack gets short pointers.
- **DM policy.** Only the Orchestrator accepts DMs (`dmPolicy: "pairing"`). Specialists have DMs disabled.
- **Mention-gated channels.** All channels use `requireMention: true` — agents only respond when `@mentioned`.
- **Source discipline.** Allowlist of approved sources; Reuters is denied. See `shared-skills/approved-sources/SKILL.md`.
- **Voice rule.** Human-facing answers are minimal and to the point.
