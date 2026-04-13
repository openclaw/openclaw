# MCP Apps — Implementation Document

> **Status**: Implemented (gateway/server-side)  
> **Date**: 13 April 2026  
> **Plan reference**: PLAN.md § "Plan: MCP Apps — Gateway Protocol Extension (Code-Informed Revision)"

---

## Overview

This document describes exactly what was changed in the OpenClaw codebase to implement **gateway-side** MCP Apps support — tool metadata, resource discovery, and the resource registry. MCP Apps are interactive HTML applications served through the Model Context Protocol's `resources` capability. They render in sandboxed iframes and communicate with the host via `postMessage`.

The implementation is additive and backward-compatible. No gateway protocol version bump was made — clients use feature discovery (`hello-ok.features.methods`) to detect availability.

> **Scope note**: This covers the gateway protocol extension and resource serving surface only. Host-side rendering (iframe embedding, `postMessage` app bridge, the `ui/initialize` handshake) is **not** part of this change and must be implemented per-client (Control UI, macOS app, mobile apps, etc.).

---

## Files Changed

### `src/agents/tools/common.ts`

**Change**: Added MCP App types following the SEP-1865 domain-based model and `mcpAppUi` optional field to `AgentToolWithMeta`.

```typescript
/**
 * CSP configuration for MCP App resources.
 * Follows the MCP Apps spec domain-based declaration model (SEP-1865).
 * The host translates these to actual CSP header directives.
 */
export type McpUiResourceCsp = {
  /** Origins for network requests (fetch/XHR/WebSocket) → maps to CSP connect-src */
  connectDomains?: string[];
  /** Origins for static resources (images, scripts, styles, fonts, media) → maps to CSP img-src, script-src, style-src, font-src, media-src */
  resourceDomains?: string[];
  /** Origins for nested iframes → maps to CSP frame-src */
  frameDomains?: string[];
  /** Allowed base URIs for the document → maps to CSP base-uri */
  baseUriDomains?: string[];
};

/**
 * Structured permissions for MCP App resources.
 * Follows the MCP Apps spec (SEP-1865).
 * Maps to iframe Permission Policy `allow` attributes.
 */
export type McpUiPermissions = {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
};

/**
 * Resource-level metadata for MCP App resources.
 * Returned in `resources/read` response as `_meta.ui` on the content block.
 * Contains CSP, permissions, and rendering preferences.
 */
export type McpAppResourceMeta = {
  csp?: McpUiResourceCsp;
  permissions?: McpUiPermissions;
  domain?: string; // dedicated sandbox origin
  prefersBorder?: boolean; // render a visible border around the app
};

/** Declares how the gateway should serve the HTML for an MCP App resource. */
export type McpAppResourceSource =
  | { type: "builtin"; html: string }
  | { type: "file"; rootDir: string; relativePath: string }
  | { type: "canvas"; canvasUrl: string };

/**
 * Optional MCP App UI metadata for tools that render interactive
 * HTML content in a sandboxed iframe via the MCP Apps protocol.
 */
export type McpAppUiMeta = {
  /** `ui://` resource URI — host fetches HTML via `resources/read` */
  resourceUri: string;
  /**
   * Who can access this tool. Default: `["model", "app"]`.
   * - `"model"`: visible to and callable by the LLM agent
   * - `"app"`: callable by the MCP App from the same server connection only
   */
  visibility?: Array<"model" | "app">;
  /** Resource-level metadata (CSP, permissions, rendering prefs). Stored on the tool for convenience; the gateway attaches this to the resource content in `resources/read`, NOT to the tool's `_meta.ui`. */
  resourceMeta?: McpAppResourceMeta;
  /** Content source for the `ui://` resource. When set, the gateway auto-registers the resource on tool-cache refresh. */
  resourceSource?: McpAppResourceSource;
};
```

The `McpAppResourceSource` type (`builtin`, `file`, `canvas`) drives auto-sync registration — when a tool declares `resourceSource`, the gateway auto-registers the resource on tool-cache refresh so `resources/read` can serve it without manual `register*Resource` calls.

**Impact**: Zero breaking changes. The new field is optional and ignored by all existing code paths. Plugin authors may now declare `mcpAppUi` on any tool to make it an MCP App tool. CSP/permissions are carried on the resource content block (`resources/read` response), not on the tool's `_meta.ui`.

---

### `src/gateway/mcp-http.schema.ts`

**Change**: Simplified `McpToolUiMeta` to only carry `resourceUri` and `visibility` per SEP-1865. Updated `buildMcpToolSchema()` to extract these two fields individually from `tool.mcpAppUi`.

```typescript
export type McpToolUiMeta = {
  resourceUri: string;
  visibility?: Array<"model" | "app">;
};
```

`buildMcpToolSchema()` now reads `tool.mcpAppUi.resourceUri` and `tool.mcpAppUi.visibility` and sets `entry._meta = { ui: { resourceUri, visibility } }` when present. CSP and permissions are no longer on the tool schema — they live on the resource content block.

---

### `src/gateway/mcp-http.handlers.ts`

**Changes**:

1. `initialize` response now advertises `capabilities: { tools: {}, resources: {} }` (was `{ tools: {} }`).
2. Added `resources/list` case — calls `listResources()` from the new resource registry.
3. Added `resources/read` case — calls `resolveResourceContent(uri)` and returns `{ contents: [...] }`.
4. `tools/call` response now includes `_meta` from the tool schema entry (matching the WS handler behavior).
5. `normalizeToolCallContent()` now preserves non-text content blocks (images, resources) instead of degrading all blocks to `type: "text"`. This keeps the HTTP loopback surface consistent with the WS handler.

The handlers are now `async` because `resources/read` may read from the filesystem.

---

### `src/gateway/mcp-http.runtime.ts`

**Change**: Added `McpLoopbackToolCache` — a session-scoped tool cache with 30 s TTL that bridges tool resolution to the MCP App resource registry.

The `resolve()` method resolves tools for a given session context (session key, message provider, account ID, sender-is-owner), caches the result, and triggers resource auto-sync. On every cache refresh, the cache:

1. Inserts/updates the entry for the current session.
2. Evicts expired entries (≥30 s TTL).
3. Collects the **union** of all active cache entries' tools.
4. Passes the full tool union to `syncMcpAppResources()` — this prevents one session's refresh from orphaning resources owned by another session.

```typescript
const allActiveTools = [...this.#entries.values()].flatMap((e) => e.tools);
syncMcpAppResources(allActiveTools);
```

The cache is used by both the HTTP loopback server and the WS gateway handlers (separate instances), so both surfaces benefit from the same caching and sync behavior.

---

### `src/gateway/mcp-app-resources.ts` _(new)_

**Purpose**: Registry and resolver for `ui://` MCP App resources.

**Key exports**:

| Export                            | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `registerBuiltinResource(params)` | Register HTML bundled at startup                       |
| `registerFileResource(params)`    | Register file-backed resource (path-traversal safe)    |
| `registerCanvasResource(params)`  | Register canvas-host-backed resource                   |
| `unregisterResource(uri)`         | Remove a resource from the registry                    |
| `listResources()`                 | List all registered resources (uri/name/mimeType)      |
| `getResource(uri)`                | Lookup a resource entry by URI without reading content |
| `resolveResourceContent(uri)`     | Fetch content for a uri (async, with size limit)       |
| `syncMcpAppResources(tools)`      | Reconcile registry with tool set (auto-sync bridge)    |
| `buildResourceCsp(csp)`           | Merge domain-based CSP with default policy             |
| `MCP_APP_DEFAULT_CSP`             | Default restrictive CSP string                         |
| `MCP_APP_RESOURCE_MAX_BYTES`      | 2 MB size limit                                        |
| `MCP_APP_RESOURCE_MIME_TYPE`      | `"text/html;profile=mcp-app"`                          |
| `_resetAutoSyncState()`           | Reset auto-sync tracking (test-only)                   |

**Source types**:

- `builtin` — inline HTML string, rejected at registration time if it exceeds the 2 MB size limit (read-time check retained as defense-in-depth)
- `file` — reads `rootDir/relativePath` on demand; path traversal rejected
- `canvas` — returns the canvas host URL directly as the text content

**Resource metadata**: Each registered resource may carry optional `McpAppResourceMeta` (CSP, permissions, domain, prefersBorder). When present, `resolveResourceContent()` includes it as `_meta.ui` on the returned content block per SEP-1865.

**CSP model** (SEP-1865 domain-based declarations): Tools declare domains in `McpUiResourceCsp`, which `buildResourceCsp()` translates to actual CSP directives:

| Declaration field | CSP directive(s)                                              |
| ----------------- | ------------------------------------------------------------- |
| `connectDomains`  | `connect-src`                                                 |
| `resourceDomains` | `script-src`, `style-src`, `img-src`, `font-src`, `media-src` |
| `frameDomains`    | `frame-src`                                                   |
| `baseUriDomains`  | `base-uri`                                                    |

The `child-src`, `frame-src` (unless `frameDomains` is set), and `allow-same-origin` remain permanently blocked.

**Auto-sync lifecycle**: `syncMcpAppResources(tools, owner)` is called from `McpLoopbackToolCache.resolve()` on every cache refresh (≤30 s cadence). Each cache instance passes a unique `owner` key (`"http"` or `"ws"`) so that one surface's refresh cannot evict resources registered by a different surface. Within a single surface, the cache passes the **union of all active cache entries' tools** (not just the current session's tools) to avoid cross-session eviction. The sync iterates the full tool set, registers resources for tools that declare `mcpAppUi.resourceSource`, and cleans up orphaned auto-synced resources when tools are removed from all sessions for that owner — but only when no other owner still claims the same URI. Manual registrations (via direct `register*Resource` calls) are never evicted by the sync.

---

### `src/gateway/protocol/schema/mcp.ts` _(new)_

**Purpose**: TypeBox schemas for gateway WebSocket `mcp.*` methods.

**Schemas exported**:

| Schema                         | Description                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `McpToolUiMetaSchema`          | `{ resourceUri, visibility? }` — tool \_meta.ui (SEP-1865)                                 |
| `McpToolMetaSchema`            | `{ ui?: McpToolUiMetaSchema }`                                                             |
| `McpToolEntrySchema`           | `{ name, description?, inputSchema, _meta? }`                                              |
| `McpUiResourceCspSchema`       | `{ connectDomains?, resourceDomains?, frameDomains?, baseUriDomains? }`                    |
| `McpUiPermissionsSchema`       | `{ camera?, microphone?, geolocation?, clipboardWrite? }` — empty objects                  |
| `McpResourceUiMetaSchema`      | `{ csp?, permissions?, domain?, prefersBorder? }` — resource \_meta.ui                     |
| `McpResourceMetaSchema`        | `{ ui?: McpResourceUiMetaSchema }`                                                         |
| `McpToolsListParamsSchema`     | `{ sessionKey?: string, callerRole?: "model" \| "app" }`                                   |
| `McpToolsListResultSchema`     | `{ tools: McpToolEntry[] }`                                                                |
| `McpToolsCallParamsSchema`     | `{ name: string, arguments?: Record, sessionKey?: string, callerRole?: "model" \| "app" }` |
| `McpToolsCallResultSchema`     | `{ content: ContentBlock[], isError: boolean, _meta?: McpToolMeta }`                       |
| `McpResourcesListParamsSchema` | `{ sessionKey?: string }`                                                                  |
| `McpResourcesListResultSchema` | `{ resources: McpResourceEntry[] }`                                                        |
| `McpResourcesReadParamsSchema` | `{ uri: string, sessionKey?: string }`                                                     |
| `McpResourceEntrySchema`       | `{ uri, name, mimeType }` — resource list entry                                            |
| `McpContentBlockSchema`        | `{ uri, mimeType, text, _meta? }` — resource read content block                            |
| `McpResourcesReadResultSchema` | `{ contents: McpContentBlock[] }` — content blocks include optional `_meta`                |

---

### `src/gateway/protocol/schema/protocol-schemas.ts`

**Change**: Added all 17 MCP schemas to the `ProtocolSchemas` registry: 8 method schemas (4 params + 4 results), 3 tool sub-schemas (`McpToolUiMeta`, `McpToolMeta`, `McpToolEntry`), 4 resource metadata schemas (`McpUiResourceCsp`, `McpUiPermissions`, `McpResourceUiMeta`, `McpResourceMeta`), and 2 structural schemas (`McpResourceEntry`, `McpContentBlock`). Used by the gateway's schema documentation and validation surfaces.

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

**Session scoping**: `mcp.tools.list` and `mcp.tools.call` accept an optional `sessionKey` parameter to scope tool resolution. Falls back to the gateway's main session key when absent or `"main"`. The `mcp.resources.list` method does not accept `sessionKey` because resources are global (not session-scoped).

---

### `src/gateway/server-methods-list.ts`

**Change**: Added `mcp.tools.list`, `mcp.tools.call`, `mcp.resources.list`, `mcp.resources.read` to `BASE_METHODS`.

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
- `buildResourceCsp` — default, domain-based extension (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), deduplication, `'none'` removal
- Resource metadata in `resolveResourceContent` — `_meta.ui` included when metadata present, omitted when absent

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

### `src/gateway/mcp-http.test.ts`

Tests the HTTP loopback server including MCP App resource support:

- Session, account, and message channel headers passed to tool resolution
- `senderIsOwner` threaded through loopback request context and cache
- Active runtime tracking (singleton lifecycle)
- Lazy startup and singleton reuse via `ensureMcpLoopbackServer`
- Auth enforcement (401 without bearer token, 415 without JSON content type)
- `createMcpLoopbackServerConfig` builds correct env-driven headers
- `initialize` advertises `resources` capability alongside `tools`
- `resources/list` returns registered resources
- `resources/read` returns HTML content for valid URIs
- `resources/read` returns error for missing `uri` parameter
- `resources/read` returns error for unknown URIs

---

## WP-7 Decision: `session.tool` event enrichment

The plan asked to evaluate whether `session.tool` event payloads need enrichment with `_meta.ui`.

**Decision**: No enrichment required. Rationale:

1. `session.tool` events already include `data.name` (tool name) and `data.phase` (start/update/result).
2. Clients can pre-fetch the tool catalog via `mcp.tools.list` and build a local map of `toolName → _meta.ui`.
3. When a `session.tool` event arrives for phase `"result"`, the client looks up `_meta.ui` from its local map using `data.name`.

Adding runtime enrichment to `server-chat.ts` would require tool registry access during event emission, adding a non-trivial cross-cutting dependency for information clients can derive themselves.

> **Note**: A dedicated `mcp.tool.result` gateway event was considered but deferred — the existing `session.tool` event provides sufficient information for clients to detect MCP App tool completions. If this proves insufficient in practice, a dedicated event can be added in a future PR.

---

## Feature Detection

Clients detect MCP Apps support by checking the `hello-ok` features list at connection time:

```typescript
const hello = await connectToGateway({ minProtocol: 3, maxProtocol: 3, ... });
const supportsMcpApps = hello.features.methods.includes("mcp.resources.read");
```

No protocol version bump was required. All four `mcp.*` methods appear in `BASE_METHODS` and are thus included in `hello-ok.features.methods` automatically.
