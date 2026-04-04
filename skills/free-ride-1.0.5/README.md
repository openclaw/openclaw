# 🎢 FreeRide

### Stop paying for AI. Start riding free.

[![ClawHub Downloads](https://api.clawhub-badge.xyz/badge/free-ride/downloads.svg)](https://clawhub.ai/skills/free-ride)
[![ClawHub Current Installs](https://api.clawhub-badge.xyz/badge/free-ride/installs-current.svg)](https://clawhub.ai/skills/free-ride)
[![ClawHub Stars](https://api.clawhub-badge.xyz/badge/free-ride/stars.svg)](https://clawhub.ai/skills/free-ride)
[![ClawHub Version](https://api.clawhub-badge.xyz/badge/free-ride/version.svg)](https://clawhub.ai/skills/free-ride)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Compatible](https://img.shields.io/badge/OpenClaw-Compatible-blue.svg)](https://github.com/openclaw/openclaw)

---

**FreeRide** gives you unlimited free AI in [OpenClaw](https://github.com/openclaw/openclaw) by automatically managing OpenRouter's free models.

```
You: *hits rate limit*
FreeRide: "I got you." *switches to next best model*
You: *keeps coding*
```

## The Problem

You're using OpenClaw. You love it. But:

- 💸 API costs add up fast
- 🚫 Free models have rate limits
- 😤 Manually switching models is annoying
- 🤷 You don't know which free model is actually good

## The Solution

One command. Free AI. Forever.

```bash
freeride auto
```

That's it. FreeRide:

1. **Finds** the 30+ free models on OpenRouter
2. **Ranks** them by quality (context length, capabilities, speed)
3. **Sets** the best one as your primary
4. **Configures** smart fallbacks for when you hit rate limits
5. **Preserves** your existing OpenClaw config

## Installation

```bash
npx clawhub@latest install free-ride
cd ~/.openclaw/workspace/skills/free-ride
pip install -e .
```

That's it. `freeride` and `freeride-watcher` are now available as global commands.

## Quick Start

### 1. Get a Free OpenRouter Key

Go to [openrouter.ai/keys](https://openrouter.ai/keys) → Create account → Generate key

No credit card. No trial. Actually free.

### 2. Set Your Key

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Or add it to your OpenClaw config:

```bash
openclaw config set env.OPENROUTER_API_KEY "sk-or-v1-..."
```

### 3. Run FreeRide

```bash
freeride auto
```

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

### 5. Verify It Works

Message your agent on WhatsApp/Telegram/Discord or the dashboard:

```
You:    /status
Agent:  (shows the free model name + token count)
```

Done. You're now running on free AI with automatic fallbacks.

## What You Get

```
Primary Model: openrouter/nvidia/nemotron-3-nano-30b-a3b:free (256K context)

Fallbacks:
  1. openrouter/free          ← Smart router (auto-picks best available)
  2. qwen/qwen3-coder:free    ← Great for coding
  3. stepfun/step-3.5:free    ← Fast responses
  4. deepseek/deepseek:free   ← Strong reasoning
  5. mistral/mistral:free     ← Reliable fallback
```

When you hit a rate limit, OpenClaw automatically tries the next model. You keep working. No interruptions.

## Commands

| Command                   | What it does                          |
| ------------------------- | ------------------------------------- |
| `freeride auto`           | Auto-configure best model + fallbacks |
| `freeride list`           | See all 30+ free models ranked        |
| `freeride switch <model>` | Use a specific model                  |
| `freeride status`         | Check your current setup              |
| `freeride fallbacks`      | Update fallbacks only                 |
| `freeride refresh`        | Force refresh model cache             |

### Pro Tips

```bash
# Already have a model you like? Just add fallbacks:
freeride auto -f

# Want more fallbacks for maximum uptime?
freeride auto -c 10

# Coding? Switch to the best coding model:
freeride switch qwen3-coder

# See what's available:
freeride list -n 30

# Always restart OpenClaw after changes:
openclaw gateway restart
```

## How It Ranks Models

FreeRide scores each model (0-1) based on:

| Factor         | Weight | Why                               |
| -------------- | ------ | --------------------------------- |
| Context Length | 40%    | Longer = handle bigger codebases  |
| Capabilities   | 30%    | Vision, tools, structured output  |
| Recency        | 20%    | Newer models = better performance |
| Provider Trust | 10%    | Google, Meta, NVIDIA, etc.        |

The **smart fallback** `openrouter/free` is always first - it auto-selects based on what your request needs.

## Testing with Your OpenClaw Agent

After running `freeride auto` and `openclaw gateway restart`:

```bash
# Check OpenClaw sees the models
openclaw models list

# Validate config
openclaw doctor --fix

# Open the dashboard and chat
openclaw dashboard
# Or message your agent on WhatsApp/Telegram/Discord
```

Useful agent commands to verify:

| Command   | What it tells you                                    |
| --------- | ---------------------------------------------------- |
| `/status` | Current model + token usage                          |
| `/model`  | Available models (your free models should be listed) |
| `/new`    | Start fresh session with the new model               |

## Watcher (Auto-Rotation)

FreeRide includes a watcher daemon that monitors for rate limits and automatically rotates models:

```bash
# Run once (check + rotate if needed)
freeride-watcher

# Run as daemon (continuous monitoring)
freeride-watcher --daemon

# Force rotate to next model
freeride-watcher --rotate

# Check watcher status
freeride-watcher --status

# Clear rate limit cooldowns
freeride-watcher --clear-cooldowns
```

## FAQ

**Is this actually free?**

Yes. OpenRouter provides free tiers for many models. You just need an account (no credit card).

**What about rate limits?**

That's the whole point. FreeRide configures multiple fallbacks. When one model rate-limits you, OpenClaw automatically switches to the next.

**Will it mess up my OpenClaw config?**

No. FreeRide only touches `agents.defaults.model` and `agents.defaults.models`. Your gateway, channels, plugins, workspace, customInstructions - all preserved.

**Which models are free?**

Run `freeride list` to see current availability. It changes, which is why FreeRide exists.

**Do I need to restart OpenClaw after changes?**

Yes. Run `openclaw gateway restart` after any FreeRide command that changes your config.

## The Math

| Scenario            | Monthly Cost |
| ------------------- | ------------ |
| GPT-4 API           | $50-200+     |
| Claude API          | $50-200+     |
| OpenClaw + FreeRide | **$0**       |

You're welcome.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) installed (Node ≥22)
- Python 3.8+
- Free OpenRouter account ([get key](https://openrouter.ai/keys))

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  You         │ ──→ │  FreeRide    │ ──→ │  OpenRouter API  │
│  "freeride   │     │              │     │  (30+ free       │
│   auto"      │     │  • Fetch     │     │   models)        │
└──────────────┘     │  • Rank      │     └──────────────────┘
                     │  • Configure │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ ~/.openclaw/ │
                     │ openclaw.json│
                     └──────┬───────┘
                            │
                     openclaw gateway restart
                            │
                            ▼
                     ┌──────────────┐
                     │  OpenClaw    │
                     │  (free AI!)  │
                     └──────────────┘
```

## Contributing

Found a bug? Want a feature? PRs welcome.

```bash
cd ~/.openclaw/workspace/skills/free-ride

# Test commands
freeride list
freeride status
freeride auto --help
```

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - The AI coding agent
- [OpenRouter](https://openrouter.ai) - The model router
- [ClawHub](https://github.com/clawhub) - Skill marketplace

## License

MIT - Do whatever you want.

---

<p align="center">
  <b>Stop paying. Start riding.</b>
  <br>
  <br>
  <a href="https://github.com/Shaivpidadi/FreeRide">⭐ Star us on GitHub</a>
  ·
  <a href="https://openrouter.ai/keys">🔑 Get OpenRouter Key</a>
  ·
  <a href="https://github.com/openclaw/openclaw">🦞 Install OpenClaw</a>
</p>
