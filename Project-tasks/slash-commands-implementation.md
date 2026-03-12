---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Slash Commands System"
description: "First-class /commands system in Operator1 — unified, discoverable actions in web chat separate from skills"
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high
assignee: "rohit sharma"
tags: [feature, backend, ui, api, cli]
startAt: "2026-03-13"
dueAt: "2026-03-13"
dart_project_id: zqbum1Pyk4Zi
# ──────────────────────────────────────────────────────────────────────────────
---

# Slash Commands System

**Created:** 2026-03-12
**Status:** Planning
**Depends on:** SQLite consolidation (Phase 0–3 landed), ui-next control panel, existing skills infrastructure

---

## 1. Overview

Build a first-class `/commands` system in Operator1 that gives users and agents a unified, discoverable set of actions available in the web chat — while keeping it **separate** from the existing skills menu to avoid conflicts and confusion.

**Three distinct types, one cohesive system:**

| Type                 | User-invocable (`/` menu) | Agent auto-invocable | Example                                                           |
| -------------------- | :-----------------------: | :------------------: | ----------------------------------------------------------------- |
| **Command**          |          ✅ Yes           |        ❌ No         | `/status` — user asks, agent reports gateway state                |
| **Full skill**       |          ✅ Yes           |        ✅ Yes        | `/commit` — user can type it; agents can also invoke autonomously |
| **Agent-only skill** |           ❌ No           |        ✅ Yes        | `code-review` — tool-level skill, agents use internally           |

---

## 2. Goals

- Give users a clean `/` trigger for discoverable commands (separate from skills)
- Store user-created commands in SQLite with `.md` files as the body source
- Provide a CRUD management UI at `/commands` in ui-next
- Log every invocation with `originalMessage` + `expandedInstruction` for audit/debug
- Support typed command arguments with `{{var}}` body interpolation

## 3. Out of Scope

- Agent auto-invocation (`invoke_command` tool for Pi) — Phase 5, separate project
- `long_running` progress modal — deferred to Phase 3 pending streaming infrastructure spec
- `commands.export` / `commands.import` RPCs — deferred to Phase 3 (needs UI first)

---

## 4. Design Decisions

| Decision                       | Options Considered                       | Chosen                             | Reason                                                                          |
| ------------------------------ | ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `/` trigger scope              | Merged skills+commands vs separate       | Separate                           | Execution semantics differ; no naming conflicts                                 |
| Skills trigger                 | `//` text trigger vs toolbar button      | Toolbar button                     | `detectTrigger()` is single-char; `//` requires non-trivial changes             |
| Command body storage           | SQLite `body` column vs `.md` files      | `.md` files                        | Mirrors existing skills model; SQLite is registry only                          |
| Seed protection                | `RESERVED_NAMES` list vs `source` column | Both, separate concerns            | `source='builtin'` guards seeds; `RESERVED_NAMES` guards gateway-internal verbs |
| `SkillInvocationPolicy` naming | Reuse existing fields vs new fields      | Option B (alias)                   | Avoid duplicate fields; `user-command` → `userInvocable` in loader              |
| Dual invocation paths          | Separate logic vs shared core            | Shared `resolveAndExpandCommand()` | Single source of truth for arg parsing, substitution, logging                   |
| `commands.list.agent` naming   | Separate RPC vs `scope` param            | `scope` param on `commands.list`   | Consistent with prefix pattern                                                  |

---

## 5. Technical Spec

### 5.1 Command File Format

Commands live as `.md` files in `~/.openclaw/commands/`. SQLite is a metadata index only — the body is always read from the file at invocation time.

```
~/.openclaw/commands/
├── status.md
├── build.md
└── my-custom-cmd.md
```

```markdown
---
name: build
description: Run project build
emoji: 🔨
type: command
category: build
user-command: true
model-invocation: false
long-running: true
args:
  - name: project
    type: string
    required: false
    default: "."
---

Run `pnpm build` in {{project}}.
Report success or show the first actionable error.
```

### 5.2 SQLite Schema (Migration v5)

```sql
CREATE TABLE IF NOT EXISTS op1_commands (
  command_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  emoji TEXT,
  file_path TEXT,                       -- NULL for built-ins bundled in gateway
  type TEXT NOT NULL DEFAULT 'command', -- "command" | "skill"
  source TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'builtin' (builtin = read-only)
  user_command INTEGER NOT NULL DEFAULT 1,
  model_invocation INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  long_running INTEGER NOT NULL DEFAULT 0,
  args_json TEXT,                       -- cached from frontmatter
  tags_json TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS op1_command_invocations (
  invocation_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  invoked_by TEXT,
  args_json TEXT,
  original_message TEXT,
  expanded_instruction TEXT,
  session_key TEXT,
  success INTEGER,
  error_message TEXT,
  executed_at INTEGER DEFAULT (unixepoch())
);
```

### 5.3 RPC Namespace — `commands.*`

All handlers in `src/gateway/server-methods/commands.ts`. Registration required in:

1. `src/gateway/server-methods.ts` — import + spread into `coreGatewayHandlers`
2. `src/gateway/server-methods-list.ts` — add all names to `BASE_METHODS`
3. `src/gateway/method-scopes.ts` — add `"commands."` to `ADMIN_METHOD_PREFIXES`

RPCs: `commands.list` (scope param: "user"|"agent"), `commands.get`, `commands.getBody`, `commands.create`, `commands.update`, `commands.delete`, `commands.invoke`

### 5.4 Reserved Names & Source Guard

**Source guard** — CRUD rejects `source='builtin'` rows (403).
**Reserved names** — `["restart", "delete", "config", "bash", "session"]` rejected on create/update (400). Seed names (`status`, `build`, etc.) are NOT in this list — protected by source guard instead.

### 5.5 Shared Invocation Core

```typescript
// src/gateway/server-methods/commands-core.ts
async function resolveAndExpandCommand(name, rawArgs, originalMessage, sessionKey, db);
// 1. SQLite lookup (no file I/O)
// 2. Read body from file_path
// 3. Parse args, substitute {{vars}}
// 4. Write invocation row (originalMessage + expandedInstruction)
// 5. Return expandedInstruction + invocationId
```

Both `handleCommandsInvocation()` (reply chain) and `commands.invoke` (RPC) call this. Logic never duplicated.

### 5.6 Chat Input Changes

- `/` → `commands.list` (scope="user") autocomplete — replaces current skills trigger
- Skills toolbar button → opens skills menu directly (no `//` text trigger)
- `autocomplete-menu.tsx`: `TriggerMode = "/" | "@" | "#"` (no `//`)

### 5.7 SkillInvocationPolicy Reconciliation (Phase 4 blocker)

`src/agents/skills/types.ts` already has `userInvocable` and `disableModelInvocation`.
**Decision (Option B):** alias frontmatter keys in the skill loader — `user-command` → sets `userInvocable`, `model-invocation` → sets `!disableModelInvocation`. No duplicate fields.

### 5.8 Built-in Seed Commands

| Name      | Category | Args                    | `long_running` | Description                             |
| --------- | -------- | ----------------------- | :------------: | --------------------------------------- |
| `/status` | system   | —                       |       ❌       | Check gateway and channel status        |
| `/agents` | system   | —                       |       ❌       | List all active agents and their status |
| `/logs`   | system   | `lines` (default 30)    |       ❌       | Show recent gateway logs                |
| `/build`  | build    | `project` (default `.`) |       ✅       | Run project build                       |
| `/help`   | general  | —                       |       ❌       | List available commands                 |

### 5.9 Commands Management UI

New page at `/commands` in ui-next. File structure:

```
ui-next/src/
├── pages/commands.tsx
├── components/commands/
│   ├── commands-table.tsx
│   ├── command-form-dialog.tsx
│   └── command-badge.tsx
└── hooks/use-commands.ts
```

Reference pattern: `ui-next/src/pages/mcp/installed.tsx`

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` checkbox = one Dart Subtask (child of its Task)
> - `**Status:**` on line 1 of each task syncs with Dart status field
> - Task titles and subtask text must match Dart exactly (used for sync matching)
> - `dart_project_id` in frontmatter is filled after first sync
> - **Dates:** confirmed with user before syncing — never auto-generated
> - **Estimates:** hours, not days (AI-assisted implementation is fast)
> - **Subtasks:** each item includes ` — description` so it is self-contained in Dart

### Task 1: Phase 1 — Schema + RPCs

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** 2026-03-13 | **Est:** 3h

Add SQLite tables, command file scanner, all `commands.*` RPC handlers, and shared invocation core. See §5.2–5.5.

- [ ] 1.1 Add SQLite tables — create op1_commands + op1_command_invocations per §5.2 schema as migration v5 in schema.ts using the existing migration pattern
- [ ] 1.2 Command file scanner — on gateway startup glob ~/.openclaw/commands/\*.md, parse frontmatter, upsert rows into op1_commands with source='user'
- [ ] 1.3 Read RPCs: list, get, getBody — commands.list filters by scope param (user/agent); commands.get returns a single row by name; commands.getBody reads .md file from disk
- [ ] 1.4 Write RPCs: create, update, delete — source guard rejects source=builtin (403); reserved name check rejects RESERVED_NAMES (400); validate required fields on create
- [ ] 1.5 commands.invoke RPC — entry point that validates args and delegates to resolveAndExpandCommand(); returns expandedInstruction + invocationId
- [ ] 1.6 resolveAndExpandCommand() core — shared function in commands-core.ts: SQLite lookup → read file → parse args → substitute {{vars}} → write invocation row → return result
- [ ] 1.7 Register RPCs in gateway — import+spread in server-methods.ts, add names to BASE_METHODS, add "commands." to ADMIN_METHOD_PREFIXES
- [ ] 1.8 Seed built-in commands — create 5 .md files (status, agents, logs, build, help); seed op1_commands with source='builtin' during migration so they're read-only via CRUD
- [ ] 1.9 Unit tests — handler paths, source guard (403/400), reserved names, migration idempotency, {{var}} substitution edge cases, scanner upsert behavior

### Task 2: Phase 2 — Chat Input Integration

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** 2026-03-13 | **Est:** 2h

Wire `/` trigger to commands and update chat input. See §5.6.

- [ ] 2.1 Autocomplete: / → commands.list — change single-char `/` trigger to call commands.list (scope=user) instead of skills.list; keep `@` and `#` unchanged
- [ ] 2.2 Group autocomplete by category — render autocomplete items with category header rows using the category field from commands.list response
- [ ] 2.3 Skills button: direct open — Skills button opens skills menu directly; remove `//` text-trigger detection from detectTrigger() in chat-input.tsx
- [ ] 2.4 handleCommandsInvocation() in reply chain — insert before Pi dispatch; detects /name pattern, calls resolveAndExpandCommand, injects expandedInstruction
- [ ] 2.5 Wire /name → expandedInstruction → Pi — parse command name + raw args, call resolveAndExpandCommand, replace message body before Pi sees it
- [ ] 2.6 Verify invocation logging — confirm op1_command_invocations row written correctly; no duplicate logging outside resolveAndExpandCommand

### Task 3: Phase 3 — Commands CRUD UI

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** 2026-03-13 | **Est:** 3h

Build /commands management page and implement deferred items. See §5.9.

- [ ] 3.1 /commands page + table — commands-table.tsx with rows grouped by category, filterable by name/description; reference ui-next/src/pages/mcp/installed.tsx
- [ ] 3.2 Conflict warning badge — detect name collision between op1_commands rows and skill files; show yellow badge on conflicting rows
- [ ] 3.3 command-form-dialog.tsx — modal for create/edit: name, description, emoji, category dropdown, args table editor (name/type/required/default), long_running toggle
- [ ] 3.4 use-commands.ts hook — React hook wrapping list/get/create/update/delete RPCs with loading/error state
- [ ] 3.5 Route + sidebar entry — register /commands in React Router; add sidebar nav link with icon alongside MCP and Skills
- [ ] 3.6 Export + import RPCs — export returns all user-source commands as JSON; import validates + upserts, skips builtin names, reports conflicts
- [ ] 3.7 Export/Import buttons — toolbar buttons on /commands page: Export downloads JSON, Import opens file picker
- [ ] 3.8 long_running progress modal — identify streaming integration points; implement modal overlay with cancel support for long_running=true commands

### Task 4: Phase 4 — Skill File Flags

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** 2026-03-13 | **Est:** 2h

Merge skill files into commands system. Resolve SkillInvocationPolicy naming first. See §5.7.

- [ ] 4.1 Confirm SkillInvocationPolicy Option B — review types.ts; confirm alias approach (no new fields); document decision as code comment before any changes
- [ ] 4.2 Frontmatter aliases in skill loader — map `user-command: true` → `userInvocable=true` and `model-invocation: false` → `disableModelInvocation=true`; no new fields added
- [ ] 4.3 Filter buildWorkspaceSkillCommandSpecs() — return only specs with userInvocable=true; exclude agent-only skills from user-facing lists
- [ ] 4.4 commands.list scope=user: merge skills — merge op1_commands + skill files where userInvocable=true; deduplicate by name, command rows take precedence
- [ ] 4.5 commands.list scope=agent: merge skills — include skill files where disableModelInvocation=false; merge with model_invocation=1 op1_commands rows

### Task 5: Phase 5 — Agent Auto-invocation

**Status:** To-do | **Priority:** Low | **Assignee:** rohit sharma | **Due:** 2026-03-13 | **Est:** 2h

Phase 2 — separate project. Agent-initiated command invocation with safety guards.

- [ ] 5.1 Load agent commands into Pi context — fetch commands.list (scope=agent) on session init and include in Pi's system context with a version hash for cache invalidation
- [ ] 5.2 invoke_command tool — define MCP-style tool spec; implement handler that validates command name, checks model-invocation gate, delegates to resolveAndExpandCommand()
- [ ] 5.3 Gate on model-invocation flag — reject invoke_command for commands where model_invocation=0; return clear error that the command is user-only
- [ ] 5.4 Recursion guard (depth > 1) — track invocation depth in session context; reject invoke_command if called from within a command's expandedInstruction
- [ ] 5.5 Rate limit per session — count invoke_command calls per session_key; reject once max_invocations_per_session exceeded (default 10, configurable)

---

## 7. References

- Existing skills types: `src/agents/skills/types.ts`
- Workspace skill loading: `src/agents/skills/workspace.ts`
- Reply handler chain: `src/auto-reply/reply/commands-core.ts`, `commands-skills.ts`
- Gateway RPC skills: `src/gateway/server-methods/skills.ts`
- MCP CRUD pattern: `ui-next/src/pages/mcp/installed.tsx`
- SQLite schema: `src/infra/state-db/schema.ts`
- Method scopes: `src/gateway/method-scopes.ts`
- Chat input: `ui-next/src/components/chat/chat-input.tsx`
- Autocomplete menu: `ui-next/src/components/chat/autocomplete-menu.tsx`
- Dart project: https://app.dartai.com/t/zqbum1Pyk4Zi-Slash-Commands-System

---

_Template version: 1.0_
