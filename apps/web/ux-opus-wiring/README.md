# Apps/Web Wiring Documentation

> **Date:** 2026-02-02
> **Purpose:** Documentation for wiring apps/web to the Gateway backend

---

## Overview

This directory contains the complete analysis and game plan for connecting the `apps/web` React UI to the actual Gateway backend. Currently, most of the UI runs on mock data - these documents map what needs to be wired and how.

## Documents

| Document | Purpose |
|----------|---------|
| [01-UI-RPCS-AND-APIS.md](./01-UI-RPCS-AND-APIS.md) | Exhaustive reference of all 54 RPC methods and 3 REST endpoints used by the current `ui/*` Control UI |
| [02-APPS-WEB-FEATURE-MAP.md](./02-APPS-WEB-FEATURE-MAP.md) | Maps all apps/web features to their backend requirements and current wiring status |
| [03-WIRING-GAME-PLAN.md](./03-WIRING-GAME-PLAN.md) | Complete implementation roadmap with phases, tasks, code examples, and open questions |
| [04-WIRING-AGENT-PROMPT.md](./04-WIRING-AGENT-PROMPT.md) | **Detailed agent instructions** for implementing the wiring - copy/paste ready |
| [05-GATEWAY-AUTH-MODAL-DESIGN.md](./05-GATEWAY-AUTH-MODAL-DESIGN.md) | UX design for blocking auth modal (replaces toast spam), includes future OAuth design |

## Quick Stats

### Current State

| Category | Wired | Partial | Unwired |
|----------|-------|---------|---------|
| Routes | 2 | 5 | 9 |
| Domain Components | ~15 | ~30 | ~98 |
| Query Hooks | 3 | 3 | 9 |
| Mutation Hooks | 4 | 0 | 7 |

### RPC Methods by Category

| Category | Count | Status |
|----------|-------|--------|
| Chat & Messaging | 3 | Partially wired |
| Sessions | 3 | Partially wired |
| Agents | 3 | Wired via config |
| Configuration | 5 | Wired |
| Channels | 4 | Unwired |
| Cron | 7 | Unwired |
| Automations | 8 | Unwired |
| Overseer | 9 | Unwired |
| System/Health | 6 | Unwired |
| Skills | 3 | Unwired |
| Device Pairing | 5 | Unwired |
| Exec Approvals | 5 | Unwired |
| Logs | 1 | Unwired |
| TTS | 2 | Unwired |

## Priority Order

1. **P0 (Blocker):** Gateway client upgrade to Protocol v3, chat/sessions wiring
2. **P1 (High):** Health dashboard, channels, goals, cron jobs
3. **P2 (Medium):** Skills, memories, rituals (may need new APIs)
4. **P3 (Lower):** Workstreams, activity logs, usage metrics

## Key Questions to Resolve

1. Where are memories stored? (Config? Database? Separate file?)
2. Are rituals a UI layer over cron jobs, or a distinct concept?
3. How do workstreams relate to overseer goals?
4. Is there existing telemetry for usage metrics?

## Related Documentation

- `../ux-opus-design/` - UX design specifications
- `../ux-opus-design/11-IMPLEMENTATION-ROADMAP.md` - UX implementation phases
- `../ux-opus-design/04-CURRENT-STATE-ANALYSIS.md` - Component analysis
