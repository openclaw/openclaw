# System Overview — OpenClaw + Full Digital / CUTMV

## Architecture

OpenClaw serves as the **command center and orchestration layer** for both
Full Digital (agency) and CUTMV (SaaS). Local Ollama models handle inference.
The existing webhook gateway, orchestrator, and workers continue to handle
event-driven automation.

```
                           ┌───────────────────────┐
                           │  Telegram / Discord    │
                           │  Internal control UI   │
                           └───────────┬───────────┘
                                       │
                              ┌────────▼────────┐
                              │   M4 Mac mini    │
                              │ OpenClaw Gateway │
                              │ routing / cron   │
                              │ approvals        │
                              └────────┬────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                   │
          ┌─────────▼─────────┐ ┌──────▼──────┐ ┌──────────▼──────────┐
          │   M1 Mac Studio   │ │  External   │ │ i7 MacBook Pro      │
          │ Ollama primary    │ │ APIs:       │ │ utility worker      │
          │ queue workers     │ │ Notion /    │ │ testing / overflow  │
          │ heavier agents    │ │ Trello /    │ │ browser automation  │
          └───────────────────┘ │ Stripe/etc  │ └─────────────────────┘
                                └─────────────┘
```

## Three-Layer Stack

| Layer | Component | Description |
|-------|-----------|-------------|
| **Control** | OpenClaw Gateway (M4) | Channel routing, agent binding, cron, approvals |
| **Inference** | Ollama (M1 primary, M4 fallback) | Local LLM for agent tasks |
| **Execution** | Workers + Webhook Gateway | Event-driven automation, job queue, API integrations |

## How It Fits Together

1. **Inbound messages** arrive via Telegram/Discord/Slack → OpenClaw Gateway on M4
2. **Gateway classifies** intent and routes to the correct agent (7 agents across 2 brands)
3. **Agent inference** runs on M1 Ollama (primary) or M4 Ollama (fallback)
4. **Actions** route through the existing event-driven pipeline:
   - Webhook Gateway (port 8000) for inbound webhooks from GHL/Stripe/etc.
   - Orchestrator (port 8001) for business logic and job scheduling
   - Workers (port 8002) for creative generation and long-running tasks
5. **Approvals** flow back through Telegram before any risky action executes

## What Changed from Previous Architecture

| Before | After |
|--------|-------|
| M1 = controller/orchestration | M1 = **primary inference + heavy worker** |
| M4 = storage + compute | M4 = **Gateway + coordinator** (always-on brain stem) |
| i7 = compute worker | i7 = **utility/overflow/testing** |
| No AI agent layer | **7 OpenClaw agents** with isolated workspaces |
| No local inference | **Ollama with Qwen 3.5** on M1 (primary) + M4 (fallback) |
| Direct webhook processing only | **Gateway → Agent → Action** pipeline |

## Key Principle

> OpenClaw = command center and orchestration layer
> Ollama = local inference layer
> Workers/queues = heavy operational jobs

The Gateway coordinates. The Mac Studio does the heavy lifting.
The Mac mini keeps everything running. The MacBook helps without becoming a bottleneck.
