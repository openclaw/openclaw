---
name: mindgardener
description: "Your AI agent's personal Wikipedia — automatically built and updated from daily conversations. No database, just files."
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

**Your AI agent's personal Wikipedia — automatically built and updated from daily conversations.**

Every time you chat with your agent, it mentions people, projects, tools, and events. MindGardener turns those conversations into a personal wiki — one markdown file per entity — that grows over time. Your agent remembers what happened last week, who you talked about, and what matters.

No database needed. Just text files.

## How It Stays Manageable

You might wonder: won't this create thousands of files? No. MindGardener is opinionated about what it remembers:

- **One file per entity.** A person, a company, a project each gets one `.md` file. Mentions across different days get merged into the same file — not duplicated.
- **Surprise scoring decides what's worth keeping.** Not everything is interesting. MindGardener predicts what _should_ have happened based on what it already knows, then compares with what _actually_ happened. Only surprising things get promoted to long-term memory. Routine stuff fades.
- **Automatic pruning.** Entities that haven't been mentioned in 30+ days get archived. Your wiki stays focused on what's active and relevant.
- **You can edit it.** It's just markdown files in a folder. Open them in VS Code, Obsidian, or `vim`. Add facts, fix mistakes, delete things. Run `garden reindex` and the system catches up.

A typical agent running for a month has 30-80 entity files. That's it — a small, browsable wiki, not a data dump.

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

1. **Extract**: LLM reads your daily log → finds people, projects, events
2. **Store**: Creates one wiki page per entity with `[[wikilinks]]` between them
3. **Surprise**: Predicts what should happen, compares with reality, scores the difference
4. **Consolidate**: High-surprise items get promoted to long-term memory (MEMORY.md)
5. **Prune**: Inactive entities get archived automatically

All storage is Markdown + JSONL. Readable with `cat`, searchable with `grep`, versionable with `git`.

## Integration

### Nightly cron (set it and forget it)

```bash
garden extract && garden surprise && garden consolidate
```

### Before responding to a user (context retrieval)

```bash
garden recall "topic from user message"
```

### After manually editing wiki pages

```bash
garden reindex
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

Supports 5 LLM providers: Google Gemini, OpenAI, Anthropic, Ollama (local/free), and any OpenAI-compatible API.
