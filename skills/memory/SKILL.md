---
name: memory
description: "长期记忆。Store and recall durable facts and context across sessions. Use when: (1) user says remember X, (2) need past decisions or preferences, (3) daily log or running context. Uses memory_search, memory_get, and memory/YYYY-MM-DD.md + MEMORY.md."
metadata:
  {
    "openclaw": { "emoji": "🧠", "requires": {} },
  }
---

# Memory (长期记忆)

OpenClaw’s **memory** is Markdown in the workspace: daily logs and optional long-term MEMORY. The agent uses **memory_search** and **memory_get** to read; writes go to `memory/YYYY-MM-DD.md` or `MEMORY.md`.

## When to use

- User says “remember this”, “don’t forget”, “save that”
- Need past context: “what did I decide about X?”, “what’s in my notes?”
- Store decisions, preferences, or durable facts for later sessions

## Layout

- **memory/YYYY-MM-DD.md** — daily log (append-only). Today and yesterday are loaded at session start.
- **MEMORY.md** — long-term memory. Loaded only in the main private session (not in group contexts).

Files live under the agent workspace (`agents.defaults.workspace`). See [Memory](/concepts/memory).

## Tools

- **memory_search** — semantic search over memory content (when memory plugin is enabled).
- **memory_get** — read a specific memory file or range.
- Writing: the agent is instructed to write to `memory/YYYY-MM-DD.md` or `MEMORY.md`; use the same paths in prompts.

## Pre-compaction flush

When the session nears compaction, OpenClaw can run a silent turn that asks the model to write durable notes before context is trimmed. Configure via `agents.defaults.compaction.memoryFlush`.

## Config

Memory search uses the active memory plugin (default: memory-core). Set `memorySearch.provider` (e.g. openai, gemini, local) and API keys if using remote embeddings. See [Memory](/concepts/memory).
