---
title: Feature Maturity
description: Classification of Clawdbot features by stability and production-readiness
---

# Feature Maturity Matrix

This document classifies Clawdbot features by their maturity level, helping you understand what to expect in terms of stability, API guarantees, and support.

## Maturity Levels

| Level | Description | API Stability | Support |
|-------|-------------|---------------|---------|
| **Core** | Battle-tested, production-ready. Breaking changes only in major versions. | Stable | Full |
| **Stable** | Feature-complete with documented API contracts. Minor refinements possible. | Stable | Full |
| **Beta** | Feature-complete but may have edge cases. API contracts may evolve. | Mostly stable | Community |
| **Experimental** | Active development. API likely to change. Use with caution. | Unstable | Limited |

---

## Messaging Channels

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| WhatsApp (Web) | Core | 2024.1 | Production-ready via whatsapp-web.js |
| Telegram | Core | 2024.1 | Full Bot API support, topics, streaming |
| Discord | Core | 2024.1 | Slash commands, threads, voice support |
| Slack | Core | 2024.1 | Socket Mode, app mentions, channels |
| Signal | Stable | 2024.3 | Requires signal-cli daemon |
| iMessage | Stable | 2024.6 | macOS only, requires Full Disk Access |
| BlueBubbles | Stable | 2024.8 | Alternative iMessage via BlueBubbles server |
| Matrix | Beta | 2025.1 | E2EE support, room federation |
| Google Chat | Beta | 2025.1 | Workspace integration, spaces |
| Mattermost | Beta | 2024.10 | Self-hosted team collaboration |
| LINE | Beta | 2026.1 | Messaging API with rich replies |
| MS Teams | Beta | 2025.1 | Bot Framework integration |
| Zalo | Experimental | 2025.6 | Official API (business accounts) |
| Zalo User | Experimental | 2025.6 | User-mode via zca-js |
| Nostr | Experimental | 2025.8 | Decentralized social protocol |
| Twitch | Experimental | 2025.10 | Chat integration |
| Tlon (Urbit) | Experimental | 2025.12 | Urbit-native messaging |
| Nextcloud Talk | Experimental | 2026.1 | Self-hosted video/chat |

---

## Model Providers

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Anthropic (Claude) | Core | 2024.1 | Primary provider, full tool support |
| OpenAI (GPT) | Core | 2024.1 | Full API support including vision |
| Amazon Bedrock | Stable | 2024.6 | Multi-model, IAM auth |
| Google Gemini | Stable | 2025.1 | Native API support |
| OpenRouter | Stable | 2024.8 | Multi-provider routing |
| Ollama | Stable | 2025.3 | Local models, auto-discovery |
| Venice | Stable | 2025.6 | Privacy-focused provider |
| Moonshot (Kimi) | Beta | 2024.10 | Chinese language optimization |
| Minimax | Beta | 2025.1 | Chinese language models |
| GLM (Zhipu) | Beta | 2025.3 | Chinese language models |
| Zai | Experimental | 2025.8 | Research models |
| OpenCode | Experimental | 2025.6 | Code-focused provider |
| Vercel AI Gateway | Experimental | 2026.1 | Edge deployment |

---

## Gateway & Infrastructure

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Gateway Server | Core | 2024.1 | Central coordination service |
| WebSocket Protocol | Core | 2024.1 | Real-time bidirectional comms |
| Token Authentication | Core | 2024.1 | Bearer token auth |
| Password Authentication | Core | 2025.1 | Human-friendly auth |
| Tailscale Integration | Stable | 2024.6 | Zero-config networking |
| Health Monitoring | Stable | 2024.3 | `/health` endpoint, doctor checks |
| Background Process | Stable | 2024.6 | Daemon mode, launchd/systemd |
| Rate Limiting | Stable | 2026.1 | Request throttling |
| Bonjour Discovery | Beta | 2025.1 | Local network auto-discovery |
| Remote Gateway | Beta | 2024.10 | Connect to remote gateways |
| Multiple Gateways | Experimental | 2025.8 | Multi-gateway coordination |

---

## Agent System

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Agent Loop | Core | 2024.1 | Tool-calling conversation loop |
| Session Management | Core | 2024.1 | Per-conversation state |
| Context Compaction | Core | 2024.3 | Automatic context summarization |
| System Prompts | Core | 2024.1 | Configurable agent personality |
| Multi-Agent | Stable | 2024.6 | Multiple concurrent agents |
| Model Failover | Stable | 2024.8 | Automatic provider switching |
| Extended Thinking | Stable | 2025.1 | Reasoning traces, Claude thinking |
| Heartbeat | Stable | 2024.6 | Periodic agent check-ins |
| Presence | Beta | 2025.1 | Node capability awareness |
| Sub-Agents | Beta | 2025.3 | Spawned child agents |

---

## Tools & Skills

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Shell Execution | Core | 2024.1 | Bash/PowerShell commands |
| Exec Approvals | Core | 2024.6 | Interactive command approval |
| Web Search | Stable | 2024.3 | Brave Search integration |
| Web Fetch | Stable | 2024.3 | URL content retrieval |
| Browser Control | Stable | 2024.6 | Playwright automation |
| Chrome Extension | Beta | 2025.1 | Browser relay for automation |
| Skills System | Stable | 2024.8 | SKILL.md-based extensibility |
| ClawdHub | Stable | 2025.1 | Skill marketplace integration |
| Slash Commands | Stable | 2024.3 | `/approve`, `/help`, etc. |
| Elevated Commands | Stable | 2024.6 | Sudo/admin execution |
| Subagent Tools | Beta | 2025.3 | Agent spawning from tools |
| Lobster | Beta | 2025.6 | Natural language CLI |
| LLM Task | Beta | 2025.8 | Delegated model tasks |

---

## Memory & Context

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Session Files | Core | 2024.1 | JSONL conversation logs |
| Agent Workspace | Core | 2024.3 | Per-agent file storage |
| OpenAI Embeddings | Stable | 2024.6 | text-embedding-3 models |
| Gemini Embeddings | Stable | 2025.1 | text-embedding-004 |
| SQLite Vector Store | Stable | 2024.8 | sqlite-vec for local search |
| Hybrid Search | Beta | 2025.3 | Combined vector + keyword |
| LanceDB Store | Experimental | 2025.8 | Alternative vector backend |
| Memory Sync | Experimental | 2025.6 | Cross-session memory sharing |

---

## Automation

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Cron Jobs | Stable | 2024.6 | Scheduled agent runs |
| Webhooks | Stable | 2024.6 | HTTP trigger endpoints |
| Hooks | Stable | 2024.8 | Pre/post message processing |
| Gmail Pub/Sub | Beta | 2025.1 | Email trigger via Google |
| Auth Monitoring | Beta | 2025.6 | Session re-authentication |
| Poll | Experimental | 2025.8 | Periodic URL polling |

---

## Nodes & Media

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Image Understanding | Stable | 2024.3 | Vision model integration |
| Audio Transcription | Stable | 2024.6 | Whisper integration |
| TTS (Text-to-Speech) | Stable | 2025.1 | Multiple providers, Edge fallback |
| Camera Capture | Beta | 2024.8 | Node camera access |
| Location Services | Beta | 2025.1 | GPS/location awareness |
| Voice Wake | Beta | 2025.3 | macOS voice activation |
| Voice Call | Experimental | 2025.6 | Twilio phone integration |
| Talk Mode | Experimental | 2025.8 | Real-time voice conversation |

---

## Platforms

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| macOS App | Stable | 2024.6 | Menu bar companion app |
| iOS App | Beta | 2025.1 | Mobile companion |
| Android App | Beta | 2025.3 | Mobile companion |
| Linux (CLI) | Core | 2024.1 | Full CLI support |
| Windows (CLI) | Stable | 2024.3 | Full CLI support |
| Docker | Stable | 2024.3 | Container deployment |
| Fly.io | Stable | 2024.6 | Edge deployment |
| Railway | Stable | 2025.1 | One-click deployment |
| Render | Stable | 2026.1 | Managed deployment |
| Northflank | Beta | 2026.1 | Kubernetes deployment |
| Raspberry Pi | Beta | 2025.8 | ARM deployment |
| GCP | Beta | 2026.1 | Google Cloud deployment |

---

## Web Interfaces

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Gateway Dashboard | Stable | 2024.6 | Web-based control panel |
| WebChat | Stable | 2024.6 | Browser-based chat UI |
| TUI | Stable | 2024.8 | Terminal user interface |
| Control UI | Stable | 2025.1 | Administrative interface |
| Marketplace UI | Beta | 2026.1 | ClawdHub skill browser |

---

## Security

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Token Auth | Core | 2024.1 | Bearer token authentication |
| Password Auth | Core | 2025.1 | Human-friendly passwords |
| Exec Sandboxing | Stable | 2024.8 | Command isolation |
| Tool Policies | Stable | 2024.10 | Per-tool permissions |
| Secrets Manager | Stable | 2026.1 | Keychain/Credential Manager |
| Prompt Injection Defense | Beta | 2026.1 | Input sanitization |
| Command Blocklist | Beta | 2026.1 | Dangerous command blocking |
| Rate Limiting | Stable | 2026.1 | Request throttling |
| Formal Verification | Experimental | 2025.10 | Mathematical security proofs |

---

## Plugins & Extensions

| Feature | Maturity | Since | Notes |
|---------|----------|-------|-------|
| Plugin SDK | Stable | 2024.8 | Channel/tool extensions |
| Plugin Manifest | Stable | 2024.8 | `clawdbot.plugin.json` spec |
| Hot Reload | Beta | 2025.1 | Development mode reloading |
| Plugin HTTP Registry | Beta | 2026.1 | Dynamic route registration |

---

## Upgrade Guidance

### Moving from Experimental to Beta
Features at experimental level may have breaking changes between minor versions. Pin your Clawdbot version if you depend on experimental features.

### Moving from Beta to Stable
Beta features are generally safe for production but may require migration steps. Check the [changelog](/reference/RELEASING) when upgrading.

### Core Features
Core features maintain backward compatibility within major versions. Migration guides are provided for any breaking changes.

---

## Requesting Feature Promotion

If you're using a Beta or Experimental feature in production and would like it prioritized for stabilization, please:

1. Open a [GitHub issue](https://github.com/clawdbot/clawdbot/issues) describing your use case
2. Include any edge cases or bugs you've encountered
3. Suggest any API improvements that would make it more stable

Community feedback directly influences feature prioritization.
