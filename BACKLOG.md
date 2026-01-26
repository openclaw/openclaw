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

## P1 — Overseer & Agent Orchestration

Existing code: `src/infra/overseer/`, `src/infra/decisions/`, `src/slack/overseer/`, `ui/src/ui/views/overseer*.ts`

### Overseer Hardening
- [ ] Audit existing overseer code for stability (error handling, edge cases)
- [ ] Add unit tests for overseer controllers and views
- [ ] Add tests for decision manager (`src/infra/decisions/`)
- [ ] Ensure overseer simulator (`ui/src/ui/views/overseer-simulator.ts`) covers all flows

### Overseer Features
- [ ] Goal progress tracking and visualization
- [ ] Agent status dashboard (real-time view of all running agents)
- [ ] Decision audit log (history of overseer decisions with reasoning)
- [ ] Multi-agent coordination support

---

## P2 — UI Polish (from IMPROVEMENT-IDEAS.md)

Reference: `dgarson/IMPROVEMENT-IDEAS.md` (198 incomplete items across 14 categories)

### Command Palette Enhancement
- [ ] Implement fuzzy search (replace `string.includes()`)
- [ ] Add command history and recents (persisted to localStorage)
- [ ] Add favorites system
- [ ] Add context-aware commands based on current view
- [ ] Add nested/sub-command menus
- [ ] Add category filtering in search
- [ ] See `dgarson/COMMAND-PALETTE.md` for full design doc

### Loading States
- [ ] Add skeleton screens for views that load data
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

## P3 — Error Handling & Robustness

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

## P4 — Landing Page & SaaS

### Landing Page
- [~] Complete landing page structure (PR #6 open)
- [ ] Polish landing page copy and design
- [ ] Add interactive demos/previews
- [ ] SEO optimization

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
