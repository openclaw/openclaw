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
It answers you on the surfaces you already use (WhatsApp, Telegram, Discord, iMessage, WebChat), can speak and listen on macOS/iOS, and can render a live Canvas you control. The Gateway is just the control plane — the product is the assistant.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.

Website: https://clawd.me · Docs: [`docs/index.md`](docs/index.md) · FAQ: [`docs/faq.md`](docs/faq.md) · Wizard: [`docs/wizard.md`](docs/wizard.md) · Docker (optional): [`docs/docker.md`](docs/docker.md) · Discord: https://discord.gg/clawd

Preferred setup: run the onboarding wizard (`clawdbot onboard`). It walks through gateway, workspace, providers, and skills. The CLI wizard is the recommended path and works on **macOS, Windows, and Linux**.

Using Claude Pro/Max subscription? See `docs/onboarding.md` for the Anthropic OAuth setup.

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

## What Clawdbot does

- **Personal assistant** — one user, one identity, one memory surface.
- **Multi-surface inbox** — WhatsApp, Telegram, Discord, iMessage, WebChat, macOS, iOS. Signal support via `signal-cli` (see `docs/signal.md`). iMessage uses `imsg` (see `docs/imessage.md`).
- **Voice wake + push-to-talk** — local speech recognition on macOS/iOS.
- **Canvas** — a live visual workspace you can drive from the agent.
- **Automation-ready** — browser control, media handling, and tool streaming.
- **Local-first control plane** — the Gateway owns state, everything else connects.
- **Group chats** — mention-based by default, `/activation always|mention` per group (owner-only).
- **Nix mode** — opt-in declarative config + read-only UI when `CLAWDBOT_NIX_MODE=1`.

## How it works (short)

- **Gateway** is the single source of truth for sessions/providers.
- **Loopback-first**: `ws://127.0.0.1:18789` by default.
- **Bridge** (optional) exposes a paired-node port for iOS/Android.
- **Agent runtime** is **Pi** in RPC mode.

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

# Talk to the assistant (optionally deliver back to WhatsApp/Telegram/Discord)
pnpm clawdbot agent --message "Ship checklist" --thinking high
```

If you run from source, prefer `pnpm clawdbot …` (not global `clawdbot`).

## Chat commands

Send these in WhatsApp/Telegram/WebChat (group commands are owner-only):

- `/status` — health + session info (group shows activation mode)
- `/new` or `/reset` — reset the session
- `/think <level>` — off|minimal|low|medium|high
- `/verbose on|off`
- `/restart` — restart the gateway (owner-only in groups)
- `/activation mention|always` — group activation toggle (groups only)

## Architecture

### TypeScript Gateway (src/gateway/server.ts)
- **Single HTTP+WS server** on `ws://127.0.0.1:18789` (bind policy: loopback/lan/tailnet/auto). The first frame must be `connect`; AJV validates frames against TypeBox schemas (`src/gateway/protocol`).
- **Single source of truth** for sessions, providers, cron, voice wake, and presence. Methods cover `send`, `agent`, `chat.*`, `sessions.*`, `config.*`, `cron.*`, `voicewake.*`, `node.*`, `system-*`, `wake`.
- **Events + snapshot**: handshake returns a snapshot (presence/health) and declares event types; runtime events include `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `cron`, `node.pair.*`, `voicewake.changed`, `shutdown`.
- **Idempotency & safety**: `send`/`agent`/`chat.send` require idempotency keys with a TTL cache (5 min, cap 1000) to avoid double‑sends on reconnects; payload sizes are capped per connection.
- **Bridge for nodes**: optional TCP bridge (`src/infra/bridge/server.ts`) is newline‑delimited JSON frames (`hello`, pairing, RPC, `invoke`); node connect/disconnect is surfaced into presence.
- **Control UI + Canvas Host**: HTTP serves Control UI assets (default `/`, optional base path) and can host a live‑reload Canvas host for nodes (`src/canvas-host/server.ts`), injecting the A2UI postMessage bridge.

### iOS app (apps/ios)
- **Discovery + pairing**: Bonjour discovery via `BridgeDiscoveryModel` (NWBrowser). `BridgeConnectionController` auto‑connects using Keychain token or allows manual host/port.
- **Node runtime**: `BridgeSession` (actor) maintains the `NWConnection`, hello handshake, ping/pong, RPC requests, and `invoke` callbacks.
- **Capabilities + commands**: advertises `canvas`, `screen`, `camera`, `voiceWake` (settings‑driven) and executes `canvas.*`, `canvas.a2ui.*`, `camera.*`, `screen.record` (`NodeAppModel.handleInvoke`).
- **Canvas**: `WKWebView` with bundled Canvas scaffold + A2UI, JS eval, snapshot capture, and `clawdbot://` deep‑link interception (`ScreenController`).
- **Voice + deep links**: voice wake sends `voice.transcript` events; `clawdbot://agent` links emit `agent.request`. Voice wake triggers sync via `voicewake.get` + `voicewake.changed`.

## Companion apps

The **macOS app is critical**: it runs the menu‑bar control plane, owns local permissions (TCC), hosts Voice Wake, exposes WebChat/debug tools, and coordinates local/remote gateway mode. Most “assistant” UX lives here.

### macOS (Clawdbot.app)

- Menu bar control for the Gateway and health.
- Voice Wake + push-to-talk overlay.
- WebChat + debug tools.
- Remote gateway control over SSH.

Build/run: `./scripts/restart-mac.sh` (packages + launches).

### iOS node (internal)

- Pairs as a node via the Bridge.
- Voice trigger forwarding + Canvas surface.
- Controlled via `clawdbot nodes …`.

Runbook: `docs/ios/connect.md`.

### Android node (internal)

- Pairs via the same Bridge + pairing flow as iOS.
- Exposes Canvas, Camera, and Screen capture commands.
- Runbook: `docs/android/connect.md`.

## Agent workspace + skills

- Workspace root: `~/clawd` (configurable via `agent.workspace`).
- Injected prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Skills: `~/clawd/skills/<skill>/SKILL.md`.

## Configuration

Minimal `~/.clawdbot/clawdbot.json`:

```json5
{
  whatsapp: {
    allowFrom: ["+1234567890"]
  }
}
```

### WhatsApp

- Link the device: `pnpm clawdbot login` (stores creds in `~/.clawdbot/credentials`).
- Allowlist who can talk to the assistant via `whatsapp.allowFrom`.

### Telegram

- Set `TELEGRAM_BOT_TOKEN` or `telegram.botToken` (env wins).
- Optional: set `telegram.groups` (with `telegram.groups."*".requireMention`), `telegram.allowFrom`, or `telegram.webhookUrl` as needed.

```json5
{
  telegram: {
    botToken: "123456:ABCDEF"
  }
}
```

### Discord

- Set `DISCORD_BOT_TOKEN` or `discord.token` (env wins).
- Optional: set `discord.slashCommand`, `discord.dm.allowFrom`, `discord.guilds`, or `discord.mediaMaxMb` as needed.

```json5
{
  discord: {
    token: "1234abcd"
  }
}
```

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

- [`docs/index.md`](docs/index.md) (overview)
- [`docs/configuration.md`](docs/configuration.md)
- [`docs/group-messages.md`](docs/group-messages.md)
- [`docs/gateway.md`](docs/gateway.md)
- [`docs/web.md`](docs/web.md)
- [`docs/discovery.md`](docs/discovery.md)
- [`docs/agent.md`](docs/agent.md)
- [`docs/discord.md`](docs/discord.md)
- [`docs/wizard.md`](docs/wizard.md)
- Webhooks + external triggers: [`docs/webhook.md`](docs/webhook.md)
- Gmail hooks (email → wake): [`docs/gmail-pubsub.md`](docs/gmail-pubsub.md)

## Email hooks (Gmail)

```bash
clawdbot hooks gmail setup --account you@gmail.com
clawdbot hooks gmail run
```
- [`docs/security.md`](docs/security.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/ios/connect.md`](docs/ios/connect.md)
- [`docs/clawdbot-mac.md`](docs/clawdbot-mac.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.

AI/vibe-coded PRs welcome! 🤖

## Clawd

Clawdbot was built for **Clawd**, a space lobster AI assistant.

- https://clawd.me
- https://soul.md
- https://steipete.me
