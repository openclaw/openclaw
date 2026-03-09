# OpenClaw Master Specification

OpenClaw is the prompt-first operating system that automates growth,
operations, research, and decision support for Full Digital and CUTMV across
a local multi-node cluster.

---

## 1. Mission

Maximize operational leverage for Full Digital LLC and CUTMV. Reduce manual
work, increase profit velocity, surface opportunities faster than competitors,
and free the founder to focus on strategy, creative direction, and
relationships.

### Mission Pillars

1. **Revenue Acceleration** — Automate lead-to-close pipelines, retainer
   upsells, and campaign execution.
2. **Cost Reduction** — Replace manual ops with automated workflows, reduce
   cognitive load on the founder.
3. **Opportunity Discovery** — Continuous grant scanning, market monitoring,
   and trend detection.
4. **Knowledge Compounding** — Persistent memory that retains client
   preferences, project outcomes, and strategic lessons.
5. **Product Growth (CUTMV)** — Marketing automation, conversion optimization,
   and product iteration for the SaaS platform.

---

## 2. Prompt-First Operating Model

OpenClaw is designed as a prompt-first system. It is usable through plain
English prompts across Telegram, the Command Center UI, and Notion-linked
interfaces. Users ask questions, request actions, generate workflows, and
receive step-by-step plans without needing terminal commands or manual shell
execution.

OpenClaw interprets intent, maps prompts to the correct agent and workflow,
applies safety controls, requests approval when needed, and summarizes
outcomes in human language.

See `docs/fd/architecture/PROMPT_FIRST_OPERATING_MODEL.md` for the full
prompt engine specification.

---

## 3. Cluster Architecture

| Node | Role | Duties |
|------|------|--------|
| **M4 Mac Mini** (Brain) | Gateway, orchestrator, webhook receiver | Agent routing, planning, inference coordination |
| **M1 Mac Studio** (Workhorse) | Ollama inference, worker | Research, ad creative gen, landing pages, long-running growth jobs |
| **i7 MacBook Pro** (Sentinel) | Cron, monitoring | Watchdog, alerting, backup agent, failover |

Local inference via **Ollama (Qwen 3.5)** with **Claude (Anthropic)** as
escalation for complex analysis.

See `docs/fd/architecture/CLUSTER_TOPOLOGY.md` for network layout, port map,
and failover strategy.

---

## 4. Storage and Execution Model

- Repo code runs locally on each machine under `~/openclaw`.
- Shared cluster workspace lives on M4 at `/Users/fdclaw-m4/cluster` and is
  mounted over SMB to other nodes as `~/cluster`.
- The shared workspace is used for jobs, logs, results, and artifacts.
- The repo itself, virtual environments, local databases, and secrets are not
  stored in the shared cluster directory.

---

## 5. Agent Architecture (7 Agents, 2 Brands)

### Full Digital LLC (4 Agents)

- **`fulldigital-ops`** — Daily status summaries, approval routing, cluster
  health, internal command center
- **`fulldigital-sales`** — Lead follow-up, outreach drafting, proposals
- **`fulldigital-content`** — Caption writing, hook generation, content
  calendar planning, campaign concepts
- **`fulldigital-finance`** — Grant scanning, bookkeeping, financial reporting

### CUTMV (3 Agents)

- **`cutmv-ops`** — Product roadmap, bug triage, infrastructure, deployment
- **`cutmv-support`** — Customer help, FAQs, onboarding for artists and labels
- **`cutmv-growth`** — Promotional campaigns, announcements, conversion
  messaging

### Intent Routing

Intent classification routes messages to the correct agent based on brand +
domain. Routing configuration lives in `config/fd/intent_mapping.yaml`.
Agent bindings live in `gateway/bindings/{brand}.json`.

See `docs/fd/architecture/AGENT_ROUTING.md` for the full routing spec.

---

## 6. Channel Architecture

| Channel | Purpose | Status |
|---------|---------|--------|
| Telegram | Primary control surface | Active |
| Command Center UI | Dashboard and prompt interface | Active |
| Notion | Knowledge surface and action triggers | Active |
| API | Programmatic access | Available |

All channels accept plain English. No terminal commands, shell scripts, or
file paths required from the user.

---

## 7. Safety Model

### Non-Negotiable Controls

- `DRY_RUN=true` by default — all writes simulated until explicitly opted out
- `KILL_SWITCH` — blocks ALL external writes instantly
- `READ_ONLY` — blocks writes, allows reads
- Every external write must call `check_write_allowed()` then
  `check_dry_run()`
- Every external mutation recorded via `AuditStore.record()`
- All webhook endpoints verify auth (shared secret or Stripe signature)
- Duplicate webhooks rejected via `IdempotencyStore`
- Log redaction strips secrets automatically

### Approval Requirements

Human approval required for:

- Sending outreach or messages to clients/public
- Launching campaigns
- Spending money (ads, tools, services)
- Publishing content externally
- Submitting grants
- Creating invoices
- Modifying production infrastructure
- Deleting data or resources
- Security or access changes

See `docs/fd/architecture/SECURITY_AND_APPROVALS.md` for the full safety spec.

---

## 8. Capabilities by Brand

### Full Digital

**Revenue Automation:**
- Automated lead research and qualification
- Proposal generation and follow-up sequences
- Pipeline health tracking — flags stale deals
- Retainer conversion funnel — auto-detects candidates ($5K+ spend, 2+
  projects) and queues outreach sequences
- VSL optimization — hook variant tracking, retention scoring, conversion
  diagnostics

**Marketing and Content:**
- Caption writing, hook generation, content calendar planning
- Ad creative generation and rotation
- VSL variant A/B testing with retention and conversion scoring

**Finance:**
- Daily grant scanning for Atlanta-based opportunities
- Grant scoring, draft packages, submission support
- Bookkeeping integration and financial reporting

**Client Operations:**
- GoHighLevel CRM integration (pipeline, client comms)
- Trello project management (fulfillment boards)
- Stripe payments and invoicing
- ManyChat lead capture and automated messaging

**Site:** fulldigitalll.com (Webflow + Cloudflare), tracked via GA4 + PostHog

### CUTMV

**Product Ops:**
- Bug triage summaries and code fixes
- Feature prioritization and shipping
- Roadmap management and infrastructure monitoring
- Remotion-based video rendering engine (React video components)

**Growth Engine:**
- Marketing copy, landing page creation, A/B testing
- Ad concept generation (60+ motion specs, premium ad templates)
- Pricing and conversion optimization
- Funnel and retention improvement campaigns

**Customer Support:**
- Onboarding assistance for independent artists, small labels, media teams
- Troubleshooting and FAQ handling
- User activation guidance (first render to conversion)

**Product Stack:** cutmv.com (Vercel + Cloudflare), with Stripe, Supabase,
R2, PostHog, Sentry, Resend, Kickbox, Google/Microsoft OAuth

**Creative Engine:** Full Remotion pipeline with branded motion specs, ad
templates, UI frames, dashboard mocks, and brand asset policies for both
`cutmv` and `fulldigital` logos and overlays.

---

## 9. Event-Driven Architecture

- Webhook gateway (port 8000) receives events from GHL, ManyChat, Stripe,
  Trello
- Orchestrator (port 8001) consumes events, routes decisions, schedules jobs
- Worker (port 8002) executes creative generation, rendering, packaging
- Every event tracked to PostHog with correlation IDs

See `docs/fd/architecture/SYSTEM_OVERVIEW.md` for the full three-layer stack.

---

## 10. Non-Goals and Boundaries

- OpenClaw does not replace CUTMV's production render runtime.
- OpenClaw does not auto-send outreach, launch campaigns, spend money,
  publish content, or submit grants without approval.
- OpenClaw does not require terminal-first operation for normal use.
- OpenClaw does not store code, secrets, or local databases in the shared
  SMB cluster directory.
- OpenClaw exists to grow, operate, optimize, and coordinate the
  businesses — not to become the businesses' primary runtime.

---

## 11. Current State vs Target State

### Current

- Multi-node local cluster architecture
- Agent routing across Full Digital and CUTMV
- Prompt-first design direction
- Telegram as primary control channel
- Command center architecture
- Safety controls and approval philosophy
- Event-driven orchestration model

### Target

- Fully operational prompt engine
- Live command center with contextual guide layer
- Grant discovery and drafting inside Finance
- Marketing automation with approval-safe scaling
- Retainer conversion funnel
- VSL retention optimization
- Team calendar and schedule aggregation
- Cross-node autonomous workflow execution with human oversight

---

## 12. Canonical Document Index

| Document | Location | Purpose |
|----------|----------|---------|
| Soul | `fd/workspace/SOUL.md` | System philosophy, personality, operating principles |
| Identity | `fd/workspace/IDENTITY.md` | Brands served, system boundaries, authority model |
| Mission | `fd/workspace/MISSION.md` | Strategic objectives and prioritization |
| Capabilities | `fd/workspace/CAPABILITIES.md` | Brand-specific capabilities and current vs target state |
| Cluster topology | `docs/fd/architecture/CLUSTER_TOPOLOGY.md` | Machine roles, network layout, failover |
| System overview | `docs/fd/architecture/SYSTEM_OVERVIEW.md` | Three-layer architecture and data flow |
| Agent routing | `docs/fd/architecture/AGENT_ROUTING.md` | Intent classification and agent binding |
| Prompt-first model | `docs/fd/architecture/PROMPT_FIRST_OPERATING_MODEL.md` | Prompt engine specification |
| Model policy | `docs/fd/architecture/MODEL_POLICY.md` | Inference model selection and escalation |
| Security | `docs/fd/architecture/SECURITY_AND_APPROVALS.md` | Safety controls, secrets, approvals |
| Config | `fd/workspace/CONFIG.yaml` | Runtime configuration |
| Intent mapping | `config/fd/intent_mapping.yaml` | Intent-to-agent routing rules |
| Agent bindings | `gateway/bindings/*.json` | Per-brand agent definitions and triggers |
| Entity profiles | `fd/workspace/bank/entities/*.md` | Brand and product profiles |
