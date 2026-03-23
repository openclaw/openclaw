---
# -- Dart AI metadata --
title: "Paperclip Upstream Sync: v2026.318.0"
description: "Port features from Paperclip v2026.318.0 into Operator1 across 6 phases: schema, services, RPC, UI, components, tests."
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high
assignee: "rohit sharma"
tags: [feature, backend, ui, migration, paperclip, upstream-sync]
startAt: "2026-03-23"
dueAt:
dart_project_id:
# --
---

# Paperclip Upstream Sync: v2026.318.0

**Created:** 2026-03-23
**Status:** Planning
**Depends on:** Paperclip orchestration implementation (complete through Phase 6), upstream-sync skill update (complete)

---

## 1. Overview

Port features from Paperclip v2026.318.0 (latest stable, released 2026-03-18) into Operator1. This is the first Paperclip sync ever (`lastSyncedCommit: null`). Paperclip uses PostgreSQL + Drizzle ORM + Express REST; Operator1 uses SQLite + raw SQL + gateway RPC. All code must be adapted per the upstream-sync skill's Paperclip Adaptation Rules (`.claude/skills/upstream-sync/SKILL.md`).

**Source:** `paperclip` remote -> `paperclipai/paperclip`, tag `v2026.318.0` (SHA: `78c714c29a`)
**Operator1 baseline:** `main` at commit `d036e62dda`

---

## 2. Goals

- Port security hardening (agent JWT auth, log redaction)
- Port bug fixes (crash guards, heartbeat reliability, Pi adapter fixes)
- Port key features (execution workspaces, issue documents, budget upgrades, token optimization)
- Port adapter improvements relevant to Pi runtime
- Resolve review items (wakeup requests, config rollback, approval comments)
- Reference Paperclip UI patterns for orchestration pages

## 3. Out of Scope

- **Canary/unreleased features** (1,342 commits after v2026.318.0): Routines, Company Skills, Company Portability, Worktree History Merge -- defer to next stable tag sync (v2026.321.0)
- **Plugin framework** (XL effort, 20+ service files) -- Operator1 uses Hub/Clawhub instead; evaluate in separate project
- **Multi-tenant auth** (principal permissions, company access) -- single-operator architecture
- **Hermes adapter** -- Paperclip-specific, not applicable
- **Embedded PostgreSQL** fixes -- not applicable to SQLite
- **Untrusted PR review Docker isolation** -- not applicable

---

## 4. Design Decisions

| Decision             | Options Considered                         | Chosen                                      | Reason                                                               |
| -------------------- | ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| Sync target          | Latest stable (v2026.318.0) vs master HEAD | v2026.318.0 stable                          | Canary has 1,342 unreleased commits; too risky for first sync        |
| Phase order          | Feature-first vs safety-first              | Safety-first (bugs -> security -> features) | Crash guards and Pi fixes have immediate production impact           |
| Plugin framework     | Port vs skip vs defer                      | Skip                                        | XL effort, Operator1 has Hub/Clawhub; evaluate separately            |
| Execution workspaces | Full port vs partial (local-only)          | Partial -- local filesystem only            | Skip multi-provider support; Pi runtime uses local dirs              |
| Agent JWT auth       | Port vs keep shared gateway token          | Port                                        | Per-agent JWT eliminates single shared token risk for subagent calls |

---

## 5. Technical Spec

### 5.1 Adaptation Rules Reference

See `.claude/skills/upstream-sync/SKILL.md` section "Paperclip Adaptation Rules" for the full 17-row mapping table. Key transformations:

- `pgTable()` -> SQLite DDL in `src/infra/state-db/schema.ts`
- `db.select().from()` -> `db.prepare().all/get/run`
- `router.get/post` -> gateway RPC in `src/gateway/server-methods/*.ts`
- `z.object()` -> TypeBox in `src/gateway/protocol/schema/*.ts`
- `companyId` -> `workspaceId` or remove
- `useQuery()/useMutation()` -> `sendRpc()`

### 5.2 Path Mapping Reference

| Paperclip Path                        | Operator1 Equivalent                             |
| ------------------------------------- | ------------------------------------------------ |
| `packages/db/src/schema/*.ts`         | `src/infra/state-db/schema.ts` (migration steps) |
| `packages/shared/src/types/*.ts`      | `src/orchestration/types.ts`                     |
| `packages/shared/src/validators/*.ts` | `src/gateway/protocol/schema/*.ts` (TypeBox)     |
| `server/src/services/*.ts`            | `src/orchestration/*-sqlite.ts` (store modules)  |
| `server/src/routes/*.ts`              | `src/gateway/server-methods/*.ts`                |
| `server/src/app.ts`                   | `src/gateway/server-methods.ts` (handler spread) |

### 5.3 Post-Phase Checklist

After each phase merge, verify:

1. `src/gateway/server-methods.ts` -- new handlers imported AND spread into `coreGatewayHandlers`
2. `src/gateway/server-methods-list.ts` -- new method names in `BASE_METHODS`
3. `src/gateway/method-scopes.ts` -- new methods have scope entries
4. `src/orchestration/types.ts` -- new types exported
5. `pnpm build` passes (backend + `cd ui-next && pnpm build`)
6. `pnpm test` passes
7. Zero references to `companyId`, `pgTable`, `drizzle`, `better-auth`, `InviteToken`
8. All new SQLite migrations are idempotent

---

## 6. Implementation Plan

> **Execution model:** Each phase dispatches sub-agents via the upstream-sync skill.
> Phases are sequential -- each branches from `main` after the prior phase's PR is merged.
> User hands-on testing gate between each phase.

### Task 1: Phase 1 -- Bug Fixes (Safety First)

**Status:** Done | **Priority:** Critical | **Assignee:** rohit sharma | **Est:** 4h

Production crash guards and heartbeat reliability fixes. Zero new features -- pure hardening.

- [x] 1.1 os.userInfo() crash guard -- add try-catch fallback in `src/infra/home.ts` for Docker/CI containers where UID has no passwd entry
- [x] 1.2 AGENT_HOME env var injection -- audit agent subprocess launch in heartbeat runner; add `AGENT_HOME` to env so subagents write state to correct directory
- [x] 1.3 Heartbeat process_lost guard -- port Paperclip's fix to prevent false `process_lost` failures on queued/non-child heartbeat runs in `src/infra/team-runner.ts`
- [x] 1.4 dotenv cwd fallback -- ALREADY HARDENED: `src/infra/dotenv.ts` checks `fs.existsSync` before loading global .env; uses `override: false` to prevent double-application
- [x] 1.5 archivedAt type coercion -- NOT APPLICABLE: `op1_projects` has no `archivedAt` column; archive() only sets `status = "archived"`; no string/integer coercion issue

### Task 2: Phase 2 -- Pi Adapter Tool Result Fixes

**Status:** Done | **Priority:** Critical | **Assignee:** rohit sharma | **Est:** 3h

4 commits fixing Pi protocol handling for tool results. These are runtime bugs affecting our primary adapter.

- [x] 2.1 Handle direct array format in tool results -- `resolveToolResultContent()` helper normalizes array vs wrapped object
- [x] 2.2 Extract text content from tool results -- resolved content fed to `collectTextContentBlocks` preventing `[object Object]`
- [x] 2.3 Include toolName in tool_result messages -- `session-cost-usage.ts` passes `toolName` to `SessionLogEntry`; usage UI displays it
- [x] 2.4 Include toolName in transcript entries -- `chat-messages.tsx` uses actual `toolName` instead of hardcoded `"tool"`

### Task 3: Phase 3 -- Security Hardening

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 8h

Agent-level JWT authentication and log redaction.

- [x] 3.1 Agent API key schema -- migration v26: `op1_agent_api_keys` table with hash, prefix, revoke support
- [x] 3.2 Agent JWT signing/verification -- `src/gateway/agent-auth-jwt.ts` with HS256 HMAC, TODO at auth integration point
- [x] 3.3 Log redaction pipeline -- `getSystemRedactPatterns()` + `redactSystemPaths()` for username/homedir/workspace paths
- [x] 3.4 Secret-ref format validation -- ALREADY HANDLED: structured refs validated by `isSecretRef()`, Zod schema
- [x] 3.5 RPC handlers for agent API keys -- `agents.apiKeys.create/list/revoke` registered in BASE_METHODS + ADMIN_SCOPE

### Task 4: Phase 4 -- Core Features

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 20h

Major feature ports: execution workspaces, issue documents, budget upgrades, token optimization.

- [x] 4.1 Execution workspaces schema -- v27: `op1_execution_workspaces` + `op1_workspace_operations` tables
- [x] 4.2 Execution workspace store -- `execution-workspace-sqlite.ts` with CRUD + operation logging
- [x] 4.3 Execution workspace RPC handlers -- 7 handlers registered in server-methods
- [x] 4.4 Execution workspace policy -- covered by mode/status fields in schema
- [x] 4.5 Task documents schema -- v28: `op1_task_documents` + `op1_task_attachments` tables
- [x] 4.6 Task documents store + RPC -- `task-documents-sqlite.ts` with 5 document + 3 attachment RPCs
- [x] 4.7 Task attachments schema -- included in v28 migration with task documents
- [x] 4.8 Finance events schema -- v29: `op1_finance_events` table with full attribution fields
- [x] 4.9 Budget quota windows -- `getQuotaWindowSpend()` in cost-event-store with calendar_month_utc + lifetime
- [x] 4.10 Sidebar budget indicators -- `sidebar.badges` RPC returning pending approvals, active incidents, in-progress tasks
- [x] 4.11 Token optimization for heartbeats -- skip usage telemetry for noop heartbeat responses
- [x] 4.12 Session compaction adapter-aware -- ALREADY HANDLED: uses model.contextWindow from catalog
- [x] 4.13 Workspace logos -- DEFERRED: no asset upload infrastructure; out of scope for this sync
- [x] 4.14 App version label -- ALREADY IMPLEMENTED: `v{__APP_VERSION__}` in sidebar header via Vite build constant

### Task 5: Phase 5 -- Adapter Improvements

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 6h

Incremental adapter and infrastructure improvements.

- [x] 5.1 Pi adapter diagnostics -- `classifyPiModelDiscoveryError()` for structured error messages; FailoverError on heartbeat discovery failures
- [x] 5.2 Claude adapter shared utils -- ALREADY HANDLED: Paperclip has no token-estimation utils; Operator1 has `estimateTokens` from pi-coding-agent
- [x] 5.3 OPENCLAW\_\* env var injection -- added OPENCLAW_GATEWAY_URL, OPENCLAW_AGENT_ID, OPENCLAW_WORKSPACE_ID to subprocess env in cli-runner.ts
- [x] 5.4 Skill sync review -- NOT APPLICABLE: Paperclip's company-skills is a server-side DB-backed registry; Operator1 uses Clawhub per-workspace flat files
- [x] 5.5 realpathSync for .env -- NOT APPLICABLE: no symlinks involved; CWD .env doesn't exist, global .env is a regular file

### Task 6: Phase 6 -- Review Items (Decisions Required)

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 10h

Items requiring architectural decisions before implementation.

- [ ] 6.1 DECIDE: Approval comments -- add comment threads to `op1_approvals`? (schema: `op1_approval_comments` with `approval_id`, `author_id`, `body`, `created_at`)
- [ ] 6.2 DECIDE: Agent config revisions rollback -- expose rollback endpoints for `op1_agent_config_revisions` (schema v23 already exists; needs RPC surface)
- [ ] 6.3 DECIDE: Agent task sessions -- add `op1_agent_task_sessions` for per-agent per-task session tracking separate from heartbeat runs?
- [ ] 6.4 DECIDE: Wakeup requests -- add `op1_agent_wakeup_requests` table for async agent wakeup on task assignment? (blocking for task automation)
- [ ] 6.5 DECIDE: Issue read states -- add `op1_task_read_states` to track read/unread per task? (inbox UX improvement)
- [ ] 6.6 DECIDE: Dashboard aggregation API -- add `dashboard.summary` RPC for aggregated stats vs individual client-side fetches?
- [ ] 6.7 DECIDE: Sidebar badges API -- add `sidebar.badges` RPC for unread counts in nav items?
- [ ] 6.8 IMPLEMENT decisions -- implement all approved items from 6.1-6.7

### Task 7: Phase 7 -- UI Patterns (Reference)

**Status:** To-do | **Priority:** Low | **Assignee:** rohit sharma | **Est:** 8h

Adapt Paperclip UI patterns for orchestration pages. These are not direct ports -- they're design references.

- [ ] 7.1 Task detail page polish -- adapt Paperclip's issue detail design (cost summary in activity tab, assignee UI, comment thread)
- [ ] 7.2 Me/Unassigned quick-filter -- add assignee quick-filters to tasks page header
- [ ] 7.3 Project tab caching -- remember active tab per project in orchestration/projects area
- [ ] 7.4 Costs/Usage page improvements -- adapt Paperclip's Spend + Providers tabs pattern for usage page
- [ ] 7.5 Live run indicator -- add blue dot on active heartbeat run in heartbeat page
- [ ] 7.6 Archive project UX -- navigate to dashboard + show toast after archiving
- [ ] 7.7 Skip pre-filled fields in create dialog -- improve tab order in task create dialog
- [ ] 7.8 Sidebar scrollbar hover track fix -- CSS fix for sidebar scroll track visibility

### Task 8: Phase 8 -- Tests

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 6h

Add tests for all new functionality ported in Phases 1-6.

- [ ] 8.1 Execution workspace store tests -- in-memory SQLite CRUD tests for `execution-workspace-sqlite.ts`
- [ ] 8.2 Task documents store tests -- in-memory SQLite CRUD tests for task document operations
- [ ] 8.3 Budget quota window tests -- test quota window aggregation logic
- [ ] 8.4 Agent API key JWT tests -- test sign/verify/revoke lifecycle
- [ ] 8.5 RPC handler integration tests -- test new server-methods with mocked DB

---

## 7. What's NOT in This Sync (Deferred to v2026.321.0)

These features are on Paperclip `master` (canary) but not in the v2026.318.0 stable tag. Port when next stable tag ships:

| Feature                                     | Paperclip Files                                                                    | Why Defer                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Routines** (scheduled agent tasks)        | `packages/db/src/schema/routines.ts`, `server/src/services/routines.ts` (1268 LOC) | Major new subsystem; wait for stable release; critical for task automation |
| **Company portability** (ZIP export/import) | `server/src/services/company-portability.ts` (2819 LOC)                            | Large feature; evaluate after core sync                                    |
| **Company skills** (shared skill bundles)   | `server/src/services/company-skills.ts` (2321 LOC)                                 | Different model from Hub/Clawhub; needs design review                      |
| **Worktree history merge**                  | CLI commands for cross-worktree importing                                          | Low priority; niche use case                                               |
| **Plugin framework** (20+ service files)    | `server/src/services/plugin-*.ts`                                                  | XL effort; Operator1 uses Hub/Clawhub instead                              |

---

## 8. References

- Upstream-sync skill: `.claude/skills/upstream-sync/SKILL.md`
- Sync state: `.claude/skills/upstream-sync/state/sync-state.json`
- Paperclip orchestration spec: `Project-tasks/paperclip-orchestration-implementation.md`
- Original Paperclip UI rules: `Project-tasks/Done/onboarding-gui-implementation.md` section 2.5
- Paperclip remote: `git remote -v | grep paperclip` -> `paperclipai/paperclip`
- Target tag: `v2026.318.0` (SHA: `78c714c29a`)

---

_Estimated total effort: ~65h (~18-28 dev-days with AI-assisted implementation)_
_Sync skill: `/upstream-sync --source paperclip --phase <name>` to execute each phase_
