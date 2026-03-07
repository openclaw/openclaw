# 🦞 OpenClaw — Personal AI Assistant

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** is a _personal AI assistant_ you run on your own devices. It answers you on the messaging channels you already use — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage (via BlueBubbles), IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, and WebChat. It can speak and listen on macOS/iOS/Android, and can render a live Canvas you control. The Gateway is the control plane — the product is the assistant.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.

[Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Vision](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [Updating](https://docs.openclaw.ai/install/updating) · [Showcase](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/help/faq) · [Wizard](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

**Preferred setup:** run the onboarding wizard (`openclaw onboard`) in your terminal. The wizard guides you step by step through setting up the gateway, workspace, channels, and skills. The CLI wizard is the recommended path and works on **macOS, Linux, and Windows (via WSL2; strongly recommended)**. Works with npm, pnpm, or bun.

New install? Start here: [Getting started](https://docs.openclaw.ai/start/getting-started)

---

## Sponsors

| OpenAI | Vercel | Blacksmith | Convex |
| --- | --- | --- | --- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

**OAuth subscriptions supported:**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

> **Model note:** While many providers and models are supported, for the best experience and lowest prompt-injection risk, use the strongest latest-generation model available to you. See [Onboarding](https://docs.openclaw.ai/start/onboarding).

---

## Models (Selection + Auth)

- Models config + CLI: [Models](https://docs.openclaw.ai/concepts/models)
- Auth profile rotation (OAuth vs API keys) + fallbacks: [Model failover](https://docs.openclaw.ai/concepts/model-failover)

---

## Install (Recommended)

**Runtime: Node ≥ 22**

```bash
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

The wizard installs the Gateway daemon (launchd/systemd user service) so it stays running.

---

## Quick Start (TL;DR)

**Runtime: Node ≥ 22**

Full beginner guide (auth, pairing, channels): [Getting started](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# Talk to the assistant
# Optionally deliver responses back to any connected channel
openclaw agent --message "Ship checklist" --thinking high
```

> Upgrading? See the [Updating guide](https://docs.openclaw.ai/install/updating) and run `openclaw doctor`.

---

## Development Channels

- **stable** — tagged releases (`vYYYY.M.D` or `vYYYY.M.D-<patch>`), npm dist-tag `latest`
- **beta** — prerelease tags (`vYYYY.M.D-beta.N`), npm dist-tag `beta` (macOS app may be absent)
- **dev** — moving head of `main`, npm dist-tag `dev` (when published)

Switch channels (git + npm): `openclaw update --channel stable|beta|dev`

Details: [Development channels](https://docs.openclaw.ai/install/development-channels)

---

## Building from Source (Development)

Prefer `pnpm` for builds from source. Bun is optional for running TypeScript directly.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build   # auto-installs UI deps on first run
pnpm build

pnpm openclaw onboard --install-daemon

# Dev loop (auto-reload on TypeScript changes)
pnpm gateway:watch
```

> **Note:** `pnpm openclaw ...` runs TypeScript directly via `tsx`. `pnpm build` produces `dist/` for running via Node or the packaged `openclaw` binary.

---

## Security Defaults (DM Access)

OpenClaw connects to real messaging surfaces. Treat inbound DMs as **untrusted input**.

Full security guide: [Security](https://docs.openclaw.ai/gateway/security)

Default behavior on Telegram, WhatsApp, Signal, iMessage, Microsoft Teams, Discord, Google Chat, and Slack:

- **DM pairing** (`dmPolicy: "pairing"`): Unknown senders receive a short pairing code and the bot does not process their message until approved.
- Approve with: `openclaw pairing approve <channel> <code>` (the sender is then added to a local allowlist).
- Public inbound DMs require explicit opt-in: set `dmPolicy: "open"` and include `"*"` in the channel `allowFrom` list.

Run `openclaw doctor` to surface risky or misconfigured DM policies.

---

## Highlights

- **[Local-first Gateway](https://docs.openclaw.ai/gateway)** — single control plane for sessions, channels, tools, and events.
- **[Multi-channel inbox](https://docs.openclaw.ai/channels)** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (legacy), IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat, macOS, iOS, and Android.
- **[Multi-agent routing](https://docs.openclaw.ai/gateway/configuration)** — route inbound channels/accounts/peers to isolated agents (workspaces + per-agent sessions).
- **[Voice Wake](https://docs.openclaw.ai/nodes/voicewake) + [Talk Mode](https://docs.openclaw.ai/nodes/talk)** — wake words on macOS/iOS and continuous voice on Android (ElevenLabs + system TTS fallback).
- **[Live Canvas](https://docs.openclaw.ai/platforms/mac/canvas)** — agent-driven visual workspace with [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- **[First-class tools](https://docs.openclaw.ai/tools)** — browser, canvas, nodes, cron, sessions, and Discord/Slack actions.
- **[Companion apps](https://docs.openclaw.ai/platforms/macos)** — macOS menu bar app + iOS/Android [nodes](https://docs.openclaw.ai/nodes).
- **[Onboarding wizard](https://docs.openclaw.ai/start/wizard) + [skills](https://docs.openclaw.ai/tools/skills)** — wizard-driven setup with bundled, managed, and workspace skills.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

---

## Everything We've Built

### Core Platform

- [Gateway WebSocket control plane](https://docs.openclaw.ai/gateway) with sessions, presence, config, cron, webhooks, [Control UI](https://docs.openclaw.ai/web), and [Canvas host](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui).
- [CLI surface](https://docs.openclaw.ai/tools/agent-send): gateway, agent, send, [wizard](https://docs.openclaw.ai/start/wizard), and [doctor](https://docs.openclaw.ai/gateway/doctor).
- Pi agent runtime (the core agent process) in RPC mode with tool streaming and block streaming. See: [Agent](https://docs.openclaw.ai/concepts/agent)
- [Session model](https://docs.openclaw.ai/concepts/session): `main` for direct chats, group isolation, activation modes, queue modes, reply-back. Group rules: [Groups](https://docs.openclaw.ai/channels/groups).
- [Media pipeline](https://docs.openclaw.ai/nodes/images): images/audio/video, transcription hooks, size caps, temp file lifecycle. Audio details: [Audio](https://docs.openclaw.ai/nodes/audio).

### Channels

- [Channels](https://docs.openclaw.ai/channels): [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) (Baileys), [Telegram](https://docs.openclaw.ai/channels/telegram) (grammY), [Slack](https://docs.openclaw.ai/channels/slack) (Bolt), [Discord](https://docs.openclaw.ai/channels/discord) (discord.js), [Google Chat](https://docs.openclaw.ai/channels/googlechat), [Signal](https://docs.openclaw.ai/channels/signal) (signal-cli), [BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) (iMessage, recommended), [iMessage legacy](https://docs.openclaw.ai/channels/imessage), [IRC](https://docs.openclaw.ai/channels/irc), [Microsoft Teams](https://docs.openclaw.ai/channels/msteams), [Matrix](https://docs.openclaw.ai/channels/matrix), [Feishu](https://docs.openclaw.ai/channels/feishu), [LINE](https://docs.openclaw.ai/channels/line), [Mattermost](https://docs.openclaw.ai/channels/mattermost), [Nextcloud Talk](https://docs.openclaw.ai/channels/nextcloud-talk), [Nostr](https://docs.openclaw.ai/channels/nostr), [Synology Chat](https://docs.openclaw.ai/channels/synology-chat), [Tlon](https://docs.openclaw.ai/channels/tlon), [Twitch](https://docs.openclaw.ai/channels/twitch), [Zalo](https://docs.openclaw.ai/channels/zalo), [Zalo Personal](https://docs.openclaw.ai/channels/zalouser), [WebChat](https://docs.openclaw.ai/web/webchat).
- [Group routing](https://docs.openclaw.ai/channels/group-messages): mention gating, reply tags, per-channel chunking and routing.

### Apps + Nodes

- [macOS app](https://docs.openclaw.ai/platforms/macos): menu bar control plane, [Voice Wake](https://docs.openclaw.ai/nodes/voicewake)/PTT, [Talk Mode](https://docs.openclaw.ai/nodes/talk) overlay, [WebChat](https://docs.openclaw.ai/web/webchat), debug tools, [remote gateway](https://docs.openclaw.ai/gateway/remote) control.
- [iOS node](https://docs.openclaw.ai/platforms/ios): [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), [Voice Wake](https://docs.openclaw.ai/nodes/voicewake), [Talk Mode](https://docs.openclaw.ai/nodes/talk), camera, screen recording, Bonjour + device pairing.
- [Android node](https://docs.openclaw.ai/platforms/android): Connect tab (setup code/manual), chat sessions, voice tab, [Canvas](https://docs.openclaw.ai/platforms/mac/canvas), camera/screen recording, and Android device commands (notifications, location, SMS, photos, contacts, calendar, motion, app update).
- [macOS node mode](https://docs.openclaw.ai/nodes): `system.run`/`system.notify` + canvas/camera exposure.

### Tools + Automation

- [Browser control](https://docs.openclaw.ai/tools/browser): dedicated OpenClaw Chrome/Chromium, snapshots, actions, uploads, profiles.
- [Canvas](https://docs.openclaw.ai/platforms/mac/canvas): [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) push/reset, eval, snapshot.
- [Nodes](https://docs.openclaw.ai/nodes): camera snap/clip, screen record, [location.get](https://docs.openclaw.ai/nodes/location-command), notifications.
- [Cron + wakeups](https://docs.openclaw.ai/automation/cron-jobs); [webhooks](https://docs.openclaw.ai/automation/webhook); [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub).
- [Skills platform](https://docs.openclaw.ai/tools/skills): bundled, managed, and workspace skills with install gating and UI.

### Runtime + Safety

- [Channel routing](https://docs.openclaw.ai/channels/channel-routing), [retry policy](https://docs.openclaw.ai/concepts/retry), and [streaming/chunking](https://docs.openclaw.ai/concepts/streaming).
- [Presence](https://docs.openclaw.ai/concepts/presence), [typing indicators](https://docs.openclaw.ai/concepts/typing-indicators), and [usage tracking](https://docs.openclaw.ai/concepts/usage-tracking).
- [Models](https://docs.openclaw.ai/concepts/models), [model failover](https://docs.openclaw.ai/concepts/model-failover), and [session pruning](https://docs.openclaw.ai/concepts/session-pruning).
- [Security](https://docs.openclaw.ai/gateway/security) and [troubleshooting](https://docs.openclaw.ai/channels/troubleshooting).

### Ops + Packaging

- [Control UI](https://docs.openclaw.ai/web) + [WebChat](https://docs.openclaw.ai/web/webchat) served directly from the Gateway.
- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale) or [SSH tunnels](https://docs.openclaw.ai/gateway/remote) with token/password auth.
- [Nix mode](https://docs.openclaw.ai/install/nix) for declarative config; [Docker](https://docs.openclaw.ai/install/docker)-based installs.
- [Doctor](https://docs.openclaw.ai/gateway/doctor) migrations, [logging](https://docs.openclaw.ai/logging).

---

## How It Works

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage (BlueBubbles)
IRC / Microsoft Teams / Matrix / Feishu / LINE / Mattermost / Nextcloud Talk
Nostr / Synology Chat / Tlon / Twitch / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC — core agent process)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS / Android nodes
```

---

## Key Subsystems

- **[Gateway WebSocket network](https://docs.openclaw.ai/concepts/architecture)** — single WS control plane for clients, tools, and events. See also: [Gateway runbook](https://docs.openclaw.ai/gateway).
- **[Tailscale exposure](https://docs.openclaw.ai/gateway/tailscale)** — Serve/Funnel for the Gateway dashboard + WS. See also: [Remote access](https://docs.openclaw.ai/gateway/remote).
- **[Browser control](https://docs.openclaw.ai/tools/browser)** — OpenClaw-managed Chrome/Chromium with CDP control.
- **[Canvas + A2UI](https://docs.openclaw.ai/platforms/mac/canvas)** — agent-driven visual workspace.
- **[Voice Wake](https://docs.openclaw.ai/nodes/voicewake) + [Talk Mode](https://docs.openclaw.ai/nodes/talk)** — wake words on macOS/iOS plus continuous voice on Android.
- **[Nodes](https://docs.openclaw.ai/nodes)** — Canvas, camera snap/clip, screen record, `location.get`, notifications, plus macOS-only `system.run`/`system.notify`.

---

## Tailscale Access (Gateway Dashboard)

OpenClaw can auto-configure Tailscale **Serve** (tailnet-only) or **Funnel** (public) while the Gateway stays bound to loopback. Configure via `gateway.tailscale.mode`:

- `off` — no Tailscale automation (default)
- `serve` — tailnet-only HTTPS via `tailscale serve` (uses Tailscale identity headers by default)
- `funnel` — public HTTPS via `tailscale funnel` (requires shared password auth)

**Notes:**

- `gateway.bind` must remain `loopback` when Serve/Funnel is enabled (OpenClaw enforces this).
- Serve can be forced to require a password by setting `gateway.auth.mode: "password"` or `gateway.auth.allowTailscale: false`.
- Funnel will not start unless `gateway.auth.mode: "password"` is set.
- Optional: set `gateway.tailscale.resetOnExit: true` to undo Serve/Funnel on shutdown.

Details: [Tailscale guide](https://docs.openclaw.ai/gateway/tailscale) · [Web surfaces](https://docs.openclaw.ai/web)

---

## Remote Gateway (Linux)

You can run the Gateway on a small Linux instance. Clients (macOS app, CLI, WebChat) connect over **Tailscale Serve/Funnel** or **SSH tunnels**, and you can still pair device nodes (macOS/iOS/Android) to execute device-local actions when needed.

- **Gateway host** runs the exec tool and channel connections by default.
- **Device nodes** run device-local actions (`system.run`, camera, screen recording, notifications) via `node.invoke`.

In short: exec runs where the Gateway lives; device actions run where the device lives.

Details: [Remote access](https://docs.openclaw.ai/gateway/remote) · [Nodes](https://docs.openclaw.ai/nodes) · [Security](https://docs.openclaw.ai/gateway/security)

---

## macOS Permissions via the Gateway Protocol

The macOS app can run in **node mode** and advertises its capabilities and permission map over the Gateway WebSocket (`node.list` / `node.describe`). Clients can then execute local actions via `node.invoke`:

- `system.run` — runs a local command and returns stdout/stderr/exit code. Set `needsScreenRecording: true` to require screen-recording permission (otherwise returns `PERMISSION_MISSING`).
- `system.notify` — posts a user notification; fails if notifications are denied.
- `canvas.*`, `camera.*`, `screen.record`, and `location.get` — all routed via `node.invoke` and follow TCC permission status.

**Elevated bash** (host permissions) is separate from macOS TCC:

- Use the chat command `/elevated on|off` to toggle per-session elevated access when enabled and allowlisted.
- The Gateway persists the per-session toggle via `sessions.patch` (WS method), alongside `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, and `groupActivation`.

Details: [Nodes](https://docs.openclaw.ai/nodes) · [macOS app](https://docs.openclaw.ai/platforms/macos) · [Gateway protocol](https://docs.openclaw.ai/concepts/architecture)

---

## Agent-to-Agent (`sessions_*` Tools)

Use these to coordinate work across sessions without jumping between chat surfaces:

- `sessions_list` — discover active sessions (agents) and their metadata
- `sessions_history` — fetch transcript logs for a session
- `sessions_send` — message another session; optional reply-back ping-pong + announce step (`REPLY_SKIP`, `ANNOUNCE_SKIP`)

Details: [Session tools](https://docs.openclaw.ai/concepts/session-tool)

---

## Skills Registry (ClawHub)

ClawHub is a minimal skill registry. With ClawHub enabled, the agent can search for skills automatically and pull in new ones as needed. See the docs for setup instructions.

[ClawHub](https://clawhub.com)

---

## Chat Commands

Send these in WhatsApp, Telegram, Slack, Google Chat, Microsoft Teams, or WebChat. Group commands are owner-only.

| Command | Description |
|---|---|
| `/status` | Compact session status (model + tokens, cost when available) |
| `/new` or `/reset` | Reset the session |
| `/compact` | Compact session context (summary) |
| `/think <level>` | Set thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `/verbose on\|off` | Toggle verbose mode |
| `/usage off\|tokens\|full` | Per-response usage footer |
| `/elevated on\|off` | Toggle elevated bash access (when enabled + allowlisted) |
| `/restart` | Restart the gateway (owner-only in groups) |
| `/activation mention\|always` | Group activation toggle (groups only) |

---

## Apps (Optional)

The Gateway alone delivers a great experience. All companion apps are optional and add platform-specific features.

### macOS (OpenClaw.app)

- Menu bar control for the Gateway and health status
- Voice Wake + push-to-talk overlay
- WebChat + debug tools
- Remote gateway control over SSH

> **Note:** Signed builds are required for macOS permissions to persist across rebuilds. See `docs/mac/permissions.md`.

### iOS Node

- Pairs as a node over the Gateway WebSocket (device pairing)
- Voice trigger forwarding + Canvas surface
- Controlled via `openclaw nodes …`

Runbook: [iOS connect](https://docs.openclaw.ai/platforms/ios)

### Android Node

- Pairs as a WS node via device pairing (`openclaw devices ...`)
- Exposes Connect/Chat/Voice tabs plus Canvas, Camera, Screen capture, and Android device command families

Runbook: [Android connect](https://docs.openclaw.ai/platforms/android)

---

## Agent Workspace + Skills

- **Workspace root:** `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`)
- **Injected prompt files:** `AGENTS.md`, `SOUL.md`, `TOOLS.md`
- **Skills:** `~/.openclaw/workspace/skills/<skill>/SKILL.md`

---

## Configuration

> **Note:** Config files use [JSON5](https://json5.org/) format (supports comments and unquoted keys). The file is located at `~/.openclaw/openclaw.json`.

Minimal config (model + defaults):

```json5
{
  agent: {
    model: "claude-opus-4-6",  // Anthropic model ID (no provider prefix required)
  },
}
```

[Full configuration reference (all keys + examples)](https://docs.openclaw.ai/gateway/configuration)

---

## Security Model (Important)

- **Default:** Tools run on the host for the **main** session, so the agent has full access when it's just you.
- **Group/channel safety:** Set `agents.defaults.sandbox.mode: "non-main"` to run non-main sessions (groups/channels) inside per-session Docker sandboxes. Bash then runs in Docker for those sessions.
- **Sandbox defaults:**
  - Allowlist: `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`
  - Denylist: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

Details: [Security guide](https://docs.openclaw.ai/gateway/security) · [Docker + sandboxing](https://docs.openclaw.ai/install/docker) · [Sandbox config](https://docs.openclaw.ai/gateway/configuration)

---

## Channel Setup

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- Link the device: `openclaw channels login` (stores credentials in `~/.openclaw/credentials`)
- Allowlist who can talk to the assistant via `channels.whatsapp.allowFrom`
- If `channels.whatsapp.groups` is set, it becomes a group allowlist; include `"*"` to allow all

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- Set `TELEGRAM_BOT_TOKEN` env var or `channels.telegram.botToken` in config (env wins)
- Optional: set `channels.telegram.groups` with `requireMention`; when set, it is a group allowlist (include `"*"` to allow all)

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF",
    },
  },
}
```

### [Slack](https://docs.openclaw.ai/channels/slack)

- Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` env vars (or `channels.slack.botToken` + `channels.slack.appToken` in config)

### [Discord](https://docs.openclaw.ai/channels/discord)

- Set `DISCORD_BOT_TOKEN` env var or `channels.discord.token` in config (env wins)
- Optional: configure `commands.native`, `commands.text`, `commands.useAccessGroups`, `channels.discord.allowFrom`, `channels.discord.guilds`, or `channels.discord.mediaMaxMb`

```json5
{
  channels: {
    discord: {
      token: "1234abcd",
    },
  },
}
```

### [Signal](https://docs.openclaw.ai/channels/signal)

- Requires `signal-cli` and a `channels.signal` config section

### [BlueBubbles (iMessage)](https://docs.openclaw.ai/channels/bluebubbles)

- **Recommended** iMessage integration
- Configure `channels.bluebubbles.serverUrl`, `channels.bluebubbles.password`, and a webhook path via `channels.bluebubbles.webhookPath`
- The BlueBubbles server runs on macOS; the Gateway can run on macOS or a remote machine

### [iMessage (Legacy)](https://docs.openclaw.ai/channels/imessage)

- Legacy macOS-only integration via `imsg` (Messages app must be signed in)
- If `channels.imessage.groups` is set, it becomes a group allowlist; include `"*"` to allow all

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- Configure a Teams app + Bot Framework, then add an `msteams` config section
- Allowlist via `msteams.allowFrom`; group access via `msteams.groupAllowFrom` or `msteams.groupPolicy: "open"`

### [WebChat](https://docs.openclaw.ai/web/webchat)

- Uses the Gateway WebSocket; no separate WebChat port or config required

### Browser Control (Optional)

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500",
  },
}
```

---

## Docs

Use these when you're past the onboarding flow and want deeper reference.

- [Docs index — navigation and "what's where"](https://docs.openclaw.ai)
- [Architecture overview — gateway + protocol model](https://docs.openclaw.ai/concepts/architecture)
- [Full configuration reference — every key and example](https://docs.openclaw.ai/gateway/configuration)
- [Gateway operational runbook](https://docs.openclaw.ai/gateway)
- [Control UI / Web surfaces — how to expose safely](https://docs.openclaw.ai/web)
- [Remote access — SSH tunnels or tailnets](https://docs.openclaw.ai/gateway/remote)
- [Onboarding wizard flow](https://docs.openclaw.ai/start/wizard)
- [Webhook surface — external triggers](https://docs.openclaw.ai/automation/webhook)
- [Gmail Pub/Sub triggers](https://docs.openclaw.ai/automation/gmail-pubsub)
- [macOS menu bar companion](https://docs.openclaw.ai/platforms/mac/menu-bar)
- Platform guides: [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows) · [Linux](https://docs.openclaw.ai/platforms/linux) · [macOS](https://docs.openclaw.ai/platforms/macos) · [iOS](https://docs.openclaw.ai/platforms/ios) · [Android](https://docs.openclaw.ai/platforms/android)
- [Troubleshooting guide](https://docs.openclaw.ai/channels/troubleshooting)
- [Security guidance](https://docs.openclaw.ai/gateway/security)

## Advanced Docs (Discovery + Control)

- [Discovery + transports](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS](https://docs.openclaw.ai/gateway/bonjour)
- [Gateway pairing](https://docs.openclaw.ai/gateway/pairing)
- [Remote gateway README](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [Control UI](https://docs.openclaw.ai/web/control-ui)
- [Dashboard](https://docs.openclaw.ai/web/dashboard)

## Operations & Troubleshooting

- [Health checks](https://docs.openclaw.ai/gateway/health)
- [Gateway lock](https://docs.openclaw.ai/gateway/gateway-lock)
- [Background process](https://docs.openclaw.ai/gateway/background-process)
- [Browser troubleshooting (Linux)](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [Logging](https://docs.openclaw.ai/logging)

## Deep Dives

- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop)
- [Presence](https://docs.openclaw.ai/concepts/presence)
- [TypeBox schemas](https://docs.openclaw.ai/concepts/typebox)
- [RPC adapters](https://docs.openclaw.ai/reference/rpc)
- [Queue](https://docs.openclaw.ai/concepts/queue)

## Workspace & Skills

- [Skills config](https://docs.openclaw.ai/tools/skills-config)
- [Default AGENTS](https://docs.openclaw.ai/reference/AGENTS.default)
- [Templates: AGENTS](https://docs.openclaw.ai/reference/templates/AGENTS)
- [Templates: BOOTSTRAP](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)
- [Templates: IDENTITY](https://docs.openclaw.ai/reference/templates/IDENTITY)
- [Templates: SOUL](https://docs.openclaw.ai/reference/templates/SOUL)
- [Templates: TOOLS](https://docs.openclaw.ai/reference/templates/TOOLS)
- [Templates: USER](https://docs.openclaw.ai/reference/templates/USER)

## Platform Internals

- [macOS dev setup](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [macOS menu bar](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [macOS Voice Wake](https://docs.openclaw.ai/platforms/mac/voicewake)
- [iOS node](https://docs.openclaw.ai/platforms/ios)
- [Android node](https://docs.openclaw.ai/platforms/android)
- [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)
- [Linux app](https://docs.openclaw.ai/platforms/linux)

## Email Hooks (Gmail)

- [Gmail Pub/Sub setup](https://docs.openclaw.ai/automation/gmail-pubsub)

---

## About

OpenClaw was built for **Molty**, a space lobster AI assistant. 🦞  
Created by Peter Steinberger and the community.

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw on X](https://x.com/openclaw)

---

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.  
AI/vibe-coded PRs welcome! 🤖

Special thanks to [Mario Zechner](https://mariozechner.at/) for his support and for [pi-mono](https://github.com/badlogic/pi-mono).  
Special thanks to Adam Doppelt for lobster.bot.

Thanks to all clawtributors:

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/vincentkoc"><img src="https://avatars.githubusercontent.com/u/25068?v=4&s=48" width="48" height="48" alt="vincentkoc" title="vincentkoc"/></a> <a href="https://github.com/vignesh07"><img src="https://avatars.githubusercontent.com/u/1436853?v=4&s=48" width="48" height="48" alt="vignesh07" title="vignesh07"/></a> <a href="https://github.com/obviyus"><img src="https://avatars.githubusercontent.com/u/22031114?v=4&s=48" width="48" height="48" alt="obviyus" title="obviyus"/></a> <a href="https://github.com/mbelinky"><img src="https://avatars.githubusercontent.com/u/132747814?v=4&s=48" width="48" height="48" alt="Mariano Belinky" title="Mariano Belinky"/></a> <a href="https://github.com/sebslight"><img src="https://avatars.githubusercontent.com/u/19554889?v=4&s=48" width="48" height="48" alt="sebslight" title="sebslight"/></a> <a href="https://github.com/gumadeiras"><img src="https://avatars.githubusercontent.com/u/5599352?v=4&s=48" width="48" height="48" alt="gumadeiras" title="gumadeiras"/></a> <a href="https://github.com/Takhoffman"><img src="https://avatars.githubusercontent.com/u/781889?v=4&s=48" width="48" height="48" alt="Takhoffman" title="Takhoffman"/></a> <a href="https://github.com/thewilloftheshadow"><img src="https://avatars.githubusercontent.com/u/35580099?v=4&s=48" width="48" height="48" alt="thewilloftheshadow" title="thewilloftheshadow"/></a> <a href="https://github.com/cpojer"><img src="https://avatars.githubusercontent.com/u/13352?v=4&s=48" width="48" height="48" alt="cpojer" title="cpojer"/></a>
</p>

*(Full contributor list on [GitHub](https://github.com/openclaw/openclaw/graphs/contributors))*
