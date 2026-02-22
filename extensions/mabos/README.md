# MABOS — Multi-Agent Business Operating System

MABOS is an AI-powered business operating system that assigns autonomous agents — each with beliefs, desires, goals, and plans — to run every function of your business. It uses BDI (Belief-Desire-Intention) cognitive architecture, SBVR-aligned ontologies, and enterprise-grade coordination protocols to turn a single command into a fully staffed, reasoning organization.

## Origin

MABOS started as two standalone projects:

- [**mabos-standalone**](https://github.com/kingler/mabos-standalone) — the original BDI agent framework, cognitive file architecture, and multi-agent coordination layer
- [**mabos-workbench**](https://github.com/kingler/mabos-workbench) — a FastAPI + Next.js backend providing persistent storage (PostgreSQL, TypeDB, Redis) and a 6-step onboarding UI

These projects were merged and rebuilt on top of a fork of [OpenClaw](https://github.com/openclaw/openclaw), an open-source personal AI assistant platform. OpenClaw provided the plugin SDK, gateway infrastructure, CLI framework, and extension system that MABOS needed. Rather than reinvent that plumbing, forking OpenClaw gave MABOS a production-grade runtime from day one — freeing development to focus entirely on the agent intelligence layer, ontology system, and business tooling.

The combined project lives at [github.com/kingler/openclaw-mabos](https://github.com/kingler/openclaw-mabos). The `mabos.mjs` entry point wraps the shared runtime, and `extensions/mabos/` contains the full MABOS extension (99 tools, 21 modules, React dashboard).

---

## What MABOS Does

You describe a business. MABOS creates it:

1. **Onboards** the venture through a 5-phase pipeline (conversational CLI or web UI)
2. **Generates** TOGAF enterprise architecture, Business Model Canvas, and Tropos goal models
3. **Spawns** 9 C-suite agents (CEO, CFO, COO, CMO, CTO, HR, Legal, Strategy, Knowledge) plus domain-specific agents
4. **Initializes** each agent with role-specific desires, beliefs, and playbooks
5. **Runs** continuous BDI reasoning cycles where agents perceive, deliberate, plan, act, and learn
6. **Coordinates** through FIPA-standard ACL messaging, contract-net task allocation, and stakeholder escalation
7. **Persists** knowledge in a 3-layer SBVR-aligned ontology (JSON-LD/OWL), optionally synced to TypeDB

Every agent maintains 10 cognitive files (Persona, Beliefs, Desires, Goals, Intentions, Plans, Capabilities, Memory, Cases, Playbook) and can reason across 17+ methods including Bayesian updating, causal analysis, counterfactual reasoning, and case-based retrieval.

---

## Installation

### From the Combined Repository

```bash
git clone https://github.com/kingler/openclaw-mabos.git
cd openclaw-mabos
pnpm install
pnpm build
```

### As a Standalone Extension

```bash
cd ~/.openclaw/workspace/extensions
git clone https://github.com/kingler/mabos.git
cd mabos && npm install && npm run build
```

Enable in your config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "mabos": { "enabled": true }
    }
  }
}
```

---

## `mabos.mjs` CLI

The repository root contains `mabos.mjs`, the MABOS command-line entry point. It sets `MABOS_PRODUCT=1` to activate MABOS mode within the shared runtime, enables Node.js compile caching for fast startup, and delegates to the compiled entry point.

### Subcommands

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `mabos onboard`       | Start the guided business onboarding pipeline |
| `mabos agents`        | List and manage agents across businesses      |
| `mabos bdi cycle`     | Manually trigger a BDI reasoning cycle        |
| `mabos business list` | List all managed business ventures            |
| `mabos dashboard`     | Open the stakeholder dashboard                |
| `mabos migrate`       | Run database/schema migrations                |

### Environment Variables

| Variable                     | Default                   | Description                             |
| ---------------------------- | ------------------------- | --------------------------------------- |
| `MABOS_PRODUCT`              | `"1"` (set automatically) | Signals MABOS mode to the runtime       |
| `NODE_DISABLE_COMPILE_CACHE` | unset                     | Set to `"1"` to disable compile caching |

---

## Quick Start

### Guided Onboarding (Conversational)

```
/mabos-onboarding
```

### Programmatic Onboarding

```
onboard_business(
  business_id: "acme",
  name: "Acme Consulting",
  legal_name: "Acme Consulting LLC",
  type: "consulting",
  description: "Technology consulting for startups",
  value_propositions: ["Expert technical guidance", "Startup-friendly pricing"],
  customer_segments: ["Seed-stage startups", "Series A companies"],
  revenue_streams: ["Hourly consulting", "Fixed-price engagements"],
  orchestrate: true
)
```

With `orchestrate: true`, this creates the workspace, spawns domain agents, initializes desires from templates, and syncs the SBVR ontology to the backend in one call.

### Run the First BDI Cycle

```
bdi_cycle(agent_id: "ceo", depth: "full")
```

### Check the Dashboard

```
metrics_dashboard()
```

---

## Agent Architecture

### 9 C-Suite Roles

Every business gets these agents, each with their own cognitive workspace:

| Role      | Focus             | Terminal Desires                                                   |
| --------- | ----------------- | ------------------------------------------------------------------ |
| CEO       | Vision & Strategy | Sustainable Growth, Stakeholder Value, Organizational Excellence   |
| CFO       | Finance           | Financial Health, Capital Efficiency, Fiscal Compliance            |
| COO       | Operations        | Operational Efficiency, Process Reliability, Resource Optimization |
| CMO       | Marketing         | Brand Awareness, Customer Acquisition, Market Intelligence         |
| CTO       | Technology        | System Reliability, Technical Excellence, Innovation Pipeline      |
| HR        | People            | Talent Quality, Workforce Utilization, Contractor Satisfaction     |
| Legal     | Compliance        | Legal Compliance, Risk Mitigation, IP Protection                   |
| Strategy  | Competitive       | Competitive Advantage, Market Positioning, Strategic Foresight     |
| Knowledge | Learning          | Knowledge Accuracy, Organizational Learning, Ontology Completeness |

### Domain-Specific Agents

Additional agents are spawned per business type:

| Business Type | Domain Agents                               |
| ------------- | ------------------------------------------- |
| E-commerce    | inventory-mgr, fulfillment-mgr, product-mgr |
| SaaS          | devops, product-manager, customer-success   |
| Consulting    | engagement-mgr, practice-lead, delivery-mgr |
| Marketplace   | trust-safety, seller-success, platform-ops  |
| Retail        | store-ops, merchandising, pos-manager       |

### Cognitive Files (per agent)

Each agent's workspace contains 10 cognitive files:

| File              | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `Persona.md`      | Role definition, responsibilities, decision authority  |
| `Beliefs.md`      | Current world model across 4 categories                |
| `Desires.md`      | Terminal and instrumental desires with priority scores |
| `Goals.md`        | 3-tier goal hierarchy (strategic/tactical/operational) |
| `Intentions.md`   | Active commitments with commitment strategy            |
| `Plans.md`        | Current and past plans with HTN decomposition          |
| `Capabilities.md` | Skills, tools, and integrations available              |
| `Memory.md`       | Working, short-term, and long-term memory stores       |
| `Cases.md`        | Case base for CBR retrieval                            |
| `Playbook.md`     | Domain-specific rules and procedures                   |

Desire priority formula: `base * 0.30 + importance * 0.25 + urgency * 0.25 + alignment * 0.15 + deps * 0.05`

---

## Tool Reference (99 tools across 21 modules)

### BDI Cognitive Core (6 tools)

| Tool               | Description                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `belief_get`       | Read agent beliefs (environment, self, agent, case) with certainty levels and sources    |
| `belief_update`    | Update or create a belief with certainty, source tracking, and revision logging          |
| `goal_create`      | Create a goal in the 3-tier hierarchy (strategic/tactical/operational) linked to desires |
| `goal_evaluate`    | Evaluate goal progress against beliefs, intentions, and blockers                         |
| `intention_commit` | Commit to a plan with single-minded, open-minded, or cautious commitment strategy        |
| `bdi_cycle`        | Run a full BDI cycle: PERCEIVE -> DELIBERATE -> PLAN -> ACT -> LEARN                     |

### Desire Management (4 tools)

| Tool                   | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `desire_create`        | Create a terminal or instrumental desire with computed priority using BDI-MAS formula            |
| `desire_evaluate`      | Evaluate all desires for an agent, checking priorities, conflicts, and goal recommendations      |
| `desire_drop`          | Drop a desire and log the reason, cascading to dependent goals and intentions                    |
| `intention_reconsider` | Trigger reconsideration based on belief changes, stalls, resource constraints, or better options |

### Planning (5 tools)

| Tool                  | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `plan_generate`       | Create an HTN-decomposed plan with steps, decision points, risks, and CBR provenance |
| `plan_execute_step`   | Record step completion and log to agent memory for case learning                     |
| `htn_decompose`       | Decompose a goal into a hierarchical task network of compound and primitive tasks    |
| `plan_library_search` | Search plan templates in the library for applicable patterns                         |
| `plan_adapt`          | Adapt a retrieved CBR case plan for the current situation                            |

### Case-Based Reasoning (2 tools)

| Tool           | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| `cbr_retrieve` | Retrieve similar past cases using CBR-BDI algorithm: S(B,D) = F(Sb intersect Sd) |
| `cbr_store`    | Store a new case capturing situation, solution, and outcome for future retrieval |

### Reasoning Engine (4 tools, 17+ methods)

| Tool                    | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `reason`                | Apply a specific reasoning method to a problem (see method list below) |
| `reason_bayesian`       | Update probability of a hypothesis given evidence using Bayes' theorem |
| `reason_causal`         | Identify cause-effect relationships and evaluate candidate causes      |
| `reason_counterfactual` | What-if analysis to explore alternative scenarios and implications     |

Supported reasoning methods:

- **Formal**: deductive, inductive, abductive, analogical
- **Probabilistic**: Bayesian updating, fuzzy logic, decision theory
- **Causal**: cause-effect analysis, counterfactual reasoning, temporal reasoning
- **Experience**: heuristic, case-based, means-ends analysis
- **Social**: game theory, stakeholder analysis, ethical reasoning

### Knowledge & Ontology (3 tools)

| Tool              | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `ontology_query`  | Query the MABOS ontology (JSON-LD/OWL) for domain concepts, relationships, and constraints |
| `knowledge_infer` | Run inference (deductive/inductive/abductive) over premises to derive new knowledge        |
| `rule_evaluate`   | Evaluate a business rule from playbooks against current context                            |

### Fact Store (4 tools)

| Tool           | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `fact_assert`  | Add or update an SPO triple with confidence, provenance, and temporal validity |
| `fact_retract` | Remove facts by ID, subject, or predicate                                      |
| `fact_query`   | Query with SPO pattern matching, confidence filtering, and temporal validity   |
| `fact_explain` | Trace the derivation of a fact showing inference chain and supporting evidence |

### Inference Engine (4 tools)

| Tool                | Description                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- |
| `infer_forward`     | Forward chaining: apply rules to known facts to derive new conclusions to fixed-point |
| `infer_backward`    | Backward chaining: goal-directed reasoning to prove a statement via supporting facts  |
| `infer_abductive`   | Generate and rank hypotheses that best explain an observation                         |
| `knowledge_explain` | Answer a question by combining fact store queries, inference, and derivation tracing  |

### Rule Engine (5 tools)

| Tool               | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `rule_create`      | Create an inference, constraint, or policy rule                            |
| `rule_list`        | List all rules for an agent, optionally filtered by type                   |
| `rule_toggle`      | Enable or disable a rule                                                   |
| `constraint_check` | Evaluate all constraint rules against current facts, returning violations  |
| `policy_eval`      | Evaluate policy rules against current context, returning triggered actions |

### Memory System (4 tools)

| Tool                 | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `memory_store_item`  | Store an item in working, short-term, or long-term memory with importance scoring |
| `memory_recall`      | Search across memory stores by query, type, or importance threshold               |
| `memory_consolidate` | Promote important short-term memories to long-term based on access frequency      |
| `memory_status`      | Show memory store status: counts, capacity, and recent items                      |

### Communication Protocol (5 tools)

| Tool                    | Description                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent_message`         | Send an ACL message between agents (REQUEST, INFORM, QUERY, PROPOSE, ACCEPT, REJECT, CONFIRM, CANCEL) |
| `decision_request`      | Escalate a decision to the stakeholder queue with options, impact analysis, and recommendation        |
| `contract_net_initiate` | Broadcast a call for proposals to candidate agents for task allocation                                |
| `contract_net_propose`  | Submit a proposal in response to a call for proposals                                                 |
| `contract_net_award`    | Evaluate proposals and award the task to the best bidder                                              |

### Business Management (3 tools)

| Tool              | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `business_create` | Create a new business venture with isolated workspace, 9 C-suite agents, and cognitive files |
| `business_list`   | List all managed business ventures with status overview                                      |
| `business_status` | Get detailed status of a specific business including agents and pending decisions            |

### Business Onboarding (8 tools)

| Tool                        | Description                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `onboard_business`          | End-to-end business onboarding: workspace, BMC, agents. Supports `orchestrate` mode    |
| `togaf_generate`            | Generate a TOGAF enterprise architecture (business, application, technology layers)    |
| `bmc_generate`              | Generate a Business Model Canvas for a venture                                         |
| `tropos_generate`           | Generate a Tropos i\* goal model mapping stakeholder goals to agent responsibilities   |
| `agent_spawn_domain`        | Create domain-specific agents for a business type                                      |
| `desire_init_from_template` | Batch-initialize desires for all 9 (or specified) agent roles from templates           |
| `sbvr_sync_to_backend`      | Export SBVR ontology and push to backend, creating business and agent schema in TypeDB |
| `onboarding_progress`       | Track onboarding phase state with optional Canvas progress view                        |

### Stakeholder Governance (4 tools)

| Tool                  | Description                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| `stakeholder_profile` | Configure governance preferences: approval thresholds, decision style, risk tolerance |
| `decision_review`     | Review pending decisions showing context, options, recommendation, and urgency        |
| `decision_resolve`    | Approve, reject, defer, or modify a pending decision                                  |
| `governance_check`    | Pre-flight check: does a proposed action require stakeholder approval?                |

### Workforce Management (8 tools)

| Tool                      | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `contractor_add`          | Add a freelancer/contractor to the talent pool with skills, rate, and trust score |
| `contractor_list`         | List contractors filtered by skill, availability, and trust level                 |
| `contractor_trust_update` | Adjust trust score based on performance feedback                                  |
| `work_package_create`     | Create a work package for assignment                                              |
| `work_package_assign`     | Assign work package to a contractor with handoff notes                            |
| `work_package_update`     | Update status and optionally rate quality (affects contractor trust)              |
| `work_package_list`       | List work packages with optional filters                                          |
| `handoff`                 | Formal agent-to-human handoff transferring context, artifacts, and instructions   |

### Enterprise Integration (5 tools)

| Tool                | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `integration_setup` | Configure an integration (Stripe, QuickBooks, Salesforce, Shopify, GitHub, HubSpot, Xero) |
| `integration_list`  | List all configured integrations for a business                                           |
| `integration_sync`  | Trigger a data sync, pulling data and storing as facts/metrics                            |
| `integration_call`  | Make a direct API call to an integrated service                                           |
| `webhook_process`   | Process incoming webhook events with automatic agent routing                              |

### Marketing & Social Media (8 tools)

| Tool                 | Description                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `marketing_connect`  | Connect a social/ad platform (Meta, Instagram, WhatsApp, Pinterest, LinkedIn, TikTok) |
| `content_publish`    | Publish content to one or more social platforms                                       |
| `ad_campaign_create` | Create an ad campaign with targeting, budget, and creatives                           |
| `ad_campaign_manage` | Pause, resume, update, stop, or duplicate campaigns                                   |
| `ad_analytics`       | Fetch performance metrics: impressions, clicks, CPC, CPM, ROAS, conversions, spend    |
| `audience_create`    | Create custom, lookalike, or saved audiences for ad targeting                         |
| `whatsapp_send`      | Send WhatsApp Business messages (templates, text, images, interactive buttons)        |
| `content_calendar`   | Manage content calendar: view, add, or remove scheduled content                       |

### Reporting & Finance (3 tools)

| Tool                  | Description                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `report_generate`     | Generate reports: financial, operational, strategic, portfolio, agent performance, contractor utilization |
| `legal_entity_manage` | Manage formation docs, licenses, compliance tracking, tax IDs                                             |
| `financial_pipeline`  | Chart of accounts, transactions, reconciliation, tax calendar                                             |

### Metrics (2 tools)

| Tool                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `metrics_record`    | Record a business metric data point (revenue, costs, KPIs)          |
| `metrics_dashboard` | Generate stakeholder dashboard: decisions first, key metrics second |

### Ontology Management (5 tools)

| Tool                         | Description                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `ontology_propose_concept`   | Propose a new class, property, or relationship with SBVR metadata                      |
| `ontology_validate_proposal` | Validate against existing ontology for duplicates, broken references, SHACL compliance |
| `ontology_merge_approved`    | Merge a validated proposal into the target domain ontology file                        |
| `ontology_list_proposals`    | List proposals with optional domain/status filters                                     |
| `ontology_scaffold_domain`   | Generate a new domain ontology scaffolded from the upper ontology                      |

### Setup Wizard (5 tools)

| Tool                     | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `setup_wizard_start`     | Detect current configuration state and return status with next steps           |
| `setup_channel`          | Guided channel configuration with credential validation and connection testing |
| `setup_health_check`     | Comprehensive check: gateway, service units, tokens, channels, plugins         |
| `setup_auto_fix`         | Auto-remediate stale service units, token mismatches, configuration drift      |
| `setup_status_dashboard` | Generate a Canvas-ready HTML status dashboard                                  |

---

## Onboarding Skills

### mabos-core

BDI cognitive architecture skill defining how agents think, decide, and act through the 5-phase BDI cycle (PERCEIVE -> DELIBERATE -> PLAN -> ACT -> LEARN) with 10 cognitive files per agent.

### mabos-dashboard

Stakeholder dashboard visualization with decisions-first layout, Canvas integration, and interactive HTML/CSS/JS with real-time data injection via `window.MABOS_DATA`.

### mabos-onboarding

Guided 5-phase conversational business onboarding pipeline:

| Phase               | What Happens                                                                          |
| ------------------- | ------------------------------------------------------------------------------------- |
| 1. Discovery        | Collect business info via TOGAF questionnaire (9 questions), confirm with stakeholder |
| 2. Architecture     | Generate workspace, TOGAF model, BMC, Tropos goal model                               |
| 3. Agent Activation | Spawn domain-specific agents, initialize desires from templates                       |
| 4. Knowledge Graph  | Sync SBVR ontology to TypeDB backend (falls back to local export if unavailable)      |
| 5. Launch           | Present progress canvas, run CEO's first BDI cycle, show dashboard                    |

Each phase is independently retriable. Progress is tracked in `onboarding-progress.json` across sessions.

---

## Ontology System

MABOS uses a 3-layer JSON-LD/OWL ontology stack aligned with OMG SBVR v1.3:

| Layer         | File                   | Purpose                                                   |
| ------------- | ---------------------- | --------------------------------------------------------- |
| Upper         | `mabos-upper.jsonld`   | Core BDI concepts, agent types, organizational primitives |
| Business Core | `business-core.jsonld` | Business entities, processes, financial instruments       |
| Domain        | `ecommerce.jsonld`     | E-commerce: products, orders, inventory, fulfillment      |
| Domain        | `saas.jsonld`          | SaaS: subscriptions, features, tenants, usage             |
| Domain        | `consulting.jsonld`    | Consulting: engagements, deliverables, expertise          |
| Domain        | `marketplace.jsonld`   | Marketplace: listings, transactions, trust                |
| Domain        | `retail.jsonld`        | Retail: stores, POS, merchandise                          |
| Cross-Domain  | `cross-domain.jsonld`  | Relationships bridging multiple domains                   |

Validation is enforced via SHACL shapes (`shapes.jsonld`, `shapes-sbvr.jsonld`).

The ontology loader (`src/ontology/index.ts`) provides:

- `loadOntologies()` — Load and validate all ontology files
- `mergeOntologies()` — Merge into a unified graph
- `exportSBVRForTypeDB()` — Export concept types, fact types, rules, and proof tables for TypeDB ingestion

---

## Backend Integration

MABOS connects to the [mabos-workbench](https://github.com/kingler/mabos-workbench) backend for persistent storage:

| Service    | Purpose                                                             |
| ---------- | ------------------------------------------------------------------- |
| PostgreSQL | Business records, agent metadata, audit trails                      |
| TypeDB     | SBVR ontology graph, agent knowledge nodes, typed inference queries |
| Redis      | State caching, session data, real-time metrics                      |

The extension works fully offline with file-based storage. Backend sync is best-effort — if unavailable, SBVR exports are saved locally for later sync.

---

## React Dashboard

The built-in React dashboard (`ui/`) provides a real-time view of your MABOS-managed businesses:

- **Overview** — System status, agent count, health score, BDI cycle status
- **Agents** — Per-agent cognitive state, trigger manual BDI cycles
- **Tasks** — Kanban board with SLA perspectives, parsed from agent Plans.md
- **Decisions** — Stakeholder decision queue with urgency sorting and resolution
- **Goals** — Tropos goal model browser with level/type filtering
- **Timeline** — Gantt chart generated from goal priorities and durations
- **Knowledge Graph** — Interactive ReactFlow visualization of the Tropos model
- **Workflows** — BPMN process flows linked to business goals
- **HR** — Contractor workforce management with trust scoring

---

## Lifecycle Hooks

| Hook                 | Trigger              | Behavior                                                              |
| -------------------- | -------------------- | --------------------------------------------------------------------- |
| `before_agent_start` | Agent session begins | Injects `Persona.md` content into system prompt if found in workspace |
| `after_tool_call`    | Any tool completes   | Logs BDI tool calls to audit trail                                    |

---

## Project Structure

```
extensions/mabos/
  .context/                        # Project status and API contracts
  src/
    tools/
      bdi-tools.ts                 # BDI cognitive core (6 tools)
      desire-tools.ts              # Desire management (4 tools)
      planning-tools.ts            # HTN planning (5 tools)
      cbr-tools.ts                 # Case-based reasoning (2 tools)
      reasoning-tools.ts           # Multi-method reasoning (4 tools)
      knowledge-tools.ts           # Ontology queries (3 tools)
      fact-store.ts                # SPO triple store (4 tools)
      inference-tools.ts           # Forward/backward chaining (4 tools)
      rule-engine.ts               # Rule management (5 tools)
      memory-tools.ts              # 3-store memory (4 tools)
      communication-tools.ts       # ACL messaging (5 tools)
      business-tools.ts            # Business CRUD (3 tools)
      onboarding-tools.ts          # Onboarding pipeline (8 tools)
      stakeholder-tools.ts         # Governance (4 tools)
      workforce-tools.ts           # Contractors & packages (8 tools)
      integration-tools.ts         # External services (5 tools)
      marketing-tools.ts           # Social & ads (8 tools)
      reporting-tools.ts           # Reports & finance (3 tools)
      metrics-tools.ts             # KPI tracking (2 tools)
      ontology-management-tools.ts # Ontology evolution (5 tools)
      setup-wizard-tools.ts        # Setup & health (5 tools)
      common.ts                    # Shared helpers
    types/
      bdi-runtime.d.ts             # BDI runtime type declarations
    ontology/
      index.ts                     # Loader, validator, SBVR exporter
      mabos-upper.jsonld           # Upper ontology
      business-core.jsonld         # Business core ontology
      ecommerce.jsonld             # E-commerce domain
      saas.jsonld                  # SaaS domain
      consulting.jsonld            # Consulting domain
      marketplace.jsonld           # Marketplace domain
      retail.jsonld                # Retail domain
      cross-domain.jsonld          # Cross-domain bridges
      shapes.jsonld                # SHACL validation shapes
      shapes-sbvr.jsonld           # SBVR-specific shapes
  ui/                              # React dashboard
    src/
      components/                  # Reusable UI components
      hooks/                       # React Query hooks
      lib/                         # API client, types, utilities
      pages/                       # Route-level page components
  templates/base/
    desires-{role}.md              # Per-role desire templates
    plan-templates.md              # Reusable plan patterns
    agents/{role}/Persona.md       # Per-role persona templates
  skills/
    mabos-core/SKILL.md            # BDI cognitive skill
    mabos-dashboard/SKILL.md       # Stakeholder dashboard skill
    mabos-onboarding/SKILL.md      # 5-phase onboarding skill
  tests/
    api-error-handling.test.ts     # HTTP retry and timeout tests
    typedb-fallback.test.ts        # TypeDB connection fallback tests
  index.ts                         # Extension entry point
  package.json
  tsconfig.json
```

---

## Testing

```bash
pnpm test -- --config vitest.extensions.config.ts
```

Tests cover:

- HTTP request retry behavior, timeouts, and error handling
- TypeDB connection fallback and best-effort write patterns
- Plugin registration (all 21 tool modules load, lifecycle hooks register)
- Ontology validation (SBVR alignment, SHACL shapes, cross-references)
- Onboarding pipeline E2E (all 5 phases, orchestrate mode, recovery, idempotency)

---

## Related Projects

| Project                                                         | Description                                             |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| [openclaw-mabos](https://github.com/kingler/openclaw-mabos)     | This repository — the combined MABOS + OpenClaw runtime |
| [mabos-standalone](https://github.com/kingler/mabos-standalone) | Original standalone BDI agent framework                 |
| [mabos-workbench](https://github.com/kingler/mabos-workbench)   | FastAPI + Next.js backend (PostgreSQL, TypeDB, Redis)   |
| [OpenClaw](https://github.com/openclaw/openclaw)                | Upstream personal AI assistant platform                 |

---

## License

MIT
