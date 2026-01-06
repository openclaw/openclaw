---
summary: "Beginner guide: from repo checkout to first message (wizard, auth, providers, pairing)"
read_when:
  - First time setup from zero
  - You want the fastest path from checkout → onboarding → first message
---

# Getting Started

Goal: go from **zero** → **first working chat** (with sane defaults) as quickly as possible.

Recommended path: use the **CLI onboarding wizard** (`clawdbot onboard`). It sets up:
- model/auth (OAuth recommended)
- gateway settings
- providers (WhatsApp/Telegram/Discord/…)
- pairing defaults (secure DMs)
- workspace bootstrap + skills
- optional background daemon

If you want the deeper reference pages, jump to: [Wizard](https://docs.clawd.bot/wizard), [Setup](https://docs.clawd.bot/setup), [Pairing](https://docs.clawd.bot/pairing), [Security](https://docs.clawd.bot/security).

## 0) Prereqs

- Node `>=22`
- `bun` (preferred) or `pnpm`
- Git

macOS: if you plan to build the apps, install Xcode / CLT. For the CLI + gateway only, Node is enough.

## 1) Check out from source

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
bun install
```

Note: `pnpm` is also supported:

```bash
pnpm install
```

## 2) Build the Control UI (recommended)

The Gateway serves the browser dashboard (Control UI) when assets exist.

```bash
bun run ui:install
bun run ui:build
bun run build
```

If you skip UI build, the gateway still works — you just won’t get the dashboard.

## 3) Run the onboarding wizard

```bash
bun run clawdbot onboard
```

What you’ll choose:
- **Local vs Remote** gateway
- **Auth**: Anthropic OAuth or OpenAI OAuth (recommended), API key (optional), or skip for now
- **Providers**: WhatsApp QR login, bot tokens, etc.
- **Daemon**: optional background install (launchd/systemd/Task Scheduler)

Wizard doc: https://docs.clawd.bot/wizard

### Auth: where it lives (important)

- OAuth credentials (legacy import): `~/.clawdbot/credentials/oauth.json`
- Auth profiles (OAuth + API keys): `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`

Headless/server tip: do OAuth on a normal machine first, then copy `oauth.json` to the gateway host.

## 4) Start the Gateway

If the wizard didn’t start it for you:

```bash
bun run clawdbot gateway --port 18789 --verbose
```

Dashboard (local loopback): `http://127.0.0.1:18789/`

## 5) Pair + connect your first chat surface

### WhatsApp (QR login)

```bash
bun run clawdbot login
```

Scan via WhatsApp → Settings → Linked Devices.

WhatsApp doc: https://docs.clawd.bot/whatsapp

### Telegram / Discord / others

The wizard can write tokens/config for you. If you prefer manual config, start with:
- Telegram: https://docs.clawd.bot/telegram
- Discord: https://docs.clawd.bot/discord

## 6) DM safety (pairing approvals)

Default posture: unknown DMs get a short code and messages are not processed until approved.

Approve:

```bash
bun run clawdbot pairing list --provider telegram
bun run clawdbot pairing approve --provider telegram <CODE>
```

Pairing doc: https://docs.clawd.bot/pairing

## 7) Verify end-to-end

In a new terminal:

```bash
bun run clawdbot health
bun run clawdbot send --to +15555550123 --message "Hello from Clawdbot"
```

If `health` shows “no auth configured”, go back to the wizard and set OAuth/key auth — the agent won’t be able to respond without it.

## Next steps (optional, but great)

- macOS menu bar app + voice wake: https://docs.clawd.bot/macos
- iOS/Android nodes (Canvas/camera/voice): https://docs.clawd.bot/nodes
- Remote access (SSH tunnel / Tailscale Serve): https://docs.clawd.bot/remote and https://docs.clawd.bot/tailscale
