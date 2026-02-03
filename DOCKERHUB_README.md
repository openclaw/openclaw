# OpenClaw - AI Agent Gateway

[![Docker Pulls](https://img.shields.io/docker/pulls/openclaw/openclaw)](https://hub.docker.com/r/openclaw/openclaw)
[![Image Size](https://img.shields.io/docker/image-size/openclaw/openclaw/latest)](https://hub.docker.com/r/openclaw/openclaw)
[![Multi-arch](https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-blue)](https://hub.docker.com/r/openclaw/openclaw)

> OpenClaw is an AI agent gateway that enables conversational AI across multiple channels (Telegram, WhatsApp, Discord, etc.).

## 🚀 Quick Start

```bash
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -e ZHIPU_API_KEY=your_api_key \
  -e GATEWAY_TOKEN=auto \
  openclaw/openclaw:latest
```

Access Dashboard: `http://localhost:18789?token=YOUR_TOKEN`

## 📋 Features

- 🤖 Multi-model support (Zhipu AI, OpenAI, Anthropic, Cohere)
- 💬 Multi-channel (Telegram, WhatsApp, Discord, Slack)
- 🔄 Auto-deployment
- 📦 Persistent storage
- 🏥 Health checks
- 🔒 Secure authentication
- 🎯 Skills system

## 📚 Documentation

- [Full Documentation](https://docs.openclaw.ai)
- [Docker Deployment Guide](https://docs.openclaw.ai/install/docker)
- [GitHub Repository](https://github.com/openclaw/openclaw)

## 🔧 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZHIPU_API_KEY` | Yes* | Zhipu AI API key (or other provider) |
| `GATEWAY_TOKEN` | No | Auth token (default: auto) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `OPENCLAW_MODEL` | No | Default model (default: zhipu/GLM-4.7) |

*At least one model provider API key is required.

## 📦 Volumes

- `/root/.openclaw` - Configuration and memory
- `/workspace` - Workspace for agent files

## 🏥 Health Check

```bash
curl http://localhost:18789/health
```

## 🔄 Updates

```bash
docker pull openclaw/openclaw:latest
docker stop openclaw
docker rm openclaw
docker run -d ... # same as above
```

## 🌟 Star on GitHub

[![GitHub stars](https://img.shields.io/github/stars/openclaw/openclaw?style=social)](https://github.com/openclaw/openclaw)

---

**License**: MIT | **Support**: [Discord](https://discord.com/invite/clawd)
