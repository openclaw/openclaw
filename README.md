# 🦞 OpenJarvis Gateway — Personal AI Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/open-jarvis/OpenJarvis/main/assets/OpenJarvis_Horizontal_Logo.png" alt="OpenJarvis" width="400">
</p>

<p align="center">
  <strong>Personal AI, On Personal Devices.</strong>
</p>

<p align="center">
  <a href="https://github.com/open-jarvis/OpenJarvis/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/open-jarvis/OpenJarvis/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/open-jarvis/OpenJarvis/releases"><img src="https://img.shields.io/github/v/release/open-jarvis/OpenJarvis?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/YZZRxCAhmm"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache 2.0 License"></a>
</p>

**OpenJarvis Gateway** (formerly Moltbot) is a *personal AI assistant* that runs on your own devices.
It integrates with the [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) ecosystem to provide a unified control plane for on-device AI. It answers you on the channels you already use (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat) and provides native nodes for macOS, iOS, and Android.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is the Gateway for you.

---

## 🚀 About This Fork

This repository is a pivot of the **Moltbot** project, now rebranded and integrated as the **OpenJarvis Gateway**. While the core [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) project focuses on intelligence primitives and a modular framework, the **Gateway** provides the multi-channel messaging bridge, companion device nodes (Android/iOS/Mac), and the RPC orchestration layer.

---

[Website](https://scalingintelligence.stanford.edu/blogs/openjarvis/) · [Docs](https://open-jarvis.github.io/OpenJarvis/) · [Leaderboard](https://open-jarvis.github.io/OpenJarvis/leaderboard/) · [Roadmap](https://open-jarvis.github.io/OpenJarvis/development/roadmap/) · [Discord](https://discord.gg/YZZRxCAhmm)

Preferred setup: run the onboarding wizard (`jarvis onboard`). It walks through gateway, workspace, channels, and skills. The CLI wizard is the recommended path and works on **macOS, Linux, and Windows (via WSL2; strongly recommended)**.
Works with npm, pnpm, or bun.

## Install (recommended)

Runtime: **Node ≥22**.

```bash
npm install -g openjarvis@latest
# or: pnpm add -g openjarvis@latest

jarvis onboard --install-daemon
```

The wizard installs the Gateway daemon (launchd/systemd user service) so it stays running.
Legacy note: `moltbot` and `clawdbot` remains available as a compatibility shim.

## Quick start (TL;DR)

Runtime: **Node ≥22**.

Full beginner guide (auth, pairing, channels): [Getting started](https://open-jarvis.github.io/OpenJarvis/getting-started/)

```bash
jarvis onboard --install-daemon

jarvis gateway --port 18789 --verbose

# Send a message
jarvis message send --to +1234567890 --message "Hello from OpenJarvis"

# Talk to the assistant
jarvis agent --message "Ship checklist" --thinking high
```

## Features & Subsystems

### Core platform
- **Gateway WS control plane** — single control plane for sessions, channels, tools, and events.
- **CLI surface** — gateway, agent, send, wizard, and doctor.
- **Agent runtime** — RPC mode with tool streaming and block streaming.
- **Session model** — main for direct chats, group isolation, activation modes, queue modes, reply-back.
- **Media pipeline** — images/audio/video, transcription hooks, size caps, temp file lifecycle.

### Channels
- **Messaging** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, BlueBubbles, Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat.
- **Group routing** — mention gating, reply tags, per-channel chunking and routing.

### Apps + nodes
- **macOS app** — menu bar control plane, Voice Wake/PTT, Talk Mode overlay, WebChat, debug tools.
- **iOS node** — Canvas, Voice Wake, Talk Mode, camera, screen recording, Bonjour pairing.
- **Android node** — Canvas, Talk Mode, camera, screen recording, optional SMS.

### Tools + automation
- **Browser control** — dedicated Chrome/Chromium control, snapshots, actions, uploads, profiles.
- **Canvas** — agent-driven visual workspace with push/reset, eval, snapshot.
- **Nodes** — camera snap/clip, screen record, location.get, notifications.
- **Automation** — Cron + wakeups; webhooks; Gmail Pub/Sub.

## How it works (short)

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / Microsoft Teams / Matrix / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Agent runtime (RPC)
               ├─ CLI (jarvis …)
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS / Android nodes
```

## License

[Apache 2.0](LICENSE)
