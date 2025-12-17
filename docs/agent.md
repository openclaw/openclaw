---
summary: "Agent runtime (embedded Pi), workspace contract, and session bootstrap"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
---
<!-- {% raw %} -->
# Agent Runtime 🤖

CLAWDIS runs a single agent runtime: **Pi (embedded, in-process)**.

## Workspace (required)

You must set an agent home directory via `inbound.workspace`. CLAWDIS uses this as the agent’s **only** working directory (`cwd`) for tools and context.

Recommended: use `clawdis setup` to create `~/.clawdis/clawdis.json` if missing and initialize the workspace files.

## Bootstrap files (injected)

Inside `inbound.workspace`, CLAWDIS expects these user-editable files:
- `AGENTS.md` — operating instructions + “memory”
- `SOUL.md` — persona, boundaries, tone
- `TOOLS.md` — user-maintained tool notes (e.g. `imsg`, `sag`, conventions)

On the first turn of a new session, CLAWDIS injects the contents of these files directly into the agent context.

If a file is missing, CLAWDIS injects a single “missing file” marker line (and `clawdis setup` will create a safe default template).

## Built-in tools (internal)

Pi’s embedded core tools (read/bash/edit/write and related internals) are defined in code and always available. `TOOLS.md` does **not** control which tools exist; it’s guidance for how *you* want them used.

## Sessions

Session transcripts are stored as JSONL at:
- `~/.clawdis/sessions/<SessionId>.jsonl`

The session ID is stable and chosen by CLAWDIS.

## Configuration (minimal)

At minimum, set:
- `inbound.workspace`
- `inbound.allowFrom` (strongly recommended)

---

*Next: [Group Chats](./group-messages.md)* 🦞
<!-- {% endraw %} -->
