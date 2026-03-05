# Matrix Planning-First Workflow

> Feedback from Rohit (2026-03-04): Improve Operator1 <> Claude Code coordination
> Refined: 2026-03-05 — clarified specialist roles, two-phase Claude Code interaction, multi-domain orchestration
> Review: 2026-03-05 — incorporated senior developer feedback (result template, plan storage wiring, timeouts, parallel status, classification, lateral consult, QA note, non-coding enforcement)

## The Problem

Current flow:

```
User → Operator1 → Neo → Tank/Spark → Claude Code (execution)
                                ↓
                  Specialist throws prompt to Claude Code
                  Claude Code plans + implements in one shot
                  No structured requirement capture
                  No plan review gate before coding starts
```

**Issues:**

- No structured requirements document before Claude Code starts work
- Claude Code receives raw prompts — no template, no acceptance criteria
- No plan review gate — code is written before anyone approves the approach
- Specialist has no chance to validate alignment before implementation begins
- Back-and-forth between GLM-5 specialists and Claude Code is inefficient

---

## Proposed Flow: Two-Phase Plan-Then-Implement

```
User → Operator1 → Neo
                     ↓
              Neo classifies task (single-domain / multi-domain / tightly-coupled)
                     ↓
              Neo delegates to specialist(s) with context
                     ↓
              Specialist creates REQUIREMENTS BRIEF (structured template)
                     ↓
         ┌──── PHASE 1: Plan ────────────────────────────────┐
         │  Specialist spawns Claude Code:                    │
         │  "Here is the requirements brief. Create a plan.  │
         │   Do NOT implement yet."                          │
         │                                                    │
         │  Claude Code returns: implementation plan          │
         └────────────────────────────────────────────────────┘
                     ↓
              Specialist reviews plan against requirements
                ├── Aligned? → approve, proceed to Phase 2
                └── Not aligned? → feedback, Claude Code revises plan (max 2 rounds)
                     ↓
         ┌──── PHASE 2: Implement ───────────────────────────┐
         │  Specialist spawns Claude Code:                    │
         │  "Plan approved. Implement it."                   │
         │                                                    │
         │  Claude Code writes code, runs tests, reports     │
         └────────────────────────────────────────────────────┘
                     ↓
              Specialist reviews output, reports to Neo
                     ↓
              Neo reports to Operator1
```

**Key principle:** Specialists (Tank, Spark, etc.) remain essential. They own the requirements brief and the plan review gate. Claude Code is domain-agnostic — it plans and implements. Specialists ensure alignment.

---

## Templates

### Unified Brief Template

A single template used by both Neo (multi-domain) and specialists (single-domain). Multi-domain fields are marked optional — skip them for single-domain tasks.

Stored at: `docs/reference/templates/matrix/workflows/brief-template.md`

```markdown
# Brief: [Feature Name]

## Objective

[One-liner: what needs to be built or changed]

## Context

[What exists today, what's changing, why this work is needed]

## Scope & Components

[Files, modules, or areas affected. Be specific.]
[For multi-domain: list components with ownership]

- [Component] — [Specialist] (multi-domain only)

## Constraints

[Tech stack, patterns to follow, things to avoid,
performance targets, compatibility requirements]

## Interface Contracts (skip if single-component)

[API shapes, data formats, event names between components.
Example: "GET /api/visitors returns { count: number }"]

## Execution Order (skip if single-component)

[Which piece first, and why.
Example: "Backend first — frontend depends on API existing."]

## Lead Specialist (tightly-coupled only)

[Who owns the unified Claude Code session]

## Acceptance Criteria

[How to verify it's done. Be specific and testable.]
```

**Usage:**

- **Neo (multi-domain):** Fills all fields including Components, Interface Contracts, Execution Order, Lead Specialist. Hands relevant sections to each specialist.
- **Specialist (single-domain):** Fills Objective, Context, Scope, Constraints, Acceptance Criteria. Skips multi-domain fields.

### Specialist → Neo Result Template

After reviewing Claude Code's output, specialists report back to Neo using this structure:

```markdown
# Result: [Feature Name]

## Status

[completed | completed-with-deviations | blocked]

## What Was Built

- [file/module]: [what it does]

## Test Results

[pass/fail summary, coverage if relevant]

## Deviations from Plan

[Any changes made during implementation and why. "None" if plan was followed exactly.]

## Blockers (if status = blocked)

[What's blocking, what decision is needed from Neo]

## Notes

[Anything Neo should know — performance concerns, tech debt introduced, follow-up work needed]
```

This closes the "report to Neo" step — specialists use this template so Neo gets structured, consistent updates instead of freeform messages.

---

## Task Classification & Orchestration

Neo classifies every incoming task before delegating:

### Scenario 1: Single-Domain Task

```
Example: "Add rate limiting to the API"
Domain:  Backend only → Tank

Neo → Tank
       ↓
  Tank creates Requirements Brief
  Tank → Claude Code Phase 1 (plan)
  Tank reviews plan
  Tank → Claude Code Phase 2 (implement)
  Tank → Neo (result)
```

One specialist, one Claude Code session. Straightforward.

### Scenario 2: Multi-Domain, Separable

```
Example: "Add visitor counter — backend API + frontend widget"
Domains: Backend (Tank) + Frontend (Spark)

Neo creates Architecture Brief:
  - Component 1: "GET/POST /api/visitors" → Tank
  - Component 2: "Visitor counter widget" → Spark
  - Interface contract: { count: number }
  - Execution order: Backend first

Neo → Tank (with architecture brief + interface contract)
       ↓
  Tank creates Requirements Brief (backend piece)
  Tank → Claude Code Phase 1 → Phase 2
  Tank → Neo (backend done)

Neo → Spark (with architecture brief + interface contract)
       ↓
  Spark creates Requirements Brief (frontend piece)
  Spark → Claude Code Phase 1 → Phase 2
  Spark → Neo (frontend done)
```

Neo defines the interface contract so both specialists build compatible pieces. Each specialist runs their own Claude Code session independently.

#### Neo's Parallel Status Protocol

When running multiple specialists in parallel (Scenario 2):

- Neo reports **partial progress** to Operator1 as each specialist completes (e.g., "Backend done, frontend in progress")
- Neo does NOT wait for all specialists to finish before giving any update
- Final consolidated report is sent once all components are complete

### Scenario 3: Tightly Coupled / Full-Stack

```
Example: "Build real-time dashboard with WebSocket backend + live chart frontend"
Domains: Backend + Frontend, deeply intertwined

Neo picks LEAD SPECIALIST based on where complexity lives:
  - Mostly backend complexity? → Tank leads
  - Mostly frontend complexity? → Spark leads
  - Equal? → Tank leads (default: data layer first)
```

```
Neo → Tank (lead, full requirement)
       ↓
  Tank creates Requirements Brief for the FULL feature
  Tank → Claude Code Phase 1 (plan covers backend + frontend)
  Tank reviews plan
    ├── Can optionally consult Spark: "Does this frontend approach look right?"
    └── Spark provides input, Tank incorporates
  Tank → Claude Code Phase 2 (implement everything)
  Tank → Neo (result)
```

**Claude Code is domain-agnostic** — it handles backend, frontend, database, tests, all in one session. The lead specialist owns the review gate. They can ping another specialist for a second opinion, but the Claude Code session stays unified.

#### Lateral Consultation Protocol

When a lead specialist needs a second opinion from another specialist (e.g., Tank pings Spark about frontend approach):

1. Lead sends a **scoped question** via `message()` — not the full plan, just the specific part needing review
2. Consulted specialist responds with input — no ACP spawn, just domain advice
3. Lead incorporates feedback and proceeds

Keep it lightweight. This is a quick check, not a co-review session.

### Decision Framework for Neo

```
Neo receives task
    ↓
    ├── Touches ONE domain?
    │     → Delegate to that specialist
    │
    ├── Touches MULTIPLE domains, loosely coupled?
    │     → Write Architecture Brief with interface contracts
    │     → Delegate pieces to respective specialists
    │     → Each specialist runs independent Claude Code session
    │
    └── Touches MULTIPLE domains, tightly coupled?
          → Write Architecture Brief
          → Pick lead specialist (where complexity lives)
          → Lead owns unified Claude Code session
          → Lead can consult other specialists for review
```

---

## Two-Phase Spawn Pattern

### Phase 1: Plan

```javascript
sessions_spawn({
  runtime: "acp",
  agentId: "claude",
  cwd: "/path/to/project",
  task: `
    Review the requirements brief below and create an implementation plan.

    REQUIREMENTS BRIEF:
    ---
    [Full requirements brief here]
    ---

    Provide:
    1. Implementation plan with file-by-file breakdown
    2. Technical approach and library choices
    3. Any risks or concerns
    4. Questions if requirements are ambiguous

    Save the approved plan to: Project-tasks/plans/<feature-name>.md

    Do NOT start implementation. Plan only.
  `,
  label: "tank-plan-visitor-api-" + Date.now(),
  runTimeoutSeconds: 300,
});
```

### Plan Review Gate

Specialist receives Claude Code's plan and checks:

- Does the plan address every acceptance criterion?
- Is the scope correct (not bloated, not missing pieces)?
- Does the approach follow project patterns and constraints?
- Are interface contracts respected?

If not aligned: specialist sends feedback, Claude Code revises. **Max 2 revision rounds** — if still not aligned after 2 rounds, escalate to Neo.

### Phase 2: Implement

```javascript
sessions_spawn({
  runtime: "acp",
  agentId: "claude",
  cwd: "/path/to/project",
  task: `
    The following plan has been reviewed and approved. Implement it.

    APPROVED PLAN (also saved at Project-tasks/plans/<feature-name>.md):
    ---
    [Full approved plan here]
    ---

    REQUIREMENTS BRIEF:
    ---
    [Original requirements brief for reference]
    ---

    Implement the plan. Run tests. Report the result with:
    - Files created/modified
    - Test results
    - Any deviations from the plan and why

    BLOCKER PROTOCOL:
    - Minor blockers (missing dep, failing test, small adjustment): resolve independently, note the deviation.
    - Major blockers (architecture conflict, missing API, unclear requirement, scope change): STOP and report back with what you found and what decision is needed.
  `,
  label: "tank-implement-visitor-api-" + Date.now(),
  runTimeoutSeconds: 900,
});
```

---

## Role Definitions

| Role                               | Responsibility                                                              | Interacts with Claude Code?             |
| ---------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| **Neo**                            | Task classification, architecture briefs, interface contracts, coordination | No (orchestration only)                 |
| **Specialist (Tank, Spark, etc.)** | Requirements brief, plan review gate, output review                         | Yes — owns the Claude Code sessions     |
| **Claude Code**                    | Plan creation, implementation, testing                                      | Receives briefs, returns plans and code |

**What changed:**

- Specialists are NOT bypassed — they are MORE important now (they own quality gates)
- Claude Code is used for BOTH planning and implementation (two phases)
- Neo stays at orchestration level — defines architecture, never talks to Claude Code directly for coding tasks
- The raw "throw a prompt at Claude Code" pattern is replaced with structured briefs + plan gates

---

## When to Use This Pattern

**Who classifies?** Neo always classifies the task complexity before delegating. The classification is included in Neo's delegation message to the specialist so the specialist knows which workflow to follow.

| Task Type                                          | Signals (Neo looks for these)                                | Approach                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Trivial** (typo fix, 1-line change)              | Single file, obvious fix, no ambiguity                       | Direct execution — specialist sends to Claude Code, no plan phase needed |
| **Simple** (single file, clear scope)              | One module, clear requirements, no architecture decisions    | Specialist creates brief, single-phase execution (skip plan review)      |
| **Medium** (multiple files, clear scope)           | Multiple files, clear scope but non-trivial implementation   | Full two-phase: requirements brief → plan → review → implement           |
| **Complex** (architecture decisions, multi-domain) | Multiple domains, unclear scope, architecture choices needed | Neo architecture brief → specialist(s) → full two-phase per specialist   |

**Default:** When in doubt, Neo classifies as **Medium**. Better to plan unnecessarily than to skip planning on something that needed it.

---

## Template Storage

### Where the templates live

One shared folder, minimal files:

```
docs/reference/templates/matrix/
├── workflows/
│   ├── brief-template.md          # Unified brief template (Neo + specialists)
│   └── result-template.md         # Specialist → Neo result template
├── SETUP.md
├── matrix-agents.template.json
├── neo/
├── tank/
├── spark/
└── ...
```

Two files only. The brief template is unified (multi-domain fields are optional, skipped for single-domain). No separate architecture vs requirements brief — one template, used at different zoom levels.

**Why a shared `workflows/` folder:**

- Single source of truth — update the template once, all agents get it
- Agents reference the template by path in their SOUL.md (e.g., "Use the template at `workflows/brief-template.md`")
- Avoids duplicating the same template across 10+ specialist SOUL.md files
- New specialists automatically know where to find the templates

---

## Implementation Checklist

### Shared Files to Create

| File                           | Purpose                                              | Used By                     |
| ------------------------------ | ---------------------------------------------------- | --------------------------- |
| `workflows/brief-template.md`  | Unified brief template (requirements + architecture) | Neo + 10 coding specialists |
| `workflows/result-template.md` | Specialist → Neo result template                     | 10 coding specialists       |

### Agent Tiers & What Changes Per Tier

**Tier 1: Leadership (3 agents)**

| Agent        | Role | Changes Needed                                                                                                                                                                                                           |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Neo**      | CTO  | Add task classification framework (single/multi/coupled), brief template usage (multi-domain fields), lead specialist assignment, decision framework, parallel status protocol. Reference `workflows/brief-template.md`. |
| **Morpheus** | CMO  | Awareness only — knows the workflow exists so marketing-related coding tasks (e.g., landing pages) are routed to Neo's engineering pipeline correctly.                                                                   |
| **Trinity**  | CFO  | Awareness only — same as Morpheus for finance-related coding tasks.                                                                                                                                                      |

**Tier 2: Coding Specialists (10 agents) — ALL need the two-phase pattern**

| Agent      | Role                   | Changes Needed                                                                                                                                                                                                                                                            |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tank**   | Backend Engineer       | Add two-phase spawn pattern, plan review gate, blocker protocol, result template. Reference `workflows/brief-template.md` + `workflows/result-template.md`.                                                                                                               |
| **Spark**  | Frontend Engineer      | Same as Tank, adapted for frontend domain.                                                                                                                                                                                                                                |
| **Dozer**  | DevOps Engineer        | Same pattern for infra/CI/CD tasks.                                                                                                                                                                                                                                       |
| **Mouse**  | QA + Research Engineer | Same pattern for test automation / tooling tasks. **Note:** Mouse's QA review work (reviewing other specialists' output) does not always need a plan phase — only when Mouse is building tooling or test infrastructure. Pure review/QA tasks skip the two-phase pattern. |
| **Cipher** | Security Engineer      | Same pattern for security tooling / hardening tasks.                                                                                                                                                                                                                      |
| **Relay**  | Integration Engineer   | Same pattern for integration / API connector tasks.                                                                                                                                                                                                                       |
| **Ghost**  | Data Engineer          | Same pattern for data pipeline / ETL tasks.                                                                                                                                                                                                                               |
| **Binary** | Mobile Engineer        | Same pattern for mobile app tasks.                                                                                                                                                                                                                                        |
| **Kernel** | Systems Engineer       | Same pattern for systems / performance tasks.                                                                                                                                                                                                                             |
| **Prism**  | AI/ML Engineer         | Same pattern for ML pipeline / model integration tasks.                                                                                                                                                                                                                   |

All 10 coding specialists get the same structural update to their SOUL.md:

1. Reference to `workflows/brief-template.md` and `workflows/result-template.md`
2. Two-phase spawn pattern (Phase 1: plan, Phase 2: implement)
3. Plan review gate checklist
4. Blocker protocol (minor: resolve, major: stop and report)
5. Result template for reporting back to Neo
6. Max 2 revision rounds, then escalate to Neo

**Tier 3: Non-Coding Specialists (20 agents) — NO changes needed**

| Agents                                                                    | Why No Changes                            |
| ------------------------------------------------------------------------- | ----------------------------------------- |
| Niobe, Switch, Rex, Ink, Vibe, Lens, Echo, Nova, Pulse, Blaze (Marketing) | Do not spawn Claude Code for coding tasks |
| Oracle, Seraph (Operations)                                               | Non-coding roles                          |
| Zee, Ledger, Vault, Shield, Trace, Quota, Merit, Beacon (Finance)         | Non-coding roles                          |

These agents may spawn ACP for their own domain work (e.g., content generation, data analysis) but do not follow the coding-specific planning-first workflow. If any of these agents need coding work done, they must route through Neo → coding specialist.

**Enforcement:** Add one line to each non-coding specialist's SOUL.md: _"If your task requires code changes (new features, bug fixes, infrastructure), route it to Neo for engineering delegation. Do not spawn Claude Code for coding tasks directly."_

### What Each Agent Tier Learns

**Neo learns:**

- "Classify tasks (trivial/simple/medium/complex) before delegating — include classification in delegation message"
- "Default to Medium when uncertain"
- "For multi-domain: fill full brief template (from `workflows/brief-template.md`) with interface contracts + component ownership"
- "For tightly coupled: assign lead specialist based on where complexity lives"
- "For cross-project: same as multi-domain, one specialist per project"
- "Report partial progress during parallel runs — don't wait for all specialists to finish"
- "Never spawn Claude Code directly for coding tasks"

**Coding Specialists learn:**

- "Before spawning Claude Code, create a brief (from `workflows/brief-template.md`)"
- "Always do Phase 1 (plan, 5 min timeout) before Phase 2 (implement, 15 min timeout)"
- "Review the plan against requirements and acceptance criteria"
- "Max 2 revision rounds, then escalate to Neo"
- "Include blocker protocol in Phase 2 prompt"
- "Report results to Neo using the result template (from `workflows/result-template.md`)"
- "Lateral consultation: send scoped questions to other specialists via `message()` — not the full plan, just the specific part needing review"

**Non-Coding Specialists learn:**

- "If your task requires code changes, route it to Neo for engineering delegation. Do not spawn Claude Code for coding tasks directly."

### Update Order

1. Create `workflows/` folder with `brief-template.md` and `result-template.md`
2. Update Neo's SOUL.md (task classification + brief template usage + parallel status protocol)
3. Update Neo's AGENTS.md (decision framework + orchestration patterns)
4. Update Tank's SOUL.md (reference implementation for coding specialists)
5. Verify Tank's pattern works end-to-end
6. Roll out same pattern to remaining 9 coding specialists
7. Add awareness note to Morpheus and Trinity SOUL.md files
8. Add one-liner enforcement to all 20 non-coding specialist SOUL.md files

---

## Resolved Decisions

1. **Sub-agents are essential, not optional** — They own the requirements brief and plan review gate
2. **Plan revision cap: 2 rounds** — Then escalate to Neo
3. **Tightly coupled tasks: lead specialist model** — Claude Code handles all domains in one session; lead specialist reviews; can consult other specialists
4. **Claude Code is domain-agnostic** — It writes backend, frontend, whatever. Specialists provide domain expertise through the requirements brief and plan review, not by writing code themselves
5. **Plan storage: project folder** — Approved plans are stored in `Project-tasks/plans/<feature-name>.md`. Completed plans move to `Project-tasks/Done/` alongside other completed task docs. This keeps plans auditable, searchable, and traceable when debugging later.
6. **Cross-project tasks: Neo coordinates per-project** — Same pattern as multi-domain separable (Scenario 2) applied at project level. Neo writes architecture brief with cross-project interface contracts, assigns one specialist per project, each specialist runs their own Claude Code session scoped to their project's `cwd`.
7. **Mid-execution blockers: hybrid** — Claude Code resolves minor blockers independently (missing dependency, failing test, small scope adjustment) and notes deviations. For major blockers (architecture conflict, missing API, unclear requirement, scope change), Claude Code stops and reports back to the specialist with findings and what decision is needed.

## No Open Questions

All questions resolved as of 2026-03-05.

---

_Created: 2026-03-04_
_Refined: 2026-03-05_
_Authors: Rohit + Claude Code_
