# 🧠 Mindbot — Personal AI with Conscious and Subconscious Memory Architecture

<p align="center">
  <strong>IDENTITY. MEMORY. EVOLUTION.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Mindbot** is a fork of [**OpenClaw**](https://github.com/openclaw/openclaw) focused on persistent identity and long-term memory for a single-user AI assistant.

> Base project: [openclaw/openclaw](https://github.com/openclaw/openclaw) · [Docs](https://docs.openclaw.ai) · [Discord](https://discord.gg/clawd)

---

## Architecture

Mindbot uses a **Dual-Process Theory of Mind** architecture: a foreground conscious system (context window + active recall tools) and a background subconscious system (narrative autobiography + semantic memory graph).

### Conscious System (Foreground)

- **Context window**: current conversation
- **`remember` tool**: queries the Graphiti knowledge graph for facts and entities

### Subconscious System (Background)

| Component    | Description                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `STORY.md`   | First-person autobiography, injected every turn. Auto-consolidated from conversation history.       |
| `QUICK.md`   | Ultra-compact user profile (~500–1000 chars). Used as query context for flashback retrieval.        |
| `SUMMARY.md` | Session summary for hyperfocus mode.                                                                |
| Graphiti     | Docker-based temporal knowledge graph (FalkorDB). Automatic "flashback" retrieval before each turn. |

Memory files live at `~/.openclaw/agents/<agentId>/` (not in the workspace).

### Hyperfocus Mode (`/hyperfocus`)

Intensive mode that suppresses background memory (SOUL.md, USER.md, MEMORY.md) and uses SUMMARY.md as context. Useful when working on a focused task where historical context would be noise.

---

## Model Hooks

Mindbot adds `beforeMessage` and `afterResponse` hook support to the RPC/embedded agent path (in addition to the existing Telegram/Discord path). Hooks run shell scripts before/after each model turn and support `{sessionId}`, `{agentId}`, `{provider}`, and `{model}` substitution variables.

See [docs/mind/HOOKS_AND_COMMANDS.md](docs/mind/HOOKS_AND_COMMANDS.md) for configuration details and examples.

---

## Telegram Custom Commands

OpenClaw supports shell-backed custom commands on any channel. Commands map a `/slash` to a shell script whose output is returned as the response.

See [docs/mind/HOOKS_AND_COMMANDS.md](docs/mind/HOOKS_AND_COMMANDS.md) for configuration details and examples.

---

## Notifications

The `mind-memory` plugin fires desktop notifications via `~/scripts/notify.sh` at key lifecycle events (compaction start/end, narrative regeneration). The script path is hardcoded — replace with your own notification mechanism if needed.

---

## Plugin Configuration (`mind-memory`)

```json
{
  "plugins": {
    "entries": {
      "mind-memory": {
        "enabled": true,
        "config": {
          "graphiti": {
            "baseUrl": "http://localhost:8001",
            "autoStart": true
          },
          "narrative": {
            "provider": "anthropic",
            "model": "claude-opus-4-6",
            "thinking": "low"
          }
        }
      }
    }
  }
}
```

### Start Graphiti (Docker)

```bash
docker-compose -f extensions/mind-memory/docker-compose.yml up -d
```

---

## Development

```bash
pnpm install
pnpm build          # TypeScript build
pnpm tsgo           # Type check (memory-safe)
pnpm test           # Run tests
pnpm check          # Lint + format check
pnpm format:fix     # Auto-format
```

See base project docs for full setup: [docs.openclaw.ai](https://docs.openclaw.ai)
