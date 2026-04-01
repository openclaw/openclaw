# MABOS — Multi-Agent Business Operating System

## What It Is

MABOS is an agentic business operating system built on a **BDI (Belief-Desire-Intention) cognitive architecture**. It deploys autonomous AI agents — each representing a C-suite or functional role — that perceive their environment, reason about goals, form plans, and execute actions across real business systems. Built as an OpenClaw gateway extension, it turns a single LLM interface into a coordinated executive team.

## Agent Roster

**16 role-scoped agents**, each with filtered tool access:

| Role               | Domain                                                      |
| ------------------ | ----------------------------------------------------------- |
| CEO                | Strategic decisions, stakeholder communications, reporting  |
| CFO                | Financial planning, forecasting, budgeting, P&L             |
| CMO                | Marketing ops, campaigns, audience, content                 |
| COO                | Workflows, supply chain, capacity, vendor management        |
| CTO                | Infrastructure, integrations, security, deployment          |
| Legal              | Compliance, contracts, policy enforcement                   |
| HR                 | Recruitment, performance, workforce planning                |
| Strategy           | Scenario planning, competitive analysis, market positioning |
| Knowledge Manager  | Ontology, fact stores, knowledge graphs                     |
| E-Commerce Manager | Shopify operations, products, inventory, collections        |
| Lead Gen           | Lead sourcing, CRM, Apollo prospecting                      |
| Sales Research     | Competitive intelligence, market analysis                   |
| Outreach           | Multi-channel campaigns, email sequences                    |
| Financial Analyst  | Budget tracking, forecasting, variance analysis             |
| Operations Analyst | SLA management, inventory, vendor scoring                   |
| TechOps            | Infrastructure monitoring, CI/CD, APM                       |

## Cognitive Architecture

### BDI Cycle

Each agent maintains a 10-file cognitive state:

- `Beliefs.md`, `Desires.md`, `Goals.md`, `Intentions.md`, `Plans.md`
- `Skills.md`, `Observations.md`, `Facts.json`, `Memory.md`, experience logs

The BDI heartbeat service runs every 5 minutes (configurable): perceive environment → update beliefs → reconsider goals → select intentions → execute plans. Results persist to TypeDB for cross-agent reasoning and dashboard visibility.

### Dual-Process Cognitive Router (System 1/System 2)

A 3-tier fast-then-slow pipeline that minimizes LLM calls:

| Tier | Name         | LLM Calls | When                                                                  |
| ---- | ------------ | --------- | --------------------------------------------------------------------- |
| 1    | Reflexive    | 0         | Pattern-matched signals (inbox filters, rule triggers, time-based)    |
| 2    | Analytical   | 1         | Medium-urgency signals (observations, fact changes, goal transitions) |
| 3    | Deliberative | 3–5       | Strategic signals requiring full BDI deliberation                     |

**7 signal scanners** feed the router: inbox, observations, facts, goals, rules, policies, deadlines. Role-based thresholds tune sensitivity (Legal strictest, COO most reflexive).

### Reasoning System

10 formal reasoning modules with a fusion layer for conflict resolution:

Deductive, Inductive, Abductive, Deontic (obligations/permissions), Modal (necessity/possibility), Probabilistic (Bayesian), Causal (do-calculus), Social (trust/reputation/coalition), Analogical (case-based reasoning), and Meta-reasoning (introspection/strategy selection).

## Storage Architecture

MABOS uses a **four-layer storage architecture** — not a single database:

| Layer                 | Technology                                        | What It Stores                                                           | Access Pattern                                               |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Knowledge Graph**   | TypeDB (HTTP driver at `157.230.13.13:8729`)      | Facts, rules, memory, inference, BDI state, decisions, workflows         | Direct `getTypeDBClient()` singleton import — 15+ tool files |
| **ERP Database**      | PostgreSQL (`mabos_erp`, schema `erp`)            | Products, contacts, orders, invoices, financial records                  | SQL via gateway services                                     |
| **Operational State** | Workspace JSON files (`~/.openclaw/workspace/`)   | Catalogs, waitlists, inventory, competitor data, cron jobs, integrations | Local `readJson`/`writeJson` per tool                        |
| **Semantic Search**   | OpenClaw native hybrid (BM25 + vector embeddings) | Agent memory, beliefs, observations, facts as Markdown                   | Auto-indexed via chokidar file watcher                       |

**Key design points:**

- The `OpenClawPluginApi` itself exposes **no database methods** — tools import their own DB clients directly
- TypeDB is the primary knowledge backbone with **dual-layer fallback**: if TypeDB is unavailable, tools gracefully degrade to JSON file storage
- pgvector is **not used** — semantic/vector search is handled by OpenClaw's built-in hybrid search engine
- The memory materializer (`memory-materializer.ts`) writes structured agent data as Markdown files into `agents/{id}/memory/`, which OpenClaw's chokidar watcher auto-indexes for both keyword and semantic search — zero core modifications required
- All TypeQL queries are **agent-scoped**: `$agent isa agent, has uid "agent-id"` ensures data isolation

## Tools & Capabilities

**107 tools** across **36 factory modules**, organized by domain:

- **BDI Core** — belief/desire/goal/intention CRUD, plan execution, BDI cycle trigger
- **Knowledge** — fact store, rule engine, inference, case-based reasoning, ontology management
- **Memory** — episodic/semantic memory, memory hierarchy, materialization
- **Communication** — inter-agent messaging, contract net protocol
- **Reasoning** — formal reasoning tools (10 methods + fusion)
- **Cognitive Router** — demand assessment, routing, status inspection
- **Business Ops** — onboarding, stakeholder management, workforce planning, reporting
- **Marketing & Sales** — campaigns, content, audience segmentation, lead gen, outreach, CRM
- **Finance** — budgeting, forecasting, P&L, metrics tracking
- **Operations** — SLA management, inventory, vendor scoring, supply chain
- **E-Commerce** — Shopify products/orders/inventory, catalog sync, LE waitlist, LE inventory/scarcity
- **Integrations** — Stripe, QuickBooks, Salesforce, HubSpot, Xero, Shopify, GitHub, Google Workspace, Slack, SendGrid, Twilio, Instagram, Apollo, Pictorem, webhooks
- **Tech Ops** — infrastructure monitoring, CI/CD, APM
- **Workflows** — BPMN creation/execution/monitoring, migration

## Knowledge Representation

**TypeDB knowledge graph** with TypeQL query builders for:

- `FactStoreQueries` — SPO triple operations (assert, retract, query, explain)
- `RuleStoreQueries` — Business rule management
- `MemoryQueries` — Memory item storage/recall
- `InferenceQueries` — Pattern matching, goal proving
- `CBRQueries` — Case-based reasoning storage

**Ontology system** with domain-specific JSON-LD schemas:

- Upper ontology (`mabos-upper.jsonld`) — Agent, Goal, Belief, Intention, Decision
- Domain ontologies — business-core, ecommerce, saas, retail, marketplace, consulting
- SHACL/SBVR validation shapes
- Dynamic schema generation from JSON-LD → TypeQL

## Cron System

**CronBridge** syncs MABOS-defined cron jobs to the parent OpenClaw CronService:

- File-based persistence: `cron-jobs.json` in workspace (55 jobs currently)
- WebSocket RPC sync (`cron.add`, `cron.update`, `cron.remove`)
- Each job maps to an isolated agent turn session
- Parent gateway also runs 11 independent cron jobs (Instagram, SEO, Shopify, newsletters)

## Dashboard

**23-page React web UI** (React 19 + TanStack Router + Tailwind CSS + Radix UI):

Overview, Agents, Agent Detail, Analytics, Business Goals, Compliance, Customers, Decisions, E-Commerce, Inventory, Knowledge Graph, Legal, Marketing, Onboarding, Performance, Projects, Suppliers, Supply Chain, Tasks, Timeline, Workflow Editor, Workflows, Accounting

Visualization via XYFlow (workflow graphs), Recharts (metrics), and Dagre (DAG layouts). Data sourced from TypeDB queries with filesystem fallback.

## Enterprise Integrations

15 external service connectors with standardized `integration_setup`/`integration_sync`/`integration_call` patterns:

Stripe, QuickBooks, Salesforce, HubSpot, Xero, Shopify, GitHub, Google Workspace, Slack, SendGrid, Twilio, Instagram (Meta API), Apollo, Pictorem, and generic webhooks.

Credentials stored in `integrations.json` per business directory. OAuth token refresh for Google; API key auth for others.

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx for development)
- **Framework**: OpenClaw Plugin SDK (`openclaw/plugin-sdk`)
- **Knowledge Graph**: TypeDB 3.x (HTTP driver via `typedb-driver-http`)
- **ERP Database**: PostgreSQL 16
- **Schema Validation**: TypeBox (`@sinclair/typebox`)
- **UI**: React 19, TanStack Router/Query, Tailwind CSS 4, Radix UI, XYFlow, Recharts
- **Build**: Vite 7.3, TypeScript 5.4, Vitest
