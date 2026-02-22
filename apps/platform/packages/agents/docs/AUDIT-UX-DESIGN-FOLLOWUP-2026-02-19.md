# Follow-up UX/UI and Design Audit (Unaudited Areas)

**Date:** February 19, 2026  
**Scope:** `packages/agents/frontend` pages and shared layout/components, plus backend endpoints directly tied to UI affordances.

---

## 1. Why this follow-up exists

The original audit covered broad UX, monitoring, integrations, and automations.  
This follow-up audits areas that were not deeply validated before:

- Interaction integrity (visible controls that do not execute an action)
- Navigation quality (SPA vs full reload behavior)
- Data trust in dashboard metrics
- Accessibility semantics for overlays and icon-only controls
- Small UI consistency defects

---

## 2. Findings (ordered by severity)

| ID | Severity | Finding | Evidence | Impact | Recommendation |
|----|----------|---------|----------|--------|----------------|
| F-01 | P1 | Integrations page exposes multiple primary controls with no behavior wired | `packages/agents/frontend/src/pages/Integrations.tsx:47`, `packages/agents/frontend/src/pages/Integrations.tsx:76`, `packages/agents/frontend/src/pages/Integrations.tsx:127`, `packages/agents/backend/main.py:501` | Users click critical CTAs ("Add Integration", per-card settings, available integration buttons) and nothing happens, reducing product trust | Wire actions end-to-end or render disabled state with "Coming soon" and hide unavailable controls |
| F-02 | P1 | Settings navigation includes a `Database` section, but there is no corresponding content panel | `packages/agents/frontend/src/pages/Settings.tsx:19`, `packages/agents/frontend/src/pages/Settings.tsx:70` | Selecting "Database" appears broken and creates a dead-end view | Add a database settings panel or remove the section from navigation until implemented |
| F-03 | P1 | Monitoring retry path refreshes summary only; metrics query can remain failed | `packages/agents/frontend/src/pages/Monitoring.tsx:23`, `packages/agents/frontend/src/pages/Monitoring.tsx:45`, `packages/agents/frontend/src/pages/Monitoring.tsx:99` | Users can hit "Try again"/"Refresh" and still not recover all monitoring data | Retry both queries (`summary` and `metrics`) from shared retry actions |
| F-04 | P1 | Agent list uses raw anchor navigation, causing full page reload in SPA | `packages/agents/frontend/src/pages/Agents.tsx:184` | Reload drops in-memory state and introduces avoidable navigation latency | Replace `<a href>` with React Router `Link`/`NavLink` |
| F-05 | P2 | Dashboard shows hardcoded KPI values (trend and alerts) | `packages/agents/frontend/src/pages/Dashboard.tsx:203`, `packages/agents/frontend/src/pages/Dashboard.tsx:208` | Misleading metrics reduce confidence in operational dashboard accuracy | Compute trend and alerts from backend data, or hide cards until data exists |
| F-06 | P2 | Header search field is rendered but has no interaction logic | `packages/agents/frontend/src/components/Layout.tsx:152` | Creates false discoverability expectations and can be mistaken for a bug | Implement search behavior (route/global filter) or remove the input until ready |
| F-07 | P2 | Overlay/dialog accessibility semantics are incomplete | `packages/agents/frontend/src/components/Layout.tsx:80`, `packages/agents/frontend/src/pages/Tasks.tsx:120`, `packages/agents/frontend/src/pages/Tasks.tsx:124` | Keyboard and assistive tech users do not get robust modal/sidebar behavior (naming, focus management, dialog semantics) | Add `aria-label` for icon-only close controls, `role="dialog"` + `aria-modal`, focus trap, and Esc-to-close |
| F-08 | P3 | `btn-icon-sm` utility class is used but not defined in stylesheet | `packages/agents/frontend/src/pages/Tasks.tsx:126`, `packages/agents/frontend/src/index.css:73` | Modal close button styling can be inconsistent with the rest of the system | Define `.btn-icon-sm` or replace usage with `.btn-icon` and size utilities |

---

## 3. Implementation status (February 19, 2026)

- [x] Resolve integration affordance integrity (F-01)
- [x] Fix missing database settings panel (F-02)
- [x] Make monitoring retries refresh all failed queries (F-03)
- [x] Convert agent list navigation to SPA links (F-04)
- [x] Remove hardcoded dashboard KPIs (F-05)
- [x] Implement header search behavior (F-06)
- [x] Improve modal/sidebar accessibility semantics (F-07)
- [x] Normalize icon button sizing utilities (F-08)

---

## 4. Notes

- This document is an addendum to: `packages/agents/docs/AUDIT-UX-MONITORING-INTEGRATIONS.md`.
- The goal is to close unaudited UX/UI gaps before a new implementation wave, so subsequent design work starts from a stable and trustworthy baseline.

---

## 5. Manual validation pass

Desktop and mobile flows were revalidated in-browser on February 19, 2026:

- Search (header): result dropdown and Enter-to-search route transition.
- Tasks: URL-based search filter (`/tasks?search=`), clear-search control, and empty states.
- New Task modal: Escape-to-close, backdrop close, focus trap behavior, and dialog semantics.
- Navigation: agent list SPA transitions and mobile sidebar open/close behavior.
- Monitoring: retry/refresh actions with loaded summary + metrics.
- Integrations: unavailable affordances shown as disabled, with explicit "soon" messaging.
