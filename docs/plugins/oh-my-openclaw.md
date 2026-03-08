---
summary: "Oh-My-OpenClaw plugin: multi-agent orchestration with 10 personas, model routing, hooks, tools, and commands"
read_when:
  - You want multi-agent orchestration in OpenClaw
  - You are configuring or developing the oh-my-openclaw plugin
title: "Oh-My-OpenClaw Plugin"
---

# Oh-My-OpenClaw (plugin)

Multi-agent orchestration for OpenClaw via a plugin. Provides category-based
agent delegation with 10 specialized personas, dynamic model routing, hooks,
tools, and workflow commands.

Key features:

- **10 agent personas** — visual-engineering, ultrabrain, deep, artistry, quick, and more
- **Category-based model routing** — route tasks to the right model per category
- **5 hooks** — todo enforcement, comment checking, message monitoring, startup
- **3 tools** — task delegation, look-at (media analysis), checkpoint recovery
- **8 commands** — ralph loop, workflow management, health/config status
- **80 tests**, zero `any` in production code

## Where it runs

This plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure it on the **machine running the Gateway**, then restart the Gateway.

## Install

### Option A: install from npm (recommended)

```bash
openclaw plugins install @happycastle/oh-my-openclaw
```

Restart the Gateway afterwards.

### Option B: install from a local folder (dev)

```bash
git clone https://github.com/happycastle114/oh-my-openclaw.git
openclaw plugins install ./oh-my-openclaw/plugin
cd ./oh-my-openclaw/plugin && npm install
```

Restart the Gateway afterwards.

## Config

Set config under `plugins.entries.oh-my-openclaw.config`:

```json5
{
  plugins: {
    entries: {
      "oh-my-openclaw": {
        enabled: true,
        config: {
          // tmux socket name for background task management
          tmux_socket: "openclaw",

          // Model routing: map categories to specific models
          model_routing: {
            "visual-engineering": "anthropic/claude-sonnet-4-20250514",
            ultrabrain: "anthropic/claude-sonnet-4-20250514",
            deep: "anthropic/claude-sonnet-4-20250514",
            quick: "anthropic/claude-sonnet-4-20250514",
          },
        },
      },
    },
  },
}
```

## Agent personas

| Category             | Description                                  |
| -------------------- | -------------------------------------------- |
| `visual-engineering` | Frontend, UI/UX, design, styling, animation  |
| `ultrabrain`         | Genuinely hard, logic-heavy tasks            |
| `deep`               | Goal-oriented autonomous problem-solving     |
| `artistry`           | Creative approaches beyond standard patterns |
| `quick`              | Single file changes, typo fixes              |
| `unspecified-low`    | Low effort tasks                             |
| `unspecified-high`   | High effort tasks                            |
| `writing`            | Documentation, prose, technical writing      |

## Commands

```bash
/ralph-loop       # Start self-referential development loop
/cancel-ralph     # Cancel active ralph loop
/start-work       # Start work session from plan
/handoff          # Create context summary for session handoff
/omoc-health      # Show plugin health status
/omoc-config      # Show current configuration
```

## Agent tools

- **task-delegation** — Delegate work to specialized sub-agents with category routing
- **look-at** — Analyze media files (images, PDFs) via vision models
- **checkpoint** — Save/restore conversation checkpoints for recovery

## Links

- npm: [`@happycastle/oh-my-openclaw`](https://www.npmjs.com/package/@happycastle/oh-my-openclaw)
- GitHub: [happycastle114/oh-my-openclaw](https://github.com/happycastle114/oh-my-openclaw)
