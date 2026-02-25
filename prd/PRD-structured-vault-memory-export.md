# PRD: Structured Vault Memory Export

## Status: Draft
## Author: Jesten Herrild (via Copilot)
## Date: 2026-02-25

---

## Problem

OpenClaw's memory system writes raw daily logs (`memory/YYYY-MM-DD.md`) and a curated `MEMORY.md`. These files are functional for agent recall via QMD but:

1. **Not human-browsable** — raw dumps with no structure, tags, or interlinks
2. **Single point of failure** — workspace-only, no off-machine backup
3. **No knowledge graph** — decisions, preferences, and facts are buried in chronological logs
4. **No PARA integration** — notes don't land in the user's existing knowledge management structure

Users with external vaults (Obsidian, Logseq, etc.) want agent memory to be **durable, structured, and visible** in their existing tools.

## Proposed Solution

Enhance the session-memory or compaction-flush pipeline to produce structured vault-compatible notes as a secondary output. The workspace `memory/*.md` remains the source of truth for QMD; the vault export is a **curated, human-readable projection**.

### What gets exported

On `/new`, `/reset`, or compaction, extract from the session:

| Content Type | Vault Destination | Example |
|---|---|---|
| Decisions | Append to project note | `[[openclaw]]: Switched primary model to Gemini Flash` |
| Preferences | `2-Areas/Magnus/Preferences.md` | `Token frugality is paramount` |
| Facts learned | `3-Resources/` or relevant area | `GLM-5 context window is 204,800 tokens` |
| Action items | `1-Projects/<project>/` | `TODO: Submit pruning PR upstream` |
| Session summary | `2-Areas/Magnus/Sessions/YYYY-MM-DD.md` | Daily digest with links |

### Note format

```markdown
---
date: 2026-02-25
tags: [openclaw, memory, magnus]
source: session-memory
session: agent:main:telegram:5918274686
---

## Decisions
- Switched primary model to [[Gemini Flash]] due to rate limit issues with [[GLM-5]]
- Enabled context pruning for all providers ([[openclaw-fork]])

## Learned
- QMD indexes Obsidian vaults natively via `memory.qmd.paths`
- `isCacheTtlEligibleProvider` was the Anthropic-only gate

## Follow-up
- [ ] Submit pruning PR upstream
- [ ] Redesign obsidian-memory hook
```

### Architecture options

#### Option A: Enhanced session-memory hook
- Modify the built-in `session-memory` hook to produce a second output
- Pros: Simple, fires on existing events
- Cons: Hook runs synchronously before `/new` completes, limited context

#### Option B: Post-compaction vault export
- New hook event `compaction:complete` fires after compaction
- Export receives the compaction summary (already a structured digest)
- Pros: Compaction summary is pre-distilled, best content quality
- Cons: New hook event needed in OpenClaw core

#### Option C: Dedicated vault-export skill (agent-driven)
- Agent periodically reviews `memory/*.md` and creates structured vault notes
- Uses `obsidian-scribe` for writing, `local-rag` for dedup
- Pros: No core changes, agent decides what's important
- Cons: Token-expensive, unreliable (agent may forget)

### Recommended: Option B (post-compaction export)

Compaction already distills the session into a structured summary. Exporting that summary to the vault with proper frontmatter and wiki-links is lightweight and high-value. Requires one new hook event in OpenClaw core.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "vault-memory-export": {
          "enabled": true,
          "vaultPath": "/mnt/c/Users/Jherr/Documents/remote-personal",
          "targetFolder": "2-Areas/Magnus/Sessions",
          "tags": ["openclaw", "memory", "magnus"],
          "format": "obsidian",
          "writeVia": "obsidian-scribe"
        }
      }
    }
  }
}
```

## Dependencies

- `obsidian-scribe` skill (existing) for vault writes
- QMD for deduplication (search before write)
- New `compaction:complete` hook event in OpenClaw core (Option B)

## Non-goals

- Real-time streaming of conversation to vault (too noisy)
- Replacing QMD's search with vault search (QMD is better)
- Auto-filing into arbitrary PARA locations (start with fixed target folder)

## Open questions

1. Should the export happen on every compaction, or only on `/new`?
2. How to extract wiki-links from unstructured conversation? (NER? keyword matching against vault filenames?)
3. Should the agent review/approve the export before writing? (Token cost vs accuracy)
4. Can this be a community hook on ClawHub rather than a core feature?
