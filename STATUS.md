# OpenClaw (RA 2.0) — Project Status & Installation

## Overview

OpenClaw is a **local-first, multi-channel AI assistant platform** that runs on
your own devices. It bridges 13+ messaging channels (WhatsApp, Telegram, Slack,
Discord, Signal, iMessage, Teams, Matrix, …) to LLM providers (Claude, GPT,
Gemini) with a single always-on gateway.

**Version**: 2026.2.19
**License**: MIT
**Runtime**: Node.js ≥ 22.12.0, pnpm 10+

---

## Current Status

| Area | State | Notes |
|------|-------|-------|
| Gateway / core | Stable | WebSocket control plane on `ws://127.0.0.1:18789` |
| Messaging channels | 13+ integrations | WhatsApp, Telegram, Slack, Discord, Signal, Teams, Matrix, etc. |
| Native apps | macOS, iOS, Android | Menu-bar daemon + mobile clients |
| Voice | Active | ElevenLabs TTS + speech-to-text |
| Browser automation | Active | Playwright-based Chrome control |
| Skills | 52 bundled | GitHub, email, coding-agent, canvas, 1Password, … |
| Extensions | 37 modules | BlueBubbles, Zalo, Google Gemini CLI auth, … |
| `ra2/` context layer | Phase 1 | Python — context engine, ledger, sigil, redact, token gate |
| Test coverage | ~1 176 test files | 70 % line/function threshold; 55 % branch threshold |

---

## Installation

### Quick install (npm)

```bash
npm install -g openclaw@latest   # or: pnpm add -g openclaw@latest
openclaw onboard --install-daemon
```

### From source (development)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build        # builds the web UI (auto-installs UI deps)
pnpm build           # compiles TypeScript → dist/

openclaw onboard --install-daemon
```

### Development mode

```bash
pnpm dev              # run via tsx (no build step)
pnpm gateway:watch    # auto-reload on file changes
```

---

## Running Tests

```bash
# Full suite
pnpm test

# Subsets
pnpm test:fast          # unit tests only
pnpm test:e2e           # end-to-end
pnpm test:live          # live model tests
pnpm test:coverage      # unit + coverage report

# Python (ra2 module)
cd ra2 && pytest tests/
```

---

## Configuration

Set environment variables in `.env` or `~/.openclaw/.env`:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude access |
| `OPENAI_API_KEY` | GPT access |
| `GEMINI_API_KEY` | Gemini access |
| `TELEGRAM_BOT_TOKEN` | Telegram channel |
| `DISCORD_BOT_TOKEN` | Discord channel |
| `SLACK_BOT_TOKEN` | Slack channel |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth |

Config lives in `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`).

---

## Project Structure (abridged)

```
src/            TypeScript core (agents, channels, gateway, CLI, plugins)
extensions/     37 extension packages
skills/         52 bundled skills
ra2/            Python context-sovereignty layer
apps/           Native apps (macOS / iOS / Android)
ui/             Web dashboard + WebChat
docs/           Comprehensive documentation
test/           Integration & e2e tests
```

---

## Pre-PR Checklist

```bash
pnpm check      # format + lint + type-check
pnpm test       # full test suite
pnpm build      # production build
```
