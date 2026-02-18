# daedalus-memory

Trust-gradient memory for OpenClaw. Every fact stored by the agent enters as
**[SUGGESTED]** (AI-proposed, unverified). Facts only become **[VERIFIED]**
through explicit human approval. Red facts are quarantined from retrieval.

## The Problem

OpenClaw's built-in memory treats all stored facts with equal confidence.
A hallucinated "fact" and a user-confirmed fact are stored and retrieved
identically. Over time, unverified AI inferences accumulate and get
retrieved as if they were ground truth — hallucination propagation across
sessions.

## The Architecture

Based on the DAEDALUS dual-memory architecture and tri-color trust model:

| Trust Level | Tag | Meaning | In Search Results? |
|------------|-----|---------|-------------------|
| Blue | [VERIFIED] | Human-approved | Yes (default) |
| Green | [SUGGESTED] | AI-proposed, pending review | Yes (default) |
| Red | [QUARANTINED] | Rejected or flagged | No (unless explicitly requested) |

**The core invariant:** AI agents can propose facts but never auto-commit
to verified knowledge. Green to Blue requires explicit human action.
This is a structural guarantee, not a configuration option.

### Trust Transitions

```
green -> blue    human_approve (only path to verified)
green -> red     human_reject | staleness_timeout | constraint_violation
blue  -> red     human_reject (demotion)
red   -> blue    human_resolve (restoration)

FORBIDDEN: blue -> green, red -> green, any AI-triggered -> blue
```

## Install

```bash
openclaw plugins install openclaw-daedalus-memory
```

Activate in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "daedalus-memory"
    }
  }
}
```

> **Note:** `kind: "memory"` is an exclusive slot — activating daedalus-memory
> replaces the default memory-core plugin.

## Usage

The agent automatically uses `memory_search` and `memory_store` tools.
You manage trust through CLI commands:

```bash
openclaw daedalus pending              # Review unvalidated facts
openclaw daedalus approve <id>         # Promote to [VERIFIED]
openclaw daedalus reject <id>          # Quarantine
openclaw daedalus resolve <id>         # Restore quarantined fact
openclaw daedalus info <id>            # Full detail + trust history
openclaw daedalus stats                # Count by trust level
openclaw daedalus search <query>       # Search with optional --trust filter
openclaw daedalus stale --days 7       # Flag old suggestions
```

## Configuration

In `openclaw.json` under `plugins.daedalus-memory`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `staleness_days` | number | `7` | Days before unreviewed green facts are flagged red |
| `show_trust_tags` | boolean | `true` | Include [VERIFIED]/[SUGGESTED] tags in auto-recall |
| `data_dir` | string | `"daedalus-memory"` | Database directory (relative to OpenClaw data) |
| `autoCapture` | boolean | `false` | Auto-extract facts from conversations |
| `autoRecall` | boolean | `true` | Auto-inject relevant memories into context |

## Validation Rules

Three AXIOM-derived rules run on every fact before storage:

1. **Orphan check** — Subject and object must be non-empty
2. **Self-loop check** — Subject cannot equal Object (case-insensitive)
3. **Duplicate check** — No existing blue/green fact with same (subject, predicate, object) triple

## Research References

This plugin implements concepts from:

- **Tri-Color Trust Model for AI Agent Memory Systems**
  Cristian Leu, University of Oradea, Romania
  [doi:10.5281/zenodo.18510367](https://doi.org/10.5281/zenodo.18510367)

- **Dual-Memory Architecture with Trust Gradients for Cognitive AI Agents**
  Cristian Leu, University of Oradea, Romania
  [doi:10.5281/zenodo.18507663](https://doi.org/10.5281/zenodo.18507663)

- **ARIADNE: Neo4j Working Memory Specification for Cognitive AI Agents**
  Cristian Leu, University of Oradea, Romania
  [doi:10.5281/zenodo.18506520](https://doi.org/10.5281/zenodo.18506520)

All publications CC BY 4.0 — use freely with attribution.

## Author

**Cristian Leu**
Advanced R&D Engineer · AI Supervision Researcher · Battery Arhitecture and Module Strategy · University of Oradea, Romania
https://www.cristian-leu.de/
