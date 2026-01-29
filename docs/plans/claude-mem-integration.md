# Claude-Mem Integration Plan

Integrate `thedotmack/claude-mem` as the primary observation agent and memory layer for Clawdbot.

---

## Phase 0: Documentation Discovery

### Allowed APIs (Clawdbot Plugin System)

**Source:** `/home/user/clawdbot/src/plugins/types.ts:235-274`

| API | Signature | Use Case |
|-----|-----------|----------|
| `api.registerTool` | `(tool: AnyAgentTool \| ClawdbotPluginToolFactory, opts?: ClawdbotPluginToolOptions) => void` | Register memory tools |
| `api.on` | `<K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K]) => void` | Register lifecycle hooks |
| `api.registerCli` | `(registrar: ClawdbotPluginCliRegistrar, opts?: { commands?: string[] }) => void` | Add CLI commands |
| `api.registerService` | `(service: ClawdbotPluginService) => void` | Health check service |
| `api.logger` | `PluginLogger` | Logging (`info`, `warn`, `debug`) |
| `api.pluginConfig` | `Record<string, unknown>` | Plugin configuration |

### Available Hooks

**Source:** `/home/user/clawdbot/src/plugins/types.ts:289-303`

| Hook | Execution | Clawdbot → Claude-Mem |
|------|-----------|----------------------|
| `session_start` | Parallel (fire-and-forget) | → `SessionStart` |
| `before_agent_start` | Sequential (can modify) | → `UserPromptSubmit` + context injection |
| `after_tool_call` | Parallel (fire-and-forget) | → `PostToolUse` |
| `agent_end` | Parallel (fire-and-forget) | → `Stop` |
| `session_end` | Parallel (fire-and-forget) | → `SessionEnd` |

### Allowed APIs (Claude-Mem Worker)

**Source:** GitHub Issue #348, Platform Integration Guide

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/health` | GET | - | 200 OK |
| `/api/sessions/observations` | POST | `{ claudeSessionId, tool_name, tool_input, tool_response, cwd? }` | `{ id }` |
| `/api/search` | GET | `?query=<q>&type=observations&format=index&limit=<n>` | `SearchResult[]` |
| `/api/observations/batch` | POST | `{ ids: number[], orderBy?, limit? }` | `Observation[]` |

**Note:** `created_at_epoch` is in MILLISECONDS (not seconds).

### Memory Disable Mechanism

**Source:** `/home/user/clawdbot/src/agents/memory-search.ts:276`

```typescript
// Existing kill switch - returns null when disabled
if (!resolved.enabled) return null;
```

**Config location:** `agents.defaults.memorySearch.enabled` (default: `true`)

### Copy-Ready Patterns

| Pattern | Source File | Lines |
|---------|-------------|-------|
| Minimal plugin structure | `/home/user/clawdbot/extensions/memory-core/index.ts` | 1-36 |
| Tool registration | `/home/user/clawdbot/extensions/memory-lancedb/index.ts` | 238-286 |
| Hook registration (`before_agent_start`) | `/home/user/clawdbot/extensions/memory-lancedb/index.ts` | 468-491 |
| Hook registration (`agent_end`) | `/home/user/clawdbot/extensions/memory-lancedb/index.ts` | 496-569 |
| CLI commands | `/home/user/clawdbot/extensions/memory-lancedb/index.ts` | 418-460 |
| Config schema with `parse` + `uiHints` | `/home/user/clawdbot/extensions/memory-lancedb/config.ts` | 61-114 |
| Plugin manifest | `/home/user/clawdbot/extensions/memory-lancedb/clawdbot.plugin.json` | 1-67 |

### Anti-Patterns to Avoid

1. **Do NOT invent API endpoints** - Only use confirmed endpoints from Phase 0
2. **Do NOT use `Type.Union` in tool schemas** - Use `stringEnum`/`optionalStringEnum` instead
3. **Do NOT use raw `format` property** - Reserved keyword in some validators
4. **Do NOT add dependencies to root package.json** - Plugin deps go in plugin's package.json
5. **Do NOT use `workspace:*` in dependencies** - Use in `devDependencies` or `peerDependencies` only

---

## Phase 1: Disable Built-in Memory

### What to Implement

1. Add `memorySearch.enabled: false` config to disable built-in memory tools
2. User configures this in their config file when using claude-mem

**No code changes required.** The existing kill switch at `src/agents/memory-search.ts:276` already returns `null` when `enabled: false`.

### Documentation References

- Config schema: `/home/user/clawdbot/src/config/types.tools.ts:223` (`enabled?: boolean`)
- Kill switch: `/home/user/clawdbot/src/agents/memory-search.ts:276`
- Tool creation guard: `/home/user/clawdbot/src/agents/tools/memory-tool.ts:32`

### Verification Checklist

```bash
# 1. Set config
clawdbot config set agents.defaults.memorySearch.enabled false

# 2. Verify memory tools are not registered
clawdbot agent --dry-run 2>&1 | grep -c "memory_search"
# Expected: 0

# 3. Verify config is persisted
clawdbot config get agents.defaults.memorySearch.enabled
# Expected: false
```

### Anti-Pattern Guards

- Do NOT modify `resolveMemorySearchConfig()` - existing logic sufficient
- Do NOT add new config keys - reuse existing `enabled` flag

---

## Phase 2: Create Plugin Structure

### What to Implement

Create `extensions/memory-claudemem/` by copying structure from `extensions/memory-lancedb/`.

### Documentation References

- Copy from: `/home/user/clawdbot/extensions/memory-lancedb/` (directory structure)
- Manifest spec: `/home/user/clawdbot/docs/plugins/manifest.md:16-42`

### Files to Create

```
extensions/memory-claudemem/
├── package.json              # Copy from memory-lancedb/package.json
├── clawdbot.plugin.json      # Copy from memory-lancedb/clawdbot.plugin.json
├── index.ts                  # Plugin entry point
├── config.ts                 # Config schema
├── client.ts                 # HTTP client for worker
└── types.ts                  # Type definitions
```

### package.json (Copy and Modify)

**Copy from:** `/home/user/clawdbot/extensions/memory-lancedb/package.json`

```json
{
  "name": "@clawdbot/memory-claudemem",
  "version": "0.0.1",
  "type": "module",
  "main": "index.ts",
  "dependencies": {},
  "devDependencies": {
    "clawdbot": "workspace:*"
  },
  "peerDependencies": {
    "clawdbot": "*"
  }
}
```

### clawdbot.plugin.json (Copy and Modify)

**Copy from:** `/home/user/clawdbot/extensions/memory-lancedb/clawdbot.plugin.json:1-20`

```json
{
  "id": "memory-claudemem",
  "name": "Memory (Claude-Mem)",
  "description": "Real-time observation and memory via claude-mem worker",
  "kind": "memory",
  "version": "0.0.1",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "workerUrl": { "type": "string", "default": "http://localhost:37777" },
      "workerTimeout": { "type": "number", "default": 10000 }
    }
  }
}
```

### Verification Checklist

```bash
# 1. Verify plugin loads
cd extensions/memory-claudemem && pnpm install

# 2. Verify manifest is valid JSON
cat clawdbot.plugin.json | jq .

# 3. Verify plugin appears in list
clawdbot plugins list | grep memory-claudemem
```

### Anti-Pattern Guards

- Do NOT add `workspace:*` to `dependencies` (breaks `npm install`)
- Do NOT add plugin deps to root `package.json`

---

## Phase 3: HTTP Client

### What to Implement

Create `client.ts` with methods for claude-mem worker API.

### Documentation References

- Observation endpoint: `POST /api/sessions/observations` (GitHub Issue #348)
- Search endpoint: `GET /api/search?query=<q>&format=index`
- Batch fetch: `POST /api/observations/batch` (v7.3.0+)
- Health: `GET /api/health`

### client.ts

```typescript
// Copy timeout + AbortController pattern from:
// /home/user/clawdbot/src/infra/fetch-with-timeout.ts (if exists)
// Otherwise use standard fetch with AbortController

export class ClaudeMemClient {
  constructor(private baseUrl: string, private timeout: number) {}

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(this.timeout)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async observe(sessionId: string, toolName: string, toolInput: unknown, toolResponse: unknown): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claudeSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse
      }),
      signal: AbortSignal.timeout(this.timeout)
    });
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      query,
      type: "observations",
      format: "index",
      limit: String(limit)
    });
    const res = await fetch(`${this.baseUrl}/api/search?${params}`, {
      signal: AbortSignal.timeout(this.timeout)
    });
    return res.json();
  }

  async getObservations(ids: number[]): Promise<Observation[]> {
    const res = await fetch(`${this.baseUrl}/api/observations/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(this.timeout)
    });
    return res.json();
  }
}
```

### Verification Checklist

```bash
# 1. Start claude-mem worker
claude-mem worker &

# 2. Test health endpoint
curl http://localhost:37777/api/health
# Expected: 200 OK

# 3. Test search endpoint
curl "http://localhost:37777/api/search?query=test&format=index&limit=5"
# Expected: JSON array
```

### Anti-Pattern Guards

- Do NOT invent endpoints like `/api/observe` - use documented `/api/sessions/observations`
- Do NOT assume `created_at_epoch` is in seconds - it's MILLISECONDS
- Do NOT skip error handling - worker may be offline

---

## Phase 4: Hook Registration

### What to Implement

Register hooks that forward events to claude-mem worker.

### Documentation References

- Hook handler signature: `/home/user/clawdbot/src/plugins/types.ts:466-520`
- Example `before_agent_start`: `/home/user/clawdbot/extensions/memory-lancedb/index.ts:468-491`
- Example `agent_end`: `/home/user/clawdbot/extensions/memory-lancedb/index.ts:496-569`

### Hook: after_tool_call → PostToolUse

**Copy pattern from:** `/home/user/clawdbot/extensions/memory-lancedb/index.ts:496-520`

```typescript
// In index.ts register() function
api.on("after_tool_call", async (event, ctx) => {
  // Skip our own tools to prevent recursion
  if (event.toolName.startsWith("memory_")) return;

  try {
    await client.observe(
      ctx.sessionId,
      event.toolName,
      event.params,
      event.result
    );
  } catch (err) {
    api.logger.warn?.(`claude-mem: observation failed: ${err}`);
  }
});
```

### Hook: before_agent_start → Context Injection

**Copy pattern from:** `/home/user/clawdbot/extensions/memory-lancedb/index.ts:468-491`

```typescript
api.on("before_agent_start", async (event, ctx) => {
  try {
    const results = await client.search(event.prompt, 5);
    if (results.length === 0) return;

    const context = results
      .map(r => `- [#${r.id}] ${r.title}: ${r.snippet}`)
      .join("\n");

    return {
      prependContext: `<claude-mem-context>\n${context}\n</claude-mem-context>`
    };
  } catch (err) {
    api.logger.warn?.(`claude-mem: context injection failed: ${err}`);
  }
});
```

### Verification Checklist

```bash
# 1. Enable debug logging
clawdbot config set plugins.memory-claudemem.debug true

# 2. Run a test message
clawdbot message send "test message"

# 3. Check logs for observation
tail -f ~/.clawdbot/logs/gateway.log | grep claude-mem

# 4. Verify in claude-mem UI
open http://localhost:37777
```

### Anti-Pattern Guards

- Do NOT observe `memory_*` tools (causes recursion)
- Do NOT block on observation failures (use fire-and-forget pattern for void hooks)
- Do NOT modify event object for void hooks (only `before_agent_start` can return modifications)

---

## Phase 5: Progressive Disclosure Tools

### What to Implement

Register three tools following claude-mem's 3-layer retrieval pattern.

### Documentation References

- Tool registration: `/home/user/clawdbot/extensions/memory-lancedb/index.ts:238-286`
- Tool factory pattern: `/home/user/clawdbot/src/plugins/types.ts:69-77`
- Tool schema guardrails: Use `Type.Object` with `Type.String`, `Type.Optional`, `Type.Number`

### Layer 1: memory_search (~50-100 tokens per result)

**Copy pattern from:** `/home/user/clawdbot/extensions/memory-lancedb/index.ts:238-270`

```typescript
api.registerTool({
  name: "memory_search",
  label: "Memory Search",
  description: "Search past observations. Returns compact results with IDs. Use memory_observations for full details.",
  parameters: Type.Object({
    query: Type.String({ description: "Natural language search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" }))
  }),
  async execute(_toolCallId, params) {
    const results = await client.search(params.query, params.limit ?? 10);
    const text = results.length === 0
      ? "No memories found."
      : results.map((r, i) => `${i + 1}. [#${r.id}] ${r.title}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
}, { name: "memory_search" });
```

### Layer 3: memory_observations (~500-1000 tokens per result)

```typescript
api.registerTool({
  name: "memory_observations",
  label: "Memory Observations",
  description: "Get full details for specific observation IDs. Use after memory_search to filter.",
  parameters: Type.Object({
    ids: Type.Array(Type.Number(), { description: "Observation IDs from memory_search" })
  }),
  async execute(_toolCallId, params) {
    const observations = await client.getObservations(params.ids);
    const text = observations.map(o =>
      `## #${o.id}\n${o.narrative}\n\nFiles: ${o.files_modified?.join(", ") || "none"}`
    ).join("\n\n---\n\n");
    return { content: [{ type: "text", text }] };
  }
}, { name: "memory_observations" });
```

### Verification Checklist

```bash
# 1. Verify tools are registered
clawdbot tools list | grep memory_

# 2. Test search tool
clawdbot agent --message "Use memory_search to find recent file edits"

# 3. Test observations tool
clawdbot agent --message "Use memory_observations with IDs [1, 2, 3]"
```

### Anti-Pattern Guards

- Do NOT use `Type.Union` in parameters - not allowed by schema guardrails
- Do NOT use raw `format` property name - reserved keyword
- Do NOT return tool results without `content: [{ type: "text", text }]` structure

---

## Phase 6: CLI Commands

### What to Implement

Add CLI commands for worker status and manual search.

### Documentation References

- CLI registration: `/home/user/clawdbot/extensions/memory-lancedb/index.ts:418-460`
- Commander.js pattern: `/home/user/clawdbot/src/plugins/types.ts:193-200`

### Implementation

**Copy pattern from:** `/home/user/clawdbot/extensions/memory-lancedb/index.ts:418-460`

```typescript
api.registerCli(({ program }) => {
  const mem = program
    .command("claude-mem")
    .description("Claude-mem integration commands");

  mem.command("status")
    .description("Check claude-mem worker status")
    .action(async () => {
      const alive = await client.ping();
      console.log(alive
        ? `✓ Worker running at ${cfg.workerUrl}`
        : `✗ Worker not responding at ${cfg.workerUrl}`);
    });

  mem.command("search")
    .description("Search memories")
    .argument("<query>", "Search query")
    .action(async (query) => {
      const results = await client.search(query);
      console.log(JSON.stringify(results, null, 2));
    });
}, { commands: ["claude-mem"] });
```

### Verification Checklist

```bash
# 1. Verify command appears in help
clawdbot claude-mem --help

# 2. Test status command
clawdbot claude-mem status

# 3. Test search command
clawdbot claude-mem search "authentication"
```

### Anti-Pattern Guards

- Do NOT use reserved command names (help, send, config, status, etc.) - see `/home/user/clawdbot/src/plugins/commands.ts:33-69`

---

## Phase 7: Verification

### Implementation Verification

1. **Memory disabled when configured:**
   ```bash
   clawdbot config set agents.defaults.memorySearch.enabled false
   clawdbot tools list | grep -v memory_claudemem | grep memory_
   # Expected: no results (built-in memory tools gone)
   ```

2. **Plugin loads successfully:**
   ```bash
   clawdbot plugins list | grep memory-claudemem
   # Expected: memory-claudemem (enabled)
   ```

3. **Worker connection verified:**
   ```bash
   clawdbot claude-mem status
   # Expected: ✓ Worker running at http://localhost:37777
   ```

4. **Observations recorded:**
   ```bash
   # Run a command
   clawdbot agent --message "List files in current directory"

   # Check worker UI
   open http://localhost:37777
   # Expected: New observation for "bash" tool
   ```

5. **Context injection works:**
   ```bash
   # First, create some observations
   clawdbot agent --message "Create a file called test.txt"

   # Then search should inject context
   DEBUG=claude-mem clawdbot agent --message "What files did I create recently?"
   # Expected: Logs show context injection
   ```

### Anti-Pattern Check

```bash
# Grep for known bad patterns
grep -r "Type\.Union" extensions/memory-claudemem/
# Expected: no results

grep -r "format:" extensions/memory-claudemem/*.ts
# Expected: no results (or only in non-schema contexts)

grep -r "/api/observe" extensions/memory-claudemem/
# Expected: no results (should use /api/sessions/observations)
```

### Test Suite

```bash
cd extensions/memory-claudemem
pnpm test
# Expected: All tests pass

pnpm lint
# Expected: No lint errors

pnpm build
# Expected: Builds without type errors
```

---

## Configuration Summary

### User Config (to use claude-mem)

```yaml
# ~/.clawdbot/config.yml

# Disable built-in memory
agents:
  defaults:
    memorySearch:
      enabled: false

# Enable claude-mem plugin
plugins:
  memory-claudemem:
    workerUrl: http://localhost:37777
    workerTimeout: 10000
```

### Rollback (to restore built-in memory)

```yaml
agents:
  defaults:
    memorySearch:
      enabled: true

plugins:
  memory-claudemem:
    enabled: false
```
