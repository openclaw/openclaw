---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Agent Personas — Blueprint Templates"
description: "Centralized persona template library that drives agent workspace generation during setup"
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high
assignee: "rohit sharma"
tags: [feature, agents, personas, onboarding]
startAt:
dueAt:
dart_project_id: m6xcOfFiqNkF
# ──────────────────────────────────────────────────────────────────────────────
---

# Agent Personas — Blueprint Templates

**Created:** 2026-03-13
**Status:** Planning
**Depends on:** Agent framework (`agents/` directory), Workspace bootstrap system (done)

---

## 1. Overview

Agent personas are **centralized blueprint templates** that determine how an
agent's workspace files get generated during setup. A persona defines the
behavioral role, personality, rules, and workflow for an agent — it is the
seed from which the full agent workspace grows.

When a user creates a new agent (via onboarding wizard, CLI, or UI), they
select a persona from the available library (147 personas: 143 adapted from
[agency-agents](https://github.com/msitarzewski/agency-agents), MIT, plus 4
custom leadership personas). The
persona template then drives generation of all workspace bootstrap files:
`SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, `USER.md`, etc.

**Key principle:** A persona is a **generation-time concept**. Once the agent
is deployed and its workspace files are expanded, the agent operates from
those generated files. The persona is the blueprint; the workspace is the
building.

As part of this work, the agent definition format is unified from two files
(`agent.yaml` + `AGENT.md`) into a **single `AGENT.md`** with YAML frontmatter

- markdown body, preserving the folder-per-agent structure (industry standard:
  Claude Code, Cursor). The 4 core agents (Operator1, Neo, Morpheus, Trinity)
  are rebuilt from persona templates. Remaining agents are built on demand.

Future delivery via Operator1Hub — see `Project-tasks/operator1hub.md`.

---

## 2. Goals

- Unify agent definition into a single `AGENT.md` (YAML frontmatter + markdown body), retiring `agent.yaml`
- Provide 147 ready-made persona blueprints (143 from agency-agents + 4 custom leadership: coo, cto, cmo, cfo)
- Drive agent workspace file generation from persona templates during agent setup
- Integrate persona selection into the agent creation wizard (onboarding, CLI, and UI)
- Rebuild 4 core agents (Operator1, Neo, Morpheus, Trinity) from persona templates in the new unified format
- Centralize persona templates in the repo as a reference library
- Lay groundwork for Operator1Hub delivery — the `_index.json` manifest and persona file format serve as the stable contract that Hub will consume

## 3. Out of Scope

- Mid-session persona switching (persona changes require a new agent run, not a hot-swap during an active session)
- Operator1Hub integration (separate task — `Project-tasks/operator1hub.md`)
- Paid/premium personas
- Community submission pipeline (future — requires Hub + review process)

**Note:** Persona re-assignment (Task 7, `personas.apply`) is in scope — it
regenerates workspace files and updates the agent file, but does not affect
active sessions. Only mid-session switching is out of scope.

---

## 4. Design Decisions

| Decision            | Options Considered                                                              | Chosen                                                        | Reason                                                                                     |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Agent file format   | Two files (`agent.yaml` + `AGENT.md`) / Single `AGENT.md` with YAML frontmatter | **Single `AGENT.md` with YAML frontmatter**                   | Industry standard (Claude Code, Cursor). Folder-per-agent preserved. `agent.yaml` retired. |
| Persona role        | Runtime overlay / Generation-time blueprint                                     | **Generation-time blueprint**                                 | Persona drives workspace file creation; agent operates from generated files.               |
| Persona storage     | Per-agent folders / Centralized in repo                                         | **Centralized in repo** (`agents/personas/`)                  | Single library, reusable across agents. Future Hub syncs from this.                        |
| Persona file format | Raw markdown / YAML-only / YAML frontmatter + markdown body                     | **YAML frontmatter + markdown body**                          | Matches agency-agents format and the new unified agent format.                             |
| Agent creation flow | Manual file editing / Wizard with persona selection                             | **Wizard with persona selection**                             | User picks persona from list; system generates workspace files automatically.              |
| Workspace expansion | Copy persona as-is / Expand into multiple bootstrap files                       | **Expand into multiple bootstrap files**                      | Persona sections map to workspace files (SOUL.md, IDENTITY.md, etc.).                      |
| Persona categories  | Flat list / Categorized by department                                           | **Categorized by department**                                 | Matches agency-agents organization. Easier to browse in wizard and Hub.                    |
| Existing agents     | Keep as-is / Rebuild from personas                                              | **Rebuild 4 core agents** (Operator1, Neo, Morpheus, Trinity) | Core agents demonstrate the pattern. Remaining 30 built on demand.                         |

---

## 5. Technical Spec

### 5.1 Unified Agent File Format

The agent definition is unified into a single `AGENT.md` per agent folder.
YAML frontmatter carries all structural config (previously in `agent.yaml`),
and the markdown body carries behavioral instructions.

**Before (two files):**

```
agents/neo/
├── agent.yaml    # structural config
└── AGENT.md      # behavioral instructions
```

**After (single file, folder preserved):**

```
agents/neo/
└── AGENT.md      # YAML frontmatter (structural) + markdown body (behavioral)
```

**Example — `agents/neo/AGENT.md`:**

```markdown
---
id: neo
name: Neo
persona: cto
tier: 2
role: CTO
department: engineering
description: Chief Technology Officer — routes engineering tasks to specialists
version: 1.0.0
identity:
  emoji: "🔮"
model:
  provider: anthropic
  primary: claude-opus-4-6
  fallbacks:
    - claude-sonnet-4-5
tools:
  allow:
    - read
    - write
    - edit
    - exec
    - browser
capabilities:
  - code_review
  - architecture_decisions
  - technical_planning
  - team_coordination
routing_hints:
  keywords: [backend, api, infrastructure, engineering]
  priority: high
  preferred_for: [architectural_questions, technical_debt]
skills: [coding-agent, github]
limits:
  timeout_seconds: 300
  cost_limit_usd: 0.50
  context_window_tokens: 100000
author:
  name: OpenClaw Team
  url: https://openclaw.ai
keywords: [engineering, cto]
category: department-head
---

# Neo — CTO

You are Neo, the Chief Technology Officer in the Matrix organization.

## Responsibilities

- Route engineering tasks to appropriate specialists
- Make architecture decisions
- Coordinate between Tank (Backend), Dozer (DevOps), and Mouse (QA)
- Report to Operator1 (COO)

## When to Spawn Sub-agents

| Task Type            | Route To |
| -------------------- | -------- |
| Backend/API work     | Tank     |
| Infrastructure/CI/CD | Dozer    |
| Testing/QA           | Mouse    |

## Decision Making

- Prefer established patterns over new ones
- Security > Features > Convenience
- Document architectural decisions
```

Key points:

- `persona` field records which blueprint was used to create this agent
- Frontmatter schema extends `AgentManifestSchema` with `persona` field
- `agent.yaml` is retired — all structural config in YAML frontmatter
- Bundle agents (e.g., `agents/engineering-pack/AGENT.md`) use `is_bundle: true`

### 5.2 Persona File Format

Each persona is a single `.md` file with YAML frontmatter + structured markdown body.
Adapted from the agency-agents format to fit operator1's workspace conventions.

```markdown
---
slug: security-engineer
name: Security Engineer
description: Application security specialist focused on OWASP, dependency auditing, and secrets detection
category: engineering
role: Application Security Engineer
department: engineering
emoji: "🛡️"
color: red
vibe: Direct, evidence-based, cites CWE/CVE IDs. Doesn't sugarcoat findings.
tags: [security, owasp, audit, vulnerabilities, code-review]
version: 1.0.0
author: OpenClaw Team
source: agency-agents/engineering-security-engineer.md
---

# Security Engineer

> Specialized agent persona for security-focused code review and threat analysis.

## Identity

- **Role:** Application Security Engineer
- **Focus:** OWASP Top 10, dependency auditing, secrets detection
- **Communication:** Direct, evidence-based, cites CWE/CVE IDs
- **Vibe:** Doesn't sugarcoat findings. Security first, always.

## Core Mission

You exist to catch vulnerabilities before they ship. Every code change is a
potential attack surface. Review with the assumption that adversaries are
creative and persistent.

## Critical Rules

- Never approve code with unvalidated user input in SQL/shell/eval
- Flag all hardcoded secrets, even in tests
- Require CSP headers on all web responses
- Escalate any auth/authz boundary violations immediately
- Document findings with severity level (Critical/High/Medium/Low/Info)

## Workflow

1. Scan changed files for security anti-patterns
2. Check dependencies against known CVEs (npm audit, Snyk, etc.)
3. Review authentication and authorization boundaries
4. Validate input sanitization and output encoding
5. Report findings with severity + remediation steps

## Deliverables

- Security review summary (pass/fail + findings table)
- Remediation suggestions with code examples
- Dependency vulnerability report when applicable

## Communication Style

- Lead with the finding, not the preamble
- Always include CWE/CVE IDs when referencing known vulnerabilities
- Severity ratings are non-negotiable — don't downplay for politics
- Provide fix code, not just problem descriptions

## Heartbeat Guidance

- Monitor for new CVE disclosures relevant to project dependencies
- Periodic dependency audit reminders
- Track unresolved security findings from previous reviews
```

### 5.3 Persona Frontmatter Schema

| Field          | Type     | Required | Description                                                                                        |
| -------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `slug`         | string   | yes      | Unique identifier, lowercase with hyphens                                                          |
| `name`         | string   | yes      | Display name                                                                                       |
| `description`  | string   | yes      | One-line summary                                                                                   |
| `category`     | string   | yes      | Department/category (e.g., `engineering`, `marketing`)                                             |
| `role`         | string   | yes      | Job role title                                                                                     |
| `department`   | string   | yes      | Organizational department                                                                          |
| `emoji`        | string   | yes      | Signature emoji                                                                                    |
| `color`        | string   | no       | Theme color for UI                                                                                 |
| `vibe`         | string   | no       | One-sentence personality tagline                                                                   |
| `tags`         | string[] | no       | Searchable tags                                                                                    |
| `version`      | string   | no       | Semver version                                                                                     |
| `author`       | string   | no       | Author name                                                                                        |
| `source`       | string   | no       | Original source file reference (agency-agents attribution)                                         |
| `tools`        | string[] | no       | Suggested tool allowlist (flat list; expansion maps to `{ allow: [...] }` in AGENT.md frontmatter) |
| `tier`         | number   | no       | Suggested agent tier (1=core, 2=dept head, 3=specialist)                                           |
| `capabilities` | string[] | no       | Suggested capabilities list                                                                        |

### 5.4 Persona to Workspace Expansion

When a persona is selected during agent creation, its content is expanded into
the agent's workspace bootstrap files:

| Persona Section                                                     | Generated Workspace File | Notes                                                                    |
| ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `## Identity` + frontmatter (`role`, `department`, `emoji`, `vibe`) | `IDENTITY.md`            | Structured identity record                                               |
| `## Core Mission` + `## Critical Rules` + `## Communication Style`  | `SOUL.md`                | Personality, tone, behavioral rules                                      |
| Full persona body (all sections)                                    | `AGENT.md` body          | Complete behavioral instructions                                         |
| `## Heartbeat Guidance`                                             | `HEARTBEAT.md`           | Polling/monitoring guidance (if section present; skipped if absent)      |
| Frontmatter `tags`, `category`, `role`, `department`                | `USER.md`                | Context framing — see example below                                      |
| _(none — from system template)_                                     | `TOOLS.md`               | Copied from `docs/reference/templates/TOOLS.md` (not persona-driven)     |
| _(none — from system template)_                                     | `BOOTSTRAP.md`           | Copied from `docs/reference/templates/BOOTSTRAP.md` (not persona-driven) |
| Frontmatter `tools`, `capabilities`, `tier`                         | `AGENT.md` frontmatter   | Suggested structural values (user can override in wizard)                |

**`USER.md` generated example** (for a Security Engineer persona):

```markdown
# About This Agent

- **Persona:** Security Engineer
- **Department:** Engineering
- **Role:** Application Security Engineer
- **Focus areas:** security, owasp, audit, vulnerabilities, code-review

This agent was created from the `security-engineer` persona template.
Customize this file to add user-specific context, preferences, or project details.
```

**Expansion error handling contract:**

- Missing optional section (e.g., no `## Heartbeat Guidance`): skip that workspace file, log info-level note. Do not generate empty files.
- Missing required section (e.g., no `## Identity`): fail expansion with descriptive error listing the missing section.
- Malformed frontmatter: fail with Zod validation error before any files are written.
- All-or-nothing: if any file generation fails, no files are written (atomic expansion).

```
┌──────────────────────┐
│  Persona Template    │
│  agents/personas/    │
│  security-engineer.md│
└──────────┬───────────┘
           │  agent creation wizard
           │  user selects persona + agent name
           ▼
┌──────────────────────────────────────────────────┐
│  Generated outputs:                              │
│                                                  │
│  agents/{name}/AGENT.md  ← unified agent file    │
│  (frontmatter from persona hints + user          │
│   overrides; body from persona template)         │
│                                                  │
│  ~/.openclaw/{agentId}/workspace/                │
│  ├── SOUL.md       ← mission + rules             │
│  ├── IDENTITY.md   ← role/dept/emoji             │
│  ├── HEARTBEAT.md  ← heartbeat section           │
│  ├── USER.md       ← context framing             │
│  ├── TOOLS.md      ← (from template)             │
│  └── BOOTSTRAP.md  ← (from template)             │
└──────────────────────────────────────────────────┘
```

### 5.5 Centralized Persona Library

```
agents/
├── personas/
│   ├── engineering/           (23 personas)
│   ├── design/                (8 personas)
│   ├── marketing/             (26 personas)
│   ├── testing/               (8 personas)
│   ├── sales/                 (8 personas)
│   ├── product/               (4 personas)
│   ├── project-management/    (6 personas)
│   ├── game-dev/              (18 personas)
│   ├── spatial-computing/     (6 personas)
│   ├── paid-media/            (7 personas)
│   ├── specialized/           (23 personas)
│   ├── support/               (6 personas)
│   ├── leadership/            (4 personas — custom: coo, cto, cmo, cfo)
│   └── _index.json            # generated manifest
├── neo/
│   └── AGENT.md               # unified agent file
├── morpheus/
│   └── AGENT.md
├── trinity/
│   └── AGENT.md
├── operator1/
│   └── AGENT.md
└── ...
```

### 5.6 Persona Index Manifest (`_index.json`)

Generated manifest listing all available personas for the wizard/UI.

**Regeneration triggers:**

- `pnpm personas:index` script (added in Task 2.6) — parses all `agents/personas/**/*.md` frontmatter and writes `_index.json`
- Pre-commit hook: if any `agents/personas/**/*.md` file is staged, auto-run `pnpm personas:index` and stage the updated `_index.json`
- CI check: `vitest` test validates that `_index.json` is up-to-date with persona files on disk (fails if stale)

```jsonc
{
  "version": 1,
  "generated": "2026-03-14T00:00:00Z",
  "personas": [
    {
      "slug": "security-engineer",
      "name": "Security Engineer",
      "description": "Application security specialist...",
      "category": "engineering",
      "emoji": "🛡️",
      "tags": ["security", "owasp", "audit"],
      "path": "engineering/security-engineer.md",
    },
    // ... 147 entries (143 agency-agents + 4 leadership)
  ],
  "categories": [
    { "slug": "engineering", "name": "Engineering", "count": 23 },
    { "slug": "design", "name": "Design", "count": 8 },
    { "slug": "marketing", "name": "Marketing", "count": 26 },
    { "slug": "testing", "name": "Testing", "count": 8 },
    { "slug": "sales", "name": "Sales", "count": 8 },
    { "slug": "product", "name": "Product", "count": 4 },
    { "slug": "project-management", "name": "Project Management", "count": 6 },
    { "slug": "game-dev", "name": "Game Development", "count": 18 },
    { "slug": "spatial-computing", "name": "Spatial Computing", "count": 6 },
    { "slug": "paid-media", "name": "Paid Media", "count": 7 },
    { "slug": "specialized", "name": "Specialized", "count": 23 },
    { "slug": "support", "name": "Support", "count": 6 },
  ],
}
```

### 5.7 Agent Creation Wizard

**CLI flow:**

```
$ operator1 agent create

  Agent name: Shield
  Select a persona:
  ▸ Engineering (23)
    Design (8)
    Marketing (26)
    ...

  Engineering personas:
  ▸ 🛡️ Security Engineer — Application security specialist
    🏗️ Backend Architect — Backend systems and API design
    🔍 Code Reviewer — PR review, code quality
    ...

  Selected: Security Engineer
  Generating workspace files...
  ✓ AGENT.md  ✓ SOUL.md  ✓ IDENTITY.md  ✓ HEARTBEAT.md  ✓ USER.md
  Agent "Shield" created with persona "Security Engineer"
```

**UI flow:** Agent creation dialog with persona grid/list grouped by category,
preview panel, and "Create Agent" button.

### 5.8 RPC Methods

| Method                | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `personas.list`       | List available persona templates, optionally filtered by category/tags |
| `personas.get`        | Get full content of a specific persona template by slug                |
| `personas.categories` | List available categories with counts                                  |
| `personas.search`     | Search personas by name, description, tags                             |
| `personas.expand`     | Preview generated workspace files + agent file before committing       |

### 5.9 Persona Validation Schema (Zod)

```typescript
const PersonaFrontmatterSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    role: z.string().min(1),
    department: z.string().min(1),
    emoji: z.string().min(1),
    color: z.string().optional(),
    vibe: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    source: z.string().optional(),
    tools: z.array(z.string()).optional(), // flat list; mapped to { allow: [...] } in AGENT.md frontmatter during expansion
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .strict();
```

### 5.10 Migration Impact

| Component         | Before                    | After                                                         |
| ----------------- | ------------------------- | ------------------------------------------------------------- |
| Agent file format | `agent.yaml` + `AGENT.md` | Single `AGENT.md` (frontmatter + body). `agent.yaml` retired. |
| Agent creation    | Manual file writing       | Wizard with persona selection                                 |
| `SOUL.md`         | Mostly empty / generic    | Generated from persona Core Mission + Rules                   |
| `IDENTITY.md`     | Hand-written              | Generated from persona Identity + frontmatter                 |
| `HEARTBEAT.md`    | Generic template          | Generated from persona Heartbeat Guidance                     |
| Agent loader      | Reads two files           | Parses single `AGENT.md`                                      |
| Core agents       | Two-file format           | 4 rebuilt from personas; 30 cleaned up, on-demand             |

What stays the same: workspace bootstrap pipeline, system prompt injection,
subagent spawning, tier system, bundle system, all structural config fields.

**Migration transition behavior:**

- If both `AGENT.md` (with frontmatter) and `agent.yaml` exist in the same
  folder, the loader prefers `AGENT.md` frontmatter and ignores `agent.yaml`.
- If only `agent.yaml` exists (legacy), the loader reads it as before
  (backward compatible).
- Partially migrated agents (e.g., `AGENT.md` with no frontmatter +
  `agent.yaml`) use `agent.yaml` for structural config and `AGENT.md` body
  for behavioral instructions (original two-file behavior).
- The `agents/_archive/` directory is excluded from agent loading entirely
  (`EXCLUDED_DIRS` in `server-startup-agent-sync.ts`).

**Schema relationship post-migration:**

- `AgentManifestSchema` (`zod-schema.agent-manifest.ts`) validates the YAML
  frontmatter in `AGENT.md` — this is the on-disk source of truth.
- `AgentEntrySchema` (`zod-schema.agent-runtime.ts`) validates the runtime
  config entries in `agents.list` — these are reconciled from manifests on
  gateway startup by `agent-config-sync.ts`. Manifests are authoritative;
  runtime entries are derived.

### 5.11 Template Variable Support

Supported variables in persona expansion (markdown body only, not frontmatter):

| Variable         | Value                               |
| ---------------- | ----------------------------------- |
| `{{agent_name}}` | Display name of the agent           |
| `{{agent_id}}`   | Agent ID (lowercase, used in paths) |
| `{{role}}`       | Role from persona frontmatter       |
| `{{department}}` | Department from persona frontmatter |
| `{{emoji}}`      | Emoji from persona frontmatter      |

**Unknown variables:** left as-is (not expanded, no error). This allows
workspace files to contain other template syntaxes without interference.

**Missing variables:** if a declared variable has no value (e.g., `{{role}}`
but persona has no `role` field), it is replaced with an empty string.

### 5.12 Persona Catalog (Full List)

See appendix at end of document.

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` checkbox = one Dart Subtask (child of its Task)
> - `**Status:**` on line 1 of each task syncs with Dart status field
> - Task titles and subtask text must match Dart exactly (used for sync matching)
> - `dart_project_id` in frontmatter is filled after first sync
> - **Dates:** `dueAt` and per-task `**Due:**` dates must be confirmed with the user before syncing to Dart — never auto-generate from estimates
> - **Estimates:** use hours (`**Est:** Xh`), not days — AI-assisted implementation is much faster than manual dev
> - **Subtasks:** every `- [ ]` item must include a brief inline description after `—` so it is self-contained when read in Dart without the MD file
>
> **Parallelism note:** Tasks 1 and 2 are independent and can run in parallel (~4h saved).

### Task 1: Phase 1 — Unified Agent File Format

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 4h

Migrate agent definition from two files to single `AGENT.md` with YAML
frontmatter. See §5.1.

- [ ] 1.1 Define unified agent schema — extend `AgentManifestSchema` to support YAML frontmatter parsing, add `persona` field
- [ ] 1.2 Unified agent file parser — load agent definition from `AGENT.md`, extract frontmatter as structural config and body as behavioral instructions
- [ ] 1.3 Update agent loader — modify `resolveAgentConfig()` to read from unified `agents/{name}/AGENT.md` instead of two-file format
- [ ] 1.4 Update `AgentEntrySchema` — add `persona?: string` field to runtime config
- [ ] 1.5 Update `agents.list` RPC — ensure it reads the new unified format
- [ ] 1.6 Tests — unit tests for unified file parsing and backward compat validation

### Task 2: Phase 2 — Persona Format & Template Conversion

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 6h

Define persona file format and convert agency-agents templates. See §5.2, §5.3.

- [ ] 2.1 Define persona `.md` format — finalize YAML frontmatter schema + markdown body section conventions per §5.2
- [ ] 2.2 Create `PersonaFrontmatterSchema` — Zod validation schema per §5.9
- [ ] 2.3 Create `agents/personas/` directory structure — organized by category per §5.5
- [ ] 2.4 Convert priority personas (engineering, 23) — adapt from agency-agents with all required sections
- [ ] 2.5 Convert remaining categories (~97 more) — design, marketing, testing, sales, product, project-management, game-dev, spatial-computing, paid-media, specialized, support
- [ ] 2.6 Generate `_index.json` manifest — script to parse all persona frontmatter and produce the index per §5.6
- [ ] 2.7 Validate all personas — run Zod schema validation across all 147 persona files (143 agency-agents + 4 leadership)
- [ ] 2.8 CI persona validation — add vitest test that runs Zod validator against all `agents/personas/**/*.md` files, checks `_index.json` is up-to-date, and validates that per-category `count` fields match actual file counts on disk

### Task 3: Phase 3 — Workspace Expansion Engine

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 4h

Build the system that expands a persona into a unified agent file + workspace.
See §5.4.

- [ ] 3.1 Persona parser — parse YAML frontmatter + extract markdown sections from a persona `.md` file
- [ ] 3.2 Section-to-file mapper — implement persona-to-workspace-file mapping per §5.4 (Identity -> IDENTITY.md, Core Mission + Rules -> SOUL.md, etc.)
- [ ] 3.3 Unified agent file generator — given persona + agent name + user overrides, produce `agents/{name}/AGENT.md`
- [ ] 3.4 `personas.expand` function — given persona slug + agent name, generate all workspace bootstrap files + unified agent file
- [ ] 3.5 Template variable support — support `{{agent_name}}`, `{{role}}`, `{{department}}` substitution in generated files
- [ ] 3.6 Tests — unit tests for parser, mapper, and expansion with snapshot tests for generated outputs

### Task 4: Phase 4 — Rebuild Core 4 Agents

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 2h

Rebuild Operator1, Neo, Morpheus, Trinity from persona templates. See §5.10.

- [ ] 4.1 Map core agents to personas — Operator1 -> `coo`, Neo -> `cto`, Morpheus -> `cmo`, Trinity -> `cfo`
- [ ] 4.2 Create operator1-specific personas — custom `coo`, `cto`, `cmo`, `cfo` persona templates under `agents/personas/leadership/` (Matrix org, not from agency-agents)
- [ ] 4.3 Generate unified agent files — run expansion engine to produce `agents/{name}/AGENT.md` for all 4 core agents
- [ ] 4.4 Generate workspace files — expand persona templates into workspace bootstrap files for each core agent
- [ ] 4.5 Remove old `agent.yaml` files — delete from the 4 core agent folders
- [ ] 4.6 Archive remaining agent folders — export the other 30 agent folders to `agents/_archive/` (preserving any hand-written customizations) before removing old files from active directories
- [ ] 4.7 Validate — ensure all 4 core agents load correctly from new format, run agent tests

### Task 5: Phase 5 — RPC Methods & Persona Library API

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 3h

Expose persona library to gateway for wizard/UI consumption. See §5.8.

- [ ] 5.1 `personas.list` RPC — list available persona templates with optional category/tag filters
- [ ] 5.2 `personas.get` RPC — return full persona content by slug
- [ ] 5.3 `personas.categories` RPC — list categories with counts
- [ ] 5.4 `personas.search` RPC — full-text search across name, description, tags
- [ ] 5.5 `personas.expand` RPC — thin wrapper over the core expansion engine from Task 3.4; returns preview of generated files without writing to disk
- [ ] 5.6 Register methods — add to `server-methods.ts`, `server-methods-list.ts`, `method-scopes.ts`

### Task 6: Phase 6 — Agent Creation Wizard Integration

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 5h

Wire persona selection into agent creation flow. See §5.7.

- [ ] 6.1 CLI wizard — extend `operator1 agent create` with persona selection (category browse -> persona pick -> name -> create)
- [ ] 6.2 UI agent creation dialog — persona grid/list grouped by category, preview panel, create button
- [ ] 6.3 Agent creation backend — use `personas.expand` for preview, then `personas.apply` (or direct `writeExpansionResult()`) to write unified agent file + workspace files to disk
- [ ] 6.4 Onboarding integration — include persona selection step in fresh install onboarding; pre-select a general-purpose persona (e.g., `senior-developer` from engineering) for the default agent, with option to skip or change
- [ ] 6.5 High-privilege tool warning — when a persona's `tools` includes `exec` or `browser`, surface a confirmation prompt in the wizard before proceeding
- [ ] 6.6 "No persona" option — allow creating agents without a persona (uses generic templates as today)
- [ ] 6.7 Record persona origin — store persona slug in agent file frontmatter (`persona: slug`)

### Task 7: Phase 7 — Persona Re-assignment (Stretch)

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** TBD | **Est:** 2h

Allow changing an existing agent's persona. Regenerates workspace files + agent
file body.

- [ ] 7.1 `personas.apply` RPC — apply a different persona to an existing agent, regenerating files (with confirmation/backup)
- [ ] 7.2 CLI command — `operator1 agent set-persona <agent-id> <persona-slug>`
- [ ] 7.3 UI integration — persona selector in agent settings page
- [ ] 7.4 Workspace backup — before re-expansion, snapshot existing workspace files to `~/.openclaw/{agentId}/workspace.bak/{ISO-timestamp}/` so user edits aren't lost; keep last 3 snapshots

---

## 7. References

- Source repo: https://github.com/msitarzewski/agency-agents (MIT, 143 personas across 12 categories + 1 custom leadership category)
- Key source files:
  - `agents/` — current agent definitions (migrating to unified `AGENT.md`)
  - `docs/reference/templates/matrix/` — current matrix agent templates (reference only)
  - `src/agents/workspace.ts` — workspace bootstrap file management
  - `src/agents/bootstrap-files.ts` — bootstrap file resolution and loading
  - `src/agents/system-prompt.ts` — system prompt builder (SOUL.md injection)
  - `src/agents/agent-scope.ts` — agent config resolution (needs update for unified format)
  - `src/config/zod-schema.agent-manifest.ts` — agent manifest validation (needs `persona` field)
  - `src/config/zod-schema.agent-runtime.ts` — agent runtime config (`AgentEntrySchema`)
  - `src/gateway/server-methods/agents.ts` — agent RPCs (needs update)
- Related tasks:
  - `Project-tasks/operator1hub.md` — Hub delivery (future, personas browsable from Hub)
- Dart project: _(filled after first sync)_

---

## Appendix A: Persona Catalog (Full List from agency-agents)

### Engineering (23 personas)

| Slug                                | Name                              |
| ----------------------------------- | --------------------------------- |
| `ai-data-remediation-engineer`      | AI Data Remediation Engineer      |
| `ai-engineer`                       | AI Engineer                       |
| `autonomous-optimization-architect` | Autonomous Optimization Architect |
| `backend-architect`                 | Backend Architect                 |
| `code-reviewer`                     | Code Reviewer                     |
| `data-engineer`                     | Data Engineer                     |
| `database-optimizer`                | Database Optimizer                |
| `devops-automator`                  | DevOps Automator                  |
| `embedded-firmware-engineer`        | Embedded Firmware Engineer        |
| `frontend-developer`                | Frontend Developer                |
| `git-workflow-master`               | Git Workflow Master               |
| `incident-response-commander`       | Incident Response Commander       |
| `mobile-app-builder`                | Mobile App Builder                |
| `rapid-prototyper`                  | Rapid Prototyper                  |
| `security-engineer`                 | Security Engineer                 |
| `senior-developer`                  | Senior Developer                  |
| `software-architect`                | Software Architect                |
| `solidity-smart-contract-engineer`  | Solidity Smart Contract Engineer  |
| `sre`                               | SRE (Site Reliability Engineer)   |
| `technical-writer`                  | Technical Writer                  |
| `threat-detection-engineer`         | Threat Detection Engineer         |
| `feishu-integration-developer`      | Feishu Integration Developer      |
| `wechat-mini-program-developer`     | WeChat Mini Program Developer     |

### Design (8 personas)

| Slug                           | Name                         |
| ------------------------------ | ---------------------------- |
| `brand-guardian`               | Brand Guardian               |
| `image-prompt-engineer`        | Image Prompt Engineer        |
| `inclusive-visuals-specialist` | Inclusive Visuals Specialist |
| `ui-designer`                  | UI Designer                  |
| `ux-architect`                 | UX Architect                 |
| `ux-researcher`                | UX Researcher                |
| `visual-storyteller`           | Visual Storyteller           |
| `whimsy-injector`              | Whimsy Injector              |

### Marketing (26 personas)

| Slug                          | Name                        |
| ----------------------------- | --------------------------- |
| `app-store-optimizer`         | App Store Optimizer         |
| `book-co-author`              | Book Co-Author              |
| `carousel-growth-engine`      | Carousel Growth Engine      |
| `content-creator`             | Content Creator             |
| `growth-hacker`               | Growth Hacker               |
| `instagram-curator`           | Instagram Curator           |
| `linkedin-content-creator`    | LinkedIn Content Creator    |
| `podcast-strategist`          | Podcast Strategist          |
| `reddit-community-builder`    | Reddit Community Builder    |
| `seo-specialist`              | SEO Specialist              |
| `short-video-editing-coach`   | Short Video Editing Coach   |
| `social-media-strategist`     | Social Media Strategist     |
| `tiktok-strategist`           | TikTok Strategist           |
| `twitter-engager`             | Twitter Engager             |
| `baidu-seo-specialist`        | Baidu SEO Specialist        |
| `bilibili-content-strategist` | Bilibili Content Strategist |
| `china-e-commerce-operator`   | China E-Commerce Operator   |
| `cross-border-e-commerce`     | Cross-Border E-Commerce     |
| `douyin-strategist`           | Douyin Strategist           |
| `kuaishou-strategist`         | Kuaishou Strategist         |
| `livestream-commerce-coach`   | Livestream Commerce Coach   |
| `private-domain-operator`     | Private Domain Operator     |
| `wechat-official-account`     | WeChat Official Account     |
| `weibo-strategist`            | Weibo Strategist            |
| `xiaohongshu-specialist`      | Xiaohongshu Specialist      |
| `zhihu-strategist`            | Zhihu Strategist            |

### Testing (8 personas)

| Slug                      | Name                    |
| ------------------------- | ----------------------- |
| `accessibility-auditor`   | Accessibility Auditor   |
| `api-tester`              | API Tester              |
| `evidence-collector`      | Evidence Collector      |
| `performance-benchmarker` | Performance Benchmarker |
| `reality-checker`         | Reality Checker         |
| `test-results-analyzer`   | Test Results Analyzer   |
| `tool-evaluator`          | Tool Evaluator          |
| `workflow-optimizer`      | Workflow Optimizer      |

### Sales (8 personas)

| Slug                  | Name                |
| --------------------- | ------------------- |
| `account-strategist`  | Account Strategist  |
| `deal-strategist`     | Deal Strategist     |
| `discovery-coach`     | Discovery Coach     |
| `outbound-strategist` | Outbound Strategist |
| `pipeline-analyst`    | Pipeline Analyst    |
| `proposal-strategist` | Proposal Strategist |
| `sales-coach`         | Sales Coach         |
| `sales-engineer`      | Sales Engineer      |

### Product (4 personas)

| Slug                      | Name                    |
| ------------------------- | ----------------------- |
| `behavioral-nudge-engine` | Behavioral Nudge Engine |
| `feedback-synthesizer`    | Feedback Synthesizer    |
| `sprint-prioritizer`      | Sprint Prioritizer      |
| `trend-researcher`        | Trend Researcher        |

### Project Management (6 personas)

| Slug                     | Name                   |
| ------------------------ | ---------------------- |
| `experiment-tracker`     | Experiment Tracker     |
| `jira-workflow-steward`  | Jira Workflow Steward  |
| `project-shepherd`       | Project Shepherd       |
| `senior-project-manager` | Senior Project Manager |
| `studio-operations`      | Studio Operations      |
| `studio-producer`        | Studio Producer        |

### Game Development (18 personas)

| Slug                           | Name                         |
| ------------------------------ | ---------------------------- |
| `game-audio-engineer`          | Game Audio Engineer          |
| `game-designer`                | Game Designer                |
| `level-designer`               | Level Designer               |
| `narrative-designer`           | Narrative Designer           |
| `technical-artist`             | Technical Artist             |
| `blender-addon-engineer`       | Blender Addon Engineer       |
| `godot-gameplay-scripter`      | Godot Gameplay Scripter      |
| `godot-multiplayer-engineer`   | Godot Multiplayer Engineer   |
| `godot-shader-developer`       | Godot Shader Developer       |
| `roblox-avatar-creator`        | Roblox Avatar Creator        |
| `roblox-experience-designer`   | Roblox Experience Designer   |
| `roblox-systems-scripter`      | Roblox Systems Scripter      |
| `unity-architect`              | Unity Architect              |
| `unity-editor-tool-developer`  | Unity Editor Tool Developer  |
| `unity-multiplayer-engineer`   | Unity Multiplayer Engineer   |
| `unity-shader-graph-artist`    | Unity Shader Graph Artist    |
| `unreal-multiplayer-architect` | Unreal Multiplayer Architect |
| `unreal-systems-engineer`      | Unreal Systems Engineer      |

### Spatial Computing (6 personas)

| Slug                                | Name                              |
| ----------------------------------- | --------------------------------- |
| `macos-spatial-metal-engineer`      | macOS Spatial Metal Engineer      |
| `terminal-integration-specialist`   | Terminal Integration Specialist   |
| `visionos-spatial-engineer`         | VisionOS Spatial Engineer         |
| `xr-cockpit-interaction-specialist` | XR Cockpit Interaction Specialist |
| `xr-immersive-developer`            | XR Immersive Developer            |
| `xr-interface-architect`            | XR Interface Architect            |

### Paid Media (7 personas)

| Slug                     | Name                   |
| ------------------------ | ---------------------- |
| `creative-strategist`    | Creative Strategist    |
| `paid-media-auditor`     | Paid Media Auditor     |
| `paid-social-strategist` | Paid Social Strategist |
| `ppc-strategist`         | PPC Strategist         |
| `programmatic-buyer`     | Programmatic Buyer     |
| `search-query-analyst`   | Search Query Analyst   |
| `tracking-specialist`    | Tracking Specialist    |

### Specialized (23 personas)

| Slug                               | Name                                   |
| ---------------------------------- | -------------------------------------- |
| `accounts-payable-agent`           | Accounts Payable Agent                 |
| `agentic-identity-trust`           | Agentic Identity & Trust               |
| `agents-orchestrator`              | Agents Orchestrator                    |
| `automation-governance-architect`  | Automation Governance Architect        |
| `blockchain-security-auditor`      | Blockchain Security Auditor            |
| `compliance-auditor`               | Compliance Auditor                     |
| `corporate-training-designer`      | Corporate Training Designer            |
| `cultural-intelligence-strategist` | Cultural Intelligence Strategist       |
| `data-consolidation-agent`         | Data Consolidation Agent               |
| `developer-advocate`               | Developer Advocate                     |
| `document-generator`               | Document Generator                     |
| `government-digital-presales`      | Government Digital Presales Consultant |
| `healthcare-marketing-compliance`  | Healthcare Marketing Compliance        |
| `identity-graph-operator`          | Identity Graph Operator                |
| `lsp-index-engineer`               | LSP Index Engineer                     |
| `mcp-builder`                      | MCP Builder                            |
| `model-qa`                         | Model QA                               |
| `recruitment-specialist`           | Recruitment Specialist                 |
| `report-distribution-agent`        | Report Distribution Agent              |
| `sales-data-extraction-agent`      | Sales Data Extraction Agent            |
| `study-abroad-advisor`             | Study Abroad Advisor                   |
| `supply-chain-strategist`          | Supply Chain Strategist                |
| `zk-steward`                       | ZK Steward                             |

### Support (6 personas)

| Slug                          | Name                        |
| ----------------------------- | --------------------------- |
| `analytics-reporter`          | Analytics Reporter          |
| `executive-summary-generator` | Executive Summary Generator |
| `finance-tracker`             | Finance Tracker             |
| `infrastructure-maintainer`   | Infrastructure Maintainer   |
| `legal-compliance-checker`    | Legal Compliance Checker    |
| `support-responder`           | Support Responder           |

### Leadership (4 personas — custom, not from agency-agents)

| Slug  | Name                     |
| ----- | ------------------------ |
| `coo` | Chief Operating Officer  |
| `cto` | Chief Technology Officer |
| `cmo` | Chief Marketing Officer  |
| `cfo` | Chief Financial Officer  |

---

_Template version: 2.1 — updated 2026-03-15: fixed persona count (147), clarified scope on re-assignment, added migration transition behavior, template variables, schema relationship, CI count validation, Leadership appendix_
