# MCP Apps — Implementation Document

> **Status**: Implemented  
> **Date**: 13 April 2026  
> **Plan reference**: PLAN.md § "Plan: MCP Apps — Gateway Protocol Extension (Code-Informed Revision)"

---

## Overview

This document describes exactly what was changed in the OpenClaw codebase to implement MCP Apps support. MCP Apps are interactive HTML applications served through the Model Context Protocol's `resources` capability. They render in sandboxed iframes and communicate with the host via `postMessage`.

The implementation is additive and backward-compatible. No gateway protocol version bump was made — clients use feature discovery (`hello-ok.features.methods`) to detect availability.

---

## Files Changed

### `src/agents/tools/common.ts`

**Change**: Added `McpAppUiMeta` type and `mcpAppUi` optional field to `AgentToolWithMeta`.

```typescript
export type McpAppUiMeta = {
  resourceUri: string;       // ui:// URI served by resources/read
  permissions?: string[];    // Extra sandbox permissions (never allow-same-origin)
  csp?: Record<string, string[]>;  // CSP directives (allowlisted)
};

export type AgentToolWithMeta<TParameters extends TSchema, TResult> = AgentTool<...> & {
  ownerOnly?: boolean;
  displaySummary?: string;
  mcpAppUi?: McpAppUiMeta;  // NEW: MCP App UI metadata
};
```

**Impact**: Zero breaking changes. The new field is optional and ignored by all existing code paths. Plugin authors may now declare `mcpAppUi` on any tool to make it an MCP App tool.

---

### `src/gateway/mcp-http.schema.ts`

**Change**: Added `McpToolUiMeta` type and extended `McpToolSchemaEntry` with optional `_meta.ui`. Updated `buildMcpToolSchema()` to pass through `mcpAppUi` from tools.

```typescript
export type McpToolUiMeta = {
  resourceUri: string;
  permissions?: string[];
  csp?: Record<string, string[]>;
};

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
  _meta?: { ui?: McpToolUiMeta }; // NEW
};
```

`buildMcpToolSchema()` now reads `tool.mcpAppUi` and sets `entry._meta = { ui: mcpAppUi }` when present.

---

### `src/gateway/mcp-http.handlers.ts`

**Changes**:

1. `initialize` response now advertises `capabilities: { tools: {}, resources: {} }` (was `{ tools: {} }`).
2. Added `resources/list` case — calls `listResources()` from the new resource registry.
3. Added `resources/read` case — calls `resolveResourceContent(uri)` and returns `{ contents: [...] }`.

The handlers are now `async` because `resources/read` may read from the filesystem.

---

### `src/gateway/mcp-app-resources.ts` _(new)_

**Purpose**: Registry and resolver for `ui://` MCP App resources.

**Key exports**:

| Export                            | Description                                         |
| --------------------------------- | --------------------------------------------------- |
| `registerBuiltinResource(params)` | Register HTML bundled at startup                    |
| `registerFileResource(params)`    | Register file-backed resource (path-traversal safe) |
| `registerCanvasResource(params)`  | Register canvas-host-backed resource                |
| `unregisterResource(uri)`         | Remove a resource from the registry                 |
| `listResources()`                 | List all registered resources (uri/name/mimeType)   |
| `resolveResourceContent(uri)`     | Fetch content for a uri (async, with size limit)    |
| `buildResourceCsp(extraCsp)`      | Merge tool CSP with default policy                  |
| `MCP_APP_DEFAULT_CSP`             | Default restrictive CSP string                      |
| `MCP_APP_RESOURCE_MAX_BYTES`      | 2 MB size limit                                     |
| `MCP_APP_RESOURCE_MIME_TYPE`      | `"text/html;profile=mcp-app"`                       |

**Source types**:

- `builtin` — inline HTML string, rejected at registration time if it exceeds the 2 MB size limit (read-time check retained as defense-in-depth)
- `file` — reads `rootDir/relativePath` on demand; path traversal rejected
- `canvas` — returns the canvas host URL directly as the text content

**CSP allowlist** (only these can be extended by tools): `script-src`, `style-src`, `img-src`, `connect-src`, `font-src`. The `child-src`, `frame-src`, and `allow-same-origin` directives are permanently blocked.

---

### `src/gateway/protocol/schema/mcp.ts` _(new)_

**Purpose**: TypeBox schemas for gateway WebSocket `mcp.*` methods.

**Schemas exported**:

| Schema                         | Description                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| `McpToolsListParamsSchema`     | `{ sessionKey?: string }`                                            |
| `McpToolsListResultSchema`     | `{ tools: McpToolEntry[] }`                                          |
| `McpToolsCallParamsSchema`     | `{ name: string, arguments?: Record, sessionKey?: string }`          |
| `McpToolsCallResultSchema`     | `{ content: ContentBlock[], isError: boolean, _meta?: McpToolMeta }` |
| `McpResourcesListParamsSchema` | `{ sessionKey?: string }`                                            |
| `McpResourcesListResultSchema` | `{ resources: McpResourceEntry[] }`                                  |
| `McpResourcesReadParamsSchema` | `{ uri: string }`                                                    |
| `McpResourcesReadResultSchema` | `{ contents: McpContentBlock[] }`                                    |

---

### `src/gateway/protocol/schema/protocol-schemas.ts`

**Change**: Added all 8 MCP schemas to the `ProtocolSchemas` registry (used by the gateway's schema documentation and validation surfaces).

---

### `src/gateway/protocol/schema.ts`

**Change**: Added `export * from "./schema/mcp.js"` to the barrel.

---

### `src/gateway/protocol/index.ts`

**Changes**:

- Imported `McpToolsListParams`, `McpToolsCallParams`, `McpResourcesListParams`, `McpResourcesReadParams` types and their schemas.
- Added `validateMcpToolsListParams`, `validateMcpToolsCallParams`, `validateMcpResourcesListParams`, `validateMcpResourcesReadParams` AJV validators.
- Exported the new types and schema exports.

---

### `src/gateway/server-methods/mcp.ts` _(new)_

**Purpose**: Gateway WebSocket method handlers for `mcp.*` methods.

**Handlers**:

| Method               | Scope         | Description                                                |
| -------------------- | ------------- | ---------------------------------------------------------- |
| `mcp.tools.list`     | `READ_SCOPE`  | Returns tool schema including `_meta.ui` for MCP App tools |
| `mcp.tools.call`     | `WRITE_SCOPE` | Executes a tool by name, returns result + `_meta`          |
| `mcp.resources.list` | `READ_SCOPE`  | Returns all registered `ui://` resources                   |
| `mcp.resources.read` | `READ_SCOPE`  | Returns HTML content for a `ui://` URI                     |

All handlers use the shared `McpLoopbackToolCache` with 30 s TTL caching.

**Session scoping**: `sessionKey` parameter (when provided) is used to scope tool resolution. Falls back to the gateway's main session key when absent or `"main"`.

---

### `src/gateway/server-methods-list.ts`

**Change**: Added `mcp.tools.list`, `mcp.tools.call`, `mcp.resources.list`, `mcp.resources.read` to `BASE_METHODS`. Added `mcp.tool.result` to `GATEWAY_EVENTS` (reserved for future use — currently the `session.tool` event is sufficient, see WP-7 discussion below).

---

### `src/gateway/method-scopes.ts`

**Change**: Assigned scope groups for `mcp.*` methods:

| Method               | Scope         |
| -------------------- | ------------- |
| `mcp.tools.list`     | `READ_SCOPE`  |
| `mcp.resources.list` | `READ_SCOPE`  |
| `mcp.resources.read` | `READ_SCOPE`  |
| `mcp.tools.call`     | `WRITE_SCOPE` |

---

### `src/gateway/server-methods.ts`

**Change**: Imported `mcpHandlers` from `./server-methods/mcp.js` and spread it into `coreGatewayHandlers`.

---

## New Test Files

### `src/gateway/mcp-app-resources.test.ts`

Tests resource registry behavior:

- `registerBuiltinResource` + list + resolve content
- 2 MB size limit enforcement
- Path traversal rejection
- Canvas source (returns URL as text)
- File source (missing file returns error)
- `unregisterResource`
- `buildResourceCsp` — default, extension, non-allowlisted directive rejection, deduplication

### `src/gateway/server-methods/mcp.test.ts`

Tests gateway WS handlers:

- `mcp.tools.list` returns tools including `_meta.ui` on MCP App tools
- `mcp.tools.list` accepts optional `sessionKey`
- `mcp.tools.list` rejects invalid params
- `mcp.tools.call` executes tool, returns result
- `mcp.tools.call` includes `_meta.ui` in result for MCP App tools
- `mcp.tools.call` returns `isError: true` for unknown tools
- `mcp.tools.call` rejects missing `name`
- `mcp.resources.list` returns registered resources
- `mcp.resources.read` returns HTML content
- `mcp.resources.read` returns error for unknown URI
- `mcp.resources.read` rejects missing `uri`

---

## WP-7 Decision: `session.tool` event enrichment

The plan asked to evaluate whether `session.tool` event payloads need enrichment with `_meta.ui`.

**Decision**: No enrichment required. Rationale:

1. `session.tool` events already include `data.name` (tool name) and `data.phase` (start/update/result).
2. Clients can pre-fetch the tool catalog via `mcp.tools.list` and build a local map of `toolName → _meta.ui`.
3. When a `session.tool` event arrives for phase `"result"`, the client looks up `_meta.ui` from its local map using `data.name`.
4. The `mcp.tool.result` event is reserved in `GATEWAY_EVENTS` for future use if this proves insufficient in practice.

Adding runtime enrichment to `server-chat.ts` would require tool registry access during event emission, adding a non-trivial cross-cutting dependency for information clients can derive themselves.

---

## Feature Detection

Clients detect MCP Apps support by checking the `hello-ok` features list at connection time:

```typescript
const hello = await connectToGateway({ minProtocol: 3, maxProtocol: 3, ... });
const supportsMcpApps = hello.features.methods.includes("mcp.resources.read");
```

No protocol version bump was required. All four `mcp.*` methods appear in `BASE_METHODS` and are thus included in `hello-ok.features.methods` automatically.
