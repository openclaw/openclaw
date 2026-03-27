# Phase 5: Context Injection — Research

## Overview

Phase 5 adds PROJECT.md context injection for agents via two paths (cwd pickup and bootstrap hook) and extends IDENTITY.md with capability tags for task matching.

## Bootstrap File Pipeline

### Entry Points

The canonical path for agent bootstrap files is `resolveBootstrapFilesForRun()` in `src/agents/bootstrap-files.ts`. It:

1. Loads workspace bootstrap files (AGENTS.md, IDENTITY.md, SOUL.md, HEARTBEAT.md)
2. Filters by `contextMode` — `"lightweight"` keeps only HEARTBEAT.md (used for heartbeat runs)
3. Calls `applyBootstrapHookOverrides()` from `src/agents/bootstrap-hooks.ts` which fires `triggerInternalHook("agent:bootstrap", ...)`
4. Returns final `WorkspaceBootstrapFile[]` array

### Hook System

`src/hooks/internal-hooks.ts` provides:

- `registerInternalHook(eventKey, handler)` — registers handlers in a globalThis singleton Map
- `triggerInternalHook(event)` — runs all handlers for the event type
- `AgentBootstrapHookContext` type — `{ workspaceDir, bootstrapFiles[], cfg?, sessionKey?, sessionId?, agentId? }`
- `isAgentBootstrapEvent(event)` — type guard

Example bundled hook: `src/hooks/bundled/bootstrap-extra-files/handler.ts` — reads glob patterns from config and appends matched files to `context.bootstrapFiles`.

### WorkspaceBootstrapFile Type

From `src/agents/workspace.ts`:

- `WorkspaceBootstrapFileName` union type includes the valid bootstrap file names
- `VALID_BOOTSTRAP_NAMES` array lists recognized names
- `DEFAULT_IDENTITY_FILENAME = "IDENTITY.md"`

Files are injected into agent system prompt sections automatically.

## CWD-Based Pickup Implementation

### Pattern to Follow

AGENTS.md pickup already happens in `resolveBootstrapFilesForRun()`. The function receives `workspaceDir` and loads files from there. For PROJECT.md:

1. Starting from `workspaceDir`, walk up directory tree
2. Check each directory for `PROJECT.md`
3. Stop at `~/.openclaw/projects/` root (or filesystem root)
4. If found, create a `WorkspaceBootstrapFile` with the content
5. Add to the files array before hook execution

### Key Consideration

PROJECT.md is NOT in `VALID_BOOTSTRAP_NAMES` currently. Options:

- Add "PROJECT.md" to the union type and valid names array
- Or treat it as a special-case injection outside the standard bootstrap file discovery
- The second approach is cleaner since PROJECT.md lives in project dirs, not workspace dirs

### Heartbeat Filtering

When `runKind === "heartbeat"`, the existing filter keeps only HEARTBEAT.md. PROJECT.md should also be excluded in this mode (per D-12 decision).

## Bootstrap Hook Implementation

### Registration Pattern

Follow `src/hooks/bundled/bootstrap-extra-files/handler.ts`:

1. Create hook handler file
2. Register via `registerInternalHook("agent:bootstrap", handler)`
3. Handler reads agent config for `project` field
4. If configured, reads the project's PROJECT.md from `~/.openclaw/projects/<name>/PROJECT.md`
5. Appends as `WorkspaceBootstrapFile` to `context.bootstrapFiles`

### Deduplication

If both cwd pickup and bootstrap hook find a PROJECT.md:

- cwd version takes priority (per D-06)
- Check `bootstrapFiles` for existing PROJECT.md before appending
- Or append and let cwd override during merge

### Agent Config Access

`AgentBootstrapHookContext` has `cfg?: OpenClawConfig`. The project mapping (`agents.project: myproject`) would be read from agent-level config. Need to verify how agent config is accessed — likely via the config object passed through the hook context.

## IDENTITY.md Capabilities Extension

### Current Parser

`src/agents/identity-file.ts` — `parseIdentityMarkdown(content)`:

- Parses `- key: value` bullets from markdown
- Returns `AgentIdentityFile` with fields: `name`, `emoji`, `creature`, `vibe`, `theme`, `avatar`
- Uses regex to match `^\s*[-*]\s*(\w+)\s*[:=]\s*(.+)` pattern

### Extension Plan

1. Add `capabilities?: string[]` to `AgentIdentityFile` type
2. In `parseIdentityMarkdown()`, when key is "capabilities":
   - Split value by commas: `value.split(",").map(s => s.trim()).filter(Boolean)`
   - Store as string array
3. Export from identity-file.ts

### Capability Matcher

New file: `src/projects/capability-matcher.ts`

```typescript
export function matchCapabilities(agentCaps: string[], taskCaps: string[]): boolean;
```

Logic (per D-08, D-09):

- If `taskCaps` is empty → any agent can claim (no restriction)
- If `agentCaps` is empty → cannot claim capability-gated tasks (return false)
- Otherwise: return true if ANY agentCap is in taskCaps (intersection check)

## Testing Strategy

### Unit Tests

1. **CWD walk-up**: Mock filesystem with nested dirs containing PROJECT.md at different levels. Verify nearest wins. Verify stops at projects root.
2. **Bootstrap hook**: Mock agent config with `project: myproject`. Verify PROJECT.md injected. Verify skip when no config.
3. **Deduplication**: Both cwd and hook find PROJECT.md. Verify cwd version used.
4. **Heartbeat exclusion**: Verify PROJECT.md not injected when `runKind === "heartbeat"`.
5. **parseIdentityMarkdown capabilities**: Parse `- capabilities: code, testing, ui` → `["code", "testing", "ui"]`.
6. **matchCapabilities**: Test all combos — empty task caps, empty agent caps, matching, non-matching.

### Integration Considerations

- Existing AGENTS.md loading must continue working (AGNT-03 — additive only)
- No modification to `parseFrontmatterBlock()` (PARSE-04)
- Tests should verify existing bootstrap behavior is preserved

## Error Handling

- PROJECT.md not found via cwd walk-up: silently skip (no error)
- PROJECT.md configured via agent config but file missing: log warning, skip injection
- Malformed capabilities in IDENTITY.md: treat as empty array (no capabilities)
- Both paths inject same project: deduplicate by checking `bootstrapFiles` names

## File Impact Summary

| File                                                   | Change Type   | Description                                              |
| ------------------------------------------------------ | ------------- | -------------------------------------------------------- |
| `src/agents/identity-file.ts`                          | Modify        | Add `capabilities` to `AgentIdentityFile`, extend parser |
| `src/agents/bootstrap-files.ts`                        | Modify        | Add cwd walk-up for PROJECT.md                           |
| New: `src/projects/capability-matcher.ts`              | Create        | `matchCapabilities()` utility                            |
| New: `src/projects/capability-matcher.test.ts`         | Create        | Tests for matcher                                        |
| New: `src/agents/project-context-hook.ts` (or similar) | Create        | Bootstrap hook for project-scoped channels               |
| `src/agents/identity-file.test.ts` or new test         | Modify/Create | Tests for capabilities parsing                           |
| `src/projects/index.ts`                                | Modify        | Export capability matcher                                |

## Validation Architecture

### Automated Verification

- `pnpm test -- src/agents/identity-file.test.ts` — capabilities parsing
- `pnpm test -- src/projects/capability-matcher.test.ts` — matching logic
- `pnpm test -- src/agents/bootstrap-files.test.ts` or new test — cwd pickup + hook injection
- `pnpm tsgo` — type checking for new capabilities field

### Success Criteria Mapping

| Criterion                                          | How to Verify                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent in dir with PROJECT.md receives context      | Test cwd walk-up returns PROJECT.md in bootstrap files                 |
| Agent on project channel receives context via hook | Test bootstrap hook injects PROJECT.md when agent config has `project` |
| AGENTS.md loading unchanged                        | Test existing bootstrap behavior preserved (no regression)             |
| Capability matching works                          | Test `matchCapabilities()` with various input combos                   |
