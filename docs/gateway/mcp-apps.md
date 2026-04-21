# MCP Apps - Gateway status and integration notes

> **Audience**: Gateway contributors and client developers  
> **Gateway protocol version**: 3 (feature-detected, no version bump required)  
> **Date**: 14 April 2026

---

## Overview

OpenClaw currently implements the **gateway-side MCP Apps transport surface** only.

That means the gateway can:

1. advertise MCP App-capable tools via `_meta.ui.resourceUri`
2. list registered `ui://` resources
3. return resource content from `mcp.resources.read`
4. expose the same functionality over the MCP HTTP loopback server

OpenClaw does **not** currently ship a complete MCP Apps host implementation in its clients. In particular, there is no built-in iframe renderer, no shipped `ui/initialize` bridge, and no spec-complete host/app JSON-RPC bridge in the current macOS, mobile, web, or Control UI clients.

This page documents what exists today, what is OpenClaw-specific, and what client authors must still implement themselves.

---

## Current support status

### Implemented in the gateway

- `mcp.tools.list`
- `mcp.tools.call`
- `mcp.resources.list`
- `mcp.resources.read`
- loopback HTTP `initialize` with `capabilities.tools` and `capabilities.resources`
- tool `_meta.ui` metadata with `resourceUri` and optional `visibility`
- resource `_meta.ui` metadata with `csp`, `permissions`, `domain`, and `prefersBorder`
- auto-registration of resources from tool declarations via `resourceSource`

### Not implemented in OpenClaw clients

- automatic rendering of MCP App results in a shipped client
- the spec's host/app `ui/*` bridge
- a public Plugin SDK seam for resource registration
- a built-in production MCP App tool shipped in the repo outside of tests

### Important limitations

- resources are currently registered globally, not scoped per session (though `sessionKey` is accepted on all methods for forward compatibility)
- `canvas` resources are an OpenClaw-specific extension and return an HTML wrapper embedding the canvas URL in an iframe

---

## Detecting MCP Apps support

At connection time, check the `hello-ok` method list:

```typescript
const hello = await connectToGateway({
  minProtocol: 3,
  maxProtocol: 3,
});

const supportsMcpApps = hello.features.methods.includes("mcp.resources.read");
```

All four `mcp.*` methods are advertised through the gateway method list. Checking for `mcp.resources.read` is sufficient for feature detection.

> `hello-ok` does **not** include a tool catalog. Clients must call `mcp.tools.list` to discover tool metadata.

---

## Discovering MCP App tools

Use `mcp.tools.list` to fetch the tool catalog for the current session context.

An optional `callerRole` parameter filters tools by MCP Apps visibility:

- `"model"` — excludes tools with `visibility: ["app"]`
- `"app"` — excludes tools with `visibility: ["model"]`
- omitted — returns all tools (backward-compatible default)

```typescript
{
  "type": "req",
  "id": "req-1",
  "method": "mcp.tools.list",
  "params": {
    "sessionKey": "board:abc123",
    "callerRole": "model"
  }
}
```

Example response:

```typescript
{
  "type": "res",
  "id": "req-1",
  "ok": true,
  "payload": {
    "tools": [
      {
        "name": "show_chart_app",
        "description": "Render a chart MCP App",
        "inputSchema": { "type": "object", "properties": {} },
        "_meta": {
          "ui": {
            "resourceUri": "ui://openclaw-charts/chart.html",
            "visibility": ["model", "app"]
          }
        }
      }
    ]
  }
}
```

Recommended lookup pattern:

```typescript
const toolsResult = await gatewayCall("mcp.tools.list", {
  sessionKey: currentSessionKey,
});

const mcpAppToolMap = new Map<string, string>();

for (const tool of toolsResult.payload.tools) {
  const resourceUri = tool._meta?.ui?.resourceUri;
  if (resourceUri) {
    mcpAppToolMap.set(tool.name, resourceUri);
  }
}
```

Tools without `_meta.ui.resourceUri` are standard tools. Tools with `_meta.ui.resourceUri` are MCP App-capable.

---

## Executing MCP App tools

Use `mcp.tools.call` to execute a tool directly through the gateway.

The optional `callerRole` parameter enforces visibility. If the tool's `visibility` does not include the caller's role, the gateway rejects the call with `isError: true`.

```typescript
{
  "type": "req",
  "id": "req-2",
  "method": "mcp.tools.call",
  "params": {
    "name": "show_chart_app",
    "arguments": {
      "type": "bar",
      "data": [10, 20, 30]
    },
    "sessionKey": "board:abc123"
  }
}
```

Example response:

```typescript
{
  "type": "res",
  "id": "req-2",
  "ok": true,
  "payload": {
    "content": [
      { "type": "text", "text": "{\"chartId\":\"chart-abc\"}" }
    ],
    "isError": false,
    "_meta": {
      "ui": {
        "resourceUri": "ui://openclaw-charts/chart.html",
        "visibility": ["model", "app"]
      }
    }
  }
}
```

When `_meta.ui.resourceUri` is present, the client can fetch the resource content and decide how to render it.

### Chat-driven tool calls

If tools are invoked indirectly through `sessions.send` or `chat.send`, clients can use `session.tool` events together with a previously fetched `mcp.tools.list` catalog:

1. call `mcp.tools.list` and cache `toolName -> resourceUri`
2. subscribe to the session
3. when a `session.tool` event arrives with `phase: "result"`, look up the tool name in the cached map
4. if a matching `resourceUri` exists, fetch the resource via `mcp.resources.read`

The gateway does not currently enrich `session.tool` events with `_meta.ui` directly.

---

## Reading resources

Once a client has a `resourceUri`, it can fetch the resource through `mcp.resources.read`.

```typescript
{
  "type": "req",
  "id": "req-3",
  "method": "mcp.resources.read",
  "params": {
    "uri": "ui://openclaw-charts/chart.html"
  }
}
```

Example response:

```typescript
{
  "type": "res",
  "id": "req-3",
  "ok": true,
  "payload": {
    "contents": [
      {
        "uri": "ui://openclaw-charts/chart.html",
        "mimeType": "text/html;profile=mcp-app",
        "text": "<!DOCTYPE html><html>...</html>",
        "_meta": {
          "ui": {
            "csp": {
              "connectDomains": ["https://api.example.com"],
              "resourceDomains": ["https://cdn.example.com"]
            },
            "permissions": { "camera": {} },
            "prefersBorder": false
          }
        }
      }
    ]
  }
}
```

`_meta.ui` on the content block is optional. When present, it contains resource-level metadata declared by the tool author.

Clients can also query the registry directly:

```typescript
{
  "method": "mcp.resources.list",
  "params": {}
}
```

> Resources are currently global to the gateway process, not session-scoped. Treat that as an implementation limitation, not a strong isolation guarantee.

---

## HTTP loopback support

The MCP loopback server exposes the same functionality via standard JSON-RPC.

Visibility filtering on the HTTP surface uses the `X-OpenClaw-Caller-Role` header (value: `model` or `app`).

```bash
curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'

curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/list"}'

curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://openclaw-charts/chart.html"}}'
```

The loopback `initialize` response advertises `capabilities: { tools: {}, resources: {} }`.

---

## Declaring resources on tools

The preferred gateway-side declaration is `mcpAppUi.resourceSource`.

```typescript
const dashboardTool = {
  name: "show_dashboard",
  description: "Show an interactive dashboard",
  parameters: Type.Object({ title: Type.String() }),
  mcpAppUi: {
    resourceUri: "ui://my-plugin/dashboard.html",
    visibility: ["model", "app"],
    resourceSource: {
      type: "builtin",
      html: "<!DOCTYPE html><html><body><h1>Dashboard</h1></body></html>",
    },
    resourceMeta: {
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      },
      permissions: { camera: {} },
      prefersBorder: false,
    },
  },
};
```

Supported source types:

| Source type | Shape                                     | Notes                                                                                                 |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `builtin`   | `{ type: "builtin", html }`               | Inline HTML, capped at 2 MB                                                                           |
| `file`      | `{ type: "file", rootDir, relativePath }` | File read at request time, traversal protected                                                        |
| `canvas`    | `{ type: "canvas", canvasUrl }`           | OpenClaw-specific extension; returns an HTML wrapper that embeds the canvas URL in a sandboxed iframe |

When `resourceSource` is present, the gateway auto-registers the resource during tool-cache refresh. Without it, resources must be registered manually through internal gateway APIs.

> The registration helpers are currently internal. There is no public `openclaw/plugin-sdk/mcp-app-resources` seam yet.

---

## Spec alignment notes

OpenClaw's gateway-side implementation follows the spec in these areas:

- tool `_meta.ui` only exposes `resourceUri` and optional `visibility`
- resource `_meta.ui` carries `csp`, `permissions`, `domain`, and `prefersBorder`
- CSP uses the domain-based declaration model (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`)
- loopback MCP `initialize` advertises both `tools` and `resources`

OpenClaw does not yet implement the full host-side app bridge described by the spec. In particular:

- there is no shipped `ui/initialize` bridge
- there is no shipped `ui/*` JSON-RPC channel between host and iframe/app
- there is no built-in OpenClaw client that renders MCP Apps end-to-end today

Any host-side rendering should treat this page as a description of the current gateway contract, not as proof that the full host/app protocol already exists in shipped clients.

---

## Security and scope notes

Gateway method scopes:

| Method               | Required scope   |
| -------------------- | ---------------- |
| `mcp.tools.list`     | `operator.read`  |
| `mcp.tools.call`     | `operator.write` |
| `mcp.resources.list` | `operator.read`  |
| `mcp.resources.read` | `operator.read`  |

Current caveats:

- `visibility` is exposed on tools and enforced by the gateway when `callerRole` is provided on `tools/list` and `tools/call`
- resource registry entries are process-global today
- host-side sandboxing and message validation remain the responsibility of the client that renders the app

If a client chooses to render app HTML, it should at minimum:

- use a sandboxed iframe
- avoid `allow-same-origin`
- validate `postMessage` origin/source boundaries carefully
- avoid treating arbitrary resource content as trusted host markup

---

## Verification status

The gateway-side MCP Apps tests currently cover:

- resource registration and resolution
- size limits and file traversal rejection
- HTTP loopback `initialize`, `resources/list`, and `resources/read`
- WS `mcp.tools.list`, `mcp.tools.call`, `mcp.resources.list`, and `mcp.resources.read`
- visibility filtering (`filterToolSchemaByVisibility`, `isToolVisibleTo`)
- owner-aware cross-surface resource sync (HTTP and WS caches do not evict each other)
- canvas HTML wrapping

Known follow-up work remains around session/resource isolation and host-side protocol support.
