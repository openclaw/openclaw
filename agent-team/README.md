# Investment Agent Team

Canonical source for the multi-agent investment research team that gets synced into OpenClaw runtime workspaces.

## Layout

- `agents/<agentId>/`
  - Versioned workspace files for one OpenClaw agent (`SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `skills/*`).
- `shared-skills/`
  - Reusable `SKILL.md` packages shared across all agents.
- `shared-state/portfolio/`
  - Small canonical reference files (positions, operating protocol, lifecycle patterns, conflict + error handling, dispatch template, channel map, team memory).
- `config/`
  - `openclaw.json` — runtime config with `${ENV_VAR}` interpolation for secrets and channel IDs.
  - `.env.example` — environment template (gitignored in real form, real tokens only on VM).
  - `scheduled-jobs.json` — cron-driven skill invocations (scout scans, weekly outlook, etc.).
  - `slack-app-manifest.example.json` — Socket Mode manifest template.
  - `slack-rollout-checklist.md` — five-bot, eleven-channel rollout.
- `scripts/`
  - `sync-agent-workspaces.sh` — bash deploy script (supports `--clean`).
  - `sync-agent-workspaces.ps1` — PowerShell equivalent (supports `-Clean`).

## Runtime mapping

The deploy script places these into `~/.openclaw`:

- `config/openclaw.json` → `~/.openclaw/openclaw.json`
- `config/scheduled-jobs.json` → `~/.openclaw/scheduled-jobs.json`
- `config/.env` → `~/.openclaw/.env` (first run only, never overwrites)
- `agents/<id>/*` → `~/.openclaw/workspace-<id>/`
- `shared-skills/*` → `~/.openclaw/skills/*`
- `shared-state/` → each workspace's `shared/` directory
- each workspace gets a `files/` + `files/index.md` created on first run

## Canonical state model

- **Watchlist** lives in the `#watchlist` Slack channel (rebuilt every morning by Scout, mutated during the day by Orchestrator). There is no `watchlist.md`.
- **Decisions** live in the `#portfolio-daily` Slack channel (published by Orchestrator). There is no `recent-decisions.md`.
- **Per-agent memory** lives in each agent's `MEMORY.md` (append-only session log).
- **Per-agent artifacts** live in `files/YYYY-MM-DD/<category>-<slug>.<ext>`, indexed by `files/index.md`. Agents post short pointers to Slack and retrieve full files via A2A (artifact pull only).

## Channel topology (11 channels)

| Channel | Post | Env var |
|---|---|---|
| `#dispatch` | Orchestrator | `SLACK_CHANNEL_DISPATCH` |
| `#market-signals` | Scout | `SLACK_CHANNEL_MARKET_SIGNALS` |
| `#research` | Analyst | `SLACK_CHANNEL_RESEARCH` |
| `#quant-signals` | Quant | `SLACK_CHANNEL_QUANT_SIGNALS` |
| `#contrarian` | Devil's Advocate | `SLACK_CHANNEL_CONTRARIAN` |
| `#portfolio-daily` | Orchestrator (canonical decisions) | `SLACK_CHANNEL_PORTFOLIO_DAILY` |
| `#portfolio-weekly` | Orchestrator | `SLACK_CHANNEL_PORTFOLIO_WEEKLY` |
| `#watchlist` | Orchestrator + Scout morning | `SLACK_CHANNEL_WATCHLIST` |
| `#weekly-outlook` | Scout | `SLACK_CHANNEL_WEEKLY_OUTLOOK` |
| `#themes` | any | `SLACK_CHANNEL_THEMES` |
| `#agents` | any | `SLACK_CHANNEL_AGENTS` |

All secrets and channel IDs are referenced via `${ENV_VAR}` interpolation in `config/openclaw.json`. Real values live only on the VM at `~/.openclaw/.env`.

## Scheduled jobs

See `config/scheduled-jobs.json`. Current cron map (America/New_York):

| Skill | Agent | Cron | Posts to |
|---|---|---|---|
| `build_morning_watchlist` | Scout | `30 6 * * 1-5` | `#watchlist` |
| `scan_pre_market` | Scout | `0 8 * * 1-5` | `#market-signals` |
| `scan_mid_day` | Scout | `0 12 * * 1-5` | `#market-signals` |
| `scan_post_market` | Scout | `30 16 * * 1-5` | `#market-signals` |
| `earnings_beat_tracker` | Scout | `0 17 * * 1-5` | `#market-signals` |
| `weekly_outlook` | Scout | `0 17 * * 0` | `#weekly-outlook` |

## A2A policy

Agent-to-agent direct (A2A) is **enabled but restricted**: use it only for pulling finished artifacts from another agent's `files/` folder after a Slack pointer has been posted. Never use A2A for tasking, discussion, or coordination — those stay in Slack. See `shared-skills/a2a-artifact-pull/SKILL.md`.

## Deploy

```bash
./agent-team/scripts/sync-agent-workspaces.sh            # additive sync
./agent-team/scripts/sync-agent-workspaces.sh --clean    # wipe workspace-*/ + skills/, then sync (.env and openclaw.json preserved)
```

PowerShell alternative (Windows):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agent-team/scripts/sync-agent-workspaces.ps1 -All -IncludeSharedSkills -IncludeSharedState -IncludeConfig
powershell -NoProfile -ExecutionPolicy Bypass -File agent-team/scripts/sync-agent-workspaces.ps1 -All -Clean -IncludeSharedSkills -IncludeSharedState -IncludeConfig
```

`--clean` / `-Clean` wipes `~/.openclaw/workspace-*/` and `~/.openclaw/skills/` before syncing. It never touches `~/.openclaw/.env`; it does rewrite `~/.openclaw/openclaw.json` when `-IncludeConfig` is passed.

## Notes

- `SOUL.md` — voice, authority, non-negotiables.
- `AGENTS.md` — 4-file progressive startup list, channel ownership, file-layout rule, A2A rule, hard rules.
- `IDENTITY.md` / `USER.md` — fallback identity + user context templates (required reads at startup).
- `MEMORY.md` — append-only session log; read the tail at startup.
- `skills/` — per-agent playbooks (`Trigger → Inputs → Steps → Output format → Where to post → Next step`).
- No workspace or skill in this tree grants trade execution.
- Cross-agent coordination is channel-visible by design. Specialists do not dispatch hidden work to each other.
- Reuters is on the source denylist — see `shared-skills/approved-sources/SKILL.md`.

For the full setup walkthrough, see [SETUP.md](SETUP.md).
