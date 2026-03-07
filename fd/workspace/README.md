# OpenClaw — Full Digital + CUTMV Operations System

OpenClaw is a prompt-first autonomous operations system for
**Full Digital LLC** and **CUTMV**. Users talk to it in plain English.
It interprets intent, builds safe action plans, and executes workflows
across a local three-node cluster.

---

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env
# Fill in API keys, tokens, and cluster config

# 2. Start the gateway (M4)
make gateway-start

# 3. Start cluster services
make cluster-start

# 4. Verify health
make healthcheck

# 5. Talk to OpenClaw via Telegram or Command Center UI
```

---

## Cluster Layout

| Node | Role | Key services |
|------|------|-------------|
| **M4 Mac Mini** | Brain | Gateway (18789), orchestrator (8001), webhook-gateway (8000) |
| **M1 Mac Studio** | Workhorse | Ollama (11434), worker (8002), heavy compute |
| **i7 MacBook Pro** | Sentinel | Cron, monitoring, failover, backup execution |

---

## How It Works

```
You say something → OpenClaw interprets → builds a plan → safety check → execute → summarize
```

Supported workflows:

- **GrantOps** — scan, score, and draft grant applications
- **Marketing Ops** — campaign analysis, next-action proposals
- **Content Generation** — ad hooks, captions, scripts via Ollama + Remotion
- **System Health** — cluster, gateway, and model status checks
- **Daily Guidance** — today's priorities, deadlines, and focus areas
- **Sales Ops** — pipeline status and follow-up suggestions
- **Approvals** — approve or deny pending actions

---

## Directory Structure

```
openclaw/
├── SOUL.md              # Agent philosophy, personality, decision framework
├── IDENTITY.md          # Who the agent is, who it serves, authority model
├── MISSION.md           # Primary objectives and strategic priorities
├── OPERATING_RULES.md   # Non-negotiable rules, safety controls, approval protocol
├── SECURITY.md          # Secrets, network security, filesystem boundaries
├── CONFIG.yaml          # Runtime configuration
├── clawdbot.json        # OpenClaw gateway config anchor
│
├── config/              # Runtime YAML configs
│   ├── models.yaml      # Model selection and routing
│   ├── routing.yaml     # Node assignment rules
│   ├── skills.yaml      # Enabled capabilities
│   └── schedules.yaml   # Cron jobs and scheduled tasks
│
├── memory/              # Persistent knowledge
│   ├── memory.md        # Core durable memory
│   ├── projects.md      # Active projects across both brands
│   ├── clients.md       # Client facts and preferences
│   └── cutmv.md         # CUTMV-specific product memory
│
├── bank/                # Structured entity profiles
│   ├── entities/
│   │   ├── full-digital.md
│   │   └── cutmv.md
│   ├── opinions.md      # Working beliefs and hypotheses
│   └── active-context.md # What matters this week
│
├── prompts/             # LLM prompt templates
│   ├── system.md        # Base instruction layer
│   ├── planner.md       # Work decomposition
│   ├── executor.md      # Action execution
│   └── reviewer.md      # Output quality review
│
├── tasks/               # Work management
│   ├── inbox.md         # Raw incoming work
│   ├── queue.md         # Prioritized work queue
│   ├── approvals.md     # Pending approval items
│   └── completed.md     # Completed task ledger
│
├── ops/                 # Operations documentation
│   ├── runbook.md       # Start, stop, recover, inspect
│   ├── node-map.md      # Node roles and responsibilities
│   ├── failure-recovery.md # Failure scenarios and responses
│   └── maintenance.md   # Updates, backups, key rotation
│
├── brain/               # Agent reasoning framework
│   ├── memory.md        # How the agent uses memory
│   ├── knowledge.md     # Knowledge organization
│   ├── reasoning.md     # Decision-making process
│   └── decision_rules.md # Explicit decision rules
│
├── tools/               # Capability registry
│   ├── tool_registry.md # Available tools and their status
│   └── tool_specs.md    # Tool specifications and usage
│
├── control/             # Autonomy controls
│   ├── approval_rules.md # When approval is required
│   ├── risk_levels.md   # Risk classification system
│   └── human_override.md # How DA overrides the agent
│
├── scripts/             # Operational scripts
│   ├── boot.sh          # Start services in order
│   ├── healthcheck.sh   # Verify cluster health
│   ├── sync-memory.sh   # Sync memory across nodes
│   └── failover.sh      # Move jobs to backup node
│
├── logs/                # Agent activity logs
│   └── README.md        # Log format and retention policy
│
└── prompt_engine/       # Python orchestration layer
    ├── engine.py        # Main pipeline
    ├── interpreter.py   # Intent classification
    ├── planner.py       # Action plan generation
    ├── safety.py        # Safety gate
    ├── executors.py     # Workflow executors
    └── adapters/        # Channel bridges (Telegram, UI, Notion)
```

---

## Safety Model

| Control | Default | Effect |
|---------|---------|--------|
| `DRY_RUN` | `true` | All writes simulated |
| `KILL_SWITCH` | `false` | Blocks all external writes when active |
| `READ_ONLY` | `false` | Blocks writes, allows reads |

High-risk actions (spend, publish, delete) always require DA's approval.

---

## Key Commands

| Command | What it does |
|---------|-------------|
| `make dev` | Start dev server |
| `make test` | Run tests |
| `make lint` | Lint with ruff |
| `make gateway-start` | Start OpenClaw Gateway on M4 |
| `make cluster-start` | Start all services on all nodes |
| `make healthcheck` | Full cluster health check |
| `make warm-models` | Pre-warm Ollama models on M1 |
| `make failover` | Check M1 + failover to M4 if needed |

---

## Core Docs

| Document | Purpose |
|----------|---------|
| [SOUL.md](SOUL.md) | Agent philosophy and personality |
| [IDENTITY.md](IDENTITY.md) | System identity and authority model |
| [MISSION.md](MISSION.md) | Objectives and strategic priorities |
| [OPERATING_RULES.md](OPERATING_RULES.md) | Non-negotiable rules and safety |
| [SECURITY.md](SECURITY.md) | Security model and boundaries |
