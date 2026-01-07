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

If you want the deeper reference pages, jump to: [Wizard](/wizard), [Setup](/setup), [Pairing](/pairing), [Security](/security).

## 0) Prereqs

- Node `>=22`
- `pnpm` (recommended) or `bun` (optional)
- Git

macOS: if you plan to build the apps, install Xcode / CLT. For the CLI + gateway only, Node is enough.
Windows: use **WSL2** (Ubuntu recommended). WSL2 is strongly recommended; native Windows is untested and more problematic. Install WSL2 first, then run the Linux steps inside WSL. See [Windows (WSL2)](/windows).

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

## 2) Build the Control UI (recommended)

The Gateway serves the browser dashboard (Control UI) when assets exist.

```bash
pnpm ui:install
pnpm ui:build
pnpm build
```

If you skip UI build, the gateway still works — you just won’t get the dashboard.

## 3) Run the onboarding wizard

```bash
pnpm clawdbot onboard
```

What you’ll choose:
- **Local vs Remote** gateway
- **Auth**: Anthropic OAuth or OpenAI OAuth (recommended), API key (optional), or skip for now
- **Providers**: WhatsApp QR login, bot tokens, etc.
- **Daemon**: optional background install (launchd/systemd; WSL2 uses systemd)
  - **Runtime**: Node (recommended; required for WhatsApp) or Bun (faster, but incompatible with WhatsApp)

Wizard doc: [Wizard](/wizard)

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

WhatsApp doc: [WhatsApp](/whatsapp)

### Telegram / Discord / others

The wizard can write tokens/config for you. If you prefer manual config, start with:
- Telegram: [Telegram](/telegram)
- Discord: [Discord](/discord)

## 6) DM safety (pairing approvals)

Default posture: unknown DMs get a short code and messages are not processed until approved.

Approve:

```bash
pnpm clawdbot pairing list --provider telegram
pnpm clawdbot pairing approve --provider telegram <CODE>
```

Pairing doc: [Pairing](/pairing)

## 7) Verify end-to-end

In a new terminal:

```bash
pnpm clawdbot health
pnpm clawdbot send --to +15555550123 --message "Hello from Clawdbot"
```

If `health` shows “no auth configured”, go back to the wizard and set OAuth/key auth — the agent won’t be able to respond without it.

## Next steps (optional, but great)

- macOS menu bar app + voice wake: [macOS app](/macos)
- iOS/Android nodes (Canvas/camera/voice): [Nodes](/nodes)
- Remote access (SSH tunnel / Tailscale Serve): [Remote access](/remote) and [Tailscale](/tailscale)
