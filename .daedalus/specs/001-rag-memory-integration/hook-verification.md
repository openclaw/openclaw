# RAG Context Inject Hook - Discovery Verification

**Date:** 2026-02-03
**Subtask:** 5.3 - Verify hook discovery and registration

## Verification Summary

✅ **Hook is properly structured and will be discovered by the hook loader system**

## Directory Structure

```
src/hooks/bundled/rag-context-inject/
├── HOOK.md              ✓ Metadata file with frontmatter
├── handler.ts           ✓ Handler with default export
├── format.ts            ✓ Formatting utilities
└── discovery.test.ts    ✓ Comprehensive test suite
```

## Key Verifications

### 1. Hook Directory Location ✓
- **Location:** `src/hooks/bundled/rag-context-inject/`
- **Status:** Present alongside other bundled hooks (boot-md, session-memory, command-logger, soul-evil)
- **Discovery:** Will be found by `loadHooksFromDir()` in `src/hooks/workspace.ts`

### 2. HOOK.md Metadata ✓
```yaml
name: rag-context-inject
description: "Auto-inject relevant RAG context into agent bootstrap on session start"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["agent:bootstrap"]    # Correct event specified
    requires:
      config:
        - agents.defaults.memorySearch.graphiti.endpoint
        - agents.defaults.memorySearch.lightrag.endpoint
        - agents.defaults.memorySearch.memoryService.endpoint
```

### 3. Handler File ✓
- **File:** `handler.ts` (one of the valid handler candidates)
- **Export:** `export default injectRAGContext;` (default export as expected)
- **Type:** Implements `HookHandler<AgentBootstrapHookContext>` interface

### 4. Hook Loader Process ✓

The hook will be discovered and registered through this flow:

1. **Server Startup** (`src/gateway/server-startup.ts:104`)
   ```ts
   await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
   ```

2. **Load Internal Hooks** (`src/hooks/loader.ts:36-106`)
   - Calls `loadWorkspaceHookEntries(workspaceDir, { config: cfg })`
   - Filters hooks by eligibility
   - Imports handler module with cache-busting
   - Registers handler for each event in metadata

3. **Workspace Hook Discovery** (`src/hooks/workspace.ts:193-261`)
   - Resolves bundled hooks directory via `resolveBundledHooksDir()`
   - Scans for subdirectories containing `HOOK.md`
   - Loads hook metadata and finds handler file
   - Returns `HookEntry[]` including our hook

4. **Bundled Directory Resolution** (`src/hooks/bundled-dir.ts`)
   - Checks `OPENCLAW_BUNDLED_HOOKS_DIR` env var
   - Falls back to dist/hooks/bundled (production)
   - Falls back to src/hooks/bundled (development) ✓

### 5. Event Registration ✓
- **Event:** `agent:bootstrap`
- **Registration:** Hook will be registered to trigger on this event
- **Context:** Receives `AgentBootstrapHookContext` with access to `bootstrapFiles[]`

### 6. Configuration Support ✓
The hook respects configuration from `openclaw.json`:
```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "rag-context-inject": {
          "enabled": true,
          "maxEntities": 20,
          "maxRelations": 30,
          "maxMemories": 15,
          "maxDocuments": 10
        }
      }
    }
  }
}
```

### 7. Test Coverage ✓
Comprehensive test suite exists in `discovery.test.ts`:
- ✅ Hook discovered in bundled directory
- ✅ Correct metadata (name, source, events, emoji)
- ✅ Valid handler file path
- ✅ Registration for agent:bootstrap event
- ✅ Respects enabled flag in config

## Expected Behavior

When OpenClaw starts:

1. Hook loader scans `src/hooks/bundled/` directory
2. Finds `rag-context-inject/HOOK.md` with valid frontmatter
3. Locates `rag-context-inject/handler.ts` handler file
4. Parses metadata: `events: ["agent:bootstrap"]`
5. Imports handler module and gets default export
6. Registers handler to be triggered on `agent:bootstrap` event
7. Logs: `Registered hook: rag-context-inject -> agent:bootstrap`

When an agent session starts:

1. Agent bootstrap process begins
2. `agent:bootstrap` event is triggered with context
3. Handler queries RAG services (Graphiti, LightRAG, Memory Service)
4. Handler formats results into `RAG_CONTEXT.md`
5. Handler injects synthetic bootstrap file into `context.bootstrapFiles`
6. Agent receives RAG context in its initial prompt

## Manual Testing

To verify hook registration at runtime:

```bash
# 1. Start OpenClaw gateway
openclaw gateway start

# 2. Look for registration message in logs
# Expected: "Registered hook: rag-context-inject -> agent:bootstrap"

# 3. Start an agent session
# Expected: "[rag-context-inject] RAG context injected successfully"

# 4. List registered hooks
openclaw hooks list | grep rag-context-inject
```

## Conclusion

✅ The `rag-context-inject` hook is **properly structured and will be discovered and registered** by the hook loader system.

All acceptance criteria met:
- ✅ Hook discovered in bundled hooks directory
- ✅ Hook registered for agent:bootstrap event
- ✅ Hook config read from openclaw.json
- ✅ Comprehensive test coverage exists
