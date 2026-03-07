# OpenClaw Prompt Engine

## Purpose

OpenClaw is a **prompt-first business operating system**.  Users interact
with OpenClaw through plain English prompts — not shell commands, not
scripts, not config files.

The Prompt Engine is the layer that sits between:

- **human language** (Telegram, Command Center UI, Notion)
- **business systems** (GHL, Stripe, Trello, Notion, Google Calendar)
- **the automation engine** (orchestrator, workers, job queue)

## Core Flow

```
Prompt → Interpret → Context → Route → Plan → Safety → Execute → Summarise
```

1. **Interpret** — Rule-first intent classification.  Deterministic patterns
   run first; an LLM pass can be added for fuzzy cases, but the engine
   never hallucinate workflows.
2. **Context** — Gather the minimum useful business/system context (schedule,
   finance summary, memory notes) with a short-lived TTL cache.
3. **Route** — Map intent to a named workflow and target agent.
4. **Plan** — Build a structured list of action steps with risk levels.
5. **Safety** — Enforce DRY_RUN, KILL_SWITCH, READ_ONLY.  Flag medium/high
   risk steps for approval.
6. **Execute** — Walk the plan step-by-step via pluggable executors.
7. **Summarise** — Explain what happened in plain English.

## User-Facing Promise

| Prompt to… | Example |
|------------|---------|
| **talk** | "What should we focus on today?" |
| **action** | "Find grants for Full Digital and draft the top two." |
| **code** | "Check if the cluster is healthy." |
| **workflow** | "Scale winners carefully but don't exceed budget." |

## Design Principles

OpenClaw should **always**:

- Speak in plain English
- Hide system complexity
- Use existing business/system knowledge
- Ask for approval on sensitive actions
- Summarise results clearly
- Remember context within a conversation

OpenClaw should **never** require:

- Terminal commands
- Direct script execution by the user
- System-specific technical knowledge
- Knowledge of internal executor names or payloads

## File Map

```
openclaw/prompt_engine/
├── __init__.py          # Public API: OpenClawPromptEngine, UserPrompt
├── types.py             # Core data types (UserPrompt, Intent, ActionPlan, …)
├── interpreter.py       # Rule-first intent classification
├── context.py           # Context builder with TTL cache
├── router.py            # Intent → workflow + agent routing
├── planner.py           # Workflow-specific action plan builders
├── safety.py            # Safety gate (DRY_RUN, KILL_SWITCH, approvals)
├── registry.py          # Pluggable executor registry
├── executors.py         # Plan executor + built-in workflow executors
├── responders.py        # Human-readable response builder
├── memory.py            # Conversation history + persistent notes
├── summarizer.py        # Plan previews, approval cards, execution summaries
├── prompts.py           # LLM prompt templates (for fuzzy classification)
└── adapters/
    ├── telegram_adapter.py   # Telegram ↔ engine bridge
    ├── ui_adapter.py         # Command Center UI ↔ engine bridge
    └── notion_adapter.py     # Notion action surface ↔ engine bridge
```

## Supported Workflows

| Workflow | Agent | What it does |
|----------|-------|-------------|
| `grantops` | fulldigital-finance | Scan, score, summarise, submit grants |
| `marketing_ops` | fulldigital-content / cutmv-growth | Analyse campaigns, propose next actions |
| `content_generation` | fulldigital-content / cutmv-growth | Generate ad hooks, captions, scripts |
| `system_health` | fulldigital-ops / cutmv-ops | Check cluster, gateway, Ollama status |
| `daily_guidance` | fulldigital-ops / cutmv-ops | Today's priorities, deadlines, focus areas |
| `sales_ops` | fulldigital-sales | Pipeline status, follow-up suggestions |
| `approvals` | fulldigital-ops / cutmv-ops | Process approve/deny decisions |

## Safety Controls

All safety controls from the platform are enforced:

- **DRY_RUN=true** (default) — all writes simulated
- **KILL_SWITCH=true** — blocks ALL external writes immediately
- **READ_ONLY=true** — blocks writes, allows reads
- Medium/high risk steps automatically route through the approval layer
- Every external mutation is recorded via `AuditStore.record()`

## Multi-Turn Conversations

The engine maintains per-conversation turn history (sliding window,
default 20 turns) and per-user notes (last brand used, preferences).
This enables:

- "Do the same thing for CUTMV" (references previous brand context)
- Remembering which brand a user typically works with
- Building on previous answers within a session

## Extension Points

### Adding a new workflow

1. Add a planner method in `planner.py`
2. Add an entry to `_WORKFLOW_BUILDERS`
3. Create an executor class in `executors.py`
4. Register it in `register_default_executors()`
5. Add routing entries in `router.py`

### Adding a new channel

1. Create an adapter in `adapters/`
2. Convert channel messages to `UserPrompt`
3. Call `engine.handle(prompt)`
4. Send `response.reply` back to the channel

### Replacing a stub executor

Each built-in executor returns stub data.  Replace by implementing the
`StepExecutor` protocol and calling `registry.register("name", instance)`.
