# 🦞 CLAWDBOT — Personal AI Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/clawdbot/clawdbot/main/docs/whatsapp-clawd.jpg" alt="CLAWDBOT" width="400">
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/clawdbot/clawdbot/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/clawdbot/clawdbot/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/clawdbot/clawdbot/releases"><img src="https://img.shields.io/github/v/release/clawdbot/clawdbot?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Clawdbot** is a *personal AI assistant* you run on your own devices.
It answers you on the surfaces you already use (WhatsApp, Telegram, Slack, Discord, iMessage, WebChat), can speak and listen on macOS/iOS, and can render a live Canvas you control. The Gateway is just the control plane — the product is the assistant.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.

Website: [clawdbot.com](https://clawdbot.com) · Docs: [docs.clawdbot.com](https://docs.clawdbot.com/) · FAQ: [FAQ](https://docs.clawdbot.com/faq) · Wizard: [Wizard](https://docs.clawdbot.com/wizard) · Nix: [nix-clawdbot](https://github.com/clawdbot/nix-clawdbot) · Docker: [Docker](https://docs.clawdbot.com/docker) · Discord: [discord.gg/clawd](https://discord.gg/clawd)

Preferred setup: run the onboarding wizard (`clawdbot onboard`). It walks through gateway, workspace, providers, and skills. The CLI wizard is the recommended path and works on **macOS, Windows, and Linux**.

Subscriptions: **Anthropic (Claude Pro/Max)** and **OpenAI (ChatGPT/Codex)** are supported via OAuth. See [Onboarding](https://docs.clawdbot.com/onboarding).

## Recommended setup (from source)

Do **not** download prebuilt binaries. Build from source.

```bash
# Clone this repo
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot

pnpm install
pnpm build
pnpm ui:build
pnpm clawdbot onboard
```

## Quick start (from source)

Runtime: **Node ≥22** + **pnpm**.

```bash
pnpm install
pnpm build
pnpm ui:build

# Recommended: run the onboarding wizard
pnpm clawdbot onboard

# Link WhatsApp (stores creds in ~/.clawdbot/credentials)
pnpm clawdbot login

# Start the gateway
pnpm clawdbot gateway --port 18789 --verbose

# Dev loop (auto-reload on TS changes)
pnpm gateway:watch

# Send a message
pnpm clawdbot send --to +1234567890 --message "Hello from Clawdbot"

# Talk to the assistant (optionally deliver back to WhatsApp/Telegram/Slack/Discord)
pnpm clawdbot agent --message "Ship checklist" --thinking high
```

Upgrading? `clawdbot doctor`.

If you run from source, prefer `pnpm clawdbot …` (not global `clawdbot`).

## Highlights

- **Local-first Gateway** — single control plane for sessions, providers, tools, and events.
- **Multi-surface inbox** — WhatsApp, Telegram, Slack, Discord, iMessage, WebChat, macOS, iOS/Android.
- **Voice Wake + Talk Mode** — always-on speech for macOS/iOS/Android with ElevenLabs.
- **Live Canvas** — agent-driven visual workspace with A2UI.
- **First-class tools** — browser, canvas, nodes, cron, sessions, and Discord/Slack actions.
- **Companion apps** — macOS menu bar app + iOS/Android nodes.
- **Onboarding + skills** — wizard-driven setup with bundled/managed/workspace skills.

## Everything we built so far

### Core platform
- Gateway WS control plane with sessions, presence, config, cron, webhooks, control UI, and Canvas host.
- CLI surface: gateway, agent, send, wizard, doctor/update, and TUI.
- Pi agent runtime in RPC mode with tool streaming and block streaming.
- Session model: `main` for direct chats, group isolation, activation modes, queue modes, reply-back.
- Media pipeline: images/audio/video, transcription hooks, size caps, temp file lifecycle.

### Surfaces + providers
- WhatsApp (Baileys), Telegram (grammY), Slack (Bolt), Discord (discord.js), Signal (signal-cli), iMessage (imsg), WebChat.
- Group mention gating, reply tags, per-surface chunking and routing.

### Apps + nodes
- macOS app: menu bar control plane, Voice Wake/PTT, Talk Mode overlay, WebChat, Debug tools, SSH remote gateway control.
- iOS node: Canvas, Voice Wake, Talk Mode, camera, screen recording, Bonjour pairing.
- Android node: Canvas, Talk Mode, camera, screen recording, optional SMS.
- macOS node mode: system.run/notify + canvas/camera exposure.

### Tools + automation
- Browser control: dedicated clawd Chrome/Chromium, snapshots, actions, uploads, profiles.
- Canvas: A2UI push/reset, eval, snapshot.
- Nodes: camera snap/clip, screen record, location.get, notifications.
- Cron + wakeups; webhooks; Gmail Pub/Sub triggers.
- Skills platform: bundled, managed, and workspace skills with install gating + UI.

### Ops + packaging
- Control UI + WebChat served directly from the Gateway.
- Tailscale Serve/Funnel or SSH tunnels with token/password auth.
- Nix mode for declarative config; Docker-based installs.
- Health, doctor migrations, structured logging, release tooling.

## How it works (short)

```
Your surfaces
   │
   ▼
┌───────────────────────────────┐
│            Gateway            │  ws://127.0.0.1:18789
│       (control plane)         │  tcp://0.0.0.0:18790 (optional Bridge)
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC)
               ├─ CLI (clawdbot …)
               ├─ WebChat (browser)
               ├─ macOS app (Clawdbot.app)
               └─ iOS node (Canvas + voice)
```

## Skills registry (ClawdHub)

ClawdHub is a minimal skill registry. With ClawdHub enabled, the agent can search for skills automatically and pull in new ones as needed.

https://clawdhub.com

## Chat commands

Send these in WhatsApp/Telegram/Slack/WebChat (group commands are owner-only):

- `/status` — health + session info (group shows activation mode)
- `/new` or `/reset` — reset the session
- `/think <level>` — off|minimal|low|medium|high
- `/verbose on|off`
- `/restart` — restart the gateway (owner-only in groups)
- `/activation mention|always` — group activation toggle (groups only)

## macOS app (optional)

The Gateway alone delivers a great experience. All apps are optional and add extra features.

### macOS (Clawdbot.app) (optional)

- Menu bar control for the Gateway and health.
- Voice Wake + push-to-talk overlay.
- WebChat + debug tools.
- Remote gateway control over SSH.

Build/run: `./scripts/restart-mac.sh` (packages + launches).

### iOS node (optional)

- Pairs as a node via the Bridge.
- Voice trigger forwarding + Canvas surface.
- Controlled via `clawdbot nodes …`.

Runbook: [iOS connect](https://docs.clawdbot.com/ios/connect).

### Android node (optional)

- Pairs via the same Bridge + pairing flow as iOS.
- Exposes Canvas, Camera, and Screen capture commands.
- Runbook: [Android connect](https://docs.clawdbot.com/android/connect).

## Agent workspace + skills

- Workspace root: `~/clawd` (configurable via `agent.workspace`).
- Injected prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Skills: `~/clawd/skills/<skill>/SKILL.md`.

## Configuration

Minimal `~/.clawdbot/clawdbot.json` (model + defaults):

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

[Full configuration reference (all keys + examples).](https://docs.clawdbot.com/configuration)

### WhatsApp

[Read the WhatsApp provider guide in docs/whatsapp.md.](docs/whatsapp.md)

- Link the device: `pnpm clawdbot login` (stores creds in `~/.clawdbot/credentials`).
- Allowlist who can talk to the assistant via `whatsapp.allowFrom`.

### Telegram

[Read the Telegram provider guide in docs/telegram.md.](docs/telegram.md)

- Set `TELEGRAM_BOT_TOKEN` or `telegram.botToken` (env wins).
- Optional: set `telegram.groups` (with `telegram.groups."*".requireMention`), `telegram.allowFrom`, or `telegram.webhookUrl` as needed.

```json5
{
  telegram: {
    botToken: "123456:ABCDEF"
  }
}
```

### Slack

[Read the Slack provider guide in docs/slack.md.](docs/slack.md)

- Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (or `slack.botToken` + `slack.appToken`).

### Discord

[Read the Discord provider guide in docs/discord.md.](docs/discord.md)

- Set `DISCORD_BOT_TOKEN` or `discord.token` (env wins).
- Optional: set `discord.slashCommand`, `discord.dm.allowFrom`, `discord.guilds`, or `discord.mediaMaxMb` as needed.

```json5
{
  discord: {
    token: "1234abcd"
  }
}
```

### Signal

[Read the Signal provider guide in docs/signal.md.](docs/signal.md)

- Requires `signal-cli` and a `signal` config section.

### iMessage

[Read the iMessage provider guide in docs/imessage.md.](docs/imessage.md)

- macOS only; Messages must be signed in.

### WebChat

[Read the WebChat guide in docs/webchat.md.](docs/webchat.md)

- Uses the Gateway WebSocket; no separate WebChat port/config.

Browser control (optional):

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    color: "#FF4500"
  }
}
```

## Docs

- [Start with the docs index for navigation and “what’s where.”](https://docs.clawdbot.com/)
- [Read the architecture overview for the gateway + protocol model.](https://docs.clawdbot.com/architecture)
- [Use the full configuration reference when you need every key and example.](https://docs.clawdbot.com/configuration)
- [Run the Gateway by the book with the operational runbook.](https://docs.clawdbot.com/gateway)
- [Learn how the Control UI/Web surfaces work and how to expose them safely.](https://docs.clawdbot.com/web)
- [Understand remote access over SSH tunnels or tailnets.](https://docs.clawdbot.com/remote)
- [Follow the onboarding wizard flow for a guided setup.](https://docs.clawdbot.com/wizard)
- [Wire external triggers via the webhook surface.](https://docs.clawdbot.com/webhook)
- [Set up Gmail Pub/Sub triggers.](https://docs.clawdbot.com/gmail-pubsub)
- [Learn the macOS menu bar companion details.](https://clawdbot.com/clawdbot-mac.html)
- [Debug common failures with the troubleshooting guide.](https://docs.clawdbot.com/troubleshooting)
- [Review security guidance before exposing anything.](https://docs.clawdbot.com/security)

## Email hooks (Gmail)

[Gmail Pub/Sub wiring (gcloud + gogcli), hook tokens, and auto-watch behavior are documented here.](https://docs.clawdbot.com/gmail-pubsub)

Gateway auto-starts the watcher when `hooks.enabled=true` and `hooks.gmail.account` is set; `clawdbot hooks gmail run` is the manual daemon wrapper if you don’t want auto-start.

```bash
clawdbot hooks gmail setup --account you@gmail.com
clawdbot hooks gmail run
```

## Clawd

Clawdbot was built for **Clawd**, a space lobster AI assistant. 🦞  
by Peter Steinberger and the community.

- https://clawd.me
- https://soul.md
- https://steipete.me

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.  
AI/vibe-coded PRs welcome! 🤖

Thanks to everyone who has contributed:

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/thewilloftheshadow"><img src="https://avatars.githubusercontent.com/u/35580099?v=4&s=48" width="48" height="48" alt="thewilloftheshadow" title="thewilloftheshadow"/></a> <a href="https://github.com/mcinteerj"><img src="https://avatars.githubusercontent.com/u/3613653?v=4&s=48" width="48" height="48" alt="mcinteerj" title="mcinteerj"/></a> <a href="https://github.com/joshp123"><img src="https://avatars.githubusercontent.com/u/1497361?v=4&s=48" width="48" height="48" alt="joshp123" title="joshp123"/></a> <a href="https://github.com/joaohlisboa"><img src="https://avatars.githubusercontent.com/u/8200873?v=4&s=48" width="48" height="48" alt="joaohlisboa" title="joaohlisboa"/></a> <a href="https://github.com/petter-b"><img src="https://avatars.githubusercontent.com/u/62076402?v=4&s=48" width="48" height="48" alt="petter-b" title="petter-b"/></a> <a href="https://github.com/mukhtharcm"><img src="https://avatars.githubusercontent.com/u/56378562?v=4&s=48" width="48" height="48" alt="mukhtharcm" title="mukhtharcm"/></a> <a href="https://github.com/dan-dr"><img src="https://avatars.githubusercontent.com/u/6669808?v=4&s=48" width="48" height="48" alt="dan-dr" title="dan-dr"/></a> <a href="https://github.com/Nachx639"><img src="https://avatars.githubusercontent.com/u/71144023?v=4&s=48" width="48" height="48" alt="Nachx639" title="Nachx639"/></a> <a href="https://github.com/jeffersonwarrior"><img src="https://avatars.githubusercontent.com/u/89030989?v=4&s=48" width="48" height="48" alt="jeffersonwarrior" title="jeffersonwarrior"/></a>
  <a href="https://github.com/mbelinky"><img src="https://avatars.githubusercontent.com/u/132747814?v=4&s=48" width="48" height="48" alt="mbelinky" title="mbelinky"/></a> <a href="https://github.com/julianengel"><img src="https://avatars.githubusercontent.com/u/10634231?v=4&s=48" width="48" height="48" alt="julianengel" title="julianengel"/></a> <a href="https://github.com/CashWilliams"><img src="https://avatars.githubusercontent.com/u/613573?v=4&s=48" width="48" height="48" alt="CashWilliams" title="CashWilliams"/></a> <a href="https://github.com/omniwired"><img src="https://avatars.githubusercontent.com/u/322761?v=4&s=48" width="48" height="48" alt="omniwired" title="omniwired"/></a> <a href="https://github.com/jverdi"><img src="https://avatars.githubusercontent.com/u/345050?v=4&s=48" width="48" height="48" alt="jverdi" title="jverdi"/></a> <a href="https://github.com/Syhids"><img src="https://avatars.githubusercontent.com/u/671202?v=4&s=48" width="48" height="48" alt="Syhids" title="Syhids"/></a> <a href="https://github.com/meaningfool"><img src="https://avatars.githubusercontent.com/u/2862331?v=4&s=48" width="48" height="48" alt="meaningfool" title="meaningfool"/></a> <a href="https://github.com/rafaelreis-r"><img src="https://avatars.githubusercontent.com/u/57492577?v=4&s=48" width="48" height="48" alt="rafaelreis-r" title="rafaelreis-r"/></a> <a href="https://github.com/wstock"><img src="https://avatars.githubusercontent.com/u/1394687?v=4&s=48" width="48" height="48" alt="wstock" title="wstock"/></a> <a href="https://github.com/vsabavat"><img src="https://avatars.githubusercontent.com/u/50385532?v=4&s=48" width="48" height="48" alt="vsabavat" title="vsabavat"/></a>
  <a href="https://github.com/scald"><img src="https://avatars.githubusercontent.com/u/1215913?v=4&s=48" width="48" height="48" alt="scald" title="scald"/></a> <a href="https://github.com/sreekaransrinath"><img src="https://avatars.githubusercontent.com/u/50989977?v=4&s=48" width="48" height="48" alt="sreekaransrinath" title="sreekaransrinath"/></a> <a href="https://github.com/ratulsarna"><img src="https://avatars.githubusercontent.com/u/105903728?v=4&s=48" width="48" height="48" alt="ratulsarna" title="ratulsarna"/></a> <a href="https://github.com/osolmaz"><img src="https://avatars.githubusercontent.com/u/2453968?v=4&s=48" width="48" height="48" alt="osolmaz" title="osolmaz"/></a> <a href="https://github.com/conhecendocontato"><img src="https://avatars.githubusercontent.com/u/82890727?v=4&s=48" width="48" height="48" alt="conhecendocontato" title="conhecendocontato"/></a> <a href="https://github.com/hrdwdmrbl"><img src="https://avatars.githubusercontent.com/u/554881?v=4&s=48" width="48" height="48" alt="hrdwdmrbl" title="hrdwdmrbl"/></a> <a href="https://github.com/jayhickey"><img src="https://avatars.githubusercontent.com/u/1676460?v=4&s=48" width="48" height="48" alt="jayhickey" title="jayhickey"/></a> <a href="https://github.com/jamesgroat"><img src="https://avatars.githubusercontent.com/u/2634024?v=4&s=48" width="48" height="48" alt="jamesgroat" title="jamesgroat"/></a> <a href="https://github.com/gtsifrikas"><img src="https://avatars.githubusercontent.com/u/8904378?v=4&s=48" width="48" height="48" alt="gtsifrikas" title="gtsifrikas"/></a> <a href="https://github.com/djangonavarro220"><img src="https://avatars.githubusercontent.com/u/251162586?v=4&s=48" width="48" height="48" alt="djangonavarro220" title="djangonavarro220"/></a>
  <a href="https://github.com/azade-c"><img src="https://avatars.githubusercontent.com/u/252790079?v=4&s=48" width="48" height="48" alt="azade-c" title="azade-c"/></a> <a href="https://github.com/andranik-sahakyan"><img src="https://avatars.githubusercontent.com/u/8908029?v=4&s=48" width="48" height="48" alt="andranik-sahakyan" title="andranik-sahakyan"/></a>
</p>
