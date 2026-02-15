# 🦎 GlobalCaos OpenClaw Fork

**A trust-first, Ubuntu-optimized fork of OpenClaw with enhanced AI capabilities.**

[![Based on OpenClaw](https://img.shields.io/badge/based%20on-OpenClaw-blue)](https://github.com/openclaw/openclaw)
[![Platform](https://img.shields.io/badge/platform-Ubuntu%2FLinux-orange)](https://ubuntu.com)
[![AI Models](https://img.shields.io/badge/AI-Claude%20%7C%20Gemini%20%7C%20Manus-green)](#multi-model-support)

---

## 🎯 Why This Fork?

This fork is built by **Oscar Serra**, an inventor and AI enthusiast who believes in giving AI assistants **full access** to be truly helpful. We take a **trust-first approach** — no sandboxing, no artificial restrictions, just a capable AI partner.

### Philosophy

> "An AI assistant with no access is just a search engine with extra steps."

We believe:
- **Trust first, restrict later** (if ever needed)
- **Multi-model resilience** — never be stuck when one provider rate-limits you
- **Linux-native** — optimized for Ubuntu, not an afterthought
- **Community-driven** — we document everything for newcomers

---

## ✨ What's Different Here?

### 🔐 Security Patches Applied
All critical upstream security PRs cherry-picked:
- **#7769** — DNS Rebinding Protection
- **#7616** — Zip Path Traversal Fix
- **#7704** — WebSocket Auth Enforcement

### 🧠 Smart Model Management
- **Smart Router V2** (#7770) — Auto-selects the best model for each task
- **Rate Limiting** (#7644) — Prevents runaway API costs
- **Anthropic Failover** — Auto-switches to Gemini when Claude hits quota (tested & verified!)

### 📦 Enhanced Skills
| Skill | Description | Status |
|-------|-------------|--------|
| `youtube-ultimate` | FREE transcripts (no API cost!) + video downloads | ✅ v2.0 |
| `google-sheets` | Content calendars, spreadsheet automation | ✅ Installed |
| `healthcheck` | System security auditing | ✅ Installed |

### 📱 WhatsApp Full History (Coming Soon)
We're enabling Baileys' full history sync — your AI will have access to all your WhatsApp messages, not just new ones. **Opt-in via config.**

### 🐧 Ubuntu-Native
- Tested on Ubuntu 22.04/24.04
- Works with `deja-dup` for backups
- Systemd service examples included
- No macOS-only skills (we removed Bear Notes)

---

## 🚀 Quick Start (First-Time Install)

### 1. Clone This Fork
```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git openclaw
cd openclaw
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the Wizard
```bash
npx openclaw init
```

### 4. Configure Your AI Keys
Edit `~/.openclaw/openclaw.json`:
```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "google": { "apiKey": "AIza..." }
  }
}
```

### 5. Start the Gateway
```bash
npx openclaw gateway start
```

### 6. Let the AI Guide You
Once connected, ask your AI:
> "Read FORK.md and help me configure the remaining features."

The AI will walk you through enabling WhatsApp, skills, and optimizations.

---

## 🤖 Multi-Model Support

We run **multiple AI subscriptions** for resilience and capability:

| Provider | Model | Use Case |
|----------|-------|----------|
| **Anthropic** | Claude Opus 4.5 | Primary chat, coding, complex tasks |
| **Google** | Gemini 3 Pro | Failover, large context, vision |
| **Manus** | manus-1.6-adaptive | Background research, deep analysis |

### Failover Chain
```
Claude (primary) → Gemini (rate limit) → [Your Local Model]
```

When Claude hits its quota, we **automatically switch to Gemini** with zero downtime. This was tested and verified on 2026-02-03 when both providers rate-limited within minutes of each other!

---

## 📋 Configuration Highlights

### Trust-First WhatsApp Access
```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+YOUR_NUMBER"],
      "syncFullHistory": true,  // NEW: Read all messages
      "groups": { "*": { "requireMention": false } }
    }
  }
}
```

### Budget Awareness
```json
{
  "budget": {
    "monthlyLimitUsd": 200,
    "warningThresholdPercent": 70
  }
}
```

---

## 📚 Documentation

- [WhatsApp Setup](docs/channels/whatsapp.md)
- [Model Providers](docs/concepts/model-providers.md)
- [Token Usage & Costs](docs/token-use.md)
- [Skills Development](docs/skills/)

---

## 🛠️ What We're Working On

- [ ] WhatsApp full history sync (PR in progress)
- [ ] YouTube Ultimate v2.0 with yt-dlp downloads
- [ ] LanceDB hybrid memory (#7695 + #7636)
- [ ] Browser cookies action (#7635)
- [ ] "The Tinker Zone" YouTube channel tutorials

---

## 🤝 Contributing

We welcome contributions! This fork is about:
1. **Documenting everything** — Help newcomers get started
2. **Testing on Linux** — Ubuntu is our primary platform
3. **Trust-first features** — Expanding AI capabilities, not restricting them

### Our Approach
- We **upstream security fixes** (and cherry-pick them quickly)
- We **experiment freely** with features that might be too aggressive for upstream
- We **document our journey** so others can learn

---

## 👤 About the Maintainer

**Oscar Serra** — Telecom engineer, inventor, and AI enthusiast based in Barcelona. Building "The Tinker Zone" to document the journey of creating truly helpful AI assistants.

- Philosophy: Trust first, Bashar-inspired (follow your highest excitement)
- Setup: Ubuntu on MSI Creator laptop, Claude + Gemini + Manus
- Goal: AI that knows you, helps you, and grows with you

---

## 📜 License

Same as upstream OpenClaw (Apache 2.0).

---

*Last updated: 2026-02-03*
*Fork version: Based on OpenClaw + 15 cherry-picked PRs + 3 custom skills*
