# MCP Apps — Client Integration Guide

> **Audience**: Client developers (Mission Control and third-party operator UIs)  
> **Gateway protocol version**: 3 (feature-detected, no version bump required)  
> **Date**: 13 April 2026

---

## Overview

OpenClaw now supports **MCP Apps** — interactive HTML applications embedded as tool results in chat sessions. When the model calls a tool that has UI metadata, the gateway signals this to connected clients, who render the HTML in a sandboxed iframe.

This guide explains how to:

1. Detect MCP Apps support at connection time
2. Discover which tools have associated apps
3. Execute app-enabled tools
4. Fetch the app's HTML content
5. Render the iframe and wire up postMessage

---

## 1. Detecting MCP Apps Support

At connection time, check the `hello-ok` features list:

```typescript
const hello = await connectToGateway({
  minProtocol: 3,
  maxProtocol: 3,
  // ...
});

const supportsMcpApps = hello.features.methods.includes("mcp.resources.read");

if (supportsMcpApps) {
  // Enable MCP App rendering in your UI
}
```

All four `mcp.*` methods are present together. Checking for `mcp.resources.read` is sufficient.

---

## 2. Listing Tools with MCP App UI

Use `mcp.tools.list` to get the tool catalog with `_meta.ui` metadata:

```typescript
// Request
{
  "type": "req",
  "id": "req-1",
  "method": "mcp.tools.list",
  "params": {
    "sessionKey": "board:abc123"  // optional; defaults to main session
  }
}

// Response
{
  "type": "res",
  "id": "req-1",
  "ok": true,
  "payload": {
    "tools": [
      {
        "name": "show_chart",
        "description": "Render an interactive chart",
        "inputSchema": { "type": "object", "properties": { ... } }
      },
      {
        "name": "show_chart_app",
        "description": "Render a chart MCP App",
        "inputSchema": { "type": "object", "properties": { ... } },
        "_meta": {
          "ui": {
            "resourceUri": "ui://openclaw-charts/chart.html",
            "permissions": [],
            "csp": {}
          }
        }
      }
    ]
  }
}
```

**Tools without `_meta.ui`** are standard tools with no interactive UI.  
**Tools with `_meta.ui.resourceUri`** are MCP App tools — their results should render in an iframe.

**Recommended**: Build a local lookup map at connection time:

```typescript
const mcpAppToolMap = new Map<string, string>(); // toolName → resourceUri

for (const tool of hello.tools) {
  if (tool._meta?.ui?.resourceUri) {
    mcpAppToolMap.set(tool.name, tool._meta.ui.resourceUri);
  }
}
```

### Session scoping

If your UI creates sessions per board or workspace, pass the `sessionKey` so tool resolution respects that session's policy:

```typescript
{
  "method": "mcp.tools.list",
  "params": { "sessionKey": "board:abc123" }
}
```

---

## 3. Calling App-Enabled Tools

Use `mcp.tools.call` to execute a tool through the WebSocket connection:

```typescript
// Request
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

// Response
{
  "type": "res",
  "id": "req-2",
  "ok": true,
  "payload": {
    "content": [
      { "type": "text", "text": "{\"chartId\":\"chart-abc\",\"data\":[10,20,30]}" }
    ],
    "isError": false,
    "_meta": {
      "ui": {
        "resourceUri": "ui://openclaw-charts/chart.html"
      }
    }
  }
}
```

When `_meta.ui.resourceUri` is present in the response, proceed to render the MCP App iframe.

### Error cases

- **`isError: true`**: Tool execution failed. Show the error text from `content[0].text`. Do not render an iframe.
- **`ok: false`**: Gateway-level error (bad params, scope missing). Check `error.message`.
- **Unknown tool name**: Returns `ok: true` with `isError: true` and `"Tool not available"` text.

### Calling tools during chat

You can also call tools implicitly using `sessions.send` or `chat.send`. In those cases, listen for `session.tool` events to detect when an MCP App tool completes:

```typescript
// Subscribe to session events first
{
  "method": "sessions.subscribe",
  "params": { "sessionKey": "board:abc123" }
}

// Then send a message that may trigger a tool
{
  "method": "sessions.send",
  "params": {
    "sessionKey": "board:abc123",
    "text": "Show me a bar chart of our Q1 revenue"
  }
}

// Watch for session.tool events with phase:"result"
// When data.name matches a tool in mcpAppToolMap, render the app
```

---

## 4. Fetching App HTML

Once you have a `resourceUri`, fetch the HTML content:

```typescript
// Request
{
  "type": "req",
  "id": "req-3",
  "method": "mcp.resources.read",
  "params": {
    "uri": "ui://openclaw-charts/chart.html"
  }
}

// Response
{
  "type": "res",
  "id": "req-3",
  "ok": true,
  "payload": {
    "contents": [
      {
        "uri": "ui://openclaw-charts/chart.html",
        "mimeType": "text/html;profile=mcp-app",
        "text": "<!DOCTYPE html><html>...</html>"
      }
    ]
  }
}
```

**Cache the HTML**: Resource content is stable for a given URI. Cache it in memory for the session lifetime.

You can also list all available resources:

```typescript
{
  "method": "mcp.resources.list",
  "params": {}
}
// Response: { "resources": [{ "uri": "...", "name": "...", "mimeType": "..." }] }
```

---

## 5. Rendering the MCP App Iframe

Render the fetched HTML in a sandboxed `<iframe>`. The sandbox must not grant `allow-same-origin`.

```html
<iframe
  id="mcp-app-frame"
  sandbox="allow-scripts"
  srcdoc="<!DOCTYPE html><html>...</html>"
  style="border: none; width: 100%; height: 400px;"
></iframe>
```

**Required sandbox attributes**: `allow-scripts`  
**Forbidden sandbox attributes**: `allow-same-origin`, `allow-top-navigation`, `allow-popups-to-escape-sandbox`, `allow-forms` (unless explicitly listed in `tool._meta.ui.permissions`)

### Injecting tool result data

Before rendering, serialize the tool call result into the iframe's initial context. A common pattern is embedding it as a data attribute or injecting it via `postMessage` immediately after the frame loads:

```typescript
const iframe = document.getElementById("mcp-app-frame") as HTMLIFrameElement;

iframe.addEventListener("load", () => {
  // Send the tool result data to the app
  iframe.contentWindow?.postMessage(
    {
      type: "mcp-app:init",
      toolResult: {
        content: toolCallResult.content,
        toolName: "show_chart_app",
      },
    },
    "*",
  );
});

iframe.srcdoc = htmlContent;
```

---

## 6. postMessage Protocol

MCP Apps communicate with the host using `window.postMessage`. Messages are JSON objects with a `type` field.

### Host → App (you send)

| message `type`  | Description                          |
| --------------- | ------------------------------------ |
| `mcp-app:init`  | Deliver tool result data on load     |
| `mcp-app:theme` | Deliver theme tokens (colors, fonts) |

```typescript
// Init message (required)
iframe.contentWindow?.postMessage(
  {
    type: "mcp-app:init",
    toolResult: {
      content: toolCallResult.content,
      toolName: "show_chart_app",
    },
    theme: {
      colorScheme: "dark",
      primaryColor: "#7c3aed",
    },
  },
  "*",
);
```

### App → Host (you receive)

Listen for these messages from the iframe:

```typescript
window.addEventListener("message", (evt) => {
  if (evt.source !== iframe.contentWindow) return;
  const msg = evt.data as { type: string; [key: string]: unknown };

  switch (msg.type) {
    case "mcp-app:ready":
      // App loaded and ready for data
      break;

    case "mcp-app:callTool":
      // App wants to call a gateway tool
      handleMcpAppCallTool(msg.toolName as string, msg.arguments as Record<string, unknown>);
      break;

    case "mcp-app:sendMessage":
      // App wants to send a chat message
      sendChatMessage(msg.text as string, msg.sessionKey as string | undefined);
      break;

    case "mcp-app:openLink":
      // App wants to open a URL
      window.open(msg.url as string, "_blank", "noopener,noreferrer");
      break;

    case "mcp-app:resize":
      // App wants to resize the iframe
      iframe.style.height = `${msg.height}px`;
      break;
  }
});
```

### Handling `mcp-app:callTool`

When an app calls a tool, proxy it through the gateway:

```typescript
async function handleMcpAppCallTool(toolName: string, args: Record<string, unknown>) {
  const result = await gatewayCall("mcp.tools.call", {
    name: toolName,
    arguments: args,
    sessionKey: currentSessionKey,
  });

  // Send result back to the iframe
  iframe.contentWindow?.postMessage(
    {
      type: "mcp-app:toolResult",
      toolName,
      result: result.payload,
    },
    "*",
  );
}
```

---

## 7. Using the MCP HTTP Loopback (Alternative)

If your integration already uses the MCP loopback server (`http://127.0.0.1:<port>/mcp`) rather than the WebSocket gateway, all the same functionality is available there via standard MCP JSON-RPC:

```bash
# Initialize
curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'

# List resources
curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"resources/list"}'

# Read a resource
curl -X POST http://127.0.0.1:PORT/mcp \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://openclaw-charts/chart.html"}}'
```

The loopback server now advertises `capabilities: { tools: {}, resources: {} }` in its `initialize` response.

---

## 8. Registering Your Own MCP App Tool (Plugin Authors)

To create a tool that renders as an MCP App, register it with `mcpAppUi` set:

```typescript
import type { AgentToolWithMeta } from "openclaw/plugin-sdk/agent-tool";
import { Type } from "@sinclair/typebox";
import { registerBuiltinResource } from "openclaw/plugin-sdk/mcp-app-resources";

// Register the HTML resource at plugin load time
registerBuiltinResource({
  uri: "ui://my-plugin/dashboard.html",
  name: "My Dashboard",
  html: `<!DOCTYPE html>
<html>
<head>
  <style>body { font-family: sans-serif; }</style>
</head>
<body>
  <h1>Dashboard</h1>
  <div id="content">Loading...</div>
  <script>
    window.addEventListener("message", (evt) => {
      if (evt.data.type === "mcp-app:init") {
        document.getElementById("content").textContent =
          JSON.stringify(evt.data.toolResult.content, null, 2);
      }
    });
    window.parent.postMessage({ type: "mcp-app:ready" }, "*");
  </script>
</body>
</html>`,
});

// Register the tool with mcpAppUi
const dashboardTool: AgentToolWithMeta<typeof paramsSchema, unknown> = {
  name: "show_dashboard",
  description: "Show an interactive dashboard",
  parameters: Type.Object({ title: Type.String() }),
  mcpAppUi: {
    resourceUri: "ui://my-plugin/dashboard.html",
    // Optionally extend CSP:
    csp: {
      "img-src": ["https://cdn.example.com"],
    },
  },
  async execute(toolCallId, args) {
    return {
      content: [{ type: "text", text: JSON.stringify({ title: args.title, data: [] }) }],
    };
  },
};

api.registerTool(dashboardTool);
```

---

## 9. Security Checklist

Before shipping MCP App support, verify:

- [ ] iframe uses `sandbox="allow-scripts"` — never `allow-same-origin`
- [ ] HTML comes from `mcp.resources.read` — never from arbitrary URLs
- [ ] `postMessage` handler validates `evt.source === iframe.contentWindow`
- [ ] `mcp-app:openLink` handler uses `window.open(..., "noopener,noreferrer")`
- [ ] No `eval()` or `innerHTML` injection of untrusted content in the host UI
- [ ] CSP on your host page blocks iframe from accessing host resources

---

## 10. Scope Requirements

Your gateway client must connect with the following scopes to use `mcp.*` methods:

| Method               | Required scope   |
| -------------------- | ---------------- |
| `mcp.tools.list`     | `operator.read`  |
| `mcp.tools.call`     | `operator.write` |
| `mcp.resources.list` | `operator.read`  |
| `mcp.resources.read` | `operator.read`  |

Standard operator connections (`admin` scope) satisfy all of these.

---

## 11. Complete Example — Rendering a Tool Result as MCP App

```typescript
async function handleChatToolResult(toolName: string, toolResult: McpToolsCallResult) {
  const resourceUri = mcpAppToolMap.get(toolName) ?? toolResult._meta?.ui?.resourceUri;

  if (!resourceUri) {
    // Standard text tool — render as markdown
    renderTextToolResult(toolName, toolResult.content);
    return;
  }

  // Fetch or get cached HTML
  let html = htmlCache.get(resourceUri);
  if (!html) {
    const res = await gatewayCall("mcp.resources.read", { uri: resourceUri });
    if (!res.ok) {
      renderTextToolResult(toolName, toolResult.content);
      return;
    }
    html = res.payload.contents[0].text;
    htmlCache.set(resourceUri, html);
  }

  // Create and mount the iframe
  const container = document.createElement("div");
  container.className = "mcp-app-container";
  const iframe = document.createElement("iframe");
  iframe.sandbox.add("allow-scripts");
  iframe.style.cssText = "border:none; width:100%; height:400px; display:block;";

  iframe.addEventListener("load", () => {
    iframe.contentWindow?.postMessage({ type: "mcp-app:init", toolResult }, "*");
  });

  iframe.srcdoc = html;
  container.appendChild(iframe);
  chatContainer.appendChild(container);

  // Wire up app → host messages
  window.addEventListener("message", createMcpAppMessageHandler(iframe, toolName));
}

function createMcpAppMessageHandler(iframe: HTMLIFrameElement, toolName: string) {
  return (evt: MessageEvent) => {
    if (evt.source !== iframe.contentWindow) return;
    const msg = evt.data as { type: string; [k: string]: unknown };

    if (msg.type === "mcp-app:callTool") {
      void handleMcpAppCallTool(msg.toolName as string, msg.arguments as Record<string, unknown>);
    } else if (msg.type === "mcp-app:sendMessage") {
      void sendChatMessage(msg.text as string);
    } else if (msg.type === "mcp-app:openLink") {
      window.open(msg.url as string, "_blank", "noopener,noreferrer");
    } else if (msg.type === "mcp-app:resize") {
      iframe.style.height = `${msg.height as number}px`;
    }
  };
}
```
