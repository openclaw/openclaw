---
summary: "Hand-drawn Excalidraw diagrams via the official Excalidraw MCP App server (interactive canvas in MCP Apps hosts)."
read_when:
  - You are installing, configuring, or auditing the excalidraw plugin
title: "Excalidraw plugin"
---

# Excalidraw plugin

Hand-drawn Excalidraw diagrams via the official Excalidraw MCP App server (interactive canvas in MCP Apps hosts).

## Distribution

- Package: `@openclaw/excalidraw-plugin`
- Install route: included in OpenClaw

## Surface

plugin

<!-- openclaw-plugin-reference:manual-start -->

## Enable

```bash
openclaw plugins enable excalidraw
```

No configuration is required. Enabling the plugin attaches the official
[Excalidraw MCP App server](https://github.com/excalidraw/excalidraw-mcp)
(`https://mcp.excalidraw.com/mcp`, streamable HTTP) to agent sessions via the
manifest's `mcpServers.excalidraw` declaration. The server's `create_view`
tool draws hand-drawn diagrams and carries an MCP Apps `ui://` resource: the
Control UI renders it as an interactive Excalidraw canvas inside the tool
card, while other surfaces receive the plain text result.

To point at a different deployment, override the server in user config, which
always wins by server name:

```json
{
  "mcp": {
    "servers": {
      "excalidraw": {
        "transport": "streamable-http",
        "url": "https://your-deployment.example.com/mcp"
      }
    }
  }
}
```

Set `mcp.servers.excalidraw.enabled: false` to keep the plugin enabled but
detach the server.

## Notes

- Tools marked app-only by the server (`_meta.ui.visibility: ["app"]`, e.g.
  checkpoint save/restore) are not exposed to the model.
- The canvas requires an MCP Apps-capable surface. The Control UI renders it
  in a sandboxed iframe (`allow-scripts`, no same-origin); the app loads its
  bundle from `https://esm.sh` per its declared CSP, so offline gateways fall
  back to text results.
- The current host is view-only for app→host calls: you can pan, zoom, and
  edit the rendered canvas locally, but app-initiated MCP requests
  (checkpoint save/restore across turns, "Export to excalidraw.com") are
  rejected with a JSON-RPC method-not-found error until the full host bridge
  lands. A follow-up `create_view` that starts from `restoreCheckpoint`
  renders only the new elements.
- Known limitation: the gateway-served Control UI ships a strict CSP that
  srcdoc iframes inherit, which blocks the inline app preview on standard
  deployments (the tool's text result still works everywhere). The dedicated
  app-document route with per-app CSP headers is the tracked follow-up that
  makes the preview function under the production CSP.

<!-- openclaw-plugin-reference:manual-end -->
