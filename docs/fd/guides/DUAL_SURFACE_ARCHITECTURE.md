# Dual-Surface Command Center Architecture

## Overview

The OpenClaw Command Center operates across **two surfaces** that share
a single canonical data layer:

| Surface          | Role                              | Update Model                                               |
| ---------------- | --------------------------------- | ---------------------------------------------------------- |
| **Local Web UI** | Primary operational interface     | On-demand pull (browser fetches REST API)                  |
| **Notion**       | Executive / collaboration surface | Scheduled push (widget writer cron replaces marker blocks) |

Both surfaces read from the same source of truth: **SQLite** (populated by
daily syncs, integration webhooks, and metrics aggregation jobs).

Neither surface writes back to SQLite. User actions go through the
Prompt Engine or admin action endpoints.

---

## Why Two Surfaces

**Local Web UI** — fast, responsive, always available on the local network.
No dependency on Notion API rate limits or uptime. Designed for real-time
operational use: checking the day, submitting prompts, reviewing approvals.

**Notion** — collaborative, linkable, embeddable in team workflows.
Notion pages can be shared, commented on, and referenced in other Notion
databases. Designed for executive review and async collaboration.

The two surfaces are **not mirrors** — they are **projections** of the
same canonical state, optimized for different use cases.

---

## Canonical State Model

```
                         ┌─────────────┐
                         │   SQLite     │
                         │  (canonical  │
                         │   state)     │
                         └──────┬──────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
          ┌──────▼──────┐  ┌───▼───┐  ┌───────▼───────┐
          │ Integrations│  │ Syncs │  │ Metrics Jobs  │
          │ (GHL,Stripe,│  │(GCal, │  │ (daily agg,   │
          │  Trello,    │  │Trello)│  │  brand tiles)  │
          │  PostHog)   │  │       │  │               │
          └─────────────┘  └───────┘  └───────────────┘
```

**Data producers** (integrations, syncs, metrics jobs) write to SQLite.

**Data consumers** (web UI, Notion) read from SQLite via different
mechanisms:

```
  SQLite ──── REST API (/admin/cc/*) ──── Local Web UI (on-demand fetch)
    │
    └──── Widget Data Providers ──── Notion Widget Writer (cron push)
```

---

## Data Flow: Local Web UI

```
1. Browser loads Command Center at localhost:5174 (dev) or /cc/ (production)
2. main.ts calls GET /admin/cc/panels
3. FastAPI aggregator endpoint calls:
   - _build_today_data() → brand KPIs, schedule, overdue, focus window
   - admin_system_health() → warnings, cooldown, compliance, queue depth
   - schedule_status() → last runs, event counts, conflicts
4. JSON response returned to browser
5. Panel render functions create DOM from response data
6. Auto-refresh polls /admin/cc/panels every 30s
```

**Prompt submission:**

```
1. User types in prompt bar, hits Enter
2. POST /admin/cc/prompt { text: "...", brand_hint: "..." }
3. UIPromptAdapter wraps text in UserPrompt(channel="ui")
4. OpenClawPromptEngine.handle() classifies intent, routes to agent
5. EngineResponse serialized via UIPromptAdapter.to_json()
6. Response rendered in prompt result area
```

---

## Data Flow: Notion

```
1. Cron triggers widget writer (typically on "Start the Day" or scheduled)
2. NotionWidgetWriter iterates ALL_WIDGETS from widget_registry.py
3. For each WidgetSpec:
   a. DataProvider callable reads from SQLite (pre-aggregated views)
   b. Renderer function converts data to Notion API block objects
   c. Writer finds marker tags on Notion page:
      [[OPENCLAW:CC_KPIS:START]] ... [[OPENCLAW:CC_KPIS:END]]
   d. Content between markers is replaced with fresh rendered blocks
4. Notion pages now show current data
```

**No bidirectional sync.** Notion is a projection target, not a source of
truth. Users do not edit widget content in Notion — they use the prompt
bar (web UI or Telegram) to trigger actions.

---

## Asymmetric Projection Model

| Dimension          | Local Web UI                           | Notion                      |
| ------------------ | -------------------------------------- | --------------------------- |
| **Read mechanism** | REST fetch on page load + polling      | Cron push via widget writer |
| **Latency**        | Real-time (seconds)                    | Batch (minutes to hours)    |
| **Interactivity**  | Full: prompt bar, buttons, hover cards | Read-only projection        |
| **Availability**   | Depends on local cluster (FastAPI)     | Depends on Notion API       |
| **Granularity**    | 5 panels, drill-down capable           | 24 widgets, fixed layout    |
| **Auth**           | X-Admin-Token header                   | Notion workspace access     |

---

## Panel ↔ Widget Mapping

| Web UI Panel  | Notion Widgets                                            |
| ------------- | --------------------------------------------------------- |
| Today         | `cc.kpis`, `cc.executive_strip`, `cc.alerts`              |
| Schedule      | `cc.calendar`, `cc.projects`                              |
| KPI Chips     | `cc.kpis`, `cc.fd`, `cc.cutmv`, `cc.global`               |
| System Health | `cc.systems_reliability`, `cc.fix_list`, `cc.db_registry` |
| Approvals     | `cc.quick_actions`                                        |

The web UI groups related information into 5 panels for operational
clarity. Notion spreads the same data across 24 widgets for detailed
Notion-native display.

---

## No Bidirectional Mirroring

The system explicitly avoids bidirectional sync because:

1. **Conflict resolution is expensive** — two surfaces editing the same
   data creates merge conflicts that require complex reconciliation logic.
2. **Notion API rate limits** — polling Notion for changes is slow and
   rate-limited (3 requests/second).
3. **SQLite is always canonical** — if Notion and SQLite disagree, SQLite
   wins. There is no scenario where Notion should be the source of truth
   for operational data.
4. **Actions flow through the prompt engine** — both surfaces submit
   actions through the same prompt engine or admin action endpoints,
   ensuring consistent state transitions.

---

## Failure Modes

| Failure            | Web UI Impact                | Notion Impact                              |
| ------------------ | ---------------------------- | ------------------------------------------ |
| SQLite unavailable | Panels show error state      | Widgets show stale data                    |
| FastAPI down       | UI cannot load               | No impact (Notion has cached data)         |
| Notion API down    | No impact                    | Widget refresh fails (stale data persists) |
| Network offline    | UI loads if on local network | Notion inaccessible                        |

Both surfaces degrade gracefully — neither crashes the other.

---

## File References

| File                                                    | Purpose                              |
| ------------------------------------------------------- | ------------------------------------ |
| `fd/services/webhook_gateway/routes/admin_cc.py`        | Aggregator REST endpoints for web UI |
| `fd/services/webhook_gateway/routes/admin_today.py`     | Today panel data builder             |
| `fd/services/webhook_gateway/routes/admin_health.py`    | System health data                   |
| `fd/services/webhook_gateway/routes/admin_schedule.py`  | Schedule data                        |
| `fd/workspace/prompt_engine/adapters/ui_adapter.py`     | Web prompt submission handler        |
| `fd/workspace/guide/adapters/ui.py`                     | Panel help content + walkthrough     |
| `fd/packages/agencyu/notion/widgets/widget_registry.py` | Notion widget definitions            |
| `fd/packages/agencyu/notion/widgets/widgets.py`         | NotionWidgetWriter                   |
| `packages/command-center/`                              | Local web UI package                 |
