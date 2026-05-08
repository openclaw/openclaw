---
name: personal-api
description: Turn your Obsidian vault into a personal identity layer for AI. Any agent reads ME.md and AGENT.md and instantly knows who you are, how you think, and how to work with you. Scaffolds a complete Knowledge Palace v2 second-brain system (PARA + Johnny.Decimal + Zettelkasten + MOC + LLM Wiki + Memory Palace). Use when setting up a new Obsidian vault for AI collaboration, onboarding AI assistants, or building a structured knowledge management system.
license: MIT
compatibility: Requires an Obsidian vault. Works with any AI agent that can read files. macOS, Linux, Windows (WSL).
metadata:
  author: beiyuii
  version: "2.0.0"
  openclaw:
    requires: {}
---

# Personal API — AI Identity Layer for Your Obsidian Vault

> **30-second elevator pitch:** Stop re-onboarding every AI assistant. This skill scaffolds an "API documentation" for yourself inside your Obsidian vault — `ME.md` is your identity contract, `AGENT.md` is your behavior contract. Any AI that reads these two files knows who you are, how you think, and how to work with you in under 30 seconds.

> **Agent-agnostic by design.** This is not tied to any single agent runtime. Drop it next to Claude Code, Codex, Cursor, ChatGPT, Gemini, or your own custom LLM agent — it works the same way: a folder convention + two markdown contracts that any LLM can read.

---

## Why This Exists

Every new chat, every new project, every new AI tool — you start from zero. You re-explain your preferences, your tech stack, your communication style, your constraints. By the time the AI is "calibrated," you've burned 10 minutes and a chunk of context window.

**Personal API solves this with three primitives:**

1. **`ME.md`** — Your single-page identity contract. Read once, AI knows you.
2. **`AGENT.md`** — Your behavior contract. Defines the rules of engagement.
3. **A vault navigation layer** — When AI needs more depth, it knows exactly where to look.

---

## Methodology

Personal API fuses six well-established methodologies:

| Methodology | Core Idea | How We Use It |
|---|---|---|
| **PARA** (Tiago Forte) | Sort by *actionability*, not topic | Lifecycle directories: capture → intel → research → notes → frameworks → outputs → archive |
| **Johnny.Decimal** | Numbered prefixes keep locations stable | `00 / 10 / 20 / … / 90` partitions; topics never need to be re-filed |
| **Zettelkasten** (Luhmann) | Atomic permanent notes that compound | `40.notes/permanent/` holds only ideas you have genuinely thought through |
| **MOC / LYT** (Nick Milo) | Maps over deep folders | `40.notes/moc/` gives semantic indexes, decoupled from file structure |
| **LLM Wiki** (Karpathy) | Strict separation of raw vs compiled | `10.capture/raw/` (raw material) ≠ `40.notes/literature/` (compiled) |
| **Memory Palace** | Spatial metaphor reduces lookup cost | Each top-level folder is a "room" — you know what is inside before opening |

> **Core formula:** Folders solve **lifecycle**. MOCs solve **topic membership**. Wikilinks solve **relationships**.

---

## Dual-Track Architecture

| Track | Scope | Maintained By | AI Role |
|---|---|---|---|
| **Track A: Identity Archive** | `ME.md`, `00.context/`, `10.identity/`, `20.skills/`, `40.memory-stream/`, `50.maps/` | 100% human-curated | Read-only; can suggest but not rewrite |
| **Track B: Knowledge Production** | Everything under `30.knowledge/` | AI-led organization, human review | Active librarian — compile, link, archive |

---

## Directory Structure

```
your-vault/
├── ME.md                          # Layer 0 — Identity entry
├── AGENT.md                       # AI behavior contract
├── 00.context/                    # Layer 1 — current state
│   ├── now.md
│   ├── open-questions.md
│   └── projects/
├── 10.identity/                   # Layer 2 — deep identity
│   ├── values.md
│   ├── vision.md
│   ├── thinking-models.md
│   └── strengths-gaps.md
├── 20.skills/                     # Layer 2 — capability map
├── 30.knowledge/                  # Knowledge production (AI-led)
│   ├── 00.system/                 # Methodology & rules
│   ├── 10.capture/                # Inbox
│   ├── 20.intelligence/           # Time-sensitive signals
│   ├── 30.research/               # Long-form research
│   ├── 40.notes/                  # Note core asset
│   │   ├── literature/
│   │   ├── permanent/
│   │   └── moc/
│   ├── 50.frameworks/             # Reusable methods
│   ├── 60.projects/               # Project-bound knowledge
│   ├── 70.outputs/                # Publishable content
│   └── 90.archive/                # Read-only archives
├── 40.memory-stream/              # Daily logs, reflections
└── 50.maps/                       # Global navigation
```

---

## Installation

### OpenClaw install

```bash
# Via ClawHub
clawhub install personal-api

# Or manual
git clone https://github.com/beiyuii/personal-api-skill.git
cp -r personal-api-skill/.agents/skills/personal-api ~/.agents/skills/
```

### Manual setup

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
bash scripts/setup.sh
```

---

## Usage

Standard read order for any AI agent:

1. **`ME.md`** — Layer 0, identity (always)
2. **`00.context/now.md`** — Layer 1, current focus
3. **`50.maps/index.md`** — Global navigation
4. **`30.knowledge/00.system/methodology.md`** — Knowledge production rules

Tell your AI: `"Read my ME.md and AGENT.md to understand my context. Then proceed."`

---

## AI Operation Boundaries

| Action | Allowed? |
|---|---|
| Read any markdown file | Yes |
| Create new files under `30.knowledge/` | Yes |
| Reorganize `30.knowledge/` content | Yes |
| Update `50.maps/index.md` links | Yes |
| Update `00.context/now.md` (factually) | Yes (carefully) |
| Modify `ME.md` core identity | No |
| Modify `10.identity/` values/vision | No |
| Bulk delete files | No (requires explicit user confirmation) |

---

## Credits

Designed by [@beiyuii](https://github.com/beiyuii).
Methodology synthesizes work from Tiago Forte, Niklas Luhmann, Nick Milo, Andrej Karpathy, and Johnny Decimal.
