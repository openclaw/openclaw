<div align="center">

# 🐾 OpenClaw — Enhanced Fork

**A superset of [OpenClaw](https://github.com/openclaw/openclaw) with cognitive memory, 8 published skills, and an operating doctrine for compound AI systems.**

[![Upstream](https://img.shields.io/badge/upstream-OpenClaw%20190K⭐-blue?logo=github)](https://github.com/openclaw/openclaw)
[![Merge Cadence](https://img.shields.io/badge/upstream%20sync-several%20times%2Fweek-green)](https://github.com/openclaw/openclaw)
[![Ahead](https://img.shields.io/badge/commits%20ahead-21%2B-orange)](#whats-different)
[![ClawHub Downloads](https://img.shields.io/badge/ClawHub%20downloads-4%2C700%2B-purple)](https://clawhub.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Upstream Docs](https://docs.openclaw.ai) · [ClawHub Skills](https://clawhub.com) · [Discord](https://discord.gg/clawd) · [Memory Architecture Proposal](https://github.com/openclaw/openclaw/issues/13991)

</div>

---

## What Is This?

This fork stays **days behind upstream** (merging several times a week) while being **21+ commits ahead** with exclusive features. Everything upstream has, plus more.

Not a competitor — a **superset** for power users who want more from their agent.

---

## Why This Fork?

### 🧠 Cognitive Memory System (7 Phases)

Not flat files. A full cognitive architecture built on **SQLite + sqlite-vec + FTS5**:

| Feature                           | Description                               |
| --------------------------------- | ----------------------------------------- |
| **4 Memory Types**                | Episodic, semantic, procedural, strategic |
| **Spreading Activation**          | +23% on multi-hop benchmarks              |
| **RAPTOR Hierarchical Summaries** | Zoom in and out across abstraction levels |
| **Nightly Consolidation**         | Clustering, decay, and memory maintenance |
| **Cross-Agent Sharing**           | Memory sharing with sensitivity gates     |
| **Local ONNX Embeddings**         | ~30ms per embedding, zero API calls       |

📄 [Read the full architecture proposal →](https://github.com/openclaw/openclaw/issues/13991)

### 📦 8 Published Skills (4,700+ Downloads)

| Skill                            | Description                                                  | Link                                                                |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 🧠 **agent-memory-ultimate**     | Persistent memory with spreading activation                  | [ClawHub](https://clawhub.com/globalcaos/agent-memory-ultimate)     |
| 💬 **whatsapp-ultimate**         | Full WhatsApp: messages, media, polls, voice, history search | [ClawHub](https://clawhub.com/globalcaos/whatsapp-ultimate)         |
| 🎬 **youtube-ultimate**          | FREE transcripts (zero API quota), 4K download, comments     | [ClawHub](https://clawhub.com/globalcaos/youtube-ultimate)          |
| 🎙️ **jarvis-voice**              | JARVIS-style TTS, fully offline via sherpa-onnx              | [ClawHub](https://clawhub.com/globalcaos/jarvis-voice)              |
| 📤 **chatgpt-exporter-ultimate** | Export ALL ChatGPT conversations instantly                   | [ClawHub](https://clawhub.com/globalcaos/chatgpt-exporter-ultimate) |
| 🛡️ **agent-boundaries-ultimate** | AI safety, privacy, ethics, OPSEC                            | [ClawHub](https://clawhub.com/globalcaos/agent-boundaries-ultimate) |
| 🔒 **shell-security-ultimate**   | Command risk classification (SAFE → CRITICAL)                | [ClawHub](https://clawhub.com/globalcaos/shell-security-ultimate)   |
| 📊 **token-panel-ultimate**      | Track usage across Claude, ChatGPT, Gemini                   | [ClawHub](https://clawhub.com/globalcaos/token-panel-ultimate)      |

### 📋 Operating Doctrine

12 intelligence strategies for compound AI systems — how to structure agent reasoning, tool use, and multi-agent coordination effectively.

### ⚡ Active Development

Upstream merges happen **several times per week**, always within days of the latest release. You get upstream stability plus enhanced features.

---

## Getting Started

Installation is the same as upstream:

```bash
npm install -g openclaw@latest
```

Then clone this fork to get the enhanced features:

```bash
git clone https://github.com/globalcaos/clawdbot-moltbot-openclaw.git
cd clawdbot-moltbot-openclaw
npm install
```

For full setup instructions, see the [upstream documentation](https://docs.openclaw.ai).

---

## Staying Current

This fork maintains a **tight merge cadence** with upstream:

- 🔄 Merges from upstream **several times per week**
- 📅 Always within **days** of the latest upstream release
- ✅ All upstream features and fixes included
- ➕ Enhanced features layered on top without conflict

---

## Links

|                 |                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| 🌐 **Website**  | [thetinkerzone.com](https://thetinkerzone.com) _(under development)_                             |
| 📺 **YouTube**  | [@TheTinkerZone](https://www.youtube.com/@TheTinkerZone-o7t) _(coming soon — tutorials & demos)_ |
| 📦 **ClawHub**  | [clawhub.com](https://clawhub.com) _(search globalcaos)_                                         |
| 💬 **Discord**  | [discord.gg/clawd](https://discord.gg/clawd)                                                     |
| 📄 **Upstream** | [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)                             |
| 📚 **Docs**     | [docs.openclaw.ai](https://docs.openclaw.ai)                                                     |

---

## License

MIT — same as upstream. See [LICENSE](LICENSE).

Built on top of [OpenClaw](https://github.com/openclaw/openclaw) (190K+ ⭐). All credit to the upstream team and contributors for the incredible foundation.
