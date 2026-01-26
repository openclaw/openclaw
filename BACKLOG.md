# ClawdBrain — Backlog

Clawdbot fork with Second Brain / Autonomous Evolution enhancements.
Tech stack: TypeScript, Node.js (pnpm), Lit web components (UI), Clawdbot gateway architecture.

This file tracks work items for autonomous development.

## Status Key
- `[ ]` — Not started
- `[~]` — In progress
- `[x]` — Complete
- `[!]` — Blocked (needs human input)

---

## P1 — Landing Page

Branch: `landing-page-ux` | Design doc: `docs/plans/2026-01-25-landing-page-design.md`

- [x] Complete landing page structure (PR #13 — `autodev-landing-page`)
- [x] Polish landing page copy and design (PR #13)
- [~] Mobile navigation + accessibility improvements (PR from `landing-page-ux`)
- [ ] Implement interactive demos/previews (live Overseer visualization, chat preview)
- [~] Responsive breakpoints (mobile, tablet, desktop) — mobile hamburger menu + back-to-top added
- [ ] Wire CTA flows (signup, waitlist, demo request)
- [ ] SEO optimization (meta tags, structured data, og tags)
- [ ] Performance pass (lazy load sections, optimize animations)

---

## P2 — Goal Management UI (Feature-Rich & Intuitive)

**Theme:** Make managing autonomous workflows feel effortless. This is the product's core UX.

Existing code: `src/infra/overseer/`, `src/infra/decisions/`, `ui/src/ui/views/overseer*.ts`
UX audit: `docs/audits/agentic-workflow-ux-audit.md`

### Goal Lifecycle (Web UI)
- [x] Create goal from Web UI (with guided wizard) — PR #14
- [x] Pause/resume goals from Web UI — PR #14
- [x] Mark work done / block work nodes from Web UI — PR #14
- [x] Wire the "Retry" button — PR #14 (overseer.goal.resume + work.update endpoints)
- [ ] Inline goal editing (title, constraints, success criteria)
- [ ] Goal templates (common workflow presets)

### Agent Status Dashboard (Real-time)
- [ ] Real-time view of all running agents and their current task
- [ ] WebSocket streaming of agent events
- [ ] Resource usage indicators (tokens, time, cost)
- [ ] Agent health status (active, stalled, idle, errored)
- [ ] Drill-down from agent → session → task detail

### Decision Audit Log
- [ ] Timestamped log of every Overseer decision
- [ ] Capture reasoning chain for each decision
- [ ] Show dispatched actions and outcomes
- [ ] Searchable/filterable by goal, agent, time range, outcome
- [ ] Decision replay (step through what happened)

### Mid-Execution Abort (Safety Controls)
- [ ] Abort background agent tasks from Web UI (not just streaming chat)
- [ ] Abort Overseer-dispatched work from dashboard
- [ ] Graceful cancellation with partial-work cleanup
- [ ] Confirmation dialog for abort with impact summary
- [ ] Emergency "stop all" button

### Goal Progress Tracking & Visualization
- [ ] Progress bars per goal/phase/task (completed/total with dependency awareness)
- [ ] Plan graph visualization (building on `overseer.graph.ts`)
- [ ] Estimated time remaining + velocity tracking
- [ ] Phase transition animations
- [ ] Historical progress timeline (burndown/burnup)

---

## P3 — UI Polish (from IMPROVEMENT-IDEAS.md)

Reference: `dgarson/IMPROVEMENT-IDEAS.md` (198 incomplete items across 14 categories)

### Command Palette Enhancement
- [x] Implement fuzzy search (replace `string.includes()`)
- [~] Add command history and recents (persisted to localStorage) — PR #21
- [ ] Add favorites system
- [~] Add context-aware commands based on current view — PR #24
- [ ] Add nested/sub-command menus
- [ ] Add category filtering in search
- [ ] See `dgarson/COMMAND-PALETTE.md` for full design doc

### Loading States
- [~] Add skeleton screens for views that load data (sessions, agents, nodes, skills, logs, chat already done; overseer + cron added in `autodev-skeleton-screens`)
- [ ] Add progress indicators for long-running operations
- [ ] Implement optimistic UI updates

### Empty States
- [ ] Design and implement empty state illustrations/messages for all views
- [ ] Add helpful CTAs in empty states

### Accessibility
- [ ] ARIA compliance audit across all components
- [ ] Screen reader testing
- [ ] Focus management improvements

### Animations & Transitions
- [ ] View transition animations
- [ ] Micro-interactions for common actions
- [ ] Smooth state transitions

---

## P4 — Error Handling & Robustness

### Error Handling UX
- [ ] Implement retry patterns for failed operations
- [ ] Add error boundary components
- [ ] User-friendly error messages with recovery suggestions

### Search & Filtering
- [ ] Global search across sessions, logs, config
- [ ] Advanced filtering UI
- [ ] Saved search presets

### Visual Consistency
- [ ] Design token audit (colors, spacing, typography)
- [ ] Component style consistency pass
- [ ] Dark/light theme refinement

---

## P5 — Platform & Extensibility

### Keyboard Navigation
- [ ] Full keyboard navigation across all views
- [ ] Keyboard shortcut discovery UI
- [ ] Vim-style navigation option

### Component Gaps
- [ ] Identify and build missing shared components
- [ ] Tooltip system improvements
- [ ] Modal/drawer standardization

---

## Completed

_Items move here when done._

- [x] Toast notification system wired up
- [x] Confirmation dialog component
- [x] WebSocket connection toasts
- [x] Overseer bridge + decision manager
- [x] Overseer simulator for e2e testing
- [x] Agentic workflow UX improvements
- [x] Sessions view responsive filtering/sorting
- [x] Agent status Slack command
- [x] Decision store unit tests (PR #16)

---

## Notes for Autonomous Worker

When picking a task:
1. Start from P1, work down
2. Pick ONE item per session, then look for isolated next items
3. If blocked (needs external API, credentials, unclear requirements), mark `[!]` and report
4. Create `autodev-` prefixed branches and PRs
5. Always run `pnpm build` and `pnpm test` before pushing
6. Commit and push after completing
7. Update this file to mark progress
8. Read AGENTS.md for coding conventions and project structure
9. Check `dgarson/IMPROVEMENT-IDEAS.md` for detailed specs on UI items
10. Check `dgarson/COMMAND-PALETTE.md` for command palette design
