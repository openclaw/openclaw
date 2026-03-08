---
read_when:
  - You are a user in China
  - You want to configure domestic LLM APIs (Kimi, Zhipu, etc.)
  - You need help with network connectivity issues
summary: Guide for Chinese users including domestic API configs and troubleshooting
title: China User Guide
---

# China User Guide 🇨🇳

This guide addresses specific needs for users in mainland China, including domestic LLM API configurations and network troubleshooting.

## Domestic LLM API Configurations

### Kimi (Moonshot AI)

Kimi is a popular domestic LLM with strong long-context capabilities.

```json
{
  "models": {
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "apiKey": "sk-your-api-key",
        "models": [
          {
            "id": "moonshot-v1-8k",
            "name": "Kimi 8K"
          },
          {
            "id": "moonshot-v1-32k",
            "name": "Kimi 32K"
          },
          {
            "id": "moonshot-v1-128k",
            "name": "Kimi 128K"
          }
        ]
      }
    }
  }
}
```

### Zhipu AI (GLM)

Zhipu AI provides the GLM-4 series models.

```json
{
  "models": {
    "providers": {
      "zhipu": {
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "your-api-key",
        "models": [
          {
            "id": "glm-4",
            "name": "GLM-4"
          },
          {
            "id": "glm-4-flash",
            "name": "GLM-4-Flash"
          }
        ]
      }
    }
  }
}
```

### Alibaba DashScope (Qwen)

```json
{
  "models": {
    "providers": {
      "dashscope": {
        "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
        "apiKey": "sk-your-api-key",
        "models": [
          {
            "id": "qwen-max",
            "name": "Qwen-Max"
          },
          {
            "id": "qwen-plus",
            "name": "Qwen-Plus"
          }
        ]
      }
    }
  }
}
```

### DeepSeek

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "sk-your-api-key",
        "models": [
          {
            "id": "deepseek-chat",
            "name": "DeepSeek-V3"
          },
          {
            "id": "deepseek-reasoner",
            "name": "DeepSeek-R1"
          }
        ]
      }
    }
  }
}
```

## Local Channel Setup

### Feishu (Lark)

Feishu is supported as an extension channel.

```bash
# Install Feishu plugin
openclaw plugins install feishu
```

Configuration example:
```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "your-app-id",
      "appSecret": "your-app-secret",
      "encryptKey": "your-encrypt-key",
      "verificationToken": "your-verification-token"
    }
  }
}
```

### Other Chinese Channels

For QQ, DingTalk, and WeCom support, check the community extensions or consider using Telegram as an alternative (no real-name verification required).

## Network Troubleshooting

### 1. npm Installation Timeouts

If `npm install` times out:

```bash
# Use Taobao npm mirror
npm config set registry https://registry.npmmirror.com

# Or use pnpm
pnpm config set registry https://registry.npmmirror.com
```

### 2. GitHub Access Issues

```bash
# Configure Git to use proxy (if you have HTTP proxy)
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# Or use SSH instead of HTTPS
git clone git@github.com:openclaw/openclaw.git
```

### 3. Model API Access

Domestic APIs (Kimi, Zhipu, DashScope, DeepSeek) typically work without proxy. For overseas APIs, you may need system-level proxy configuration.

## Recommended Setup for China

For users in mainland China, we recommend:

1. **Model**: Kimi (Moonshot) or Zhipu AI — stable domestic access
2. **Channel**: Telegram (no real-name verification) or Feishu for work scenarios
3. **npm**: Use npmmirror registry
4. **Git**: Use SSH protocol or configure proxy

## Getting Help

- GitHub Issues: https://github.com/openclaw/openclaw/issues
- Discord Community: https://discord.gg/clawd
- For Chinese discussions, feel free to open issues in Chinese

---

*Last updated: 2026-02-25*

