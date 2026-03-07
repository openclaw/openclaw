# Command Center — Prioritized Next Steps

Ordered by impact. These should be tackled after the CC has been used daily
for at least a few days and real usage patterns emerge.

---

## Tier 1: Foundation (do first)

### 1. Seed canonical SQLite state

**Impact:** High — panels show empty/error without real data
**Effort:** Low

Ensure `_build_today_data()`, schedule sync, and health checks produce
meaningful output even on a fresh database. Run `Start the Day` once to
populate schedule events. Verify KPI metrics have reasonable defaults.

### 2. Define real panel data contracts

**Impact:** High — prevents drift between frontend types and backend shapes
**Effort:** Medium

Replace the 6 `unknown`/`Record<string, unknown>` fields in `api.ts` with
concrete TypeScript interfaces that match the exact backend response shapes.
Add a shared types file if needed. This catches shape mismatches at compile
time instead of runtime.

### 3. Connect live integrations one by one

**Impact:** High — makes the dashboard operational, not decorative
**Effort:** Medium per integration

Priority order:

1. Schedule sync (GCal + Trello) — the "Start the Day" flow
2. Health checks (cooldown, queue depth, compliance)
3. Brand KPIs (revenue metrics, campaign counts)
4. Approval queue (pending scheduled actions)

Test each integration by triggering it and watching the panel update.

---

## Tier 2: Reliability (do second)

### 4. Add error recovery and retry

**Impact:** Medium — prevents stuck states after transient failures
**Effort:** Low

If a panel fetch fails 3 times in a row, show a "Retry" button on that
specific panel instead of silently failing. The connection indicator already
goes red — add a per-panel retry capability.

### 5. Auth token management

**Impact:** Medium — current `prompt()` flow is fragile
**Effort:** Low

Replace the browser `prompt()` with a proper login overlay:

- Token input field with show/hide toggle
- "Test connection" button that hits `/health/` to verify
- Clear error messaging if token is wrong
- Token persists in localStorage (already done)

### 6. WebSocket or SSE for critical panels

**Impact:** Medium — removes 30s polling delay for urgent changes
**Effort:** Medium

Replace the 30-second `setInterval` with SSE (Server-Sent Events) for
panels that benefit from real-time updates: Health (cooldown changes),
Approvals (new items). Keep polling as fallback. Don't over-engineer —
SSE is simpler than WebSocket for one-directional server pushes.

---

## Tier 3: UX Polish (do when stable)

### 7. Action buttons on approval items

**Impact:** Medium — makes approvals panel actionable, not just informational
**Effort:** Medium

Add "Approve" and "Dismiss" buttons to each approval item. Wire to
`POST /admin/actions/{id}/approve` and `/dismiss` endpoints. Show
confirmation toast. Refresh approvals panel after action.

### 8. Panel collapse and drag-to-reorder

**Impact:** Low-Medium — personalization for daily use
**Effort:** Medium

Let each panel collapse to header-only. Store collapsed state in
localStorage. Later: drag-to-reorder for the grid layout.

### 9. Keyboard shortcuts

**Impact:** Low-Medium — speed for power users
**Effort:** Low

- `Cmd+K` or `/` → focus prompt bar
- `R` → manual refresh
- `1-5` → expand/focus specific panel
- `Escape` → close hover cards, walkthrough

### 10. Theme customization

**Impact:** Low — cosmetic, but signals maturity
**Effort:** Low

Add a light theme toggle alongside Simple mode. The CSS variables
(`--bg-body`, `--bg-card`, etc.) already support this — just swap the
values. Store preference in localStorage.

---

## Not recommended yet

These are commonly requested but premature until the above are solid:

- **Mobile-native app** — the responsive CSS handles tablet/phone already
- **Multi-user auth** — this is a single-operator system
- **Real-time collaboration** — this is a solo dashboard, not a team tool
- **Third-party integrations dashboard** — keep scope tight
- **AI-powered panel suggestions** — solve real workflow problems first
