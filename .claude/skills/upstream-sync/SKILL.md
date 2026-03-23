---
name: upstream-sync
description: Selectively cherry-pick fixes and features from upstream repositories into operator1. Supports multiple upstreams — OpenClaw (primary) and Paperclip (full-stack schema/services/RPC/UI). Use when the user says "sync upstream", "cherry-sync", "pick upstream", "sync to v2026.x.x", "sync paperclip", or wants to review what's new upstream. Orchestrates sync-lead, code-guard, and qa-runner agents following the selective cherry-pick pipeline with per-category phased PRs.
---

# Upstream Cherry-Pick Sync

Selectively cherry-pick changes from upstream repositories into operator1. Supports multiple upstream sources, each with their own phase categories, scope filters, and adaptation rules.

## Supported Upstreams

| Source                 | Remote                                | Tracking                                            | Phase model                                                                   | Scope                                  |
| ---------------------- | ------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| **openclaw** (default) | `upstream` → `openclaw/openclaw`      | Tag-based (`v2026.x.x`)                             | 6-phase (security → bugfixes → features → provider → review → ui-inspiration) | Full codebase                          |
| **paperclip**          | `paperclip` → `paperclipai/paperclip` | Tag-based (`v2026.x.x`) + commit-based for canaries | 6-phase (schema → services → rpc → ui-features → ui-components → tests)       | Full-stack (schema, services, RPC, UI) |

## Usage

```
# OpenClaw (default — same as before)
/upstream-sync [target-tag]
/upstream-sync --review              ← just identify & classify, don't pick
/upstream-sync --phase <name>        ← run a specific phase (security, bugfixes, features, etc.)
/upstream-sync --phase next          ← auto-pick the next pending phase
/upstream-sync --resume              ← continue from last incomplete phase
/upstream-sync --full-merge          ← escape hatch: full git merge (rare, see §8)

# Paperclip (full-stack sync)
/upstream-sync --source paperclip                          ← sync to latest Paperclip tag
/upstream-sync --source paperclip v2026.318.0              ← sync to specific tag
/upstream-sync --source paperclip --review                 ← classify only, don't pick
/upstream-sync --source paperclip --phase schema           ← run specific phase

Examples:
  /upstream-sync v2026.3.12                                ← OpenClaw sync (default)
  /upstream-sync                                           ← sync-lead checks upstream and asks
  /upstream-sync --source paperclip                        ← Paperclip full-stack sync
  /upstream-sync --source paperclip --review               ← dry-run: classify Paperclip changes
  /upstream-sync --phase security                          ← OpenClaw: cherry-pick security fixes
  /upstream-sync --source paperclip --phase rpc            ← Paperclip: cherry-pick RPC handlers
```

## Phased PR Workflow

Each upstream sync is broken into **per-category phases**, each with its own branch and PR. This keeps PRs focused, reviewable, and independently mergeable.

### OpenClaw Phases (6-phase model)

| Phase | Category          | Branch Pattern                 | Priority                                  |
| ----- | ----------------- | ------------------------------ | ----------------------------------------- |
| 1     | Security          | `sync/<tag>-security`          | Critical — merge first                    |
| 2     | Bug Fixes         | `sync/<tag>-bugfixes`          | High                                      |
| 3     | Features          | `sync/<tag>-features`          | Medium                                    |
| 4     | Provider/Refactor | `sync/<tag>-provider-refactor` | Medium — align with upstream architecture |
| 5     | Review Items      | `sync/<tag>-review`            | Triaged during Phase 2 approval           |
| 6     | UI Inspiration    | `sync/<tag>-ui-inspiration`    | Reference — draft PR                      |

### Paperclip Phases (6-phase model)

| Phase | Category         | Branch Pattern                       | Priority                       | What it covers                                                                          |
| ----- | ---------------- | ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| 1     | Schema & Types   | `sync/paperclip-<ref>-schema`        | Critical — data model first    | Drizzle migrations → SQLite migrations, type definitions → `src/orchestration/types.ts` |
| 2     | Backend Services | `sync/paperclip-<ref>-services`      | High — business logic          | Service functions → `src/orchestration/*-sqlite.ts` store modules                       |
| 3     | RPC Handlers     | `sync/paperclip-<ref>-rpc`           | High — API surface             | Express routes → `src/gateway/server-methods/*.ts` + protocol schemas                   |
| 4     | UI Features      | `sync/paperclip-<ref>-ui-features`   | Medium — pages and workflows   | React pages/components with full sendRpc adaptation                                     |
| 5     | UI Components    | `sync/paperclip-<ref>-ui-components` | Low — shared component updates | shadcn/ui updates, shared helpers                                                       |
| 6     | Tests            | `sync/paperclip-<ref>-tests`         | Medium — validation            | Adapt Paperclip tests to Vitest + SQLite in-memory pattern                              |

### Sequencing

Each phase branches from `main` AFTER the prior phase's PR is merged:

```
# OpenClaw
main ── P1 (security) ──merge── P2 (bugfixes) ──merge── P3 (features) ──merge── P4 (provider) ──merge── P5 (review) ──merge── P6 (ui-insp, draft)

# Paperclip
main ── P1 (schema) ──merge── P2 (services) ──merge── P3 (rpc) ──merge── P4 (ui-features) ──merge── P5 (ui-components) ──merge── P6 (tests)
```

## How It Works

### Source Selection

When `--source` is specified, sync-lead uses the corresponding remote, phase model, scope filter, and adaptation rules. Default is `openclaw`.

- **openclaw:** `git fetch upstream --tags` → tag-based release detection → 6-phase model → full-scope conflict strategies
- **paperclip:** `git fetch paperclip --tags` → tag-based or commit-based range → 6-phase model → full-stack scope → adaptation rules per §Paperclip Adaptation Rules (Drizzle → SQLite, Express → gateway RPC, React Query → sendRpc, multi-tenant → single-workspace)

### Paperclip Adaptation Rules

| Paperclip Pattern                                     | Operator1 Adaptation                                                                                                  | Phase |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----- |
| `pgTable()` Drizzle schema definitions                | SQLite DDL in `src/infra/state-db/schema.ts` (append migration, increment version)                                    | P1    |
| Drizzle TypeScript types (`InferSelectModel`)         | TypeScript interfaces in `src/orchestration/types.ts`                                                                 | P1    |
| Drizzle ORM queries (`db.select().from()`)            | Raw `node:sqlite` prepared statements (`db.prepare().all/get/run`)                                                    | P2    |
| Service factory pattern `serviceName(db)`             | Exported functions in `src/orchestration/*-sqlite.ts`                                                                 | P2    |
| `companyId` FK on every entity                        | `workspaceId` (single-workspace scope) or remove if unnecessary                                                       | P1-P2 |
| Express route handlers (`router.get/post`)            | Gateway RPC handlers in `src/gateway/server-methods/*.ts`                                                             | P3    |
| Zod validation schemas (`z.object()`)                 | TypeBox schemas in `src/gateway/protocol/schema/*.ts`                                                                 | P3    |
| Route registration in `app.ts`                        | Import + spread in `server-methods.ts`, add to `server-methods-list.ts` BASE_METHODS, add scope in `method-scopes.ts` | P3    |
| `useQuery()` / `useMutation()` React Query            | `sendRpc()` via `useGateway()` hook                                                                                   | P4    |
| `fetch("/api/companies/:id/...")` REST calls          | `sendRpc("method.name", params)`                                                                                      | P4    |
| React component import paths                          | Remap to `ui-next/src/components/` equivalents                                                                        | P4-P5 |
| Tailwind CSS classes                                  | Keep as-is (both use Tailwind via shadcn/ui)                                                                          | P4-P5 |
| `InviteToken` / invite flows                          | Remove — no invite system                                                                                             | All   |
| Multi-tenant auth (`assertCompanyAccess`)             | Remove — single-operator model                                                                                        | All   |
| `better-auth` session management                      | Remove — gateway auth handles this                                                                                    | All   |
| PostgreSQL-specific SQL (`SERIAL`, `TEXT[]`, `jsonb`) | SQLite equivalents (`INTEGER PRIMARY KEY`, `TEXT` with JSON, `TEXT`)                                                  | P1    |
| Drizzle migration SQL files                           | Manual SQLite migration in schema.ts `runMigrations()`                                                                | P1    |
| Vitest tests with Drizzle/PG                          | Vitest tests with in-memory SQLite (`:memory:` + `runMigrations`)                                                     | P6    |

### Paperclip Path Mapping

| Paperclip Path                           | Operator1 Equivalent                               |
| ---------------------------------------- | -------------------------------------------------- |
| `packages/db/src/schema/*.ts`            | `src/infra/state-db/schema.ts` (migration steps)   |
| `packages/db/src/migrations/*.sql`       | Same file — SQLite DDL in migration array          |
| `packages/shared/src/types/*.ts`         | `src/orchestration/types.ts`                       |
| `packages/shared/src/validators/*.ts`    | `src/gateway/protocol/schema/*.ts` (TypeBox)       |
| `server/src/services/*.ts`               | `src/orchestration/*-sqlite.ts` (store modules)    |
| `server/src/routes/*.ts`                 | `src/gateway/server-methods/*.ts`                  |
| `server/src/app.ts` (route registration) | `src/gateway/server-methods.ts` (handler spread)   |
| `server/src/__tests__/*.ts`              | Colocated `*.test.ts` files                        |
| React pages/components                   | `ui-next/src/pages/` and `ui-next/src/components/` |

### Paperclip Post-Sync Checklist

After each Paperclip phase merge, verify:

1. `src/gateway/server-methods.ts` — new handlers imported AND spread into `coreGatewayHandlers`
2. `src/gateway/server-methods-list.ts` — new method names in `BASE_METHODS`
3. `src/gateway/method-scopes.ts` — new methods have scope entries
4. `src/orchestration/types.ts` — new types exported
5. `pnpm build` passes (both backend and `cd ui-next && pnpm build`)
6. `pnpm test` passes
7. Zero references to `companyId`, `pgTable`, `drizzle`, `better-auth`, `InviteToken` in adapted code
8. All new SQLite migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`)

### Flow

```
You: "/upstream-sync v2026.3.12"                    ← openclaw (default)
You: "/upstream-sync --source paperclip"             ← paperclip UI sync
         │
    sync-lead (sonnet)
    ├── Phase 0: Fetch <source> remote, identify next release candidate (tag or commit)
    ├── Phase 1: Diff changelog, list commits
    ├── Phase 2: Classify into 6 category buckets, present plan to user
    │            ← YOU APPROVE: "adopt these, skip those"
    │            ← REVIEW items triaged to adopt/skip
    │            ← Save sync report with per-phase commit lists
    │
    │   FOR EACH PHASE (security → bugfixes → features → provider → review → ui-inspiration):
    │   │
    │   ├── Phase 3: spawn code-guard ─────────────────────────┐
    │   │                                                      │
    │   │   code-guard (opus)                                  │
    │   │   ├── Create sync/<tag>-<phase> branch from main    │
    │   │   ├── Batch dry-run (--no-commit, build)            │
    │   │   ├── Cherry-pick -x each commit for this phase     │
    │   │   ├── Resolve conflicts per §6 table                │
    │   │   ├── Run post-cherry-pick audit                    │
    │   │   └── Report back ──────────────────────────────────┘
    │   │
    │   ├── Phase 4: spawn qa-runner ──────────────────────────┐
    │   │                                                      │
    │   │   qa-runner (sonnet)                                 │
    │   │   ├── pnpm install && pnpm build && pnpm test       │
    │   │   ├── cd ui-next && pnpm build                      │
    │   │   ├── Run §7.1 cherry-pick checklist                │
    │   │   └── Report pass/fail ─────────────────────────────┘
    │   │
    │   │   (loop: if qa fails → code-guard fixes → qa reruns)
    │   │   ← HARD GATE: PR cannot open until qa-runner passes (four-eyes)
    │   │
    │   ├── Spawn docs-updater on sync branch ───────────────┐
    │   │                                                     │
    │   │   docs-updater (sonnet)                             │
    │   │   ├── Scan phase commits for doc-relevant changes  │
    │   │   ├── Update relevant docs/ pages                  │
    │   │   ├── Commit doc updates to sync branch            │
    │   │   └── Report what was updated ─────────────────────┘
    │   │
    │   ├── Push branch, open PR (includes doc updates), update sync-state.json
    │   ├── STOP — present PR to user for review
    │   │            ← USER APPROVES: "merge it" / "looks good"
    │   ├── Merge PR (regular merge, preserve -x traceability)
    │   ├── git checkout main && git pull
    │   ├── Prompt user for hands-on testing on main
    │   │            ← USER CONFIRMS: "testing passed" / "all good"
    │   ├── Update sync-state.json phase → completed
    │   └── Report phase complete, list remaining phases
    │
    ├── After ALL phases complete:
    │   ├── Update lastSyncedTag in sync-state.json
    │   ├── Collapse currentSync into history
    │   └── Update sync log in process doc
    └── Report final summary
```

## Agents Involved

| Agent          | Role                                                                                                | Model  | Tools                                      |
| -------------- | --------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| `sync-lead`    | Orchestrator — fetches, classifies into phases, coordinates, records                                | sonnet | Bash, Read, Write, Edit, Glob, Grep, Agent |
| `code-guard`   | Cherry-pick & conflict specialist — picks commits for one phase, resolves per §6, audits registries | sonnet | Bash, Read, Write, Edit, Glob, Grep        |
| `qa-runner`    | Validation — build, test, lint, UI, §7.1 checklist                                                  | sonnet | Bash, Read, Grep                           |
| `docs-updater` | Documentation maintenance — scans changes, updates relevant docs                                    | sonnet | Bash, Read, Write, Edit, Glob, Grep        |

## Key Reference Files

The agents read these automatically:

| File                                                       | Purpose                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `Project-tasks/upstream-selective-sync-process.md`         | Full process doc for OpenClaw sync (§1-10)                    |
| `Project-tasks/paperclip-orchestration-implementation.md`  | Paperclip orchestration design spec                           |
| `Project-tasks/Done/onboarding-gui-implementation.md §2.5` | Original Paperclip UI adaptation rules (historical reference) |
| `.claude/skills/upstream-sync/state/protected-files.md`    | Operator1 files that must survive                             |
| `.claude/skills/upstream-sync/state/sync-state.json`       | Last synced tag/commit, per-phase progress, history           |
| `CLAUDE.md`                                                | Build commands, project conventions                           |

## Current Sync State

Last synced tag and per-phase progress:

```bash
cat .claude/skills/upstream-sync/state/sync-state.json
```

## When to Use Full Merge Instead (§8)

The `--full-merge` flag triggers the old `git merge upstream/main` approach. Use only when:

- Cumulative skipped commits > 500
- Same dependency chain deferred 3+ times
- Upstream ships a foundational change we need
- Cherry-pick burden per release consistently exceeds 4 hours

## Invoke

Spawn the sync-lead agent to begin the cherry-pick sync process.

**Parse the `--source` argument** to determine which upstream to sync from:

- `--source openclaw` (default if omitted): OpenClaw upstream sync
- `--source paperclip`: Paperclip UI patterns sync

Pass the source to sync-lead so it uses the correct remote, phase model, scope filter, and state key.

**Other flags:**

- Default: runs Phase 0-2 (identify + classify), then loops through phases with user approval gates
- `--review`: stops after Phase 2 (classification) without cherry-picking
- `--phase <name>`: runs only the specified phase (assumes classification is already done)
- `--phase next`: auto-picks the next pending phase from `currentSync.phases`
- `--resume`: same as `--phase next`
- `--full-merge`: (OpenClaw only) escape hatch for full git merge
