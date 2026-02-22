# Audit: UX/UI, Design, Monitoring, Integrations & Automations

**Date:** February 2025  
**Scope:** Agent-system dashboard (UX/UI, design, functionality), monitoring/observability, integrations (Stripe, GitHub, Telegram, etc.), automations (cron, webhooks), and use of external services (WhatsApp, Telegram, Slack).

---

## 1. Research: What Others Are Doing

### 1.1 AI agent dashboards & observability (2024–2025)

- **Metrics to track:** Success rate (target 99%), response latency (p95), token usage/cost, tool invocation patterns, decision quality. Teams tracking 20+ metrics maintain ~99.9% uptime vs ~95% for &lt;10 ([Orbital AI](https://orbitalai.in)).
- **Transparency & control:** Surfaces that show reasoning, user modeling, and bias detection in real time increase sense of control and help expose problematic behavior ([TalkTuner / arXiv 2406.07882](https://arxiv.org/abs/2406.07882)).
- **Multi-view layouts:** Visualization mode (trends, live refresh), data mode (raw tables), performance tables (team/user), time-series for ratings and productivity ([Context AI](https://docs.context.ai/agent-dashboard)).
- **Trace visualization:** Hierarchical traces for agent lifecycle—parent/child agents, timing, tool calls, LLM calls, decision points ([Fiddler](https://docs.fiddler.ai/observability/agentic-monitoring)).
- **Filtering:** Active filter display, one-click clear, date range, user/project/team segmentation, shareable filter states.
- **Alerts:** Avoid fatigue; trigger on sustained issues (e.g. success rate &lt;95% for 5+ minutes). Cost monitoring prevents large unexpected LLM bills.

### 1.2 WhatsApp / Telegram & messaging

- **Two-way sync:** Map WhatsApp ↔ Telegram (e.g. one topic per customer) for support at scale; use webhooks + DB for mapping ([n8n](https://n8n.io), [Make](https://www.make.com)).
- **Bot deployment:** Use Telegram for FAQs, scheduling, promotions; sync confirmations to WhatsApp. CRM + chat aggregators improve response times and satisfaction.
- **Setup:** WhatsApp Cloud API (phone number ID + token), Telegram Bot token, DB for mappings, webhook config for both.

### 1.3 Orchestration dashboards

- **OrchVis-style:** Goal-driven decomposition, real-time progress per goal, conflict flagging, planning panel (dependencies, routing), summary pane (rationales, resolutions) ([OrchVis](https://arxiv.org/html/2510.24937v1)).
- **Prefect-style:** Recent runs, error logs, activity timeline, upcoming runs, agent health (e.g. healthy if active in last minute), time/project filters.
- **Balance:** Transparency (dependencies, conflicts) vs autonomy (selective intervention, not micromanagement).

---

## 2. Current State Audit

### 2.1 UX/UI & design

| Area | Current state | Gap |
|------|----------------|-----|
| **Layout** | Sidebar nav, header with search, status | OK; mobile sidebar works. Search is non-functional (no handler). |
| **Theming** | Tailwind; primary/accent/surface; dark | Consistent. No theme toggle or light mode. |
| **Cards/tables** | `.card`, `.table`, badges, status dots | Consistent. Missing: date-range filters, shareable views. |
| **Loading/error** | `QueryState` on Integrations, Activity, Tasks, Dashboard (agents) | Good. Could add skeleton loaders. |
| **Accessibility** | Focus rings on inputs/buttons | Partial. No aria-labels, skip links, or screen-reader audit. |
| **Transparency** | Agent status, last run, success rate | No “reasoning” or trace view; no user-model style controls. |
| **Filters** | Activity (level), Tasks (status) | No global date range; no “clear all filters.” |

### 2.2 Functionality

| Feature | Status | Note |
|---------|--------|------|
| Dashboard | ✅ | Stats, agents, activity, tasks. Alerts stat is hardcoded 0. |
| Agents list/detail | ✅ | Run, enable/disable. No schedule edit in UI. |
| Tasks list/create | ✅ | Modal create; filters. No task detail or cancel. |
| Integrations list | ✅ | DB-backed; no add/configure flow (API exists for health). |
| Activity (logs) | ✅ | Level filter. No agent filter in UI. |
| Settings | ✅ | Local state only; not persisted to backend. |
| Notifications | Bell in header | Unread count; no dropdown or list. |
| **Monitoring** | Partial | Backend has `/api/metrics`, `/api/observability/summary`; no dedicated Monitoring page. |
| **Schedule/cron** | Backend only | Agent has `schedule` (cron); no UI to edit. |
| **Webhooks** | Not in agent-system | OpenClaw main has webhooks; agent-system does not expose. |

### 2.3 Monitoring & observability

- **Backend:** `GET /health`, `GET /status`, `GET /api/observability/summary`, `GET /api/metrics`. Good for dashboards and tooling.
- **Frontend:** Status in sidebar; no dedicated Monitoring page, no time-series charts, no alert config, no trace/tool-call view.
- **Gaps:** No token/cost tracking; no latency percentiles; no “last 24h” or date-range charts.

### 2.4 Integrations

- **Config (backend):** Telegram (`telegram_bot_token`, `telegram_chat_id`), Stripe, GitHub, Notion, Gmail, etc. in `core.config`. Used by agents (e.g. Finance → Stripe, Operations → GitHub).
- **Agent-system UI:** Integrations page lists DB-backed integrations (table `integrations`). No Telegram/WhatsApp/Slack as first-class “channels” in this app; OpenClaw **main** provides WhatsApp/Telegram/etc. as channels to the Gateway.
- **Notification delivery:** Backend has `Notification` model and `channels` (e.g. `["telegram", "email", "desktop"]`). No sending implementation in agent-system (no Telegram/WhatsApp API calls). So: config exists; delivery not wired.

### 2.5 Automations

- **Cron:** Orchestrator runs agents on `schedule` (cron expression). No UI to edit schedule.
- **Celery:** Optional worker/beat; no tasks defined yet.
- **Webhooks:** Not in agent-system. OpenClaw main supports webhooks for triggers.
- **Gaps:** No “Run history” or “Automations” page; no webhook config UI.

### 2.6 Use of WhatsApp, Telegram, etc.

- **OpenClaw main (Gateway):** Provides WhatsApp, Telegram, Slack, Discord, etc. as **channels** for the Pi agent and WebChat. This is the product’s messaging surface.
- **OpenClaw agent-system:** Business agents (Finance, Operations) run in the background. They do **not** directly send WhatsApp/Telegram messages. Config has `telegram_bot_token` / `telegram_chat_id` for **alerts/notifications** (e.g. from agents to operator). So: messaging **to users** is via main; **alerts to operator** can be wired via Telegram (and optionally WhatsApp) when notification delivery is implemented.

---

## 3. Recommended Agents (Workstreams)

| Agent | Focus | Priority |
|-------|--------|----------|
| **UX/Design** | Accessibility (aria, skip link), date-range + clear filters, optional theme toggle, skeleton loaders | P1 |
| **Monitoring** | Dedicated Monitoring page: metrics cards, time-range selector, link to observability API; later: charts, alerts | P1 |
| **Integrations** | Document Telegram/WhatsApp role (alerts vs channels); optional: “Test” button per integration, notification delivery stub | P2 |
| **Automations** | Schedule (cron) edit in Agent detail; Run history (last N runs per agent); optional: Webhooks page if backend adds | P2 |
| **Transparency** | Optional: simple “last run output” or tool-call list for a run (if backend exposes) | P3 |

---

## 4. Checklist (Implementation)

- [x] **Backend:** Fix `/status` to use `TaskStatus.PENDING`.
- [x] **Frontend – Monitoring page:** New route `/monitoring`, fetch `/api/metrics` and `/api/observability/summary`, show metrics cards and agent health table.
- [x] **Frontend – UX:** Add “Clear filters” on Activity and Tasks; `aria-label` on menu and notifications.
- [x] **Frontend – Agents:** Schedule (cron) shown in agent detail (read-only); backend already supports PATCH `schedule`.
- [x] **Docs:** INTEGRATIONS-MESSAGING.md documents WhatsApp/Telegram in main vs agent-system and how to wire Telegram alerts.

---

## 5. References

- Orbital AI, “AI Agent Monitoring & Observability: Production Guide 2025”
- arXiv 2406.07882, “Designing a Dashboard for Transparency and Control of Conversational AI”
- Context AI, “Agent Monitoring Dashboard”
- Fiddler, “Agentic Observability”
- n8n / Make, WhatsApp + Telegram integration
- OrchVis, “Hierarchical Multi-Agent Orchestration for Human Oversight”
- Prefect, “Dashboard” (orchestration UI)
- OpenClaw docs: Gateway, channels, webhooks
