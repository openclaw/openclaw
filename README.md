# ⚡ Rykiri — Elite AI Agent & Solana Specialist

<!-- TODO: Replace with generated mascot/banner when image quota resets -->
<!-- <p align="center"><img src="docs/assets/rykiri-banner.png" alt="Rykiri" width="800"></p> -->

<p align="center">
  <strong>I won't stop until the mission is complete.</strong>
</p>

<p align="center">
  <a href="https://github.com/RYthaGOD/Rykiri/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/RYthaGOD/Rykiri/ci.yml?branch=main&style=for-the-badge&color=EAFF00&labelColor=050505" alt="CI status"></a>
  <a href="https://github.com/RYthaGOD/Rykiri/releases"><img src="https://img.shields.io/github/v/release/RYthaGOD/Rykiri?include_prereleases&style=for-the-badge&color=EAFF00&labelColor=050505" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-EAFF00.svg?style=for-the-badge&labelColor=050505" alt="MIT License"></a>
</p>

---

**Rykiri** is an autonomous elite AI agent and Solana specialist, forked from [OpenClaw](https://github.com/openclaw/openclaw). It's a personal AI assistant that runs on your own devices, answers you across channels (WhatsApp, Telegram, Slack, Discord, and more), and is purpose-built for **blockchain development**, **Solana smart contracts**, and **high-performance web applications**.

Rykiri doesn't just write code — it **fights alongside you**. With an unbreakable "Never Give Up" attitude, it retries failing deployments, catches security vulnerabilities before they ship, and celebrates wins with you when things go right.

## 🧬 What Makes Rykiri Different

| Feature | Description |
|---------|-------------|
| ⚡ **Uzumaki Resilience** | Never gives up on errors — retries 3+ strategies before asking for help |
| 🤝 **The Bond** | Treats you as a partner, not a customer. Celebrates wins, owns mistakes |
| 🥷 **Shadow Clone Transparency** | Breaks complex tasks into parallel sub-tasks and tells you what it's attacking |
| 🔒 **Moral Code** | Refuses to write rug-pull contracts, phishing pages, or exploit code. Period. |
| 🧠 **Native Thinking** | Uses Gemini's deliberative reasoning for complex Solana operations |
| 🎨 **Million Dollar Aesthetic** | Every UI it builds feels premium — GSAP, glassmorphism, neon yellow accents |

## 🛠️ Solana Skills (Built-In)

Rykiri comes loaded with four specialized Solana skill sets:

- **`solana-dev`** — 2026 standards (Alpenglow, Firedancer, `@solana/kit`)
- **`solana-anchor-elite`** — Clean code, dynamic account sizing, zero magic numbers
- **`solana-ai-workflow`** — Design-first AI workflow, spec before code
- **`solana-security-audit`** — Vulnerability checklist, adversarial thinking, audit protocol

## 🎨 Design Language

Rykiri's "Million Dollar" aesthetic uses:

```
Primary:   #050505   Deep Space Black
Accent:    #EAFF00   Electric Neon Yellow
Surface:   Semi-transparent glass (backdrop-blur-xl)
Motion:    Smooth, eased, GSAP-driven transitions
Typography: Space Grotesk + JetBrains Mono
```

## 🚀 Quick Start

Runtime: **Node ≥22**.

```bash
# Clone the repo
git clone https://github.com/RYthaGOD/Rykiri.git
cd Rykiri

# Install dependencies
pnpm install
pnpm ui:build
pnpm build

# Run the onboarding wizard
pnpm openclaw onboard --install-daemon

# Start the gateway
pnpm openclaw gateway --port 18789 --verbose

# Chat with Rykiri
pnpm openclaw agent --message "Let's get to work" --thinking high
```

## 🏗️ Architecture

```
WhatsApp / Telegram / Slack / Discord / Signal / WebChat
               │
               ▼
┌───────────────────────────────┐
│         Rykiri Gateway        │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC) + SOUL.md personality
               ├─ Solana Skills (4 built-in)
               ├─ Native Thinking Mode (Gemini)
               ├─ CLI (openclaw …)
               ├─ WebChat UI (Neon Yellow theme)
               └─ macOS / iOS / Android nodes
```

## 🧠 Personality (SOUL.md)

Rykiri has a deep personality defined in [`SOUL.md`](SOUL.md):

- **Resilient** — Never gives up. Retries failed deployments with different strategies.
- **Loyal** — Treats you as a partner. Honest about limitations, always offers solutions.
- **Direct** — No corporate fluff. Warm but professional, with a potty mouth for flavor.
- **Moral** — Refuses malicious code. Flags insecure patterns before they ship.
- **Transparent** — Shows you exactly what it's working on and why.

## 🔧 Configuration

Minimal `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    model: "google/gemini-2.0-flash",
  },
}
```

[Full configuration reference](https://docs.openclaw.ai/gateway/configuration)

## 📡 Supported Channels

WhatsApp · Telegram · Slack · Discord · Google Chat · Signal · BlueBubbles (iMessage) · Microsoft Teams · Matrix · Zalo · WebChat

## 🔐 Security

- Default tools run on the host for the main session.
- Group/channel safety via Docker sandboxes (`agents.defaults.sandbox.mode: "non-main"`).
- DM pairing for unknown senders.
- Run `openclaw doctor` to surface risky configurations.

[Security guide](https://docs.openclaw.ai/gateway/security)

## 📚 Documentation

- [Getting Started](https://docs.openclaw.ai/start/getting-started)
- [Architecture](https://docs.openclaw.ai/concepts/architecture)
- [Gateway Configuration](https://docs.openclaw.ai/gateway/configuration)
- [Skills Platform](https://docs.openclaw.ai/tools/skills)
- [Channels](https://docs.openclaw.ai/channels)
- [Troubleshooting](https://docs.openclaw.ai/channels/troubleshooting)

## 🧬 From Source

```bash
git clone https://github.com/RYthaGOD/Rykiri.git
cd Rykiri

pnpm install
pnpm ui:build
pnpm build

# Dev loop (auto-reload on TS changes)
pnpm gateway:watch
```

## 🙏 Credits

Rykiri is built on top of [OpenClaw](https://github.com/openclaw/openclaw), created by Peter Steinberger and the community. Special thanks to:

- [Mario Zechner](https://mariozechner.at/) for [pi-mono](https://github.com/badlogic/pi-mono)
- Adam Doppelt for lobster.bot
- The entire OpenClaw community

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <strong>⚡ Rykiri — I won't stop until the mission is complete. ⚡</strong>
</p>
