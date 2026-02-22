# OpenClaw

Monorepo for OpenClaw — an open-source AI agent framework and dashboard.

---

## 🎯 Our Setup

> **Always-on AI agent operations center** — a dedicated Mac Studio for **Abdulrahman** and **Abdulaziz**, running autonomous agents 24/7.

### What We're Building

A fleet of AI agents that work **day and night**, orchestrated from a single Mission Control dashboard. The Mac Studio serves as a dedicated AI workstation — agents execute tasks autonomously while operators monitor, dispatch, and steer from any device.

| Capability | How |
|---|---|
| **24/7 autonomous agents** | Long-running agents execute tasks continuously on the Mac Studio |
| **Multi-model AI** | Local models (Ollama — Llama, Mistral, Qwen, DeepSeek) + cloud APIs (GPT, Claude, Gemini) running simultaneously |
| **One dashboard** | Mission Control gives a unified view of all agents, tasks, costs, and activity |
| **Remote management** | Control agents from WhatsApp, Telegram, Signal, or any computer with a browser |
| **Self-improving agents** | Learning Hub teaches agents from past work, building institutional knowledge |

### Current Priorities

1. **UX/UI & Page Development** — Building polished, functional pages for every dashboard view (Kanban, Agents, Chat, Orchestrator, Settings, etc.)
2. **Backend Utilization** — Deep understanding and full utilization of the OpenClaw gateway, agent runtime, and API surface
3. **Learning Hub** — Making the Learning Hub fully functional so agents continuously improve from experience
4. **Dashboard Knowledge** — Comprehensive understanding of Mission Control's architecture, capabilities, and extension points
5. **Remote Control Research** — Deeper research into secure remote access patterns (messaging integrations, VPN/Tailscale, etc.) — details to follow

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mac Studio (Always On)                      │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  OpenClaw Gateway │  │   Local Models   │  │  Cloud APIs  │  │
│  │  (Agent Runtime)  │  │  Ollama/LMStudio │  │ GPT · Claude │  │
│  │  Port 18789       │  │  Llama · Mistral │  │ Gemini       │  │
│  │                   │  │  Qwen · DeepSeek │  │ DeepSeek     │  │
│  └────────┬──────────┘  └────────┬─────────┘  └──────┬───────┘  │
│           │                      │                    │          │
│  ┌────────┴──────────────────────┴────────────────────┴───────┐  │
│  │              Mission Control Dashboard                     │  │
│  │              Next.js · localhost:3000                       │  │
│  │                                                            │  │
│  │  Kanban · Agents · Chat · Orchestrator · Learning Hub      │  │
│  │  Costs · Approvals · Cron · Logs · Settings · Channels     │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                      │
└───────────────────────────┼──────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
      ┌─────┴─────┐  ┌─────┴─────┐  ┌──────┴──────┐
      │ Telegram   │  │ WhatsApp  │  │  Browser    │
      │ Signal     │  │ Discord   │  │ (any device)│
      └────────────┘  └───────────┘  └─────────────┘
            Remote Control & Notifications
```

---

## Structure

```
apps/
└── dashboard/     # Mission Control UI (Next.js 16, React 19, Tailwind 4)
                   # 20 views, 46 API endpoints, SQLite, WebSocket

packages/
├── core/          # OpenClaw engine, runtime, plugins, channels
└── agents/        # Agent orchestration (FastAPI + React)
```

## Quick Start

```bash
cd apps/dashboard
npm install
npm run dev
# → http://localhost:3000
```

## Docs

- [Workspace Index](./INDEX.md) — full map of all directories and entry points
- [Dashboard README](./apps/dashboard/README.md) — features, setup, API reference, community use cases
- [Dashboard Directory](./apps/dashboard/DIRECTORY.md) — codebase map and conventions
- [Security Audit](./SECURITY-AUDIT-2026-02-16.md) — latest security remediation report
- [Full Audit & Roadmap](./AUDIT.md) — architecture audit and long-running agent research
