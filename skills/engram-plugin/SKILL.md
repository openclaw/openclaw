---
name: engram-plugin
description: "Install and configure the Engram Memory OpenClaw plugin — a bidirectional memory bridge that auto-retrieves relevant memories before each AI turn (injected into system prompt) and auto-writes each turn back to Engram after completion. Use when: (1) setting up automatic Engram memory injection for OpenClaw, (2) installing the engram-memory plugin from scratch, (3) updating or reinstalling the plugin after Engram skill changes. Requires the Engram server (from the `engram` skill) to be running on localhost:3000. NOT for: manual Engram API queries (use `engram` skill), general memory tasks, or non-OpenClaw deployments."
---

# Engram Plugin Skill

Installs the `engram-memory` OpenClaw plugin — bridges Engram into the prompt pipeline automatically.

## What It Does

| Direction    | Hook                  | Behaviour                                                           |
| ------------ | --------------------- | ------------------------------------------------------------------- |
| **Retrieve** | `before_prompt_build` | `POST /retrieve` + `/concepts` → injected as `prependSystemContext` |
| **Write**    | `agent_end`           | Last user + assistant turn silently `POST /add` to Engram           |

Heartbeat turns are skipped (no retrieval). Sub-agent sessions are excluded from writes.

## Prerequisites

- Engram server running: `bash ~/openclaw/skills/engram/scripts/start_server.sh`
- Verify: `curl -s -X POST http://localhost:3000/stats`

## Installation

```bash
# 1. Copy plugin source to a staging directory
mkdir -p ~/engram-plugin-src
cp ~/openclaw/skills/engram-plugin/scripts/index.js ~/engram-plugin-src/
cp ~/openclaw/skills/engram-plugin/scripts/package.json ~/engram-plugin-src/
cp ~/openclaw/skills/engram-plugin/scripts/openclaw.plugin.json ~/engram-plugin-src/

# 2. Remove old install if present
rm -rf ~/.openclaw/extensions/engram-memory

# 3. Install
openclaw plugins install ~/engram-plugin-src

# 4. Restart gateway
openclaw gateway restart
```

Verify with: `openclaw plugins list` — should show `engram-memory` with status `loaded`.

## Reinstall / Update

```bash
rm -rf ~/.openclaw/extensions/engram-memory ~/engram-plugin-src
# Repeat installation steps above
```

## Configuration

Default config (works out of the box):

| Key             | Default                 | Description                                |
| --------------- | ----------------------- | ------------------------------------------ |
| `baseUrl`       | `http://localhost:3000` | Engram server URL                          |
| `maxResults`    | `5`                     | Memory results injected per turn           |
| `maxConcepts`   | `3`                     | Concept results injected per turn          |
| `writeEnabled`  | `true`                  | Write turns back to Engram                 |
| `sessionFilter` | `agent:main:`           | Only process sessions matching this prefix |

To override, add to `openclaw.json` under `plugins.config.engram-memory`:

```json
{
  "plugins": {
    "config": {
      "engram-memory": {
        "maxResults": 8,
        "sessionFilter": "agent:main:"
      }
    }
  }
}
```

## Plugin Source Files

The three files in `scripts/` make up the complete plugin:

- `index.js` — plugin logic (hooks, fetch, emotional classifier)
- `package.json` — npm manifest with `openclaw.extensions` field
- `openclaw.plugin.json` — OpenClaw plugin manifest + config schema

See `references/plugin-internals.md` for implementation details and extension points.
