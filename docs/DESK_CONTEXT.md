# Desk context — openclaw-dev

Portable architecture and runbook for **Cursor** and **Antigravity** desk agents.

## Identity

- **Product:** OpenClaw gateway fork (shrad3r/openclaw)
- **Repo key:** `openclaw-dev`
- **Path:** `/Users/jakeshrader/openclaw`
- **Fleet lane:** `henri` · agent `henri`

## Stack

| Key             | Value         |
| --------------- | ------------- |
| Language        | TypeScript    |
| Framework       | pnpm monorepo |
| Package manager | pnpm          |

## Commands

| Action | Command                                         |
| ------ | ----------------------------------------------- |
| Dev    | `pnpm openclaw`                                 |
| Test   | `pnpm test`                                     |
| Lint   | `pnpm lint`                                     |
| Build  | `pnpm build`                                    |
| Deploy | `deploy-desk-to-mini.sh (fleet policy/scripts)` |

## Ports & services

18789

## Directory map

Inspect repo root; key areas vary by project. Start with `README.md` and package manifest.

## Environment variables

Document **names only** in repo `.env.example` — never commit secrets here.

## Deploy flow

1. Feature branch from `main`
2. Verify locally (see commands above)
3. PR → review → merge
4. Product code: **git push** (MacBook) → **Mini pull**
5. OpenClaw/fleet policy: **`~/.openclaw/scripts/deploy-desk-to-mini.sh`**

## Fleet integration

- Task truth: `~/.openclaw/workspace/TASK_REGISTRY.json` (grep `openclaw`)
- Offline desk: `~/.openclaw/workspace/OFFLINE_CURSOR_HANDOFF.md`
- Paths: `~/.openclaw/workspace/workspace-paths.json`

## Git boundary (fleet fork)

- **Write target:** `shrad3r/openclaw` only — never push/PR to upstream `openclaw/openclaw`
- **Verify:** `~/.openclaw/scripts/verify-fleet-github-boundary.sh`
- **PRs:** `~/.openclaw/scripts/fleet-gh-pr-create.sh`
- Root `AGENTS.md` is upstream telegraph style — read scoped subtree `AGENTS.md` before editing subsystems

## Cursor-only files

None in this repo.

## README excerpt

> # 🦞 OpenClaw — Personal AI Assistant
>
> <p align="center">
>     <picture>
>         <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
>         <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
>     </picture>
> </p>
>
> <p align="center">
>   <strong>EXFOLIATE! EXFOLIATE!</strong>
> </p>
>
> <p align="center">
>   <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
>   <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
>   <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
>   <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
> </p>
>
> **OpenClaw** is a _personal AI assistant_ you run on your own devices.
> It answers you on the channels you already use. It can speak and listen on macOS/iOS/Android, and can render a live Canvas you control. The Gateway is just the control plane — the product is the assistant.
>
> If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.
>
> Supported channels include: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WeChat, QQ, WebChat.
>
> [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Vision](VISION.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [Updating](https://docs.openclaw.ai/install/updating) · [Showcase](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/help/faq) · [Onboarding](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)
>
> New install? Start here: [Getting started](https://docs.openclaw.ai/start/getting-started)
>
> Preferred setup: run `openclaw onboard` in your terminal.
> OpenClaw Onboard guides you step by step through setting up the gateway, workspace, channels, and skills. It is the recommended CLI setup path and works on **macOS, Linux, and Windows**.
> Windows desktop users can start with the native [Windows Hub](https://docs.openclaw.ai/platforms/windows) companion app for setup, tray status, chat, node mode, and local MCP mode.
> Works with npm, pnpm, or bun.
>
> ## Sponsors
>
> <table>
>   <tr>

_Desk context last synced: 2026-07-03_
