# PRD: Obsidian as Primary Agent Memory

## Status: Draft
## Author: Jesten Herrild (via Copilot)
## Date: 2026-02-25

---

## Problem

OpenClaw's memory lives in workspace-local files (`memory/*.md`, `MEMORY.md`). These are:

1. **Not backed up** — tied to a single machine. If the WSL2 instance dies, agent memory is gone.
2. **Not portable** — recreating the agent elsewhere means starting from scratch.
3. **Not human-accessible** — raw dumps invisible to the user's knowledge tools.
4. **Disconnected from the user's second brain** — the agent and user maintain separate, siloed knowledge stores.

## Vision

**The Obsidian vault IS the agent's memory.** Not a copy, not an export — the primary, authoritative store. The agent reads from and writes to the vault directly. The vault is synced, backed up, and browsable in Obsidian's UI (graph view, backlinks, search).

If the machine crashes and Magnus needs to be rebuilt from scratch, the vault has everything needed to rehydrate him — preferences, decisions, project context, learned facts — in structured, human-readable notes with proper metadata.

## Design Principles

1. **Vault-only** — agent memory lives in Obsidian, period. No workspace `memory/*.md` mirror. QMD indexes the vault directly (already working). Bootstrap injection reads from the vault.
2. **Human-readable** — notes use proper frontmatter, tags, wiki-links. A human should be able to browse the vault and understand what the agent knows.
3. **PARA-native** — notes land in the correct PARA location. Agent operational notes go to `2-Areas/Magnus/`. Project-specific memories go to `1-Projects/<project>/`.
4. **Rehydration-ready** — a fresh agent install pointed at the same vault should be able to bootstrap from vault contents alone.

## Architecture

### Write Path

```
Agent decides to store memory
  → obsidian-scribe writes to vault
  → QMD indexes vault on next sync cycle
```

### Read Path (already working)

```
Agent calls memory_search
  → QMD searches vault
  → Returns results
```

### Memory Categories & Vault Locations

| Category | Vault Path | Trigger | Format |
|---|---|---|---|
| Daily session log | `2-Areas/Magnus/Sessions/YYYY-MM-DD.md` | `/new`, `/reset`, compaction | Append-only daily digest |
| Curated long-term | `2-Areas/Magnus/MEMORY.md` | Agent writes explicitly | Structured facts, prefs |
| Project decisions | `1-Projects/<project>/Notes/` | Agent writes during project work | Decision log with context |
| Learned facts | `2-Areas/Magnus/Knowledge/` | Agent learns something durable | Tagged, interlinked notes |
| Rehydration bootstrap | `2-Areas/Magnus/Bootstrap.md` | Updated periodically | Identity, prefs, key relationships |

### Note Format

```markdown
---
date: 2026-02-25
tags: [openclaw, memory, magnus, config-audit]
source: agent-memory
aliases: [openclaw config audit]
---

## Context
Audited `openclaw.json` for legacy settings and token bloat.

## Decisions
- Removed Google `models.providers` block — built-in catalog is sufficient
- Fixed [[Minimax M2.5]] contextWindow: 256k → 196k (actual limit)
- Enabled context pruning for all providers (PR [[openclaw-fork#25907]])

## Learned
- [[QMD]] indexes Obsidian vaults natively via `memory.qmd.paths`
- [[Ollama]] cloud auth is SSH key-based, doesn't expire — system service needs separate signin
- `hooks.token` must differ from `gateway.auth.token` since OpenClaw v2026.2.23

## Follow-up
- [ ] Monitor pruning effectiveness on Gemini Flash
- [ ] Build structured vault memory export (this PRD)
```

### Rehydration Bootstrap

`2-Areas/Magnus/Bootstrap.md` is a special note that captures everything needed to recreate Magnus:

```markdown
---
tags: [magnus, bootstrap, identity]
updated: 2026-02-25
---

## Identity
- Name: Magnus Clockthorne
- User: Jesten Herrild (GitHub employee, Whidbey Island, WA)
- Primary channel: Telegram (id:5918274686)

## Key Preferences
- Token frugality is paramount
- Conventional commits
- PARA structure for Obsidian
- Prefer systemd-backed solutions
- obsidian-scribe for all vault writes

## Active Models
- Primary: Gemini 3 Flash Preview
- Fallbacks: Minimax M2.5, GLM-5, Kimi K2.5
- Subagents: GLM-5

## Key Projects
- [[openclaw]] fork with pruning and memory provider
- [[copilot-daemon]] for automated issue processing
- [[interrupt-service]] for event-driven architecture
```

## Implementation Phases

### Phase 1: Write path (hook-based)
- Modify `session-memory` hook (or replace with new hook) to write structured notes to vault via `obsidian-scribe`
- Disable workspace `memory/*.md` writes (vault is the only store)
- QMD indexes vault directly

### Phase 2: Agent-driven memory curation
- Agent writes to vault directly during conversations (decisions, facts, project notes)
- Add a `vault-memory` tool or enhance `memory_search`/`memory_get` to support vault writes
- Agent maintains `Bootstrap.md` and `MEMORY.md` in the vault

### Phase 3: Rehydration
- On fresh install, `openclaw doctor` or a bootstrap hook detects vault and offers to import
- Reads `Bootstrap.md` + recent session notes to populate initial agent context
- QMD indexes vault immediately for full recall

## Configuration

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "paths": [{ "path": "/mnt/c/Users/Jherr/Documents/remote-personal" }]
    },
    "vault": {
      "enabled": true,
      "path": "/mnt/c/Users/Jherr/Documents/remote-personal",
      "agentFolder": "2-Areas/Magnus",
      "writeVia": "obsidian-scribe",

      "bootstrap": "2-Areas/Magnus/Bootstrap.md"
    }
  }
}
```

## Dependencies

- `obsidian-scribe` skill (existing) for vault writes with linting
- QMD (existing, working) for vault indexing and search
- New `memory.vault` config section in OpenClaw
- New hook event or enhanced session-memory hook

## Non-goals

- Replacing QMD search with a custom vault search implementation
- Real-time conversation streaming to vault (too noisy)
- Automatic PARA categorization of arbitrary content (start with fixed paths)

## Open Questions

1. How to handle the transition — migrate existing workspace `memory/*.md` to vault, then remove?
3. Should the bootstrap note be agent-maintained or user-maintained?
4. Wiki-link extraction: keyword match against vault filenames? Or explicit agent instruction?
5. Is this an OpenClaw core feature, a hook, or a ClawHub skill?
