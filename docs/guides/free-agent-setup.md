---
title: "Free Agent Setup"
description: "Run OpenClaw agents without paid APIs using Kimi K2.5, DeepSeek, and other free models"
---

# Free Agent Setup

Run powerful AI agents without paying for API access. OpenClaw supports several free or zero-cost model providers out of the box.

## Free Model Providers

| Provider        | Model           | Context Window | API Key Required | Cost |
| --------------- | --------------- | -------------- | ---------------- | ---- |
| **Moonshot**    | Kimi K2.5       | 256k tokens    | Yes (free tier)  | $0   |
| **Qwen Portal** | Qwen Coder      | 128k tokens    | OAuth (free)     | $0   |
| **Xiaomi**      | MiMo V2 Flash   | 262k tokens    | Yes (free tier)  | $0   |
| **Qianfan**     | DeepSeek V3.2   | 98k tokens     | Yes (free tier)  | $0   |
| **Ollama**      | Any local model | 128k tokens    | No               | $0   |

## Quick Start: Kimi K2.5

Kimi K2.5 offers the best balance of capability and cost (free) with a massive 256k context window.

### 1. Get a free API key

Sign up at [platform.moonshot.ai](https://platform.moonshot.ai) and create an API key.

### 2. Configure the agent

Add to `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    list: [
      {
        id: "free-agent",
        name: "Free Agent",
        model: {
          primary: "moonshot/kimi-k2.5",
          fallbacks: ["qianfan/deepseek-v3.2", "xiaomi/mimo-v2-flash"],
        },
        skills: [
          "blog-publisher",
          "site-deployer",
          "voice-clone",
          "coding-agent",
          "github",
          "canvas",
        ],
      },
    ],
  },
}
```

### 3. Set the API key

```bash
export MOONSHOT_API_KEY="your-key-here"

# Or use auth profiles for persistence:
openclaw auth add moonshot --api-key "your-key-here"
```

### 4. Route a channel to the free agent

```json5
{
  agents: {
    bindings: [
      {
        agentId: "free-agent",
        match: { channel: "telegram" },
      },
    ],
  },
}
```

## Multi-Agent Setup (Free + Paid)

Use free models for routine tasks and paid models for complex reasoning:

```json5
{
  agents: {
    defaults: {
      model: "moonshot/kimi-k2.5", // default: free
    },
    list: [
      {
        id: "daily",
        name: "Daily Assistant",
        model: "moonshot/kimi-k2.5",
        skills: ["blog-publisher", "site-deployer", "weather", "github"],
      },
      {
        id: "power",
        name: "Power Agent",
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["moonshot/kimi-k2.5"],
        },
        skills: ["coding-agent", "voice-clone", "canvas"],
      },
    ],
  },
}
```

## Local-Only Setup (Ollama)

For fully offline operation with zero API costs:

```json5
{
  agents: {
    list: [
      {
        id: "local",
        name: "Local Agent",
        model: "ollama/llama3.1:70b",
        skills: ["blog-publisher", "site-deployer", "coding-agent"],
      },
    ],
  },
}
```

Requires [Ollama](https://ollama.ai) running locally on port 11434.

## Full Multi-Agent System

For the complete 5-agent orchestrated setup with automated research, creative mode, and autonomous task proposals, see:

- **[AGENTS.md](AGENTS.md)** - Operating instructions and quick commands
- **[free-agent-config.example.json5](free-agent-config.example.json5)** - Full config (copy to `~/.openclaw/openclaw.json`)

### Agents Overview

| Agent      | Role         | What it does                            |
| ---------- | ------------ | --------------------------------------- |
| Commander  | Orchestrator | Routes tasks, coordinates all agents    |
| Researcher | AI Scout     | Scans X.com, HackerNews, GitHub daily   |
| Creator    | Content      | Blog posts, social media, creative mode |
| Deployer   | DevOps       | Deploys sites, manages code             |
| Voice      | Audio        | Voice cloning, TTS                      |

### Setup Automated Research

```bash
# Set up cron jobs for daily research + content proposals
skills/agent-manager/scripts/setup-cron-jobs.sh --tz "Europe/Berlin"
```

### Quick Commands (via any channel)

```
"Status"                    → All agent activity
"Research AI agents"        → Researcher scans sources
"Write a blog about X"     → Creator drafts content
"Deploy my site to Vercel"  → Deployer handles it
"Clone this voice"          → Voice agent processes
"Creative mode"             → Autonomous brainstorming
"What's new?"               → Latest research findings
```
