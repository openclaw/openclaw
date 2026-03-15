---
title: China Deployment
description: Deploy OpenClaw in mainland China — proxy setup, recommended channels, and Chinese LLM providers.
---

# China Deployment Guide (中国部署指南)

This guide covers the specific challenges and solutions for running OpenClaw in mainland China, where network restrictions affect access to many services OpenClaw depends on.

## Network requirements

OpenClaw needs outbound access to:

- **npm registry** (registry.npmjs.org) — for installation and updates
- **LLM provider APIs** (api.anthropic.com, api.openai.com, generativelanguage.googleapis.com) — for model inference
- **Channel platforms** (Telegram, Discord, Signal, Slack) — for messaging, if used
- **GitHub** (github.com) — for skills, updates, and ClawHub

Most of these are not directly accessible from mainland China. A proxy solution is required.

## Recommended proxy setup: Clash Verge + TUN mode

The most reliable approach is to use [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) with TUN mode enabled. TUN mode creates a virtual network interface that captures **all system traffic** — including traffic from Node.js child processes, the OpenClaw gateway, and agent web-fetch calls — without requiring per-app proxy configuration.

### Step 1: Install Clash Verge Rev

Download from the [releases page](https://github.com/clash-verge-rev/clash-verge-rev/releases) and install. macOS (Apple Silicon) users should download the `aarch64.dmg` file.

### Step 2: Import your proxy subscription

Open Clash Verge → Profiles → paste your subscription URL → click Import.

### Step 3: Enable TUN mode + Service mode

This is the critical step:

1. Go to **Settings → Clash Core**
2. Enable **Service Mode** — this installs a helper that allows TUN to work without running Clash as root. Click the shield icon and authorize the installation.
3. Enable **TUN Mode** — toggle it on. The TUN virtual interface will be created.
4. Verify in **Connections** tab that traffic is flowing through the proxy.

### Step 4: Verify connectivity

```bash
# Test npm registry
curl -I https://registry.npmjs.org

# Test LLM provider API
curl -I https://api.anthropic.com

# Test Telegram (if using Telegram channel)
curl -I https://api.telegram.org

# Test GitHub
curl -I https://github.com
```

All should return HTTP 200 or 301/302 redirects. If any fail, check Clash Verge's log for blocked connections.

### Why TUN mode (not system proxy)

| Method                        | Covers Node.js? | Covers child processes? | Covers agent web-fetch? |
| ----------------------------- | :-------------: | :---------------------: | :---------------------: |
| System proxy (HTTP_PROXY env) |     Partial     |           No            |           No            |
| Clash system proxy mode       |     Partial     |           No            |           No            |
| **Clash TUN mode**            |     **Yes**     |         **Yes**         |         **Yes**         |

OpenClaw spawns child processes for sandboxed execution and uses undici for HTTP requests. System-level proxy environment variables are not inherited reliably across all these paths. TUN mode solves this by operating at the network layer.

## Installation with TUN mode active

With TUN mode running, install OpenClaw normally:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### If npm is slow despite TUN mode

You can optionally configure an npm mirror as a fallback:

```bash
# Use China npm mirror (optional, only if TUN mode is insufficient)
npm config set registry https://registry.npmmirror.com

# Restore to official after installation
npm config set registry https://registry.npmjs.org
```

Note: using the mirror is usually unnecessary with TUN mode active. Only use it if you experience persistent download failures.

## Recommended channels for China

### Feishu (飞书) - recommended

Feishu is the most natural channel for China-based users. It ships bundled with OpenClaw and supports WebSocket long connections, so **no public URL or webhook is needed**.

```bash
openclaw onboard
# Select: Feishu
# Enter: App ID and App Secret from https://open.feishu.cn/app
```

Key advantages:

- No public URL required (WebSocket mode)
- Native support for Chinese text and formatting
- Enterprise-ready with group routing and multi-account support
- Streaming card output for real-time responses

See [Feishu channel docs](/channels/feishu) for full configuration.

### Telegram — works with TUN mode

Telegram is accessible via proxy. With TUN mode active, the Telegram bot connection works normally:

```bash
openclaw onboard
# Select: Telegram
# Enter: Bot token from @BotFather
```

Note: without TUN mode, the Telegram long-polling connection will fail silently. If you see no `[telegram]` entries in gateway logs, verify your proxy is routing traffic to `api.telegram.org`.

### WeChat — not directly supported

OpenClaw does not have a native WeChat channel. Some community members use Feishu or Telegram as the bridge.

### Channels that require extra setup

- **WhatsApp**: works with TUN mode but requires QR pairing through web.whatsapp.com
- **Discord**: works with TUN mode, requires bot token from Discord Developer Portal
- **Slack**: works with TUN mode, requires Bot Token + App Token

## Chinese LLM providers

OpenClaw supports Chinese LLM providers through custom provider configuration.

### Qwen (通义千问)

OpenClaw has a built-in Qwen Portal auth plugin for OAuth access:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Or configure Qwen API directly:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "qwen": {
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "${QWEN_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "qwen-max", "name": "Qwen Max", "contextWindow": 131072, "maxTokens": 8192 },
          { "id": "qwen-plus", "name": "Qwen Plus", "contextWindow": 131072, "maxTokens": 8192 },
          { "id": "qwen-turbo", "name": "Qwen Turbo", "contextWindow": 131072, "maxTokens": 8192 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "qwen/qwen-max" }
    }
  }
}
```

Get your API key at [DashScope console](https://dashscope.console.aliyun.com/).

### DeepSeek

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "deepseek": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "${DEEPSEEK_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-chat",
            "name": "DeepSeek V3",
            "contextWindow": 131072,
            "maxTokens": 8192
          },
          {
            "id": "deepseek-reasoner",
            "name": "DeepSeek R1",
            "reasoning": true,
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Get your API key at [DeepSeek Platform](https://platform.deepseek.com/).

### Moonshot / Kimi

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "apiKey": "${MOONSHOT_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "kimi-k2.5", "name": "Kimi K2.5", "contextWindow": 256000, "maxTokens": 8192 }
        ]
      }
    }
  }
}
```

> **Note:** Kimi K2.5 only accepts `temperature=1.0`. If your config sets a different temperature, override it for this model or leave it unset.

Get your API key at [Moonshot Platform](https://platform.moonshot.cn/).

### Volcano Engine / Doubao (火山引擎)

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "volcengine": {
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "${VOLCANO_ENGINE_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "doubao-pro-256k",
            "name": "Doubao Pro",
            "contextWindow": 262144,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

Get your API key at [Volcano Engine Console](https://console.volcengine.com/ark/).

### Using Chinese models as primary with foreign models as fallback

A practical setup for China users — use Qwen for daily tasks (no proxy needed, lower cost), fall back to Claude for complex reasoning:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "qwen/qwen-max",
        "fallbacks": ["anthropic/claude-sonnet-4-6"]
      }
    }
  }
}
```

## Local LLM via Ollama

Running models locally via Ollama eliminates the need for LLM API proxy access. Note that the initial setup (installing Ollama and downloading models) still requires internet — after that, inference is fully offline.

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a Chinese-friendly model
ollama pull qwen3:8b
```

Configure OpenClaw:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "apiKey": "ollama-local",
        "api": "ollama",
        "models": [
          {
            "id": "qwen3:8b",
            "name": "Qwen3 8B",
            "contextWindow": 131072,
            "maxTokens": 8192,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

For truly air-gapped environments, download the Ollama installer and model files from a machine with internet access, then transfer via USB or internal network. See [Ollama provider docs](/concepts/model-providers#ollama) for more options.

## Troubleshooting

### Gateway starts but Feishu/Telegram shows no activity

Your proxy is likely not covering Node.js traffic. Verify TUN mode is enabled:

1. Check Clash Verge → Settings → TUN mode is ON and Service mode is ON
2. Run `curl -I https://api.telegram.org` — should return 200
3. Restart the gateway: `openclaw gateway restart`

### `pnpm install` or `npm install` hangs

```bash
# Check if npm can reach the registry
curl -I https://registry.npmjs.org

# If it times out, TUN mode may not be active
# Temporarily use China mirror:
npm config set registry https://registry.npmmirror.com
```

### `openclaw update` fails

Same as install — ensure TUN mode is active or use the npm mirror. After updating, restore the official registry:

```bash
npm config set registry https://registry.npmjs.org
```

### Feishu bot receives messages but agent does not respond

1. Check `openclaw doctor` for any warnings
2. Verify your LLM provider is accessible: `curl -I https://api.anthropic.com` (or whichever provider you use)
3. If using a Chinese LLM provider (Qwen, DeepSeek), these are directly accessible without proxy

### Agent web-fetch fails for foreign websites

Web-fetch uses the system network stack. With TUN mode active, it routes through the proxy automatically. Without TUN mode, web-fetch to foreign sites will fail silently.
