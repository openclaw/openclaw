---
name: mindgardener
description: Long-term memory for AI agents. Reads chat logs and builds a wiki of people, projects & events. No database — just text files.
homepage: https://github.com/widingmarcus-cyber/mindgardener
metadata:
  {
    "openclaw":
      {
        "emoji": "🌱",
        "requires": { "bins": ["garden"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "mindgardener",
              "bins": ["garden"],
              "label": "Install mindgardener (uv/pip)",
            },
          ],
      },
  }
---

# MindGardener

Long-term memory for AI agents. Reads your agent's daily logs and automatically builds a wiki of everyone and everything it encounters. No database needed — just text files.

"Your agent forgets everything between sessions. MindGardener fixes that."

## Setup

1. Install: `uv tool install mindgardener` (or `pip install mindgardener`)
2. Set LLM provider key: `export GEMINI_API_KEY=your-key` (or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
3. Initialize: `garden init`

For local models (zero cost, no API key):

```bash
garden init --provider ollama
```

## Quick Start

```bash
garden init
garden extract
garden recall "topic"
garden surprise
garden consolidate
```

## Commands

| Command                      | What it does                                    |
| ---------------------------- | ----------------------------------------------- |
| `garden init`                | Initialize workspace (config, dirs, daily file) |
| `garden extract`             | Extract entities from daily logs → wiki pages   |
| `garden surprise`            | Two-stage prediction error scoring              |
| `garden consolidate`         | Promote high-surprise events to MEMORY.md       |
| `garden recall "query"`      | Fuzzy search with graph traversal               |
| `garden entities`            | List all known entities by type                 |
| `garden prune`               | Archive stale entities                          |
| `garden merge "a" "b"`       | Merge duplicate entities                        |
| `garden fix type "X" "tool"` | Fix LLM extraction mistakes                     |
| `garden reindex`             | Rebuild graph after manual edits                |
| `garden viz`                 | Mermaid knowledge graph                         |
| `garden stats`               | Overview statistics                             |

## How It Works

1. **Extract**: LLM reads daily log → entities + relationships (JSON)
2. **Store**: Wiki pages per entity with `[[wikilinks]]` in Markdown
3. **Graph**: Triplets in JSONL (`subject → predicate → object`)
4. **Surprise**: Two-stage prediction error (predict THEN compare)
5. **Consolidate**: High-surprise → MEMORY.md
6. **Prune**: Archive unreferenced entities

All storage is Markdown + JSONL. No database. `cat`, `grep`, `git` compatible.

## Integration

### Nightly cron

```bash
garden extract && garden surprise && garden consolidate
```

### Context retrieval

```bash
garden recall "topic from user message"
```

## Config

```yaml
# garden.yaml
extraction:
  provider: google # google, openai, anthropic, ollama, compatible
  model: gemini-2.0-flash
consolidation:
  surprise_threshold: 0.5
  decay_days: 30
```
