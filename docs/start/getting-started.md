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

If you want the deeper reference pages, jump to: [Wizard](/start/wizard), [Setup](/start/setup), [Pairing](/start/pairing), [Security](/gateway/security).

## 0) Prereqs

- Node `>=22`
- `pnpm` (recommended) or `bun` (optional)
- Git

macOS: if you plan to build the apps, install Xcode / CLT. For the CLI + gateway only, Node is enough.
Windows: use **WSL2** (Ubuntu recommended). WSL2 is strongly recommended; native Windows is untested and more problematic. Install WSL2 first, then run the Linux steps inside WSL. See [Windows (WSL2)](/platforms/windows).

## 1) Check out from source

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
```

Note: Bun is optional if you prefer running TypeScript directly:

```bash
bun install
```

## 2) Control UI (auto + fallback)

The Gateway serves the browser dashboard (Control UI) when assets exist.
The wizard tries to build these for you. If it fails, run:

```bash
pnpm ui:install
pnpm ui:build
```

If you skip UI build, the gateway still works — you just won’t get the dashboard.

## 3) Run the onboarding wizard

```bash
pnpm clawdbot onboard
```

What you’ll choose:
- **Local vs Remote** gateway
- **Auth**: Anthropic OAuth or OpenAI OAuth (recommended), API key (optional), or skip for now
- **Providers**: WhatsApp QR login, Telegram/Discord bot tokens, etc.
- **Daemon**: optional background install (launchd/systemd; WSL2 uses systemd)
  - **Runtime**: Node (recommended; required for WhatsApp) or Bun (faster, but incompatible with WhatsApp)

Wizard doc: [Wizard](/start/wizard)

### Auth: where it lives (important)

- OAuth credentials (legacy import): `~/.clawdbot/credentials/oauth.json`
- Auth profiles (OAuth + API keys): `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`

Headless/server tip: do OAuth on a normal machine first, then copy `oauth.json` to the gateway host.

## 4) Start the Gateway

If the wizard didn’t start it for you:

```bash
# If you installed the CLI (npm/pnpm link --global):
clawdbot gateway --port 18789 --verbose
# From this repo:
node dist/entry.js gateway --port 18789 --verbose
```

Dashboard (local loopback): `http://127.0.0.1:18789/`

⚠️ **WhatsApp + Bun warning:** Baileys (WhatsApp Web library) uses a WebSocket
path that is currently incompatible with Bun and can cause memory corruption on
reconnect. If you use WhatsApp, run the Gateway with **Node** until this is
resolved. Baileys: https://github.com/WhiskeySockets/Baileys · Bun issue:
https://github.com/oven-sh/bun/issues/5951
## 5) Pair + connect your first chat surface

### WhatsApp (QR login)

```bash
pnpm clawdbot login
```

Scan via WhatsApp → Settings → Linked Devices.

WhatsApp doc: [WhatsApp](/providers/whatsapp)

### Telegram / Discord / others

The wizard can write tokens/config for you. If you prefer manual config, start with:
- Telegram: [Telegram](/providers/telegram)
- Discord: [Discord](/providers/discord)

**Telegram DM tip:** your first DM returns a pairing code. Approve it (see next step) or the bot won’t respond.

## 6) DM safety (pairing approvals)

Default posture: unknown DMs get a short code and messages are not processed until approved.
If your first DM gets no reply, approve the pairing:

Approve:

```bash
pnpm clawdbot pairing list --provider telegram
pnpm clawdbot pairing approve --provider telegram <CODE>
```

Pairing doc: [Pairing](/start/pairing)

## 7) Verify end-to-end

In a new terminal:

```bash
pnpm clawdbot health
pnpm clawdbot send --to +15555550123 --message "Hello from Clawdbot"
```

If `health` shows “no auth configured”, go back to the wizard and set OAuth/key auth — the agent won’t be able to respond without it.

Local probe tip: `pnpm clawdbot status --deep` runs provider checks without needing a gateway connection.
Gateway snapshot: `pnpm clawdbot providers status` shows what the gateway reports (use `status --deep` for local-only probes).

## Next steps (optional, but great)

- macOS menu bar app + voice wake: [macOS app](/platforms/macos)
- iOS/Android nodes (Canvas/camera/voice): [Nodes](/nodes)
- Remote access (SSH tunnel / Tailscale Serve): [Remote access](/gateway/remote) and [Tailscale](/gateway/tailscale)
