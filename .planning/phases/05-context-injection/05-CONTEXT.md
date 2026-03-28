# Phase 5: Context Injection - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents automatically receive project context (PROJECT.md) when working in or assigned to a project, and can be matched to tasks by capability tags defined in IDENTITY.md. This phase adds two injection paths (cwd pickup and bootstrap hook), extends IDENTITY.md parsing for capabilities, and provides a standalone capability matcher utility.

</domain>

<decisions>
## Implementation Decisions

### CWD-Based PROJECT.md Pickup

- **D-01:** Walk up from agent's cwd through parent directories until PROJECT.md is found or `~/.openclaw/projects/` root is reached. Matches the existing AGENTS.md lookup pattern.
- **D-02:** Inject PROJECT.md as a `WorkspaceBootstrapFile` alongside AGENTS.md and IDENTITY.md. Appears in agent's system prompt automatically via the existing bootstrap pipeline.
- **D-03:** Injection happens on every run including initial (not just post-compaction). Agents have project context from the start.
- **D-04:** Nearest PROJECT.md wins for sub-projects. If agent cwd is inside a sub-project, load that sub-project's PROJECT.md. Walk-up stops at first PROJECT.md found.

### Bootstrap Hook Integration

- **D-05:** Channel-to-project mapping stored in agent config (per-agent), e.g., `agents.project: myproject`. The bootstrap hook reads this config field and injects the corresponding project's PROJECT.md.
- **D-06:** Both cwd pickup and bootstrap hook are active simultaneously. If both find a PROJECT.md, cwd version takes priority (agent is physically in the project). Avoids duplicate injection.

### Capability Tags in IDENTITY.md

- **D-07:** Capabilities defined as a bullet list with comma-separated values in IDENTITY.md: `- capabilities: code, testing, ui`. Parsed by extending existing `parseIdentityMarkdown()` function. Returns `string[]`.
- **D-08:** Capability matching uses ANY-match: agent matches a task if it has at least ONE of the task's required capabilities. Permissive — good for smaller teams.
- **D-09:** No capabilities defined in IDENTITY.md = cannot claim capability-gated tasks. Agents without capabilities can only claim tasks that also have no capability requirements.

### Context Content and Format

- **D-10:** Full PROJECT.md file injected as-is. No transformation or summarization. Context cost is typically under 1KB.
- **D-11:** Capability matcher lives in a new dedicated file: `src/projects/capability-matcher.ts` with `matchCapabilities(agentCaps, taskCaps)` returning boolean. Clean separation, reused by heartbeat (Phase 6) and CLI (Phase 8).
- **D-12:** PROJECT.md injection skipped on heartbeat runs (lightweight context mode). Heartbeat task pickup (Phase 6) reads project files directly, not from bootstrap context.

### Claude's Discretion

- Internal implementation of cwd walk-up (fs.stat loop vs path resolution)
- How to register the bootstrap hook (internal hook vs bundled hook handler)
- Test approach for bootstrap file injection (mock vs integration)
- Whether to add `capabilities` to `AgentIdentityFile` type or keep as separate utility

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Bootstrap System

- `src/agents/bootstrap-hooks.ts` — `applyBootstrapHookOverrides()` entry point for hook execution
- `src/agents/bootstrap-files.ts` — `resolveBootstrapFilesForRun()` canonical path, `contextMode: "lightweight"` filtering
- `src/hooks/internal-hooks.ts` — `registerInternalHook()`, `triggerInternalHook()`, `AgentBootstrapHookContext` type
- `src/hooks/bundled/bootstrap-extra-files/handler.ts` — Example bundled bootstrap hook (glob pattern injection)

### Agent Identity

- `src/agents/identity-file.ts` — `parseIdentityMarkdown()`, `AgentIdentityFile` type, `loadAgentIdentityFromWorkspace()`
- `src/agents/workspace.ts` — `VALID_BOOTSTRAP_NAMES`, `DEFAULT_IDENTITY_FILENAME`

### Projects (from prior phases)

- `src/projects/schemas.ts` — `TaskFrontmatterSchema` with `capabilities: z.array(z.string())`
- `src/projects/scaffold.ts` — `ProjectManager`, project directory structure
- `src/projects/sync-service.ts` — `ProjectSyncService.discoverProjects()` for project discovery

### Heartbeat

- `src/agents/bootstrap-files.ts` — `runKind: "heartbeat"` filtering that keeps only HEARTBEAT.md

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `applyBootstrapHookOverrides()` — Mutates `bootstrapFiles` array in place; new hook can append PROJECT.md file
- `parseIdentityMarkdown()` — Parses `- key: value` bullets from IDENTITY.md; extend to handle `capabilities` key
- `ProjectSyncService.discoverProjects()` — Already discovers project directories with PROJECT.md
- `WorkspaceBootstrapFile` type — Standard shape for files injected into agent system prompt
- `AgentBootstrapHookContext` — Has `workspaceDir`, `bootstrapFiles[]`, `cfg`, `agentId`

### Established Patterns

- Internal hooks registered via `registerInternalHook("agent:bootstrap", handler)`
- Bootstrap files filtered by `contextMode` — "lightweight" keeps only HEARTBEAT.md
- IDENTITY.md parsed from markdown bullets, no frontmatter block

### Integration Points

- `resolveBootstrapFilesForRun()` — Where cwd-based PROJECT.md detection should happen (before hook execution)
- `registerInternalHook("agent:bootstrap", ...)` — Where bootstrap hook should be registered
- `AgentIdentityFile` type — Where `capabilities?: string[]` field should be added

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 05-context-injection_
_Context gathered: 2026-03-27_
