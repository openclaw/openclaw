# Sync & Projection Model

## Single Source of Truth

**SQLite** is the canonical state store for all Command Center data.

```
   Integrations ──┐
   (GHL, Stripe,  │
    Trello,       ├──▶  SQLite  ◀──┤  Syncs
    PostHog)      │     (canonical) │  (GCal, Trello,
                  │                 │   daily reconcile)
   Metrics Jobs ──┘                 │
   (brand tiles,                    │
    pipeline quality,               │
    finance snapshot) ──────────────┘
```

No other system writes operational state. Notion pages are read-only
projections. The web UI is a read-only viewer that submits actions
through the prompt engine.

---

## How Data Flows to Notion

```
  ┌──────────┐     ┌───────────────┐     ┌──────────────────┐
  │  SQLite  │────▶│ DataProvider  │────▶│ Widget Renderer  │
  │          │     │ (per widget)  │     │ (Notion blocks)  │
  └──────────┘     └───────────────┘     └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │ NotionWidgetWriter│
                                          │ (marker replace)  │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  Notion API      │
                                          │  (page update)   │
                                          └──────────────────┘
```

**Trigger**: Cron schedule or manual "Start the Day" action.

**Process**:

1. Widget writer iterates `ALL_WIDGETS` from `widget_registry.py`
2. For each `WidgetSpec`, the registered `DataProvider` callable reads
   pre-aggregated data from SQLite
3. The `renderer` function converts the data dict into Notion API block
   objects (callouts, tables, dividers, toggles)
4. Writer finds marker tags on the target Notion page:
   `[[OPENCLAW:CC_KPIS:START]]` ... `[[OPENCLAW:CC_KPIS:END]]`
5. All blocks between markers are deleted and replaced with fresh output
6. Notion page now displays current data

**Frequency**: Typically once at "Start the Day" + optional cron
(every 4-6 hours). Not real-time.

**Safety**: `safe_mode=True` by default — simulates changes without
writing. Mutations require `write_lock=OFF` and no active cooldown.

---

## How Data Flows to the Local Web UI

```
  ┌──────────┐     ┌────────────────────┐     ┌──────────────┐
  │  SQLite  │────▶│ FastAPI Endpoints  │────▶│ Browser      │
  │          │     │ /admin/cc/panels   │     │ (fetch + DOM)│
  └──────────┘     └────────────────────┘     └──────────────┘
```

**Trigger**: Page load + polling interval (every 30 seconds).

**Process**:

1. Browser loads `index.html` from Vite dev server (port 5174) or
   static mount (`/cc/`)
2. `main.ts` calls `GET /admin/cc/panels`
3. FastAPI aggregator calls existing data builders:
   - `_build_today_data()` — brand KPIs, schedule, overdue, focus window
   - `admin_system_health()` — warnings, compliance, capacity
   - `schedule_status()` — event counts, sync freshness
4. Returns single JSON response with all panel data
5. TypeScript render functions create DOM elements from data
6. `setInterval` re-fetches every 30s for live updates

**Latency**: Sub-second (local network, SQLite reads).

**No safety gate**: Reading data is always safe. No write_lock or
cooldown checks needed for GET endpoints.

---

## Prompt Submission Flow

Both surfaces submit prompts through the same engine:

```
  Web UI Prompt Bar                    Telegram Bot
        │                                   │
        ▼                                   ▼
  POST /admin/cc/prompt              TelegramPromptAdapter
        │                                   │
        ▼                                   ▼
  UIPromptAdapter.handle_prompt()    engine.handle(prompt)
        │                                   │
        └───────────┬───────────────────────┘
                    ▼
          OpenClawPromptEngine.handle()
                    │
                    ▼
          Intent classification
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
        Agent     Action    Workflow
        routing   execution orchestration
          │         │         │
          └─────────┼─────────┘
                    ▼
            EngineResponse
                    │
          ┌─────────┼─────────┐
          ▼                   ▼
  UIPromptAdapter.to_json()  Telegram reply
```

The key principle: **both surfaces use the same engine, the same intent
classifier, the same agents.** The only difference is the adapter that
serializes the response for the target channel.

---

## Why No Bidirectional Sync

### The Problem with Mirroring

If both Notion and the web UI could write state, we would need:

- Conflict detection (which edit wins?)
- Merge resolution (how to combine concurrent changes?)
- Eventual consistency guarantees (when does state converge?)
- Notion API polling (3 req/s limit, high latency)

This is complex infrastructure for minimal benefit.

### The Solution: Asymmetric Projection

- **SQLite** is the only writable state store
- **Both surfaces** are read-only projections
- **Actions** flow through the prompt engine (not through state edits)
- **No conflicts** possible because no surface edits canonical state

```
  WRONG:  Notion ←──→ SQLite ←──→ Web UI    (bidirectional = conflicts)
  RIGHT:  Notion ←── SQLite ──→ Web UI       (asymmetric = no conflicts)
                       ▲
                       │
               Prompt Engine / Admin Actions
                       ▲
                       │
               User (via any surface)
```

### What If the User Edits Something in Notion?

Notion content between widget markers is **overwritten** on the next
widget refresh. Manual edits outside markers are preserved but are not
synced to SQLite. If a user wants to change operational state, they
use the prompt bar or an admin action — not direct Notion editing.

---

## Failure Modes and Fallback

| Scenario                | What Happens                     | Recovery                                 |
| ----------------------- | -------------------------------- | ---------------------------------------- |
| SQLite locked           | Both surfaces show stale data    | SQLite auto-recovers (WAL mode)          |
| FastAPI down            | Web UI shows connection error    | Restart uvicorn; Notion unaffected       |
| Notion API rate-limited | Widget refresh skips; stale data | Retry on next cron cycle                 |
| Notion API down         | Notion shows stale widgets       | No action needed; web UI unaffected      |
| Browser offline         | Web UI unreachable               | Reconnect to local network               |
| Cooldown active         | "Start the Day" skipped          | Wait for cooldown expiry or manual reset |

**Graceful degradation**: Each surface fails independently. A Notion
outage does not affect the web UI. A FastAPI crash does not affect
Notion (it has cached data from the last push).

---

## Data Freshness Comparison

| Data Type         | Web UI Freshness     | Notion Freshness  |
| ----------------- | -------------------- | ----------------- |
| Brand KPIs        | Real-time (30s poll) | Last push (hours) |
| Schedule          | Real-time (30s poll) | Last push (hours) |
| System health     | Real-time (30s poll) | Last push (hours) |
| Overdue items     | Real-time (30s poll) | Last push (hours) |
| Marketing metrics | Real-time (30s poll) | Last push (hours) |

The web UI is always more current than Notion. This is by design —
the web UI is the operational interface, Notion is the executive view.

---

## File References

| File                                                     | Purpose                             |
| -------------------------------------------------------- | ----------------------------------- |
| `fd/packages/agencyu/notion/widgets/widget_registry.py`  | Widget definitions + data contracts |
| `fd/packages/agencyu/notion/widgets/widget_renderers.py` | Notion block renderers              |
| `fd/packages/agencyu/notion/widgets/widgets.py`          | NotionWidgetWriter (cron push)      |
| `fd/services/webhook_gateway/routes/admin_cc.py`         | REST aggregator (web UI pull)       |
| `fd/services/webhook_gateway/routes/admin_today.py`      | Today data builder                  |
| `fd/workspace/prompt_engine/adapters/ui_adapter.py`      | Web prompt adapter                  |
| `packages/command-center/src/api.ts`                     | Browser-side fetch wrappers         |
