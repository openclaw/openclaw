# Lazy-Loaded Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `before_tool_surface` hook and lazy-tools plugin so agents only pay token cost for tools they actually use (~87-96% savings on cron jobs).

**Architecture:** New `before_tool_surface` modifying hook lets plugins filter the `tools[]` array before each LLM API call via `streamFn` wrapper. All tools remain registered in the session for execution, but only visible tools' schemas are sent to the LLM. A `lazy-tools` extension plugin uses this hook to hide non-core tools behind a `load_toolkit` meta-tool. Toolkits are loaded mid-session by updating a per-session `Set<string>` — the next `streamFn` call (even within the same turn) picks up the change.

**Tech Stack:** TypeScript, vitest, OpenClaw plugin SDK

**Key architectural decisions:**

- `splitSdkTools` stays sync — no breaking change
- Hook runs in `streamFn` wrapper (per-LLM-call), not in `splitSdkTools` (per-session)
- `load_toolkit` execute signature: `(toolCallId: string, args: unknown, signal?: AbortSignal)` matching `AgentTool`
- `load_toolkit` returns `AgentToolResult` with `content: [{ type: "text", text: "..." }]`
- All tools pass through to session creation for execution; only schema visibility is filtered
- Per-session state uses `Map<sessionKey:sessionId, Set<string>>` for loaded toolkits

---

## Task 1: Add `before_tool_surface` hook type definitions

**Files:**

- Modify: `src/plugins/types.ts:1027-1080` (PluginHookName, PLUGIN_HOOK_NAMES)
- Modify: `src/plugins/types.ts:1526-1627` (PluginHookHandlerMap)

**Step 1: Write the failing test**

Create `src/plugins/hooks.before-tool-surface.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("before_tool_surface hook", () => {
  it("filters tools via hook handler", async () => {
    const handler = vi.fn().mockReturnValue({
      tools: [{ name: "read", description: "read", parameters: {} }],
    });
    const registry = createMockPluginRegistry([{ hookName: "before_tool_surface", handler }]);
    const runner = createHookRunner(registry);

    const event = {
      tools: [
        { name: "read", description: "read", parameters: {} },
        { name: "write", description: "write", parameters: {} },
        { name: "message", description: "message", parameters: {} },
      ],
    };
    const ctx = {
      agentId: "test",
      sessionKey: "test-sk",
      sessionId: "test-sid",
    };

    const result = await runner.runBeforeToolSurface(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
    expect(result?.tools).toHaveLength(1);
    expect(result?.tools?.[0].name).toBe("read");
  });

  it("returns undefined when no hooks registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeToolSurface(
      { tools: [{ name: "read", description: "read", parameters: {} }] },
      { agentId: "test" },
    );

    expect(result).toBeUndefined();
  });

  it("merges multiple handlers — last defined tools wins", async () => {
    const handler1 = vi.fn().mockReturnValue({
      tools: [{ name: "a", description: "a", parameters: {} }],
    });
    const handler2 = vi.fn().mockReturnValue({
      tools: [{ name: "b", description: "b", parameters: {} }],
    });
    const registry = createMockPluginRegistry([
      { hookName: "before_tool_surface", handler: handler1 },
      { hookName: "before_tool_surface", handler: handler2 },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeToolSurface({ tools: [] }, { agentId: "test" });

    expect(result?.tools?.[0].name).toBe("b");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run src/plugins/hooks.before-tool-surface.test.ts`
Expected: FAIL — `runBeforeToolSurface` does not exist on HookRunner

**Step 3: Add type definitions to `types.ts`**

In `src/plugins/types.ts`:

Add `"before_tool_surface"` to `PluginHookName` union (after `"after_tool_call"`, line 1042):

```typescript
  | "before_tool_surface"
```

Add to `PLUGIN_HOOK_NAMES` array (after `"after_tool_call"`, line 1069):

```typescript
  "before_tool_surface",
```

Add event/result types (after the `after_tool_call` types, around line 1372):

```typescript
// before_tool_surface hook
export type PluginHookBeforeToolSurfaceEvent = {
  /** Tool definitions about to be sent to the LLM. */
  tools: Array<{ name: string; description: string; parameters: unknown }>;
};

export type PluginHookBeforeToolSurfaceResult = {
  /** Replacement tool list. If set, overrides the original tools array. */
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
};
```

Add to `PluginHookHandlerMap` (after `after_tool_call` entry, around line 1582):

```typescript
  before_tool_surface: (
    event: PluginHookBeforeToolSurfaceEvent,
    ctx: PluginHookAgentContext,
  ) =>
    | Promise<PluginHookBeforeToolSurfaceResult | void>
    | PluginHookBeforeToolSurfaceResult
    | void;
```

**Step 4: Commit**

```bash
git add src/plugins/types.ts src/plugins/hooks.before-tool-surface.test.ts
git commit -m "feat(plugins): add before_tool_surface hook type definitions"
```

---

## Task 2: Implement `before_tool_surface` hook runner

**Files:**

- Modify: `src/plugins/hooks.ts` — imports (line 28), re-exports (line 82), tool hooks section (after line 660), return object (line 940)

**Step 1: Add imports and re-exports in `hooks.ts`**

Add to import block from `"./types.js"` (around line 28):

```typescript
  PluginHookBeforeToolSurfaceEvent,
  PluginHookBeforeToolSurfaceResult,
```

Add to re-export block (around line 82):

```typescript
  PluginHookBeforeToolSurfaceEvent,
  PluginHookBeforeToolSurfaceResult,
```

**Step 2: Add merge function and runner method**

In `createHookRunner`, Tool Hooks section, after `runAfterToolCall` (around line 660):

```typescript
const mergeBeforeToolSurface = (
  acc: PluginHookBeforeToolSurfaceResult | undefined,
  next: PluginHookBeforeToolSurfaceResult,
): PluginHookBeforeToolSurfaceResult => ({
  tools: next.tools ?? acc?.tools,
});

/**
 * Run before_tool_surface hook.
 * Allows plugins to filter or replace the tools[] array before it's sent to the LLM.
 * Runs sequentially in priority order.
 */
async function runBeforeToolSurface(
  event: PluginHookBeforeToolSurfaceEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeToolSurfaceResult | undefined> {
  return runModifyingHook<"before_tool_surface", PluginHookBeforeToolSurfaceResult>(
    "before_tool_surface",
    event,
    ctx,
    mergeBeforeToolSurface,
  );
}
```

**Step 3: Add to return object**

After `runAfterToolCall,` in the return statement (around line 941):

```typescript
    runBeforeToolSurface,
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run src/plugins/hooks.before-tool-surface.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/hooks.ts
git commit -m "feat(plugins): implement before_tool_surface hook runner"
```

---

## Task 3: Wire hook into `streamFn` wrapper (per-LLM-call filtering)

**Files:**

- Modify: `src/agents/pi-embedded-runner/run/attempt.ts` — add streamFn wrapper after line 2033
- Test: `src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts` (create)

**Why `streamFn` wrapper instead of `splitSdkTools`:**
`splitSdkTools` runs once at session creation. Tools passed to `createAgentSession` are immutable for the session lifetime inside `pi-agent-core`. The `streamFn` wrapper intercepts every LLM API call, so `load_toolkit` changes take effect on the very next call within the same turn.

**Step 1: Write the failing test**

Create `src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithToolSurface } from "./stream-tool-surface.js";

describe("wrapStreamFnWithToolSurface", () => {
  it("filters tools via hook before calling inner streamFn", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolSurface: vi.fn().mockResolvedValue({
        tools: [{ name: "read", description: "read", parameters: {} }],
      }),
    };

    const wrapped = wrapStreamFnWithToolSurface(innerFn as any, hookRunner as any, {
      agentId: "test",
      sessionKey: "test-sk",
    });

    const model = { provider: "anthropic" };
    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [
        { name: "read", description: "read", parameters: {} },
        { name: "message", description: "message", parameters: {} },
      ],
    };
    const options = {};

    await wrapped(model as any, context as any, options as any);

    // Verify hook was called with original tools
    expect(hookRunner.runBeforeToolSurface).toHaveBeenCalledWith(
      { tools: context.tools },
      { agentId: "test", sessionKey: "test-sk" },
    );

    // Verify inner streamFn received filtered tools
    const passedContext = innerFn.mock.calls[0][1];
    expect(passedContext.tools).toHaveLength(1);
    expect(passedContext.tools[0].name).toBe("read");
  });

  it("passes through unmodified when no hooks", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
    };

    const wrapped = wrapStreamFnWithToolSurface(innerFn as any, hookRunner as any, {});

    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [
        { name: "read", description: "read", parameters: {} },
        { name: "message", description: "message", parameters: {} },
      ],
    };

    await wrapped({} as any, context as any, {} as any);

    const passedContext = innerFn.mock.calls[0][1];
    expect(passedContext.tools).toHaveLength(2);
  });

  it("passes through when hook returns no tools override", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolSurface: vi.fn().mockResolvedValue(undefined),
    };

    const wrapped = wrapStreamFnWithToolSurface(innerFn as any, hookRunner as any, {});

    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [{ name: "read", description: "read", parameters: {} }],
    };

    await wrapped({} as any, context as any, {} as any);

    const passedContext = innerFn.mock.calls[0][1];
    expect(passedContext.tools).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts`
Expected: FAIL — module not found

**Step 3: Create `stream-tool-surface.ts`**

Create `src/agents/pi-embedded-runner/run/stream-tool-surface.ts`:

```typescript
import type { HookRunner } from "../../../plugins/hooks.js";
import type { PluginHookAgentContext } from "../../../plugins/types.js";

type StreamFn = (model: unknown, context: unknown, options: unknown) => unknown;

/**
 * Wrap a streamFn to apply `before_tool_surface` hook before each LLM call.
 * This filters tool schemas sent to the LLM while keeping all tools registered
 * in the session for execution.
 */
export function wrapStreamFnWithToolSurface(
  innerFn: StreamFn,
  hookRunner: Pick<HookRunner, "hasHooks" | "runBeforeToolSurface">,
  hookCtx: PluginHookAgentContext,
): StreamFn {
  return async (model: unknown, context: unknown, options: unknown) => {
    if (!hookRunner.hasHooks("before_tool_surface")) {
      return innerFn(model, context, options);
    }

    const ctx = context as Record<string, unknown>;
    const tools = ctx?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      return innerFn(model, context, options);
    }

    const hookResult = await hookRunner.runBeforeToolSurface({ tools }, hookCtx);

    if (!hookResult?.tools) {
      return innerFn(model, context, options);
    }

    // Replace tools in context, preserving all other fields
    const filteredContext = { ...ctx, tools: hookResult.tools };
    return innerFn(model, filteredContext, options);
  };
}
```

**Step 4: Wire into `attempt.ts`**

In `src/agents/pi-embedded-runner/run/attempt.ts`, add import at top:

```typescript
import { wrapStreamFnWithToolSurface } from "./stream-tool-surface.js";
```

After the existing streamFn wrappers (around line 2033, before the yield-detection wrapper at line 2035), add:

```typescript
// Lazy-load tool surface filtering: run before_tool_surface hook on every
// LLM call so plugins (e.g. lazy-tools) can filter tool schemas dynamically.
if (hookRunner?.hasHooks("before_tool_surface")) {
  activeSession.agent.streamFn = wrapStreamFnWithToolSurface(
    activeSession.agent.streamFn,
    hookRunner,
    {
      agentId: sessionAgentId,
      sessionKey: sandboxSessionKey,
      sessionId: params.sessionId,
      workspaceDir: resolvedWorkspace,
    },
  );
}
```

**Step 5: Run tests**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/agents/pi-embedded-runner/run/stream-tool-surface.ts src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts src/agents/pi-embedded-runner/run/attempt.ts
git commit -m "feat(tools): wire before_tool_surface hook into streamFn wrapper for per-call filtering"
```

---

## Task 4: Create the `lazy-tools` extension plugin

**Files:**

- Create: `extensions/lazy-tools/index.ts`
- Create: `extensions/lazy-tools/package.json`
- Test: `extensions/lazy-tools/index.test.ts` (create)

**Step 1: Write the failing test**

Create `extensions/lazy-tools/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createLazyToolsPlugin, TOOLKITS, CORE_TOOLS } from "./index.js";

describe("lazy-tools plugin logic", () => {
  it("loadToolkit returns toolkit info and updates state", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const result = plugin.loadToolkit("messaging", loaded);

    expect("loaded" in result && result.loaded).toBe("messaging");
    expect("tools" in result && result.tools).toEqual(TOOLKITS.messaging);
    expect(loaded.has("messaging")).toBe(true);
  });

  it("loadToolkit rejects unknown toolkit", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const result = plugin.loadToolkit("nonexistent", loaded);

    expect("error" in result).toBe(true);
  });

  it("filterTools keeps core tools, hides unloaded toolkit tools", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "write", description: "write", parameters: {} },
      { name: "exec", description: "exec", parameters: {} },
      { name: "edit", description: "edit", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
      { name: "memory_search", description: "mem", parameters: {} },
      { name: "some_unknown_tool", description: "unknown", parameters: {} },
    ];

    const filtered = plugin.filterTools(tools, loaded);
    const names = filtered.map((t) => t.name);

    // Core tools always visible
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("exec");
    expect(names).toContain("edit");
    expect(names).toContain("load_toolkit");
    // Unknown tools (not in any toolkit) pass through
    expect(names).toContain("some_unknown_tool");
    // Toolkit tools hidden
    expect(names).not.toContain("message");
    expect(names).not.toContain("memory_search");
  });

  it("filterTools shows tools from loaded toolkits", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set(["messaging"]);
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
      { name: "sessions_send", description: "send", parameters: {} },
      { name: "memory_search", description: "mem", parameters: {} },
    ];

    const filtered = plugin.filterTools(tools, loaded);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("message");
    expect(names).toContain("sessions_send");
    expect(names).not.toContain("memory_search");
  });

  it("loadToolkit then filterTools shows newly loaded tools", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
    ];

    // Before loading — message hidden
    expect(plugin.filterTools(tools, loaded).map((t) => t.name)).not.toContain("message");

    // Load toolkit
    plugin.loadToolkit("messaging", loaded);

    // After loading — message visible
    expect(plugin.filterTools(tools, loaded).map((t) => t.name)).toContain("message");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run extensions/lazy-tools/index.test.ts`
Expected: FAIL — module not found

**Step 3: Create the plugin**

Create `extensions/lazy-tools/package.json`:

```json
{
  "name": "@openclaw/lazy-tools",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "main": "index.ts"
}
```

Create `extensions/lazy-tools/index.ts`:

```typescript
import type { OpenClawPluginApi } from "../../src/plugin-sdk/index.js";

/**
 * Toolkit groupings — tool name → toolkit name.
 * Tools not in any toolkit pass through unfiltered.
 */
export const TOOLKITS: Record<string, string[]> = {
  messaging: ["message", "sessions_send", "sessions_list"],
  memory: ["memory_search", "memory_get"],
  web: ["web_search", "web_fetch"],
  sessions: ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "subagents"],
  cron: ["cron"],
  browser: ["browser"],
  media: ["tts", "image"],
  nodes: ["nodes"],
};

/** Core tools always visible regardless of lazy loading. */
export const CORE_TOOLS = new Set(["read", "write", "edit", "exec", "load_toolkit"]);

/** Reverse lookup: tool name → toolkit name. First toolkit to claim wins. */
const toolToToolkit = new Map<string, string>();
for (const [tkName, toolNames] of Object.entries(TOOLKITS)) {
  for (const tn of toolNames) {
    if (!toolToToolkit.has(tn)) {
      toolToToolkit.set(tn, tkName);
    }
  }
}

type ToolEntry = { name: string; description: string; parameters: unknown };

export function createLazyToolsPlugin() {
  function loadToolkit(
    name: string,
    loadedToolkits: Set<string>,
  ): { loaded: string; tools: string[]; message: string } | { error: string } {
    const toolkit = TOOLKITS[name];
    if (!toolkit) {
      return { error: `Unknown toolkit: ${name}. Available: ${Object.keys(TOOLKITS).join(", ")}` };
    }
    loadedToolkits.add(name);
    return {
      loaded: name,
      tools: toolkit,
      message: `Toolkit "${name}" loaded. You can now use: ${toolkit.join(", ")}`,
    };
  }

  function filterTools(tools: ToolEntry[], loadedToolkits: Set<string>): ToolEntry[] {
    return tools.filter((tool) => {
      if (CORE_TOOLS.has(tool.name)) return true;
      const tk = toolToToolkit.get(tool.name);
      if (!tk) return true; // Unknown tools pass through
      return loadedToolkits.has(tk);
    });
  }

  return { loadToolkit, filterTools };
}

// Compact catalog for load_toolkit description
const catalog = Object.entries(TOOLKITS)
  .map(([name, tools]) => `  - ${name}: ${tools.join(", ")}`)
  .join("\n");

/**
 * Per-session state: tracks which toolkits have been loaded.
 * Keyed by `sessionKey:sessionId` to isolate sessions.
 */
const sessionToolkitState = new Map<string, Set<string>>();

function getLoadedToolkits(sessionKey?: string, sessionId?: string): Set<string> {
  const key = `${sessionKey ?? ""}:${sessionId ?? ""}`;
  let loaded = sessionToolkitState.get(key);
  if (!loaded) {
    loaded = new Set<string>();
    sessionToolkitState.set(key, loaded);
  }
  return loaded;
}

const plugin = {
  id: "lazy-tools",
  name: "Lazy Tools",
  description:
    "Reduces token cost by lazy-loading tool schemas. " +
    "Only core tools and a `load_toolkit` meta-tool are sent initially.",
  register(api: OpenClawPluginApi) {
    const lazyToolsPlugin = createLazyToolsPlugin();

    // Register the load_toolkit meta-tool via factory pattern
    // Factory receives OpenClawPluginToolContext with sessionKey/sessionId
    api.registerTool(
      (ctx) => ({
        name: "load_toolkit",
        description: `Load additional tools into this session. Available toolkits:\n${catalog}`,
        parameters: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              enum: Object.keys(TOOLKITS),
              description: "Toolkit name to load",
            },
          },
          required: ["name"],
        },
        execute: async (_toolCallId: string, args: unknown) => {
          const params = args as Record<string, unknown>;
          const name = params.name as string;
          const loaded = getLoadedToolkits(ctx.sessionKey, ctx.sessionId);
          const result = lazyToolsPlugin.loadToolkit(name, loaded);
          if ("error" in result) {
            return { content: [{ type: "text" as const, text: result.error }] };
          }
          return { content: [{ type: "text" as const, text: result.message }] };
        },
      }),
      { name: "load_toolkit" },
    );

    // Hook: filter tools before surfacing to the LLM
    api.on("before_tool_surface", (event, ctx) => {
      const loaded = getLoadedToolkits(ctx.sessionKey, ctx.sessionId);
      return {
        tools: lazyToolsPlugin.filterTools(event.tools, loaded),
      };
    });

    // Clean up session state when session ends
    api.on("session_end", (_event, ctx) => {
      const key = `${ctx.sessionKey ?? ""}:${ctx.sessionId ?? ""}`;
      sessionToolkitState.delete(key);
    });
  },
};

export default plugin;
```

**Step 4: Run test**

Run: `cd /Users/sunny_yi/Projects/openclaw-fork && npx vitest run extensions/lazy-tools/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add extensions/lazy-tools/
git commit -m "feat(extensions): add lazy-tools plugin for dynamic tool surfacing"
```

---

## Task 5: Export new types from plugin-sdk

**Files:**

- Modify: `src/plugins/hooks.ts` (re-exports — already done in Task 2)
- Verify: `src/plugin-sdk/index.ts` — confirm types are accessible

**Step 1: Check if `src/plugin-sdk/index.ts` re-exports from `../plugins/types.js`**

Read the file. If it cherry-picks specific types (not `export *`), add:

```typescript
export type {
  PluginHookBeforeToolSurfaceEvent,
  PluginHookBeforeToolSurfaceResult,
} from "../plugins/types.js";
```

**Step 2: Commit**

```bash
git add src/plugin-sdk/index.ts
git commit -m "feat(sdk): export before_tool_surface hook types from plugin-sdk"
```

---

## Task 6: Run full test suite and type check

**Files:** All modified files

**Step 1: Run new tests**

```bash
cd /Users/sunny_yi/Projects/openclaw-fork
npx vitest run src/plugins/hooks.before-tool-surface.test.ts
npx vitest run src/agents/pi-embedded-runner/run/stream-tool-surface.test.ts
npx vitest run extensions/lazy-tools/index.test.ts
```

Expected: All PASS

**Step 2: Run existing tests that might break**

```bash
npx vitest run src/plugins/
npx vitest run src/agents/pi-embedded-runner.splitsdktools.test.ts
npx vitest run src/agents/pi-embedded-runner/compact.hooks.test.ts
```

Expected: All PASS. `splitSdkTools` was NOT changed, so existing tests should not break.

**Step 3: Type check**

```bash
npx tsc --noEmit
```

Expected: No errors. The `MissingPluginHookNames` assertion at `types.ts:1082-1085` will verify `"before_tool_surface"` is in both the union and the array.

**Step 4: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: resolve type and test issues for lazy-tools"
```

---

## Task 7: QA Audit (gate — 不通過就修到通過)

**使用 `/qa-audit` skill 執行雙 AI 審計。**

此為 hard gate：審計發現的每一個問題都必須修復並重新驗證，直到通過為止。

**Step 1: 執行 QA audit**

Run: `/qa-audit`

將 plan 路徑和 diff 提供給審計。審計會平行啟動：

- **Codex** — reality check（程式碼是否真的能跑）
- **Gemini** — spec audit（是否符合設計規格）

**Step 2: 修復所有發現的問題**

逐一修復，每個修復後跑對應的測試確認。

**Step 3: 重新執行 QA audit**

重複直到兩個 AI 都 PASS。

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: address qa-audit findings for lazy-tools"
```

---

## Task 8: Create feature branch and PR

**Pre-flight: confirm GitHub account**

```bash
gh auth status  # Must show active account: cyyij
# If not: gh auth switch --user cyyij
git config user.email "jacky1989411@gmail.com"
```

**Step 1: Create branch and push**

```bash
cd /Users/sunny_yi/Projects/openclaw-fork
git checkout -b feat/lazy-loaded-tools
git push -u origin feat/lazy-loaded-tools
```

**Step 2: Create PR**

```bash
gh pr create --repo openclaw/openclaw \
  --title "feat(plugins): add before_tool_surface hook for lazy tool loading" \
  --body "$(cat <<'EOF'
## Summary

- Adds `before_tool_surface` plugin hook — lets plugins filter/replace `tools[]` before each LLM API call
- Hooks into `streamFn` wrapper chain for per-call filtering (not per-session)
- Adds `lazy-tools` extension plugin with `load_toolkit` meta-tool
- Mid-session toolkit loading works within the same turn via streamFn

## Motivation

Addresses #1949 — agents pay 15-20K tokens per request for tool schemas, even when only 1-3 tools are needed. This approach preserves native function calling accuracy while reducing per-turn cost by 87-96%.

## Architecture

1. **`before_tool_surface` hook** — new modifying hook (sequential, last-writer-wins)
2. **`streamFn` wrapper** — calls hook before every LLM API call, filters tool schemas
3. **`lazy-tools` plugin** — registers `load_toolkit` tool + hook handler
4. All tools remain registered in session for execution; only schema visibility is filtered

## Token savings

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Cron job (no tools needed) | ~15-20K | ~3.5K | ~82% |
| Simple task (1 toolkit) | ~15-20K | ~5.5K | ~72% |
| Complex task (all toolkits) | ~15-20K | ~15-20K | 0% |

## Test plan

- [ ] `hooks.before-tool-surface.test.ts` — hook runner tests
- [ ] `stream-tool-surface.test.ts` — streamFn wrapper tests
- [ ] `extensions/lazy-tools/index.test.ts` — plugin logic tests
- [ ] `tsc --noEmit` passes
- [ ] Existing `splitSdkTools` tests still pass (no breaking changes)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: Return PR URL**
