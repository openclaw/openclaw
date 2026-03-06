# FIX-01: New Agents Missing MEMORY.md on Creation

## Current Behavior

When a new agent is created, `ensureAgentWorkspace()` creates all bootstrap files EXCEPT MEMORY.md.

- `src/agents/workspace.ts` lines 321-383: `ensureAgentWorkspace` — creates workspace files
- `src/agents/workspace.ts` line 32: `DEFAULT_MEMORY_FILENAME = "MEMORY.md"` — constant exists but unused in bootstrap
- `docs/reference/templates/` — all other templates exist, no MEMORY.md template
- `src/gateway/server-methods/agents.ts` lines 476-546: `agents.create` — no memory setup
- `src/commands/agents.commands.add.ts` lines 51-368: `agentsAddCommand` — no memory setup

## Dev-Mode Behavior

When `--dev-mode`, new agents get their own `MEMORY.md` on creation. Without dev-mode, behavior stays as-is (no MEMORY.md bootstrap).

## Implementation Plan

### Step 1: Create MEMORY.md template

Create `docs/reference/templates/MEMORY.md`:

```markdown
# Memory
```

### Step 2: Add to workspace bootstrap

In `src/agents/workspace.ts`, in `ensureAgentWorkspace()` (~line 321-383):

1. Add MEMORY.md to the list of bootstrap files
2. Use the existing `loadTemplate()` function (lines 104-128) to load the template
3. Write it alongside other bootstrap files

```typescript
import { isDevMode } from "../globals.js";

// In ensureAgentWorkspace():
if (isDevMode()) {
  const memoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
  if (!(await fileExists(memoryPath))) {
    const template = await loadTemplate("MEMORY.md");
    await writeFile(memoryPath, template ?? "# Memory\n");
  }
}
```

## Files to modify

| File                                 | Change                                                           |
| ------------------------------------ | ---------------------------------------------------------------- |
| `docs/reference/templates/MEMORY.md` | Create new template file                                         |
| `src/agents/workspace.ts`            | Add MEMORY.md to bootstrap in `ensureAgentWorkspace` (~line 321) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Very low. Only adds a file that was previously missing. Existing agents are unaffected (only new agents get the file).
