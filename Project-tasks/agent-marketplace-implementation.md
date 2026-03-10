# Agent Marketplace Implementation

> Agent marketplace for Operator1 — discover, install, and configure agents from a centralized registry with tier enforcement and multi-scope installation.

**Status:** Phases 1-5 Complete
**Created:** 2026-03-09
**Updated:** 2026-03-10
**Priority:** Core Feature

---

## Overview

The Agent Marketplace enables users to discover, install, and configure Matrix agents (department heads and specialists) from a centralized registry. Instead of a fixed agent hierarchy, users customize their agent setup during or after installation.

### Current State

- Fixed 3-tier agent system hardcoded in config
- All agents (Neo, Trinity, Morpheus, specialists) pre-defined
- No customization or discovery mechanism

### Target State

- Minimal default setup (Operator1/COO only)
- Marketplace for browsing and installing agents
- Tier-enforced schema validation at install AND runtime
- User-level and project-level installation scopes
- CLI + web UI discovery
- Version lock file for reproducibility

---

## Core Decisions

| Decision             | Resolution                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| **Tier enforcement** | Schema validation at install + Agent Registry Service at runtime              |
| **Default bundle**   | Current Matrix system (Neo/Trinity/Morpheus + specialists) as default package |
| **Discovery UI**     | CLI + web UI (similar to ClawHub skills marketplace)                          |
| **First-run wizard** | Keep minimal for now — complexity added post-installation                     |
| **Version locking**  | `agents-lock.yaml` for exact version pinning                                  |

---

## Architecture

### Agent Hierarchy

```
Agent Marketplace
├── Core Agent (bundled, always available)
│   └── Operator1 (COO) — the orchestrator, cannot be removed
│
├── Tier 2 — Department Heads (installable)
│   ├── Neo (CTO) — Engineering department
│   ├── Trinity (CFO) — Finance department
│   └── Morpheus (CMO) — Marketing department
│
├── Tier 3 — Specialists (installable, requires parent Tier 2)
│   ├── Engineering (Neo's team)
│   │   ├── Tank (Backend)
│   │   ├── Dozer (DevOps)
│   │   └── Mouse (QA/Testing)
│   │
│   ├── Finance (Trinity's team)
│   │   ├── Oracle (Analytics)
│   │   ├── Seraph (Compliance)
│   │   └── Zee (Operations)
│   │
│   └── Marketing (Morpheus's team)
│       ├── Niobe (Content)
│       ├── Switch (Social)
│       └── Rex (Design)
│
└── Community Agents (future)
    └── Custom templates published by community
```

### Tier Enforcement Rules

| Tier   | Dependency    | Validation                                    |
| ------ | ------------- | --------------------------------------------- |
| Core   | None          | Always present, cannot be removed             |
| Tier 2 | None          | Can be installed independently                |
| Tier 3 | Parent Tier 2 | Cannot install without parent department head |

**Validation happens at two levels:**

1. **Install time** — CLI schema validation prevents invalid installs
2. **Runtime** — Agent Registry Service validates dependencies on gateway startup

**Example:**

- ✅ Install Neo (Tier 2) → Works
- ✅ Install Tank (Tier 3) after Neo → Works
- ❌ Install Tank (Tier 3) without Neo → Schema validation error
- ❌ Remove Neo while Tank installed → Blocked (use `--cascade` to force)

---

## Agent Definition Format

### File Structure

```
agents/
├── neo/
│   ├── AGENT.md          # Agent instructions (markdown)
│   ├── agent.yaml        # Metadata and config
│   └── migrations/       # Version migration scripts (optional)
│       └── v0.9-to-v1.0.sh
├── tank/
│   ├── AGENT.md
│   ├── agent.yaml
│   └── tests/            # Agent routing tests (optional)
│       └── test_routing.yaml
└── ...
```

### agent.yaml Schema (Enhanced)

```yaml
# ===========================================
# Required fields
# ===========================================
id: neo
name: Neo
tier: 2
role: CTO
department: engineering
description: Chief Technology Officer — routes engineering tasks to specialists

# Dependencies (for Tier 3 agents)
requires: null # Tier 2 has no dependencies
# For Tier 3 specialists:
# requires: neo

# ===========================================
# Versioning
# ===========================================
version: 1.0.0

# Migration support (optional)
migrators:
  - from_version: "0.9.0"
    to_version: "1.0.0"
    script: ./migrations/v0.9-to-v1.0.sh

# ===========================================
# Model configuration
# ===========================================
model:
  provider: anthropic
  primary: claude-opus-4-6
  fallbacks:
    - claude-sonnet-4-5

# ===========================================
# Tool permissions
# ===========================================
tools:
  allow:
    - read
    - write
    - edit
    - exec
    - browser
  deny: []

# ===========================================
# Capabilities (NEW — helps COO route tasks)
# ===========================================
capabilities:
  - code_review
  - architecture_decisions
  - technical_planning
  - team_coordination

# Routing hints for Operator1 (COO)
routing_hints:
  keywords:
    - backend
    - api
    - database
    - infrastructure
    - code
    - engineering
  priority: high # high | normal | low
  preferred_for:
    - architectural_questions
    - technical_debt
    - code_quality

# ===========================================
# Skills to preload (optional)
# ===========================================
skills:
  - coding-agent
  - github

# ===========================================
# Sub-agents (derived — do not set manually)
# ===========================================
# subagents is NOT a schema field. At registry build time the registry
# derives the list of specialists for each Tier 2 agent by scanning all
# installed agents and collecting those whose `requires` points to this
# agent. Setting it manually creates two sources of truth.
# Use `requires` in specialist agents instead.

# ===========================================
# Execution limits (optional)
# ===========================================
limits:
  timeout_seconds: 300 # Max wall-clock time per invocation
  cost_limit_usd: 0.50 # Hard cost cap; terminates task if exceeded
  context_window_tokens: 100000 # Max tokens before summarisation/truncation
  retry_policy:
    max_retries: 2
    backoff: exponential # linear | exponential | none

# ===========================================
# Deprecation (optional — for sunset flow)
# ===========================================
# deprecated: true
# sunset_date: "2026-06-01"
# migration_guide: "https://docs.openclaw.ai/agents/neo-migration"
# replacement: "neo-v2"

# ===========================================
# Inheritance (optional — for extending agents)
# ===========================================
# extends: base-engineering-agent
# overrides:
#   model:
#     primary: claude-sonnet-4-5

# ===========================================
# Author metadata
# ===========================================
author:
  name: OpenClaw Team
  url: https://openclaw.ai

# ===========================================
# Marketplace metadata
# ===========================================
keywords:
  - engineering
  - backend
  - devops
  - cto
category: department-head

# Bundle support (for meta-packages)
# is_bundle: true
# bundle_agents:
#   - neo
#   - tank
#   - dozer
#   - mouse
```

### AGENT.md Format

`AGENT.md` is **prompt content only** — no frontmatter. All structured metadata lives in `agent.yaml`, which is the single source of truth. Frontmatter in `AGENT.md` creates duplication and ambiguity about which file wins; the schema validator will reject `AGENT.md` files that contain YAML frontmatter.

```markdown
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

---

## Version Lock File

### agents-lock.yaml

Ensures reproducible agent installations across environments.

```yaml
# Generated by openclaw agents install
# Do not edit manually

lockfile_version: 1

agents:
  neo:
    version: 1.0.0
    resolved: https://github.com/openclaw/agents/archive/neo-1.0.0.tar.gz
    checksum: sha256:abc123...
    installed_at: 2026-03-09T10:00:00Z
    scope: project

  tank:
    version: 1.0.0
    resolved: https://github.com/openclaw/agents/archive/tank-1.0.0.tar.gz
    checksum: sha256:def456...
    installed_at: 2026-03-09T10:01:00Z
    scope: project
    requires: neo@1.0.0

registry:
  url: https://github.com/openclaw/agents
  synced_at: 2026-03-09T09:55:00Z
  commit: a1b2c3d...
```

### CLI Integration

```bash
# Automatically creates/updates lock file
openclaw agents install neo

# Install from lock file (ci mode)
openclaw agents install --frozen

# Regenerate lock file
openclaw agents lock --regenerate
```

---

## Agent Registry Service

### Purpose

Validates agent dependencies at runtime (gateway startup), not just at install time.

### Responsibilities

1. **Dependency validation** — Ensure all Tier 3 agents have their Tier 2 parent
2. **Version compatibility** — Check version constraints between agents
3. **Health checks** — Verify agent configs are valid and model is reachable
4. **Capability registry** — Expose agent capabilities for COO routing

### Gateway Startup Flow

```
Gateway starts
    ↓
Agent Registry Service loads all installed agents
    ↓
Validate tier dependencies
    ↓ (invalid agents → DISABLED, warning logged; gateway continues)
Validate version compatibility
    ↓ (conflicting agents → DISABLED, warning logged; gateway continues)
Load valid agents into routing table
    ↓
Gateway ready (degraded mode if any agents disabled)
    ↓
openclaw agents health --all shows which agents are disabled and why
```

**Degraded mode:** a single misconfigured or missing-dependency agent must never crash the gateway. Invalid agents are disabled and logged as warnings; Operator1 remains available and reports the degraded state on next interaction. This is a hard requirement — the current hardcoded setup never fails to start, and the marketplace must not regress that reliability.

### Routing Algorithm

**Decision: keyword matching first (settled 2026-03-10).** Embeddings deferred as opt-in Phase 2+ enhancement. The algorithm uses both `capabilities` and `routing_hints.keywords` with clear precedence:

**Proposed algorithm (to be confirmed):**

1. Operator1 receives a task.
2. Score each available Tier 2 agent: keyword overlap between task tokens and `routing_hints.keywords` is the primary signal. `capabilities` are a secondary semantic match.
3. Apply `priority` as a tiebreaker only (high/normal/low), not as a blanket override.
4. If top score is below a confidence threshold → ask for clarification rather than guess.
5. If two agents tie at the same score and same priority → route to the agent listed first alphabetically (deterministic fallback; logged so we can tune later).

**Future enhancement:** Embeddings similarity can be added as an opt-in improvement once routing test data is available to measure recall gaps. Keywords are the baseline.

### CLI Commands

```bash
# Validate all agents
openclaw agents validate

# Health check specific agent
openclaw agents health neo
# Output: model reachable ✓, tools valid ✓, memory writable ✓

# Health check all
openclaw agents health --all
```

---

## Marketplace Hosting

### Phase 1: Internal/Git-Based

- Host in OpenClaw monorepo under `agents/` directory
- Sync mechanism similar to ClawHub skills
- CLI pulls from git during `openclaw agents sync`
- Local cache for offline support

### Phase 2: AgentHub (Future)

- Dedicated marketplace at `agenthub.com` or `agents.openclaw.ai`
- API-based registry similar to ClawHub
- Community submissions with review process

### Registry Manifest (`registry.json`)

Each registry repo (git or otherwise) contains a `registry.json` at its root listing available agents. Agent IDs are prefixed with the registry ID to prevent namespace collisions:

```json
{
  "id": "company",
  "name": "Company Internal",
  "description": "Internal company agents",
  "version": "1.0.0",
  "agents": [
    {
      "id": "company/neo",
      "name": "Neo (Company Custom)",
      "version": "1.0.0",
      "tier": 2,
      "department": "engineering",
      "path": "./agents/neo"
    },
    {
      "id": "company/legal-bot",
      "name": "Legal Document Reviewer",
      "version": "1.2.0",
      "tier": 2,
      "department": "legal",
      "path": "./agents/legal-bot"
    }
  ]
}
```

**Namespacing rule:** official agents use the bare ID (`neo`); agents from any other registry are always prefixed (`company/neo`). This resolves the namespace collision open question (U3).

### Registry Repo Layout

```
company-agents/
├── registry.json           # Registry manifest (above)
└── agents/
    ├── neo/
    │   ├── agent.yaml
    │   └── AGENT.md
    ├── legal-bot/
    │   ├── agent.yaml
    │   └── AGENT.md
    └── ...
```

### Installation Sources

The registry is **where** agents are discovered. The source is how files are fetched — this is an implementation detail the user never sees:

| Source           | How it works                  |
| ---------------- | ----------------------------- |
| **GitHub / git** | Clone/pull from git repo      |
| **npm**          | Install from npm package      |
| **Local**        | Point to local directory path |

### Offline Support

```bash
# Cache registry locally
openclaw agents sync --cache

# Install from cache (no network)
openclaw agents install neo --offline
```

---

## Registry Management

### Registry Config (`openclaw.json`)

Registries are configured under `agents.registries`. Auth tokens are read from environment variables — never stored in the config file to avoid committing secrets.

```json
{
  "agents": {
    "default_namespace": "openclaw",
    "registries": [
      {
        "id": "openclaw",
        "name": "OpenClaw Official",
        "url": "https://github.com/openclaw/agents",
        "description": "Official OpenClaw agent marketplace",
        "visibility": "public",
        "enabled": true
      },
      {
        "id": "company",
        "name": "Company Internal",
        "url": "https://github.com/company/openclaw-agents",
        "auth_token_env": "COMPANY_AGENTS_TOKEN",
        "description": "Internal company agents",
        "visibility": "private",
        "enabled": true
      }
    ]
  }
}
```

### CLI Commands

```bash
# List all configured registries
openclaw agents registry list

# Add a registry
openclaw agents registry add company https://github.com/company/agents

# Remove a registry
openclaw agents registry remove company

# Enable / disable without removing
openclaw agents registry enable company
openclaw agents registry disable company

# Sync all registries
openclaw agents sync

# Sync a specific registry
openclaw agents sync --registry company
```

### Web UI — Registries Page

Located at **Agents → Registries** in ui-next. Navigation structure:

```
Agents
├── Browse        # Browse marketplace agents (grid/table, includes Bundles tab)
├── Organization  # Interactive hierarchy view (React Flow + dagre)
├── Installed     # Manage installed agents (grid/table, clone/enable/disable/remove)
├── Registries    # Manage agent registries (add/sync/remove/enable/disable)
├── Health        # Agent health dashboard (auto-refresh)
└── + Create      # Create new agent wizard (also clone via ?clone=<id>)
```

**Registry list:**

```
┌─────────────────────────────────────────────────────────────┐
│  Registries                                          [+ Add] │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🟢 OpenClaw Official                        Public  │   │
│  │ github.com/openclaw/agents                          │   │
│  │ 24 agents • Last synced: 2 hours ago                │   │
│  │                                          [Sync] [⋯] │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🔒 Company Internal                         Private │   │
│  │ github.com/company/agents                           │   │
│  │ 8 agents • Last synced: 1 day ago                   │   │
│  │                                          [Sync] [⋯] │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ⚪ Legal Tech                               Disabled │   │
│  │ github.com/legaltech/agents                         │   │
│  │ Not synced                                          │   │
│  │                                        [Enable] [⋯] │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Add Registry modal:**

```
┌─────────────────────────────────────────────────────────────┐
│  Add Registry                                         [✕]  │
├─────────────────────────────────────────────────────────────┤
│  Registry ID *                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ company                                             │   │
│  └─────────────────────────────────────────────────────┘   │
│  Display Name *                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Company Internal                                    │   │
│  └─────────────────────────────────────────────────────┘   │
│  URL *                                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ https://github.com/company/agents                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  Visibility                                                 │
│  ○ Public   ● Private (requires authentication)            │
│  Auth Token (env var name, for private registries)          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ COMPANY_AGENTS_TOKEN                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                              [Cancel]  [Add & Sync]         │
└─────────────────────────────────────────────────────────────┘
```

**Registry detail view (click a registry):**

```
┌─────────────────────────────────────────────────────────────┐
│  ← Registries / Company Internal                           │
├─────────────────────────────────────────────────────────────┤
│  🔒 Company Internal                                Private │
│  URL: github.com/company/agents                             │
│  Status: ● Connected                                        │
│  Agents: 8 • Last synced: 1 day ago                         │
│  [Sync Now]  [Disable]  [Remove]                           │
├─────────────────────────────────────────────────────────────┤
│  Available Agents                                           │
│  company/neo        CTO (Company Custom)   [Install]        │
│  company/legal-bot  Legal Document Review  [Install]        │
│  company/compliance Compliance Checker     [Installed ✓]    │
└─────────────────────────────────────────────────────────────┘
```

---

## Installation Scopes

| Scope       | Config Location           | Lock File                          | Use Case                              |
| ----------- | ------------------------- | ---------------------------------- | ------------------------------------- |
| **local**   | `.openclaw/agents.local/` | `.openclaw/agents.local-lock.yaml` | Project-specific, gitignored          |
| **project** | `.openclaw/agents/`       | `.openclaw/agents-lock.yaml`       | Team-shared agents in version control |
| **user**    | `~/.openclaw/agents/`     | `~/.openclaw/agents-lock.yaml`     | Personal agents across all projects   |

### Scope Resolution Order

Resolution is **local → project → user** (narrowest wins). When the registry builds the routing table, it merges all three scopes in that order — a local-scope agent with the same ID as a user-scope agent overrides it completely for that project.

**Cross-scope dependency rule:** a Tier 3 agent at any scope can satisfy its `requires` dependency from any other scope. Example: Tank installed at `project` scope can depend on Neo installed at `user` scope. The dependency is validated at startup across all scopes, not within a single scope.

**Lock files per scope:** each scope has its own lock file (see table above). The project-scope lock file (`.openclaw/agents-lock.yaml`) is the one committed to version control. User-scope and local-scope lock files are personal and should be gitignored.

### CLI Commands

```bash
# Browse marketplace
openclaw agents search "engineering"
openclaw agents list --marketplace

# Install agents
openclaw agents install neo --scope user
openclaw agents install tank --scope project

# Validate tier dependencies
openclaw agents validate

# Sync marketplace
openclaw agents sync

# Remove agents (with dependency check)
openclaw agents remove tank --scope project
openclaw agents remove neo --cascade  # Also removes Tank, Dozer, Mouse

# Health checks
openclaw agents health neo
openclaw agents health --all
```

### Uninstall Behavior

```
$ openclaw agents remove neo

Error: Cannot remove neo — 3 agents depend on it:
  - tank (project)
  - dozer (project)
  - mouse (project)

Use --cascade to remove all dependents:
  openclaw agents remove neo --cascade

Or remove dependents first:
  openclaw agents remove tank dozer mouse
```

---

## Versioning and Updates

### Semantic Versioning

- `version: 1.2.0` in `agent.yaml`
- Breaking changes = major version bump
- New capabilities = minor version bump
- Bug fixes = patch version bump

### Update Flow

```bash
# Check for updates
openclaw agents outdated

# Update specific agent
openclaw agents update neo

# Update with migrations
openclaw agents upgrade neo --run-migrations

# Update all
openclaw agents update --all

# Rollback to previous version
openclaw agents rollback neo
openclaw agents rollback neo --to 0.9.0
```

**Rollback behaviour:** `openclaw agents update` snapshots the previous version (config + lock file entry) before applying the update. `openclaw agents rollback neo` restores the snapshot. Only one rollback level is kept per agent (rolling back again is a no-op). Migration scripts are not reversed — rollback restores the `agent.yaml` and `AGENT.md` files but cannot undo data migrations; the user is warned of this before rollback completes.

### Migration Support

When upgrading across major versions:

```yaml
# agent.yaml
migrators:
  - from_version: "0.9.0"
    to_version: "1.0.0"
    script: ./migrations/v0.9-to-v1.0.sh
```

```bash
$ openclaw agents upgrade neo --run-migrations

Upgrading neo from 0.9.0 to 1.0.0...
Running migration: v0.9-to-v1.0.sh
✓ Migration complete
✓ neo upgraded to 1.0.0
```

---

## Agent Testing Framework

### Test Structure

```yaml
# agents/tank/tests/test_routing.yaml
tests:
  - name: "routes backend tasks"
    input: "Add rate limiting to the API"
    expect_route: tank
    expect_capabilities_used:
      - backend_development

  - name: "routes CI/CD tasks"
    input: "Set up GitHub Actions pipeline"
    expect_route: dozer
    expect_not_route: tank

  - name: "handles ambiguous requests"
    input: "Fix the bug"
    expect_clarification: true
```

### CLI Commands

```bash
# Run agent tests
openclaw agents test tank

# Run all agent tests
openclaw agents test --all

# Test routing specifically
openclaw agents test-routing "Add rate limiting to the API"
```

---

## Deprecation Flow

### Marking Agent as Deprecated

```yaml
# agent.yaml
deprecated: true
sunset_date: "2026-06-01"
migration_guide: "https://docs.openclaw.ai/agents/neo-migration"
replacement: "neo-v2"
```

### User Experience

```bash
$ openclaw agents install neo

Warning: neo is deprecated and will be removed on 2026-06-01
Migration guide: https://docs.openclaw.ai/agents/neo-migration
Recommended replacement: neo-v2

Install anyway? [y/N]
```

```bash
$ openclaw agents list

Tier 2 — Department Heads
  neo         CTO — Engineering           [deprecated, sunset 2026-06-01]
  neo-v2      CTO — Engineering (v2)      [recommended]
  trinity     CFO — Finance               [installed: user]
```

---

## CLI Experience

### Browse Agents

```
$ openclaw agents browse

Agent Marketplace (openclaw-agents)

Tier 2 — Department Heads
  neo         CTO — Engineering           [installed: user]
  trinity     CFO — Finance               [not installed]
  morpheus    CMO — Marketing             [not installed]

Tier 3 — Specialists (Engineering)
  tank        Backend Development         [installed: project]
  dozer       DevOps & Infrastructure     [not installed]
  mouse       QA & Testing                [not installed]

Run `openclaw agents install <name>` to install
```

### Install with Validation

```
$ openclaw agents install tank --scope project

Validating dependencies...
  ✗ tank requires neo (Tier 2)

Install neo first:
  openclaw agents install neo --scope project

Or install both:
  openclaw agents install neo tank --scope project
```

### Health Check

```
$ openclaw agents health neo

Agent: neo (v1.0.0)
  ✓ Model reachable (claude-opus-4-6)
  ✓ Tools valid (5 allowed, 0 denied)
  ✓ Memory writable
  ✓ Skills loadable (2 skills)
  ✓ Subagents available (tank, dozer, mouse)

Status: healthy
```

---

## Web UI

Agent marketplace UI pages (all implemented):

1. **Browse page** — Card grid or table of available agents with tier/category filter tabs (All, Department Heads, Specialists, Core, Bundles). Grid/table toggle persisted in localStorage. Bundles tab has create/edit/delete/view-org actions.
2. **Organization page** — Interactive React Flow hierarchy view with dagre auto-layout, department-colored nodes/edges, minimap, legend. Supports `?bundle=<id>` filter to show only a specific bundle's agents.
3. **Installed page** — Installed agents with grid/table toggle, search, filter by tier/dept/status. Actions: Configure, Clone, Enable/Disable, Remove, Create Specialist.
4. **Registries page** — Manage agent registries (add, sync, remove, enable/disable, expand to see agents)
5. **Health page** — Agent health dashboard with auto-refresh, per-agent status
6. **Create page** — Agent creation wizard, supports `?parent=<id>&department=<dept>` (new specialist) and `?clone=<id>` (clone existing)
7. **Preview page** — Agent detail/preview view
8. **Config page** — Per-agent configuration editor (model, tools, permissions)

---

## Agent vs Skill Boundary

| Aspect          | Agent                          | Skill                          |
| --------------- | ------------------------------ | ------------------------------ |
| **Runtime**     | Own session + context          | Loaded into existing context   |
| **Lifecycle**   | Spawned, runs, returns summary | Invoked, instructions followed |
| **Memory**      | Isolated workspace             | Shared with parent             |
| **Marketplace** | AgentHub (separate)            | ClawHub                        |
| **Definition**  | `agent.yaml` + `AGENT.md`      | `SKILL.md`                     |

**Future consideration:** Unified marketplace combining agents, skills, plugins, and commands.

---

## Implementation Phases

Phase 1 is split into three sub-phases to keep scope manageable and validate the schema against real agents before building the full CLI.

### Phase 1a: Schema & Validation (spec work, no runtime) — COMPLETE

- [x] Finalise routing algorithm decision (keyword vs embeddings) → keywords first, embeddings deferred
- [x] Define `agent.yaml` schema with all fields (including `limits`, no `subagents`) → `src/config/zod-schema.agent-manifest.ts`
- [x] Define `AGENT.md` format (prompt-only, no frontmatter) → `src/config/agent-manifest-validation.ts`
- [x] Create agent manifest validator with tier enforcement → `src/config/agent-manifest-validation.ts`
- [x] Define lock file format (`agents-lock.yaml`) per scope → `src/config/agent-scope.ts`

### Phase 1b: Migrate Existing Agents — COMPLETE

- [x] Migrate all existing Matrix agents (Neo, Trinity, Morpheus, Tank, Dozer, Mouse, Oracle, Seraph, Zee, Niobe, Switch, Rex) to new `agent.yaml` + `AGENT.md` format
- [x] Validate each migrated agent against schema → `src/config/agent-manifest-validation.test.ts` (22 tests passing)
- [x] Confirm `requires` relationships replace the old hardcoded hierarchy → verified: no hardcoded hierarchies remain (only `DEPARTMENT_HEADS` in `matrix-init.ts` for cron jobs, not hierarchy enforcement)

### Phase 1c: CLI & Scopes — COMPLETE

- [x] Implement `openclaw agents` commands (install, remove, validate) → `src/commands/agents.commands.marketplace.ts`
- [x] Add installation scopes (user/project/local) with correct lock file per scope → `src/config/agent-scope.ts`
- [x] Implement uninstall cascade logic (`--cascade`) → `agentsRemoveCommand` with `findDependents`
- [x] Add `--frozen` install from lock file → `agentsInstallCommand` frozen mode
- [x] Add `--force` flag to skip interactive prompts (e.g. deprecated agent warnings)
- [x] Lock file regeneration → `agentsLockRegenerateCommand`
- [x] Bundle install with version conflict warning → bundle expansion in `agentsInstallCommand`

### Phase 2: Registry & Runtime — COMPLETE

- [x] Build Agent Registry Service for gateway startup validation → `src/gateway/agent-registry-service.ts`
- [x] Implement degraded startup mode (disable invalid agents, gateway continues)
- [x] Build git-based registry sync with local caching → `src/config/agent-registry-sync.ts`
- [x] Implement search and browse commands → `src/commands/agents.commands.marketplace.ts`
- [x] Add health check commands (`openclaw agents health`)
- [x] Build routing algorithm into registry (capability registry for COO) → keyword scoring + priority tiebreaker
- [x] Add basic agent routing tests → `src/config/agent-routing.test.ts` (12 tests passing)
- [x] Wire registry sync to CLI + web UI RPCs → `agents.marketplace.registry.add`, `.remove`, `.sync` RPCs + CLI `registry add/remove/enable/disable`
- [x] Registry enable/disable CLI → `openclaw agents registry enable/disable <id>`

### Phase 3: Updates & Migrations — COMPLETE

- [x] Implement version update flow with pre-update snapshot → `agentsUpdateCommand` in `agents.commands.registry.ts`
- [x] Add `openclaw agents rollback` command → `agentsRollbackCommand` with `--to <version>` flag
- [x] Add migration script support (`--run-migrations`) → `agentsUpdateCommand` with `--run-migrations` flag
- [x] Add deprecation warnings and sunset flow → CLI warnings (install, list, health) + web UI banners (Browse, Installed)
- [x] Interactive confirmation prompt for deprecated agent install (skip with `--force`)

### Phase 4: Testing & Quality — COMPLETE

- [x] Agent test framework (`test_routing.yaml` format) → `src/config/zod-schema.agent-test.ts`
- [x] Add `openclaw agents test` and `openclaw agents test --all` commands → `agentsTestCommand` in `agents.commands.registry.ts`
- [x] Add `openclaw agents test-routing "<input>"` ad-hoc routing test → `agentsTestRoutingCommand`
- [x] Write `test_routing.yaml` for all 12 routable agents (neo, trinity, morpheus + 9 specialists) → `agents/*/tests/test_routing.yaml`
- [x] Integration test loading all YAML test files against real bundled manifests → `src/config/agent-routing-yaml.test.ts` (54 tests)
- [x] Total marketplace test suite: 103 tests across 4 test files (schema validation, scope/lock, routing unit, routing YAML integration)

### Phase 5: Web UI — COMPLETE

- [x] Agent marketplace Browse page → `ui-next/src/pages/agents/browse.tsx` (card grid, search, tier filter)
- [x] Browse page grid/table view toggle → `DataTable` with sortable columns (Name, Role, Tier, Department, Version, Status, Parent), persisted in localStorage
- [x] Agent Installed page → `ui-next/src/pages/agents/installed.tsx` (search, filter by tier/dept/status)
- [x] Installed page grid/table view toggle → same pattern as Browse
- [x] Clone agent action → Copy icon on installed agent cards, navigates to `/agents/create?clone=<id>` (grid + table views, all tiers)
- [x] Agent Preview/detail page → `ui-next/src/pages/agents/preview.tsx`
- [x] Agent Config editor → `ui-next/src/pages/agents/config.tsx`
- [x] Agent Create wizard → `ui-next/src/pages/agents/create.tsx`
- [x] Agent Health dashboard → `ui-next/src/pages/agents/health.tsx` (auto-refresh, per-agent settings)
- [x] Registries page → `ui-next/src/pages/agents/registries.tsx` (add/sync/remove/expand)
- [x] Deprecation banners in Browse and Installed cards
- [x] Bundle browsing and installation → integrated as "Bundles" tab in Browse page (`browse.tsx`), fetches from `agents.marketplace.bundles` RPC, installs via `agents.marketplace.bundle.install` RPC, shows included agents with install status
- [x] Bundle CRUD (create/edit/delete) → `BundleFormModal` in browse.tsx, RPCs: `bundle.create`, `bundle.update`, `bundle.delete`
- [x] Bundle visual polish: dedicated "Bundle" badge (purple), partial install progress bar, edit/delete actions per card
- [x] Bundle → Org Chart navigation → GitBranch icon on bundle cards, navigates to `/agents/organization?bundle=<id>`, filters org view to bundle agents + parents + COO root, clear filter button in header
- [x] Agent Organization hierarchy view → `ui-next/src/pages/agents/organization.tsx` (React Flow + dagre auto-layout, department colors, minimap, legend)
- [x] Custom React Flow components → `ui-next/src/components/agents/agent-flow-node.tsx` (tier-sized cards, department borders), `department-edge.tsx` (colored smooth-step connectors)
- [x] Org graph builder utility → `ui-next/src/lib/agent-org-graph.ts` (dagre TB layout, `requires` hierarchy parsing)
- [x] ~~CLI bundle commands~~ → removed (UI-only management; RPCs remain)

### Phase 6: Community & Security — PLANNED (not started)

Deferred items that become relevant when external/community registries are actively used:

- [ ] AgentHub hosting infrastructure
- [ ] Community submission process with review/approval workflow
- [ ] Sandboxing for migration scripts (currently runs `sh` directly — pre-requisite for community agents)
- [ ] GPG/Sigstore signing for agent packages
- [ ] Agent inheritance runtime resolution (`extends`/`overrides` with permission escalation rules) — schema fields exist, no runtime merging yet; zero current consumers
- [ ] `--offline` flag for install from local cache — bundled agents are already local; only meaningful with external registries
- [ ] Lock file `resolved` URL and `checksum` fields — schema supports them (optional); meaningful only with external registries and signing
- [ ] Interactive `registry enable/disable` from web UI (RPCs done, CLI commands removed; web UI has agent enable/disable but not registry-level toggle)

---

## Open Questions (Unresolved)

### ~~U1. Routing algorithm: keyword matching vs embeddings?~~ → Resolved

**Resolution:** Start with keyword matching (Phase 2). Keywords are free, deterministic, and debuggable. Embeddings deferred as an opt-in enhancement once we have routing test data to measure recall gaps. The keyword algorithm scores each Tier 2 agent by token overlap with `routing_hints.keywords`, uses `capabilities` as a secondary signal, applies `priority` as a tiebreaker, and falls back to alphabetical ordering on ties. If the top score is below a confidence threshold, the COO asks for clarification rather than guessing. Moved to Resolved.

### ~~U2. Bundle version conflicts~~ → Resolved

**Resolution:** Warn and proceed. If Neo is installed at `1.0.0` and a bundle expects `neo@1.1.0`, the CLI logs a version conflict warning and overwrites with the bundle's version. The user sees the warning and can rollback if needed. No interactive prompt — bundles are expected to be internally consistent, so the bundle version wins.

### ~~U3. Agent namespacing~~ → Resolved

**Resolution:** Official agents use bare IDs (`neo`). All other registry agents are prefixed with their registry ID (`company/neo`). Defined in the Registry Management section. Moved to Resolved.

---

## Open Questions (Resolved)

### 1. Bundle Format

**Resolution:** Use meta-package pattern in `agent.yaml`:

```yaml
id: engineering-pack
name: Engineering Pack
is_bundle: true
bundle_agents:
  - neo
  - tank
  - dozer
  - mouse
version: 1.0.0
```

Install with: `openclaw agents install engineering-pack`

### 2. Agent Inheritance

**Resolution:** Use `extends` + overlay pattern:

```yaml
# custom-cto/agent.yaml
extends: neo
overrides:
  model:
    primary: claude-sonnet-4-5 # Cheaper model for custom CTO
  tools:
    deny:
      - exec # No shell access
```

**Permission escalation rules (important):** `overrides.tools` is **replace** semantics for the `deny` list, and **replace** semantics for the `allow` list. A child agent **cannot grant itself permissions the parent did not have** — if `neo` does not list `exec` in `tools.allow`, a child specifying `tools.allow: [exec]` is a schema validation error. A child can only restrict, not escalate. This rule applies to both official and community agents extending any base agent.

### 3. Metrics

**Resolution:** Optional telemetry with privacy-first approach:

- Opt-in, not opt-out
- Only aggregate usage counts (no task content)
- Self-hosted option for enterprises

### 4. Private Registries

**Resolution:** Multiple registry URLs in config with per-registry auth tokens:

```json
{
  "agents": {
    "registries": [
      {
        "name": "openclaw",
        "url": "https://github.com/openclaw/agents"
      },
      {
        "name": "company-internal",
        "url": "https://github.com/company/internal-agents",
        "auth_token_env": "OPENCLAW_INTERNAL_AGENTS_TOKEN"
      }
    ]
  }
}
```

Auth tokens are read from environment variables (not stored in config) to avoid leaking secrets into committed config files. CLI: `openclaw agents install neo --registry company-internal`

---

## Related Documents

- `/Project-tasks/matrix-multi-agent-implementation.md` — Current Matrix system
- `/Project-tasks/matrix-agent-scripting-implementation.md` — Agent scripting conventions
- `~/dev/operator1/skills/clawhub/SKILL.md` — ClawHub skills marketplace (reference)

---

## Discussion History

**2026-03-09 — Initial Planning Session**

Key decisions made:

- Tier enforcement via schema validation
- Separate marketplace from ClawHub (AgentHub)
- YAML + MD format for agent definitions
- User/project install scopes
- Start with internal hosting, cloud later

Participants: Rohit Sharma, Operator1

**2026-03-09 — Neo Review Session**

Critical improvements identified:

- P0: Runtime tier enforcement via Agent Registry Service
- P0: Version lock file (`agents-lock.yaml`)
- P0: Uninstall cascade with `--cascade` flag
- P1: Capabilities + routing_hints in schema
- P1: Migration support for major version upgrades
- P1: Phase reordering (scopes to Phase 1)
- P2: Offline support with local cache
- P2: Agent testing framework

Open questions resolved:

- Bundle format → meta-package pattern
- Agent inheritance → extends + overrides
- Metrics → opt-in, privacy-first
- Private registries → multiple registry URLs

Participants: Neo (via subagent review), Rohit Sharma, Operator1

**2026-03-09 — Operator1 Review Session (incorporating Claude Code analysis)**

Schema changes:

- Removed `subagents` field from `agent.yaml` — derived at registry build time from `requires` fields (single source of truth)
- Dropped YAML frontmatter from `AGENT.md` — `AGENT.md` is prompt content only; `agent.yaml` is the manifest
- Added `limits` block to schema: `timeout_seconds`, `cost_limit_usd`, `context_window_tokens`, `retry_policy`
- Added permission escalation rules for `extends`: child agents cannot grant themselves permissions beyond the parent's `tools.allow`

Architecture changes:

- Gateway startup flow updated to degraded mode: invalid agents disabled individually, gateway continues
- Routing algorithm documented (keyword scoring + confidence threshold + priority tiebreaker); embeddings deferred to Phase 2
- Scope resolution order defined: local → project → user (narrowest wins); lock files scoped per level
- Cross-scope dependency rule: `requires` can be satisfied across scopes
- Private registry config updated with `auth_token_env` (env-var-based, not committed to config)

Update flow changes:

- Added `openclaw agents rollback` with pre-update snapshot semantics

Planning changes:

- Phase 1 split into 1a (schema/validation), 1b (migrate existing agents), 1c (CLI/scopes)
- Routing tests moved to Phase 2 (needed before Phase 3)
- Security pre-requisites (migration sandboxing, agent signing) explicitly gated to Phase 6

New unresolved open questions:

- Routing: keyword matching vs embeddings (decision needed before Phase 1a)
- Bundle version conflicts (conflict resolution policy)
- Agent namespacing across multiple registries

Participants: Rohit Sharma, Operator1 (incorporating Claude Code review)

**2026-03-09 — Registry Management Design Session**

Added full Registry Management section covering:

- Registry config schema in `openclaw.json` (`id`, `name`, `url`, `auth_token_env`, `visibility`, `enabled`)
- `registry.json` manifest format for each registry repo — agent IDs prefixed with registry ID
- CLI: `openclaw agents registry add/remove/list/enable/disable` + `openclaw agents sync --registry`
- Web UI: Agents → Registries page with list, add modal, and detail/agent-list view
- Registry repo layout (`registry.json` + `agents/<name>/`)
- Installation sources table (git, npm, local — implementation detail, user-transparent)
- Resolved open question U3 (namespacing): official agents use bare IDs; all others prefixed with registry ID

Participants: Rohit Sharma, Operator1

---

**2026-03-10 — Phase 5 Final Polish**

Additions:

- Browse page: grid/table view toggle with sortable DataTable (Name, Role, Tier, Department, Version, Status, Parent)
- Installed page: Clone agent action (Copy icon) on all agent cards in both grid and table views
- Bundle → Org Chart navigation: GitBranch icon on bundle cards navigates to filtered Organization view
- Organization page: `?bundle=<id>` URL param filtering with "Clear filter" button in header
- Custom React Flow components documented: `agent-flow-node.tsx`, `department-edge.tsx`, `agent-org-graph.ts`

Participants: Rohit Sharma, Operator1

---

_Last updated: 2026-03-10_
