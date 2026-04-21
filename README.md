# 🦞 OpenClaw — Personal AI Assistant

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
    <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw logo" width="480">
  </picture>
</p>

<p align="center">
   <strong>EXFOLIATE! EXFOLIATE!</strong>
  <strong>Your personal AI assistant — runs on your own devices, answers on the channels you already use.</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main">
    <img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status">
  </a>
  <a href="https://github.com/openclaw/openclaw/releases">
    <img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="Latest release">
  </a>
  <a href="https://discord.gg/clawd">
    <img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License">
  </a>
</p>

<p align="center">
  <a href="https://docs.openclaw.ai/start/getting-started"><strong>Get Started</strong></a> ·
  <a href="https://docs.openclaw.ai">Docs</a> ·
  <a href="https://docs.openclaw.ai/start/showcase">Showcase</a> ·
  <a href="https://docs.openclaw.ai/help/faq">FAQ</a> ·
  <a href="https://discord.gg/clawd">Discord</a> ·
  <a href="VISION.md">Vision</a> ·
  <a href="https://deepwiki.com/openclaw/openclaw">DeepWiki</a>
</p>

---

## What is OpenClaw?

OpenClaw is a **self-hosted personal AI assistant** you run on your own machine. It connects to the messaging apps you already use, supports voice on mobile, renders a live interactive Canvas — all controlled through a local Gateway you own.

**No cloud lock-in. Fast. Private. Always on.**

> New here? Run `openclaw onboard` in your terminal — it walks you through everything step by step.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Features](#features)
  - [Multi-Channel Inbox](#-multi-channel-inbox)
  - [Voice — Wake Words & Talk Mode](#-voice--wake-words--talk-mode)
  - [Live Canvas](#-live-canvas)
  - [Skills & Automation](#-skills--automation)
- [Companion Apps](#companion-apps)
  - [macOS](#macos--openclawapp)
  - [iOS](#ios-node)
  - [Android](#android-node)
  - [Windows](#windows--system-tray-app)
- [Security](#security)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Building from Source](#building-from-source)
- [Sponsors](#sponsors)
- [Contributors](#contributors)

---

## Install

**Requires Node 24 (recommended) or Node 22.16+**

```bash
# One-liner (recommended — installs Node if needed)
curl -fsSL https://openclaw.ai/install.sh | bash

# Or via npm
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

<p align="center">
  <img src="https://mintcdn.com/clawdhub/U8jr7qEbUc9OU9YR/assets/install-script.svg?fit=max&auto=format&n=U8jr7qEbUc9OU9YR&q=85&s=50706f81e3210a610262f14facb11f65" alt="Install script process" width="600">
</p>

Works on **macOS, Linux, and Windows (via WSL2)**. Compatible with npm, pnpm, or bun.

> Upgrading? Run `openclaw update` then `openclaw doctor`. → [Updating guide](https://docs.openclaw.ai/install/updating)

---

## Quick Start

```bash
# 1. Start the gateway
openclaw gateway --port 18789 --verbose

# 2. Open the browser dashboard
openclaw dashboard

# 3. Or send a message directly
openclaw agent --message "What's on my plate today?" --thinking high
```

Want to chat from your phone? [Telegram](https://docs.openclaw.ai/channels/telegram) is the fastest channel to set up — just a bot token and you're live.

---

## Features

### 🌐 Multi-Channel Inbox

One assistant across **20+ platforms**. Wherever you already chat, OpenClaw is there.

| | | | |
|---|---|---|---|
| WhatsApp | Telegram | Slack | Discord |
| Signal | iMessage | Google Chat | Microsoft Teams |
| Matrix | IRC | LINE | Mattermost |
| Feishu | Nextcloud Talk | Nostr | Synology Chat |
| Tlon | Twitch | Zalo | WeChat / QQ |

---

### 🎙️ Voice — Wake Words & Talk Mode

- **macOS / iOS:** Voice Wake with configurable wake words + push-to-talk overlay
- **Android:** Continuous Talk Mode with ElevenLabs TTS (system TTS fallback)

→ [Voice Wake docs](https://docs.openclaw.ai/nodes/voicewake) · [Talk Mode docs](https://docs.openclaw.ai/nodes/talk)

---

### 🖼️ Live Canvas

An agent-driven visual workspace with [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) — your assistant can draw, annotate, and update a live surface in real time.

→ [Canvas docs](https://docs.openclaw.ai/platforms/mac/canvas)

---

### 🔧 Skills & Automation

Extend your assistant with community-built or custom skills from [ClawHub](https://clawhub.com).

| Path | Description |
|---|---|
| `~/.openclaw/workspace` | Your personal workspace root |
| `~/.openclaw/workspace/skills/<skill>/SKILL.md` | Individual skill definitions |

**Automation options:** Cron jobs · Webhooks · Gmail Pub/Sub

→ [Skills docs](https://docs.openclaw.ai/tools/skills) · [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs)

---

## Companion Apps

> The Gateway alone delivers a complete experience. Companion apps add extra platform-native capabilities.

### macOS — OpenClaw.app

<p align="center">
  <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/assets/dmg-background.png" alt="OpenClaw macOS DMG background" width="600">
</p>

- Menu bar control for Gateway health monitoring
- Voice Wake + push-to-talk overlay
- WebChat + debug tools
- Remote gateway control over SSH

**Download:** [Latest release](https://github.com/openclaw/openclaw/releases/latest) · Requires macOS 15+ · Universal Binary

> Signed builds are required for macOS permissions to persist across rebuilds. → [macOS Permissions](https://docs.openclaw.ai/platforms/mac/permissions)

---

### iOS Node

Pairs over the Gateway WebSocket. Supports voice trigger forwarding and the Canvas surface.

→ [iOS setup guide](https://docs.openclaw.ai/platforms/ios)

---

### Android Node

> The Android app source is available under `apps/android` — build it yourself with Java 17 + Android SDK.

Connect, Chat, and Voice tabs with Canvas, Camera, Screen Capture, and full Android device command support.

→ [Android setup guide](https://docs.openclaw.ai/platforms/android) · [Build instructions](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md)

---

### Windows — System Tray App

Windows companion suite including System Tray app, Shared library, Node, and PowerToys Command Palette extension.

→ [openclaw-windows-node](https://github.com/openclaw/openclaw-windows-node)

---

## Security

> OpenClaw connects to real messaging surfaces. **Treat inbound DMs as untrusted input.**

### Default DM Pairing Flow

Applies to: Telegram, WhatsApp, Signal, iMessage, Discord, Slack, Google Chat

1. An unknown sender receives a short pairing code — their message is **not** processed.
2. Approve the pairing with: `openclaw pairing approve <channel> <code>`
3. The sender is added to your local allowlist.

To allow public inbound DMs, set `dmPolicy="open"` and add `"*"` to the channel's `allowFrom`.  
Run `openclaw doctor` to surface risky or misconfigured DM policies.

### Sandbox Model

| Session | Behavior |
|---|---|
| `main` | Full host access (it's just you) |
| non-`main` | Sandboxed via Docker (SSH / OpenShell also available) |
| **Allowed** in sandbox | `bash`, `process`, `read`, `write`, `edit`, `sessions_*` |
| **Denied** in sandbox | `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway` |

→ [Security guide](https://docs.openclaw.ai/gateway/security) · [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)

---

## Configuration

Minimal `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    model: "<provider>/<model-id>",
  },
}
```

→ [Full configuration reference](https://docs.openclaw.ai/gateway/configuration)

> **Model note:** Use a current flagship model from the provider you already trust. → [Onboarding guide](https://docs.openclaw.ai/start/onboarding)

---

## CLI Reference

### In-Chat Commands

These slash commands work in any connected channel:

```
/status       /new          /reset        /compact
/think high   /verbose on   /usage full   /restart
```

### Session Tools

```
sessions_list   sessions_history   sessions_send   sessions_spawn
```

---

## Building from Source

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm openclaw setup     # First run only
pnpm ui:build           # Optional: prebuild Control UI
pnpm gateway:watch      # Dev loop with auto-reload
```

To produce a distributable build:

```bash
pnpm build && pnpm ui:build
```

### Release Channels

| Channel | Tag format | npm dist-tag |
|---|---|---|
| stable | `vYYYY.M.D` | `latest` |
| beta | `vYYYY.M.D-beta.N` | `beta` |
| dev | moving `main` head | `dev` |

```bash
openclaw update --channel stable|beta|dev
```

→ [Development channels docs](https://docs.openclaw.ai/install/development-channels)

---

## Docs by Goal

| Goal | Links |
|---|---|
| New here | [Getting started](https://docs.openclaw.ai/start/getting-started) · [Onboarding wizard](https://docs.openclaw.ai/start/wizard) · [Updating](https://docs.openclaw.ai/install/updating) |
| Channel setup | [All channels](https://docs.openclaw.ai/channels) · [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) · [Telegram](https://docs.openclaw.ai/channels/telegram) · [Discord](https://docs.openclaw.ai/channels/discord) · [Slack](https://docs.openclaw.ai/channels/slack) |
| Apps & nodes | [macOS](https://docs.openclaw.ai/platforms/macos) · [iOS](https://docs.openclaw.ai/platforms/ios) · [Android](https://docs.openclaw.ai/platforms/android) · [Nodes](https://docs.openclaw.ai/nodes) |
| Config & security | [Configuration](https://docs.openclaw.ai/gateway/configuration) · [Security](https://docs.openclaw.ai/gateway/security) · [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing) |
| Remote access | [Gateway](https://docs.openclaw.ai/gateway) · [Remote](https://docs.openclaw.ai/gateway/remote) · [Tailscale](https://docs.openclaw.ai/gateway/tailscale) · [Web surfaces](https://docs.openclaw.ai/web) |
| Automation | [Tools](https://docs.openclaw.ai/tools) · [Skills](https://docs.openclaw.ai/tools/skills) · [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs) · [Webhooks](https://docs.openclaw.ai/automation/webhook) · [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub) |
| Internals | [Architecture](https://docs.openclaw.ai/concepts/architecture) · [Agent](https://docs.openclaw.ai/concepts/agent) · [Session model](https://docs.openclaw.ai/concepts/session) · [Gateway protocol](https://docs.openclaw.ai/reference/rpc) |
| Troubleshooting | [Channel troubleshooting](https://docs.openclaw.ai/channels/troubleshooting) · [Logging](https://docs.openclaw.ai/logging) |

---

## Sponsors

<table>
  <tr>
    <td align="center" width="16.66%">
      <a href="https://openai.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://openclaw.ai/sponsors/openai.svg">
          <img src="https://openclaw.ai/sponsors/openai.svg" alt="OpenAI" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://github.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://openclaw.ai/sponsors/github-light.svg">
          <img src="https://openclaw.ai/sponsors/github.svg" alt="GitHub" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://www.nvidia.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://openclaw.ai/sponsors/nvidia-light.svg">
          <img src="https://openclaw.ai/sponsors/nvidia-dark.svg" alt="NVIDIA" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://vercel.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://openclaw.ai/sponsors/vercel-light.svg">
          <img src="https://openclaw.ai/sponsors/vercel-dark.svg" alt="Vercel" height="24">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://blacksmith.sh/">
        <img src="https://openclaw.ai/sponsors/blacksmith.svg" alt="Blacksmith" height="28">
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://www.convex.dev/">
        <img src="https://openclaw.ai/sponsors/convex.svg" alt="Convex" height="24">
      </a>
    </td>
  </tr>
</table>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

---

## About & Community

OpenClaw was built for **Molty**, a space lobster AI assistant. 🦞  
Created by [Peter Steinberger](https://steipete.me) and the community.

[openclaw.ai](https://openclaw.ai) · [soul.md](https://soul.md) · [@openclaw on X](https://x.com/openclaw)

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and how to submit PRs. AI/vibe-coded PRs are welcome! 🤖

Special thanks to [Mario Zechner](https://mariozachner.at/) for his support and for [pi-mono](https://github.com/badlogic/pi-mono), and to Adam Doppelt for the lobster.bot domain.

---

## Contributors

Thanks to all clawtributors! 🦞

<!-- clawtributors:start -->
[![steipete](https://avatars.githubusercontent.com/u/58493?v=4&s=48)](https://github.com/steipete) [![vincentkoc](https://avatars.githubusercontent.com/u/25068?v=4&s=48)](https://github.com/vincentkoc) [![Takhoffman](https://avatars.githubusercontent.com/u/781889?v=4&s=48)](https://github.com/Takhoffman) [![obviyus](https://avatars.githubusercontent.com/u/22031114?v=4&s=48)](https://github.com/obviyus) [![gumadeiras](https://avatars.githubusercontent.com/u/5599352?v=4&s=48)](https://github.com/gumadeiras) [![Mariano Belinky](https://avatars.githubusercontent.com/u/132747814?v=4&s=48)](https://github.com/mbelinky) [![vignesh07](https://avatars.githubusercontent.com/u/1436853?v=4&s=48)](https://github.com/vignesh07) [![joshavant](https://avatars.githubusercontent.com/u/830519?v=4&s=48)](https://github.com/joshavant) [![scoootscooob](https://avatars.githubusercontent.com/u/167050519?v=4&s=48)](https://github.com/scoootscooob) [![jacobtomlinson](https://avatars.githubusercontent.com/u/1610850?v=4&s=48)](https://github.com/jacobtomlinson)
[![shakkernerd](https://avatars.githubusercontent.com/u/165377636?v=4&s=48)](https://github.com/shakkernerd) [![sebslight](https://avatars.githubusercontent.com/u/19554889?v=4&s=48)](https://github.com/sebslight) [![tyler6204](https://avatars.githubusercontent.com/u/64381258?v=4&s=48)](https://github.com/tyler6204) [![ngutman](https://avatars.githubusercontent.com/u/1540134?v=4&s=48)](https://github.com/ngutman) [![thewilloftheshadow](https://avatars.githubusercontent.com/u/35580099?v=4&s=48)](https://github.com/thewilloftheshadow) [![Sid-Qin](https://avatars.githubusercontent.com/u/201593046?v=4&s=48)](https://github.com/Sid-Qin) [![mcaxtr](https://avatars.githubusercontent.com/u/7562095?v=4&s=48)](https://github.com/mcaxtr) [![eleqtrizit](https://avatars.githubusercontent.com/u/31522568?v=4&s=48)](https://github.com/eleqtrizit) [![BunsDev](https://avatars.githubusercontent.com/u/68980965?v=4&s=48)](https://github.com/BunsDev) [![cpojer](https://avatars.githubusercontent.com/u/13352?v=4&s=48)](https://github.com/cpojer)
<!-- clawtributors:end -->

> The full contributor wall is maintained automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) to join.
