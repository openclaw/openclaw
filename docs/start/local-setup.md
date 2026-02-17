---
summary: "Run OpenClaw 24/7 on local hardware with MiniMax and local heartbeats for under $50/month"
read_when:
  - You want a budget-friendly always-on setup
  - You are running OpenClaw on a Mac Mini or local server
  - You want to optimize costs with local heartbeat models
  - You want the MiniMax + LM Studio hybrid stack
title: "Local Setup (Budget)"
---

# Local Setup (Budget)

Goal: run OpenClaw 24/7 on your own hardware with MiniMax for heavy thinking and free local models for heartbeats. Total monthly cost: roughly **$50** (MiniMax Coding Plan).

<Info>
This guide covers the **hybrid stack**: MiniMax M2.5 (hosted) for agent reasoning + LM Studio (local) for heartbeat polling. If you only want hosted models, see [Getting Started](/start/getting-started). If you only want local models for everything, see [Local Models](/gateway/local-models).
</Info>

## What you need

### Hardware

Any always-on machine works. Common choices:

- **Mac Mini (M4, 16 GB)** — silent, low power, runs LM Studio natively.
- **Older MacBook / Mac Studio** — anything with Apple Silicon handles 3-4B local models.
- **Linux box / NUC** — x86 with a discrete GPU works too; use Ollama or vLLM instead of LM Studio.
- **No hardware?** A basic VPS (2 vCPU, 4 GB RAM) can host the Gateway without local models. Skip the LM Studio sections and let MiniMax handle heartbeats too.

### Accounts and keys

Gather these **before** opening Terminal:

| Item | Purpose | Where to get it |
| --- | --- | --- |
| **MiniMax Coding Plan** | Agent brain (1,000 prompts / 5 hours on Max plan) | [MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan) |
| **Telegram bot token** | Mobile interface to your agent | [@BotFather](https://t.me/BotFather) on Telegram |
| **Brave Search API key** (optional) | Web search for your agent | [Brave Search API](https://brave.com/search/api/) |

### Software

- **Node.js 22+** — `node --version` to check.
- **LM Studio** (optional, for local heartbeats) — [lmstudio.ai](https://lmstudio.ai).

## Step 1: Install OpenClaw

<Tabs>
  <Tab title="macOS/Linux">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Homebrew + npm">
    ```bash
    brew install node
    npm install -g openclaw@latest
    ```
  </Tab>
  <Tab title="Windows (PowerShell)">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
</Tabs>

## Step 2: Run the onboarding wizard

```bash
openclaw onboard --install-daemon
```

The wizard walks you through:

1. **Quick Start** — select this.
2. **MiniMax route** — choose MiniMax when prompted for model provider.
3. **Subscription key** — paste your MiniMax Coding Plan API key.
4. **Telegram** — select Telegram from the channel list and paste your bot token from @BotFather.
5. **Daemon install** — the `--install-daemon` flag sets up a background service (launchd on macOS, systemd on Linux) so your Gateway survives reboots.

<Tip>
On Linux, the wizard enables systemd linger so the service runs even when you log out. If it fails, run `sudo loginctl enable-linger $USER` manually.
</Tip>

## Step 3: Pair your phone

After onboarding, the TUI shows a **Pairing Key** (a string like `123456789:ABCDefgh...`).

1. Open your Telegram bot conversation on your phone.
2. Paste the pairing key into the chat.
3. Your phone buzzes with a reply — you now have a 24/7 teammate.

<Check>
If you can send a message on Telegram and get a reply, the setup is working.
</Check>

## Step 4: Verify the Gateway

```bash
openclaw gateway status
openclaw health
```

Both should report the Gateway is running and healthy.

## Cost optimization: local heartbeats

This is the key to keeping costs low. Heartbeats are periodic "check-in" pulses that make your agent autonomous — they wake the agent up to check for pending tasks. With the default config, every heartbeat burns a prompt on your MiniMax plan.

The fix: run heartbeats on a **free local model** via LM Studio, and reserve MiniMax prompts for actual work.

### Install LM Studio and load a model

1. Download [LM Studio](https://lmstudio.ai) and install it.
2. Download a small model suited for heartbeat routing. Recommended models for a 16 GB Mac:

| Model | Response time | Notes |
| --- | --- | --- |
| **Qwen 3 4B** | ~30 sec | Best stability for tool-use and routing. Recommended for heartbeats. |
| **Gemma 3 4B** | ~21 sec | Strong instruction following. |
| **Qwen 2.5 3B** | ~10 sec | Fastest, but weaker on complex logic. |
| **Gemma 2 3B** | ~15 sec | Solid stability. |

These 3-4B models are roughly equivalent to GPT-4o mini for simple routing tasks. They handle "is there work to do?" checks reliably and run entirely on your hardware for $0.

3. Start the LM Studio server (default: `http://127.0.0.1:1234`).
4. Verify it is running:

```bash
curl http://127.0.0.1:1234/v1/models
```

### Configure the hybrid stack

Edit `~/.openclaw/openclaw.json` to use MiniMax for agent work and a local model for heartbeats:

```json5
{
  agents: {
    defaults: {
      // MiniMax handles all real conversations and tasks
      model: { primary: "minimax/MiniMax-M2.1" },

      heartbeat: {
        every: "30m",
        // Local model handles heartbeat polling for free
        model: "lmstudio/heartbeat-local",
        target: "last",
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      },
    },
  },

  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "heartbeat-local",
            name: "Local Heartbeat",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          },
        ],
      },
    },
  },

  env: {
    MINIMAX_API_KEY: "sk-...", // your MiniMax API key
  },

  channels: {
    telegram: {
      enabled: true,
      botToken: "YOUR_TELEGRAM_BOT_TOKEN",
      allowFrom: [123456789], // your Telegram user ID
    },
  },
}
```

Key points:

- `agents.defaults.model.primary` points to MiniMax for all conversations.
- `agents.defaults.heartbeat.model` overrides just the heartbeat to use the local LM Studio model.
- The local model has `cost: { input: 0, output: 0 }` because it runs on your hardware.
- `contextWindow: 8192` is intentionally small — heartbeats only need a short prompt.

### Alternative: MiniMax OAuth (Coding Plan)

If you prefer OAuth over API keys:

```bash
openclaw plugins enable minimax-portal-auth
openclaw gateway restart
openclaw onboard --auth-choice minimax-portal
```

Then set only the heartbeat model override in your config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        model: "lmstudio/heartbeat-local",
      },
    },
  },
  // lmstudio provider config as above
}
```

## Agent management: fewer is better

A common mistake is running too many agents. Each agent adds heartbeat load, inter-agent communication overhead, and debugging complexity.

### The rule: start with 1-2 agents

- **1 agent** handles most solo-founder and personal-use scenarios.
- **2 agents** make sense when you have genuinely separate domains (e.g., personal + work, or coding + ops).
- **9 agents** is almost always wrong — inter-agent chatter alone can exhaust rate limits.

### One task at a time

Give each agent a single clear task. Agents perform best with focused, ground-up instructions rather than multi-part requests that assume prior context.

Bad:
> "Check my email, update the roadmap, deploy the staging build, and write the changelog."

Good:
> "Check my email inbox for messages from clients. If any need a reply, draft one and send it to me for review."

### Use HEARTBEAT.md for recurring tasks

Instead of giving agents complex standing orders in their system prompt, put recurring checks in `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Check if any GitHub issues were assigned to me in the last hour.
- If a deployment is running, check its status.
- If nothing needs attention, reply HEARTBEAT_OK.
```

The heartbeat prompt reads this file automatically. Keep it short — it runs every 30 minutes.

## Scaling up: when to add local model capacity

As you add agents or increase heartbeat frequency, monitor your MiniMax prompt usage:

| Agent count | Heartbeat interval | Prompts per day (heartbeats only) |
| --- | --- | --- |
| 1 | 30m | 48 |
| 2 | 30m | 96 |
| 2 | 15m | 192 |

With local heartbeats, these numbers go to **0 MiniMax prompts** for heartbeats. Your MiniMax budget is reserved entirely for actual conversations and tasks.

If you start scaling beyond 2 agents, consider:

- **Lower heartbeat frequency** (`every: "1h"`) for less critical agents.
- **Active hours** to skip heartbeats overnight:

```json5
{
  heartbeat: {
    activeHours: {
      start: "08:00",
      end: "23:00",
      timezone: "America/New_York",
    },
  },
}
```

- **`target: "none"`** for agents that only need internal state updates.

## Monthly cost breakdown

| Component | Cost |
| --- | --- |
| MiniMax Coding Plan (Max) | $50/month |
| LM Studio (local heartbeats) | $0 |
| Brave Search API | ~$3-5/month (usage-based) |
| Telegram | $0 |
| Hardware (Mac Mini M4) | One-time ~$500-700 |
| **Total recurring** | **~$50-55/month** |

## Troubleshooting

### Heartbeat not using local model

Verify LM Studio is running and the model is loaded:

```bash
curl http://127.0.0.1:1234/v1/models
```

Check that `agents.defaults.heartbeat.model` matches the `lmstudio/<model-id>` in your provider config.

### MiniMax rate limits

If you hit MiniMax rate limits despite local heartbeats, check that the heartbeat model override is applied. Run `openclaw doctor` and verify the resolved heartbeat config shows the local model.

### Gateway not starting after reboot

```bash
openclaw service status
openclaw service start
```

On macOS, check the launchd plist. On Linux, verify linger is enabled: `loginctl show-user $USER | grep Linger`.

### LM Studio hangs on first request

The model may need a cold-load. Open LM Studio, ensure the model is loaded, and retry. Lower `contextWindow` if you see out-of-memory errors.

## Next steps

- [Heartbeat configuration](/gateway/heartbeat) — full heartbeat reference.
- [Local Models](/gateway/local-models) — advanced local model setups.
- [MiniMax provider](/providers/minimax) — MiniMax API details.
- [Multi-Agent Routing](/concepts/multi-agent) — when you need more than 2 agents.
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — when to use cron instead.
