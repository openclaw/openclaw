---
# -- Dart AI metadata ----------------------------------------------------------
title: "Operator1Hub — Curated Registry"
description: "GitHub-hosted curated registry of skills, agents, and commands that ships built-in with operator1"
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high
assignee: "rohit sharma"
tags: [feature, hub, registry, skills, agents, commands]
startAt:
dueAt:
dart_project_id:
# -------------------------------------------------------------------------------
---

# Operator1Hub — Curated Registry

**Created:** 2026-03-13
**Updated:** 2026-03-15
**Status:** Planning
**Depends on:** Skills system (done), Commands system (done), Slash commands (done), Agent Personas (done)
**Supersedes:** `Project-tasks/agent-personas-marketplace.md` (personas delivery now via Hub)

---

## 1. Overview

Operator1Hub is a first-party, GitHub-hosted registry of curated skills, agent
personas, and commands. It ships as the **default registry** with operator1 —
no setup required. Every item is tested and optimized before inclusion.

Users can also optionally connect ClawHub or other registries as additional
sources, but Operator1Hub is independent and self-contained.

**Repo:** `github.com/operator1ai/operator1hub` (to be created)

---

## 2. Goals

- Ship a built-in, curated registry that works out of the box
- Provide three content types: **skills**, **agents** (personas), **commands**
- Keep it independent from ClawHub — separate codebase, protocol, and UI
- GitHub-native: content as files, versioning via releases, PRs for curation
- Enable users to browse, install, and uninstall from the operator1 UI and CLI

## 3. Out of Scope

- Community submissions (future — requires review pipeline)
- Paid/premium content
- ClawHub integration or adapter layer
- Self-hosted hub instances
- Auto-update of installed items (user-triggered refresh; UI shows "update available" badge)

---

## 4. Design Decisions

| Decision                | Options Considered                             | Chosen                                     | Reason                                                                                                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Hosting                 | Custom API server / npm registry / GitHub repo | GitHub repo                                | Zero infra cost, PR-based curation, raw content URLs for fetching, familiar workflow                          |
| Registry protocol       | REST API / GraphQL / Static manifest           | Static `registry.json` manifest            | Single fetch to know everything available; no server needed; GitHub CDN handles delivery                      |
| Relationship to ClawHub | Replace / Adapter / Independent                | Independent                                | No dependency on external infra; user can connect either or both                                              |
| Default behavior        | Opt-in / Opt-out / Built-in                    | Built-in                                   | Hub URL baked into operator1 config; works on first launch                                                    |
| Content format          | Custom schema / Reuse SKILL.md / Mixed         | Unified manifest + native formats per type | Skills use SKILL.md, agents use AGENT.md, commands use command .md — manifest indexes all                     |
| Install location        | Global / Per-agent / Per-workspace             | Per-agent (default) with global option     | Matches current skills directory pattern `~/.openclaw/{agentId}/skills/`                                      |
| Agent personas          | Duplicate in hub / Reference local library     | **Reference local `agents/personas/`**     | 147 personas already ship locally with `_index.json` + full RPC support; hub indexes them, not duplicates     |
| Hub URL for dev/testing | Remote-only / Local file path fallback         | **Support `file://` and `http(s)://`**     | Enables development and testing without the GitHub repo being live                                            |
| FK constraints          | Strict FK / Application-level checks           | **No FK on `op1_hub_installed`**           | Catalog gets replaced on `hub.sync`; strict FK breaks if a previously-installed item is removed from registry |

---

## 5. Technical Spec

### 5.1 Hub Repository Structure

```
operator1hub/
├── registry.json                  # manifest — single source of truth
├── skills/
│   ├── code-reviewer/
│   │   ├── SKILL.md               # skill definition (existing format)
│   │   └── README.md              # description for hub UI preview
│   ├── security-audit/
│   │   ├── SKILL.md
│   │   └── README.md
│   └── ...
├── agents/
│   ├── security-engineer.md       # persona definition (AGENT.md format)
│   ├── sre-agent.md
│   ├── architect.md
│   └── ...
├── commands/
│   ├── review-pr.md               # command definition (YAML frontmatter .md)
│   ├── deploy-check.md
│   └── ...
└── collections/
    ├── engineering-essentials.json # bundled sets
    └── devops-starter.json
```

### 5.2 Registry Manifest (`registry.json`)

```jsonc
{
  "version": 1,
  "updated": "2026-03-13T00:00:00Z",
  "items": [
    {
      "slug": "code-reviewer",
      "name": "Code Reviewer",
      "type": "skill", // "skill" | "agent" | "command"
      "category": "engineering",
      "description": "Thorough code review with style, correctness, and security checks",
      "path": "skills/code-reviewer/SKILL.md",
      "version": "1.0.0",
      "tags": ["code-quality", "review", "pr"],
      "emoji": "🔍",
      "sha256": "abc123...", // integrity check
    },
    {
      "slug": "security-engineer",
      "name": "Security Engineer",
      "type": "agent",
      "category": "engineering",
      "description": "OWASP-focused security review persona for subagents",
      "path": "agents/security-engineer.md",
      "version": "1.0.0",
      "tags": ["security", "owasp", "audit"],
      "emoji": "🛡️",
      "sha256": "def456...",
    },
  ],
  "collections": [
    {
      "slug": "engineering-essentials",
      "name": "Engineering Essentials",
      "description": "Core engineering skills and agents bundle",
      "items": ["code-reviewer", "security-engineer", "devops-automator", "architect"],
    },
  ],
}
```

### 5.3 Command File Format

Commands use the same `.md` frontmatter format as `~/.openclaw/commands/*.md`
(parsed by `commands-scanner.ts` on gateway startup). Hub commands are installed
to `~/.openclaw/commands/{slug}.md` and picked up by the existing scanner.

```markdown
---
name: review-pr
description: Review a GitHub PR with security, correctness, and style checks
emoji: "🔍"
category: engineering
user-command: true
model-invocation: true
long-running: true
args:
  - name: pr_url
    description: "GitHub PR URL or number"
    required: true
tags: [code-review, github, pr]
---

Review the GitHub PR at {{pr_url}}.

## Instructions

1. Fetch the PR diff
2. Check for security issues (OWASP top 10)
3. Review code style and correctness
4. Summarize findings with severity levels
```

**Frontmatter fields:**

| Field              | Type     | Required | Description                                           |
| ------------------ | -------- | -------- | ----------------------------------------------------- |
| `name`             | string   | yes      | Slash command name (e.g., `review-pr` → `/review-pr`) |
| `description`      | string   | yes      | One-line summary                                      |
| `emoji`            | string   | no       | Display emoji                                         |
| `category`         | string   | no       | Organizational category                               |
| `user-command`     | boolean  | no       | Can be invoked by user (default: true)                |
| `model-invocation` | boolean  | no       | Can be invoked by the model/agent (default: false)    |
| `long-running`     | boolean  | no       | Expect long execution time (default: false)           |
| `args`             | object[] | no       | Arguments with `name`, `description`, `required`      |
| `tags`             | string[] | no       | Searchable tags                                       |

The markdown body is the command prompt template. Supports `{{arg_name}}`
substitution from declared args.

### 5.4 Persona Deduplication

147 personas already ship locally in `agents/personas/` with `_index.json` and
full RPC support (`personas.list/get/search/categories/expand/apply`). The hub
**does not duplicate these**. Instead:

- Hub `type: "agent"` items in `registry.json` reference the same persona slug
- `hub.install` for agents checks if the persona already exists locally in
  `agents/personas/` — if yes, it creates a symlink or config reference rather
  than downloading a copy
- Hub can ship NEW personas not yet in the local library (e.g., community
  contributions) — these get downloaded to `~/.openclaw/{agentId}/agents/`
- `hub.sync` compares hub agent slugs against the local `_index.json` and marks
  matching ones as `"bundled": true` in the catalog (no install needed)

### 5.5 Operator1 Integration Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       operator1                           │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ hub.sync     │  │ hub.catalog  │  │ hub.install   │  │
│  │ hub.inspect  │  │ hub.search   │  │ hub.remove    │  │
│  │ hub.updates  │  │              │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                  │           │
│         ▼                 ▼                  ▼           │
│  ┌──────────────────────────────────────────────────┐    │
│  │          op1_hub_catalog (SQLite)                │    │
│  │  slug | type | name | version | bundled         │    │
│  ├──────────────────────────────────────────────────┤    │
│  │          op1_hub_installed (SQLite)              │    │
│  │  slug | type | version | install_path           │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Installed content goes to:                              │
│  • skills   → ~/.openclaw/{agentId}/skills/{slug}/       │
│  • agents   → ~/.openclaw/{agentId}/agents/{slug}.md     │
│  • commands → ~/.openclaw/commands/{slug}.md              │
│                                                          │
│  Bundled personas (already local):                       │
│  • agents/personas/{category}/{slug}.md (read-only)      │
└──────────────────────────────────────────────────────────┘
         │
         │ fetch registry.json + raw content
         │ supports file:// for local dev/testing
         ▼
┌──────────────────────────────────────────────────────────┐
│  github.com/operator1ai/operator1hub                     │
│  (static files, GitHub CDN, no server)                   │
└──────────────────────────────────────────────────────────┘
```

### 5.6 RPC Methods

| Method                  | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `hub.sync`              | Fetch `registry.json` from hub URL, upsert into `op1_hub_catalog`, mark bundled personas           |
| `hub.catalog`           | Query cached catalog — filter by type, category, search term                                       |
| `hub.search`            | Full-text search across name, description, tags                                                    |
| `hub.inspect`           | Fetch README/preview for a specific item from hub                                                  |
| `hub.install`           | Download item content to local directory, record in `op1_hub_installed`. For bundled agents: no-op |
| `hub.remove`            | Delete installed item files and remove from `op1_hub_installed`                                    |
| `hub.installed`         | List locally installed hub items with version info                                                 |
| `hub.updates`           | Compare installed versions vs catalog — return items where catalog version > installed version     |
| `hub.collections`       | List available collections                                                                         |
| `hub.installCollection` | Install all items in a collection (skips already-installed, reports results per item)              |

**Integrity verification:** `hub.install` computes SHA-256 of downloaded content
and compares against `sha256` from `registry.json`. Install fails if mismatch.

### 5.7 SQLite Schema

```sql
-- Hub catalog cache (refreshed on hub.sync)
CREATE TABLE IF NOT EXISTS op1_hub_catalog (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('skill', 'agent', 'command')),
  category    TEXT NOT NULL,
  description TEXT,
  path        TEXT NOT NULL,
  version     TEXT NOT NULL,
  tags_json   TEXT DEFAULT '[]',
  emoji       TEXT,
  sha256      TEXT,
  bundled     INTEGER NOT NULL DEFAULT 0,  -- 1 = persona already ships locally
  synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Installed items tracking (no FK — catalog gets replaced on sync)
CREATE TABLE IF NOT EXISTS op1_hub_installed (
  slug          TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  version       TEXT NOT NULL,
  install_path  TEXT NOT NULL,
  agent_id      TEXT,           -- NULL = global (commands)
  installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Collections cache
CREATE TABLE IF NOT EXISTS op1_hub_collections (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  items_json  TEXT NOT NULL     -- JSON array of item slugs
);
```

### 5.8 Default Hub URL Config

```typescript
// src/config/defaults.ts
export const DEFAULT_HUB_URL =
  "https://raw.githubusercontent.com/operator1ai/operator1hub/main/registry.json";
```

Configurable via `operator1 config set hub.url <url>` for custom/private hubs.

**Supported URL schemes:**

- `https://` — production (GitHub raw content CDN)
- `file:///path/to/registry.json` — local dev/testing without the GitHub repo

The `hub.sync` fetcher detects the scheme and uses `fetch()` for HTTP(S) or
`fs.readFile()` for `file://`. Content item paths in `registry.json` are
resolved relative to the manifest location (works for both remote and local).

### 5.9 Initial Curated Content (Launch Set)

**Skills** (adapted from agency-agents + original):
| Slug | Name | Source |
| --- | --- | --- |
| `code-reviewer` | Code Reviewer | agency-agents |
| `security-audit` | Security Audit | agency-agents |
| `db-optimizer` | Database Optimizer | agency-agents |
| `devops-automator` | DevOps Automator | agency-agents |

**Agents** (personas):
| Slug | Name | Source |
| --- | --- | --- |
| `security-engineer` | Security Engineer | agency-agents |
| `sre-agent` | SRE Agent | agency-agents |
| `architect` | Software Architect | agency-agents |
| `technical-writer` | Technical Writer | agency-agents |

**Commands**:
| Slug | Name | Source |
| --- | --- | --- |
| `review-pr` | Review PR | original |
| `deploy-check` | Deploy Checklist | original |

**Collections**:
| Slug | Items |
| --- | --- |
| `engineering-essentials` | code-reviewer, security-audit, security-engineer, architect |
| `devops-starter` | devops-automator, sre-agent, deploy-check |

---

## 6. Implementation Plan

### Task 1: Phase 1 — Hub Repository & Manifest

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 3h

Create the GitHub repo and populate with initial curated content.

- [ ] 1.1 Create `operator1ai/operator1hub` GitHub repo — initialize with README, LICENSE (MIT), and directory structure per §5.1
- [ ] 1.2 Define `registry.json` schema — implement manifest format per §5.2 with JSON schema validation
- [ ] 1.3 Convert 4 seed skills — adapt agency-agents engineering templates to SKILL.md format
- [ ] 1.4 Convert 4 seed agents — adapt agency-agents personas to AGENT.md format
- [ ] 1.5 Write 2 seed commands — create review-pr and deploy-check command definitions
- [ ] 1.6 Create 2 collections — engineering-essentials and devops-starter bundles

### Task 2: Phase 2 — Backend RPCs & SQLite

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 5h

Build the operator1 gateway integration — sync, catalog, install/remove.

- [ ] 2.1 SQLite schema — add `op1_hub_catalog`, `op1_hub_installed`, `op1_hub_collections` tables per §5.7 (add migration to `schema.ts`)
- [ ] 2.2 Hub SQLite adapter — `hub-sqlite.ts` with CRUD ops, test-overridable DB access pattern (mirror `clawhub-sqlite.ts`)
- [ ] 2.3 Hub URL fetcher — support both `https://` and `file://` schemes per §5.8, resolve relative content paths
- [ ] 2.4 `hub.sync` RPC — fetch registry.json, upsert catalog, mark `bundled=1` for personas matching local `_index.json`, cache collections
- [ ] 2.5 `hub.catalog` + `hub.search` RPCs — query cached catalog with type/category/text filters
- [ ] 2.6 `hub.inspect` RPC — fetch item README from hub for preview
- [ ] 2.7 `hub.install` + `hub.remove` RPCs — download content, verify SHA-256 integrity, write to correct local directory, manage installed tracking
- [ ] 2.8 `hub.installed` RPC — list installed items with version info
- [ ] 2.9 `hub.updates` RPC — compare installed versions vs catalog, return items with available updates
- [ ] 2.10 `hub.collections` + `hub.installCollection` RPCs — collection listing and bulk install (skip already-installed, report per-item results)
- [ ] 2.11 Register all hub methods — add to `server-methods.ts`, `server-methods-list.ts`, `method-scopes.ts`
- [ ] 2.12 Default hub URL config — bake in GitHub raw URL, allow override via `config set hub.url`
- [ ] 2.13 Tests — unit tests for hub-sqlite adapter, sync logic, SHA-256 verification, file:// URL support

### Task 3: Phase 3 — UI Hub Page

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 5h

Build the Hub page in ui-next — browse, search, preview, install.

- [ ] 3.1 Hub page route — add `/hub` page to ui-next with sidebar navigation entry
- [ ] 3.2 Catalog browser — grid/list view of available items with type/category filters and search
- [ ] 3.3 Item detail panel — preview with README content, metadata, install/remove button
- [ ] 3.4 "Update available" badges — show version badge on installed items where catalog version > installed version (uses `hub.updates` RPC)
- [ ] 3.5 Bundled indicator — show "bundled" badge on agent personas that ship locally (no install needed)
- [ ] 3.6 Collections view — show bundled sets with "Install All" action
- [ ] 3.7 Installed tab — show currently installed items with version, update/remove actions
- [ ] 3.8 Auto-sync on page load — trigger `hub.sync` if catalog is stale (>24h)

### Task 4: Phase 4 — CLI Integration

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 2h

CLI commands for hub interaction without UI.

- [ ] 4.1 `operator1 hub list` — list available items (filter by type/category)
- [ ] 4.2 `operator1 hub install <slug>` — install an item by slug
- [ ] 4.3 `operator1 hub remove <slug>` — remove an installed item
- [ ] 4.4 `operator1 hub search <query>` — search the catalog

### Task 5: Phase 5 — Hub-Installed Persona Integration

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 3h

Wire hub-installed agent personas (non-bundled) into the existing persona
system. Bundled personas already work via `personas.*` RPCs — this phase covers
NEW personas installed from the hub that don't exist in `agents/personas/`.

- [ ] 5.1 Persona discovery — extend `personas.list/search` to also scan `~/.openclaw/{agentId}/agents/*.md` for hub-installed personas alongside bundled ones
- [ ] 5.2 Unified persona source — add `source: "bundled" | "hub"` field to persona list results so UI can distinguish origin
- [ ] 5.3 Hub persona expansion — ensure `personas.expand` works with hub-installed `.md` files (not just bundled ones)
- [ ] 5.4 Active persona display — show current persona + source in chat header and agent detail page

---

## 7. References

- Hub inspiration: https://github.com/msitarzewski/agency-agents (MIT, persona templates)
- Existing registry pattern: `src/gateway/server-methods/clawhub.ts` (reference — adapt sync/catalog/install patterns)
- Key source files:
  - `src/gateway/server-methods/skills.ts` — existing skills RPCs
  - `src/gateway/server-methods/personas.ts` — existing persona RPCs (list/get/search/categories/expand/apply)
  - `src/infra/state-db/commands-sqlite.ts` — commands storage pattern
  - `src/infra/state-db/commands-scanner.ts` — command `.md` frontmatter parser (defines command file format)
  - `src/infra/state-db/clawhub-sqlite.ts` — catalog caching + lock pattern (adapt for hub-sqlite.ts)
  - `src/infra/state-db/schema.ts` — SQLite migration system (add hub tables here)
  - `src/agents/persona-expansion.ts` — persona expansion engine
  - `src/agents/system-prompt.ts` — persona injection point
  - `agents/personas/_index.json` — local persona manifest (used for bundled detection during hub.sync)
  - `ui-next/src/pages/skills.tsx` — existing skills UI (hub page modeled after)
- Related tasks:
  - `Project-tasks/Done/agent-personas-marketplace.md` (done — 147 personas, unified AGENT.md, RPCs, wizard)
- Dart project: _(filled after first sync)_

---

_Template version: 2.0 — updated 2026-03-15 with persona deduplication, command schema, integrity checks, update detection, file:// support_
