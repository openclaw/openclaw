# Bundle MCP Session Runtime Cache Technical Design

## Overview

This document defines a session-scoped caching design for bundle MCP runtime
startup in the embedded PI runner.

The immediate goal is to remove the stable per-turn startup cost currently paid
by `createBundleMcpToolRuntime()` while preserving correct session lifecycle
semantics.

The design introduces two explicit layers:

- a session-scoped MCP runtime that owns long-lived connections and the raw
  discovered tool catalog
- a per-run materialization step that projects that catalog into the concrete
  tool list for the current attempt

This note focuses on:

- why the current lifecycle is expensive
- why `sessionId` should be the primary cache key
- what should and should not be cached
- where creation, reuse, and cleanup should live
- what is intentionally deferred from the first implementation

## Problem

Recent Feishu latency samples show that the dominant fixed cost in context
assembly is bundle MCP startup, not bootstrap files, tool wrappers, LSP, or
system prompt assembly.

Observed post-restart samples show:

- `context_bundle_mcp_completed` is typically `21.6s` to `23.2s`
- `context_bootstrap_completed`, `context_tools_completed`,
  `context_bundle_lsp_completed`, and prompt assembly stages are usually
  `0ms` to `12ms`

This means the current bundle MCP lifecycle is the main stable latency source
for short chat turns.

## Current Runtime Baseline

The embedded runner currently creates and destroys bundle MCP runtime inside
each attempt.

Current behavior:

1. `src/agents/pi-embedded-runner/run/attempt.ts` calls
   `createBundleMcpToolRuntime(...)` for each run when model tools are enabled.
2. `src/agents/pi-bundle-mcp-tools.ts` loads MCP config, starts stdio
   transports, connects clients, lists tools, filters name conflicts, and
   creates tool wrappers in a single function.
3. `src/agents/pi-embedded-runner/run/attempt.ts` disposes the runtime at the
   end of the attempt.

This creates one expensive lifecycle per turn:

- spawn transport
- connect client
- discover tools
- build wrappers
- dispose transport

That shape is reasonable for correctness, but it is not a good fit for Feishu
short-chat latency.

## Goals

- remove the stable per-turn bundle MCP startup cost for repeated turns in the
  same session
- preserve clean `/new`, `/reset`, and stale-rollover behavior
- keep per-run tool visibility correct when `reservedToolNames` changes
- avoid forcing gateway-global persistence in the first implementation
- keep the first implementation small enough to land and verify quickly

## Non-Goals

- adding process-global persistent MCP servers in the first implementation
- supporting `list_changed` dynamic tool refresh in the first implementation
- adding config hot-reload for active session runtimes
- changing bundle LSP lifecycle in the same patch
- redesigning embedded runner prompt construction outside the MCP seam

## Design Principles

- Cache the expensive part, not the whole final result.
- Align runtime state with session generation, not chat identity.
- Keep per-run materialization cheap and deterministic.
- Reuse existing reset and rollover hooks instead of inventing a parallel
  cleanup mechanism.
- Preserve future evolution toward more persistent MCP lifecycles.

## Session Identity Choice

The primary cache key should be `sessionId`, not `sessionKey`.

Why:

- `sessionKey` is the stable chat identity.
- `sessionId` is the active session-generation identity.
- `/new`, `/reset`, and stale rollover can keep the same `sessionKey` while
  intentionally rotating `sessionId`.
- bundle MCP runtime is stateful. It owns transports, clients, and remote MCP
  session state, so it should follow session generation boundaries.

Using `sessionKey` as the primary key would make it too easy to accidentally
reuse old MCP runtime across a reset boundary.

The design should still maintain a helper mapping:

- `sessionKey -> sessionId`

This mapping is useful for:

- observability
- cleanup routing
- future session lookup convenience

But it should remain a secondary index, not the cache authority.

## What Should Be Cached

The cache should store a session-scoped runtime that owns connection state and
the raw discovered tool catalog.

Recommended shape:

```ts
type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;

  getCatalog(): Promise<McpToolCatalog>;
  markUsed(): void;
  callTool(serverName: string, toolName: string, input: unknown): Promise<CallToolResult>;
  dispose(): Promise<void>;
};
```

Internal state should include:

- connected MCP client and transport per server
- stderr logging detach handles
- raw discovered tool metadata
- one in-flight initial connect or refresh promise to coalesce concurrent calls

Recommended catalog shape:

```ts
type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
};

type McpCatalogTool = {
  serverName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
};
```

## What Should Not Be Cached

The cache should not store the final `AnyAgentTool[]` exposed to a specific
attempt.

Those final tools are per-run projections because they depend on:

- `reservedToolNames`
- current built-in tool names
- current client tool names
- model-specific tool enablement rules

If the cache stored the already-materialized final tool list, it would mix
session-scoped connection state with per-run visibility rules. That would make
resets harder to reason about and would make future catalog refresh more
awkward.

## Proposed Layer Split

### Session-scoped runtime layer

The first layer owns the expensive MCP lifecycle:

- load effective MCP server config
- start stdio transport
- connect client
- discover raw tools
- retain connected sessions for later calls

This layer should be created once per active `sessionId`.

### Per-run materialization layer

The second layer projects the cached catalog into the current attempt's tool
list.

Recommended entry point:

```ts
async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
}): Promise<{ tools: AnyAgentTool[] }>;
```

This layer should:

1. call `runtime.getCatalog()`
2. filter out names already reserved for the current run
3. build the concrete `AnyAgentTool[]`
4. route each tool execution back through the cached runtime

This layer should not:

- create transports
- reconnect clients
- re-run tool discovery
- own transport disposal

## Runtime Manager

The cache itself should live behind a manager with `sessionId` as the primary
key.

Recommended shape:

```ts
type SessionMcpRuntimeManager = {
  getOrCreate(params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }): Promise<SessionMcpRuntime>;

  bindSessionKey(sessionKey: string, sessionId: string): void;
  resolveSessionId(sessionKey: string): string | undefined;

  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
};
```

Internal state should include:

- `runtimesBySessionId`
- `sessionIdBySessionKey`
- `createInFlight`

The `createInFlight` map prevents duplicate startup when multiple paths reach
the same session runtime concurrently.

## Lifecycle and Ownership

### Creation

When a run starts and bundle MCP is needed:

1. resolve current `sessionId` and `sessionKey`
2. ask the manager for the session runtime
3. lazily initialize connection state and tool catalog on first use

### Reuse

For later turns in the same `sessionId`:

- reuse the same session runtime
- skip transport startup
- skip client connect
- skip tool discovery
- re-materialize only the per-run tool projection

### Cleanup

Cleanup should happen when the session generation ends, not when a single turn
ends.

The first implementation should dispose session runtime on:

- `/new`
- `/reset`
- stale rollover
- process shutdown

Existing session management already exposes the right seam through
`previousSessionEntry.sessionId`, so MCP cleanup should attach there instead of
introducing an unrelated lifecycle path.

## Failure Handling

The first implementation should stay conservative.

Recommended behavior:

- if initial startup fails, do not poison unrelated sessions
- if a runtime is marked disposed or unusable, rebuild it on the next request
- if one server fails to start, continue surfacing tools from other healthy
  servers when possible
- avoid permanent cache entries that only contain failure state

This keeps the session cache useful without requiring a full reconnection
strategy in the initial patch.

## Config Fingerprinting

The runtime should store a `configFingerprint` even if the first implementation
does not yet hot-reload active sessions.

This preserves a clean upgrade path for future invalidation based on:

- workspace changes
- MCP server config changes
- server launch definition changes

The first implementation can record the fingerprint without automatically
rebuilding on mismatch.

## Why This Is Better Than Caching BundleMcpToolRuntime Directly

The smallest possible change would be to cache the current
`BundleMcpToolRuntime` object directly.

That approach would land faster, but it has an important structural downside:
it caches both:

- long-lived connection state
- short-lived per-run tool visibility decisions

That makes it harder to:

- correctly honor new `reservedToolNames`
- refresh discovered tools later
- evolve toward persistent runtime support cleanly

Caching only the connection and catalog layer keeps responsibilities separate
and preserves a better long-term shape.

## Integration Direction

The first implementation should avoid a large runner refactor.

Recommended integration path:

1. keep `src/agents/pi-bundle-mcp-tools.ts` as the main home for bundle MCP
   runtime code
2. add a session runtime constructor there or in a nearby dedicated manager file
3. add per-run materialization beside the existing bundle MCP helper
4. update `src/agents/pi-embedded-runner/run/attempt.ts` to consume the
   session runtime rather than always calling `createBundleMcpToolRuntime(...)`
5. connect cleanup to existing session rollover paths in
   `src/auto-reply/reply/session.ts`

This keeps the first patch local to the already-relevant files.

## Rollout Plan

Phase 1:

- introduce session runtime and manager
- reuse bundle MCP runtime by `sessionId`
- add per-run materialization
- dispose on reset, rollover, and shutdown

Phase 2:

- add metrics for runtime cache hit and miss
- add stale runtime eviction such as idle timeout or LRU
- add targeted reconnect behavior for failed sessions

Phase 3:

- consider `list_changed` support for live catalog refresh
- consider gateway-global persistent runtimes for explicitly stateful MCP
  servers

## Validation Plan

The first implementation should be validated in three ways:

- unit tests for manager reuse, session rotation cleanup, and per-run
  name-filtering behavior
- targeted embedded-runner tests that confirm per-run tool projection still
  respects `reservedToolNames`
- live latency verification in Feishu confirming that
  `context_bundle_mcp_completed` drops from the current `21s` to `23s` range to
  a near-zero steady-state cost for follow-up turns in the same session

## Open Questions

- Should session runtime creation be triggered lazily on first tool-needed turn
  only, or proactively when a new session starts?
- Should the first version keep bundle LSP fully unchanged, or mirror the same
  layering pattern immediately for consistency?
- Should config fingerprint mismatch only log in phase 1, or should it trigger
  a best-effort rebuild before full hot-reload support exists?

## Summary

The core change is simple:

- cache bundle MCP connection and discovery work by `sessionId`
- keep `sessionKey -> sessionId` as a helper index
- re-materialize final tool exposure per run

This removes the biggest stable latency cost already observed in Feishu while
keeping reset semantics clean and leaving room for more persistent MCP
architectures later.
