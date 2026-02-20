---
type: report
title: "Test Investigation: Hook Lifecycle System"
created: 2026-02-19
tags:
  - validation
  - hooks
  - test
related:
  - "[[SKILL.md]]"
  - "[[codebase-exploration]]"
---

# How Does the Hook Lifecycle System Work in OpenClaw?

OpenClaw implements a **dual-layer hook system**: Layer 1 is a typed plugin hook runner (`src/plugins/hooks.ts`) with 14 named lifecycle events executed via a priority-sorted `HookRunner`, and Layer 2 is an internal event bus (`src/hooks/internal-hooks.ts`) using string-keyed `type:action` dispatch for command, session, agent, and gateway events. Both layers coexist — plugins register on either or both, and hooks are discovered from bundled, managed, workspace, and plugin directories.

### Key Files

| File | Purpose |
|------|---------|
| `src/plugins/hooks.ts:93` | `createHookRunner()` — Layer 1 hook runner factory with `runVoidHook` (parallel) and `runModifyingHook` (sequential) execution strategies |
| `src/plugins/types.ts:287` | `PluginHookName` union type — defines all 14 typed hook names |
| `src/plugins/types.ts:464` | `PluginHookHandlerMap` — maps each hook name to its handler signature |
| `src/plugins/types.ts:520` | `PluginHookRegistration` — registration record with `pluginId`, `hookName`, `handler`, `priority`, `source` |
| `src/plugins/hook-runner-global.ts:21` | `initializeGlobalHookRunner()` — singleton initialization at gateway startup |
| `src/plugins/hook-runner-global.ts:42` | `getGlobalHookRunner()` — global access point used by trigger sites |
| `src/hooks/internal-hooks.ts:67` | `registerInternalHook()` — Layer 2 handler registration by event key |
| `src/hooks/internal-hooks.ts:123` | `triggerInternalHook()` — Layer 2 event dispatch (type handlers + type:action handlers) |
| `src/hooks/internal-hooks.ts:153` | `createInternalHookEvent()` — event factory with type, action, sessionKey, context, timestamp, messages |
| `src/hooks/types.ts:10` | `OpenClawHookMetadata` — hook metadata including `events`, `requires`, `os`, `always`, `install` |
| `src/hooks/types.ts:35` | `Hook` type — hook identity with name, description, source, filePath, handlerPath |
| `src/hooks/loader.ts:36` | `loadInternalHooks()` — discovers and registers Layer 2 hooks from directories + legacy config |
| `src/hooks/config.ts:83` | `shouldIncludeHook()` — eligibility checker (OS, binaries, env vars, config paths) |
| `src/hooks/plugin-hooks.ts:60` | `registerPluginHooksFromDir()` — loads hook directories from within a plugin package |
| `src/plugins/registry.ts:124` | `PluginRegistry` type — contains both `hooks` (Layer 2 registrations) and `typedHooks` (Layer 1 registrations) |
| `src/plugins/registry.ts:195` | `registerHook()` — plugin API hook registration (creates `HookEntry`, calls `registerInternalHook()`) |
| `src/plugins/registry.ts:445` | `registerTypedHook()` — `api.on()` implementation pushing to `registry.typedHooks` |
| `src/hooks/workspace.ts` | `loadWorkspaceHookEntries()` — discovers hooks from bundled/managed/workspace directories |
| `src/hooks/frontmatter.ts` | Parses `HOOK.md` YAML frontmatter for metadata extraction |
| `src/hooks/bundled-dir.ts:5` | `resolveBundledHooksDir()` — locates bundled hooks directory (env, bun --compile, npm, dev) |

### How It Works

#### Layer 1: Typed Plugin Hooks (Priority-Sorted Lifecycle Events)

The typed hook system provides strongly-typed lifecycle events for the agent, message, tool, session, and gateway domains.

**Registration:**

1. During plugin loading, each plugin receives an `OpenClawPluginApi` instance (`src/plugins/registry.ts:468`)
2. Plugins register typed hooks via `api.on(hookName, handler, { priority? })` (`src/plugins/registry.ts:497`)
3. This calls `registerTypedHook()` which pushes a `PluginHookRegistration` to `registry.typedHooks` (`src/plugins/registry.ts:445-459`)
4. After all plugins load, `initializeGlobalHookRunner(registry)` creates and caches the singleton `HookRunner` (`src/plugins/hook-runner-global.ts:21-36`)

**Execution — two strategies:**

1. **`runVoidHook`** (fire-and-forget, parallel) — used for observational hooks (`src/plugins/hooks.ts:101-127`):
   - Gets hooks sorted by priority (higher first) via `getHooksForName()` (`src/plugins/hooks.ts:81-88`)
   - Executes all handlers in parallel via `Promise.all()`
   - Errors are caught and logged (when `catchErrors: true`, the default)
   - Used by: `agent_end`, `before_compaction`, `after_compaction`, `message_received`, `message_sent`, `after_tool_call`, `session_start`, `session_end`, `gateway_start`, `gateway_stop`

2. **`runModifyingHook`** (sequential, result-merging) — used for hooks that can alter behavior (`src/plugins/hooks.ts:133-172`):
   - Executes handlers sequentially in priority order
   - Each handler can return a result; results are merged via a custom `mergeResults` function
   - Used by: `before_agent_start` (can inject system prompt / prepend context), `message_sending` (can modify content or cancel), `before_tool_call` (can modify params or block)

3. **`runToolResultPersist`** — special synchronous hook (`src/plugins/hooks.ts:325-372`):
   - Intentionally synchronous (not async) because it runs in hot paths where session transcripts are appended synchronously
   - Handlers execute sequentially; each can replace the message passed to the next handler
   - Guards against accidental async handlers (warns and ignores if a Promise is returned)

**The 14 typed hook names** (`src/plugins/types.ts:287-301`):

| Hook Name | Category | Strategy | Can Modify? |
|-----------|----------|----------|-------------|
| `before_agent_start` | Agent | Sequential | Yes — system prompt, prepend context |
| `agent_end` | Agent | Parallel | No |
| `before_compaction` | Agent | Parallel | No |
| `after_compaction` | Agent | Parallel | No |
| `message_received` | Message | Parallel | No |
| `message_sending` | Message | Sequential | Yes — content, cancel flag |
| `message_sent` | Message | Parallel | No |
| `before_tool_call` | Tool | Sequential | Yes — params, block flag |
| `after_tool_call` | Tool | Parallel | No |
| `tool_result_persist` | Tool | Synchronous | Yes — message replacement |
| `session_start` | Session | Parallel | No |
| `session_end` | Session | Parallel | No |
| `gateway_start` | Gateway | Parallel | No |
| `gateway_stop` | Gateway | Parallel | No |

**Current trigger sites (as of 2026-02-19):**

| Hook | Trigger Location | Context |
|------|-----------------|---------|
| `before_agent_start` | `src/agents/pi-embedded-runner/run/attempt.ts:728` | Before each agent prompt attempt; can inject system prompt |
| `agent_end` | `src/agents/pi-embedded-runner/run/attempt.ts:856` | After prompt attempt completes (fire-and-forget) |
| `message_received` | `src/auto-reply/reply/dispatch-from-config.ts:170` | When an inbound message arrives |
| `before_tool_call` | `src/agents/pi-tools.before-tool-call.ts:34` | Before every agent tool execution |
| `tool_result_persist` | `src/agents/session-tool-result-guard-wrapper.ts:30` | Before tool result is written to session |

Note: `message_sending`, `message_sent`, `after_tool_call`, `before_compaction`, `after_compaction`, `session_start`, `session_end`, `gateway_start`, and `gateway_stop` are fully implemented in the hook runner but have no trigger call sites yet — they are infrastructure ready for future use or extension-initiated triggers.

#### Layer 2: Internal Event Bus (String-Keyed Dispatch)

The internal hook system is a lightweight pub/sub event bus for operational events.

**Event structure** (`src/hooks/internal-hooks.ts:28-41`):

```typescript
// src/hooks/internal-hooks.ts:28
interface InternalHookEvent {
  type: InternalHookEventType;  // "command" | "session" | "agent" | "gateway"
  action: string;               // e.g., "new", "reset", "stop", "bootstrap", "startup"
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];           // hooks can push messages back to the user
}
```

**Registration** (`src/hooks/internal-hooks.ts:67-72`):

- Handlers are stored in a `Map<string, InternalHookHandler[]>` keyed by event string
- Event keys can be general (`"command"`) or specific (`"command:new"`)
- Multiple handlers per key, stored in registration order

**Dispatch** (`src/hooks/internal-hooks.ts:123-143`):

1. `triggerInternalHook(event)` collects handlers for both the general type key and the specific `type:action` key
2. All matching handlers execute sequentially in registration order
3. Errors are caught and logged via `console.error` — one failing handler does not block others
4. Handlers can mutate the event object (e.g., push to `messages[]`, modify `context.bootstrapFiles`)

**Current trigger sites:**

| Event | Trigger Location | Purpose |
|-------|-----------------|---------|
| `command:new`, `command:reset` | `src/auto-reply/reply/commands-core.ts:84` | Fired when user sends `/new` or `/reset` |
| `command:stop` | `src/auto-reply/reply/commands-session.ts:340` | Fired when user sends `/stop` |
| `agent:bootstrap` | `src/agents/bootstrap-hooks.ts:28` | Before workspace bootstrap files are injected; handlers can mutate `context.bootstrapFiles` |
| `gateway:startup` | `src/gateway/server-startup.ts:138` | 250ms after gateway channel startup (fire-and-forget) |

#### Hook Discovery and Loading

**Directory-based discovery** (`src/hooks/loader.ts:36-146`):

1. Check `config.hooks.internal.enabled` — if false, return 0
2. Call `loadWorkspaceHookEntries()` to scan three directories in priority order:
   - Bundled: `<openclaw>/dist/hooks/bundled/` (resolved via `resolveBundledHooksDir()`)
   - Managed: `~/.openclaw/hooks/`
   - Workspace: `<workspace>/hooks/`
3. Each hook directory must contain `HOOK.md` (metadata) and `handler.ts` (implementation)
4. Filter by eligibility via `shouldIncludeHook()` (`src/hooks/config.ts:83-164`):
   - OS platform check (`metadata.os`)
   - Required binaries check (`metadata.requires.bins`, `metadata.requires.anyBins`)
   - Required environment variables check (`metadata.requires.env`)
   - Required config paths check (`metadata.requires.config`)
   - Explicit enable/disable from `config.hooks.internal.entries.<name>`
   - `metadata.always === true` bypasses all checks except OS and explicit disable
5. Import handler module via dynamic `import()` with cache-busting (`?t=${Date.now()}`)
6. Register handler for each event in `metadata.events` via `registerInternalHook()`

**Plugin-bundled hooks** (`src/hooks/plugin-hooks.ts:60-116`):

Plugins can bundle their own hook directories and register them via:
```typescript
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";
api.registerHook(events, handler, { entry, register: eligible });
```

This follows the same `HOOK.md` + `handler.ts` convention but hooks are scoped to the plugin and appear with source `"openclaw-plugin"`.

**Plugin API dual registration** (`src/plugins/registry.ts:195-263`):

When a plugin calls `api.registerHook(events, handler, opts)`:
1. A `HookEntry` is created and pushed to `registry.hooks` (for status/listing)
2. If hooks are enabled in config AND `opts.register !== false`, `registerInternalHook()` is called for each event (Layer 2 registration)
3. Separately, `api.on(hookName, handler)` registers typed hooks into `registry.typedHooks` (Layer 1 registration)

#### Bundled Hooks

OpenClaw ships 4 bundled hooks:

| Hook | Event(s) | Purpose |
|------|----------|---------|
| `session-memory` | `command:new` | Saves last N conversation messages to `<workspace>/memory/YYYY-MM-DD-slug.md` with LLM-generated slug |
| `command-logger` | `command` | Appends JSONL to `~/.openclaw/logs/commands.log` for every command event |
| `boot-md` | `gateway:startup` | Reads and runs `BOOT.md` from the workspace on gateway start |
| `soul-evil` | `agent:bootstrap` | Probabilistically or time-window swaps `SOUL.md` with `SOUL_EVIL.md` content in-memory |

### Related Modules

- `src/plugins/` — plugin system that initializes the hook runner and provides the `api.on()` / `api.registerHook()` registration API
- `src/agents/pi-embedded-runner/` — agent execution engine that triggers `before_agent_start` and `agent_end`
- `src/auto-reply/` — message processing pipeline that triggers `message_received` and Layer 2 command hooks
- `src/gateway/server-startup.ts` — gateway startup that triggers `gateway:startup` and initializes the global hook runner
- `src/config/` — configuration loading that controls `hooks.internal.enabled` and per-hook `entries` settings

### Code Snippets

```typescript
// src/plugins/hooks.ts:81-88 — Priority sorting for hook execution
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
```

```typescript
// src/hooks/internal-hooks.ts:123-143 — Layer 2 dual-key dispatch
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];
  if (allHandlers.length === 0) return;
  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      console.error(`Hook error [${event.type}:${event.action}]:`,
        err instanceof Error ? err.message : String(err));
    }
  }
}
```

```typescript
// src/plugins/hook-runner-global.ts:21-36 — Singleton initialization at gateway startup
export function initializeGlobalHookRunner(registry: PluginRegistry): void {
  globalRegistry = registry;
  globalHookRunner = createHookRunner(registry, {
    logger: {
      debug: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
    catchErrors: true,
  });
  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.info(`hook runner initialized with ${hookCount} registered hooks`);
  }
}
```

### Test Coverage Notes

The hook system has extensive test coverage across 11 test files:

- **Core registry tests** (`src/hooks/internal-hooks.test.ts`) — register/unregister/trigger/clear lifecycle, error isolation, async handler support
- **Loader tests** (`src/hooks/loader.test.ts`) — config gating, module loading, named exports, error handling, end-to-end trigger verification
- **Bundled hook tests** — `session-memory/handler.test.ts` (388 lines, message filtering, config limits), `soul-evil/handler.test.ts` (subagent skip), `soul-evil.test.ts` (252 lines, probabilistic/time-window logic)
- **E2E test** (`src/hooks/hooks-install.e2e.test.ts`) — full pipeline from install to trigger
- **Frontmatter parsing** (`src/hooks/frontmatter.test.ts`) — YAML, JSON, edge cases
- **Installation** (`src/hooks/install.test.ts`) — zip/tar archive extraction, path traversal security

Key testing pattern: `clearInternalHooks()` in both `beforeEach` and `afterEach` ensures complete isolation between tests. `OPENCLAW_BUNDLED_HOOKS_DIR` is overridden to prevent bundled hooks from interfering with unit tests.
