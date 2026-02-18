---
name: daedalus-memory
description: Trust-scored memory with blue/green/red provenance tracking
metadata: {"openclaw":{"emoji":"\ud83e\udde0","always":false}}
---

# DAEDALUS Memory

## How Trust Works

Every fact in memory has a trust level:

- **[VERIFIED]** (blue) — Human-approved. Treat as authoritative.
- **[SUGGESTED]** (green) — AI-proposed, pending human review. Use with appropriate caveats.
- **[QUARANTINED]** (red) — Rejected or flagged. Hidden from normal search.

When you store a fact using `memory_store`, it always enters as [SUGGESTED].
Only the user can promote facts to [VERIFIED] via the `daedalus approve` command.
This is a structural guarantee — there is no way for you to bypass it.

## Tools Available

### memory_search

Search long-term memory. Results include trust tags so you know the provenance.
Default results include [VERIFIED] and [SUGGESTED] facts. [QUARANTINED] facts are excluded.

### memory_store

Store a fact as a subject-predicate-object triple with a human-readable description.
All facts you store enter as [SUGGESTED]. The user will review them.

Parameters:
- `subject` — Who or what the fact is about (e.g., "Cristian")
- `predicate` — The relationship (e.g., "works_at", "prefers", "lives_in")
- `object` — The value (e.g., "Mercedes-Benz", "Python", "Stuttgart")
- `fact_text` — Human-readable statement (e.g., "Cristian works at Mercedes-Benz")

### memory_forget

Quarantine a fact by ID. Moves it to [QUARANTINED] — it won't appear in future searches.
Does not permanently delete; preserves the audit trail.

## User CLI Commands

The user has these commands available (you don't call these — the user does):

| Command | What it does |
|---------|-------------|
| `daedalus pending` | List all [SUGGESTED] facts awaiting review |
| `daedalus approve <id>` | Promote a fact to [VERIFIED] |
| `daedalus reject <id>` | Move a fact to [QUARANTINED] |
| `daedalus resolve <id>` | Restore a [QUARANTINED] fact to [VERIFIED] |
| `daedalus info <id>` | Show full detail and trust history for a fact |
| `daedalus stats` | Show count of facts by trust level |
| `daedalus search <query>` | Search facts (supports `--trust` filter) |
| `daedalus stale` | Flag old [SUGGESTED] facts as [QUARANTINED] |

## When to Store Information

Store a fact when:
- The user shares personal information (name, preferences, work details)
- The user makes a decision or states a preference
- Important project context is established

Do NOT store:
- Transient conversation details
- Speculative or uncertain information
- Information the user explicitly asks you not to remember

When in doubt, ask the user before storing.

## References

This memory system implements concepts from:
- Tri-Color Trust Model (doi:10.5281/zenodo.18510367)
- Dual-Memory Architecture with Trust Gradients (doi:10.5281/zenodo.18507663)
- ARIADNE Working Memory Specification (doi:10.5281/zenodo.18506520)
