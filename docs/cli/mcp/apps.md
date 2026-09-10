---
summary: "Enable and secure the MCP Apps host bridge that renders server-provided HTML views"
title: "MCP Apps"
read_when:
  - Enabling the MCP Apps host bridge
  - Reviewing the sandbox origin, listener port, and security boundaries for Apps
---

OpenClaw can render tools that implement the MCP Apps extension. Apps are
opt-in because their HTML comes from the configured MCP server.

## MCP Apps

OpenClaw can render tools that implement the stable [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps). Apps are opt-in because their HTML comes from the configured MCP server. A view with current App-interaction authority can request app-visible tools and resources from that same server.

Enable the host bridge:

```bash
openclaw config set mcp.apps.enabled true --strict-json
```

Restart the Gateway after changing this setting. When enabled, OpenClaw starts a sandbox-only HTTP(S) listener on the Gateway port plus one (for the default Gateway, `18790`). The Control UI loads Apps from that separate origin; the listener never serves Control UI, authenticated Gateway routes, or user data.

Direct Gateway connections need access to both ports. If a reverse proxy or TLS terminator exposes the Control UI, give Apps a dedicated public origin and proxy only that origin to the sandbox listener:

```json5
{
  mcp: {
    apps: {
      enabled: true,
      sandboxOrigin: "https://mcp-apps.example.com",
      sandboxPort: 18790,
    },
  },
}
```

The sandbox origin must differ from the Control UI origin. Do not host other authenticated or sensitive content on it.

For example, the official basic React demo can be configured as:

```json5
{
  mcp: {
    apps: { enabled: true },
    servers: {
      "basic-react": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-basic-react", "--stdio"],
      },
    },
  },
}
```

Behavior and security boundaries:

- OpenClaw advertises the `io.modelcontextprotocol/ui` extension only when Apps are enabled.
- Only `ui://` resources with the exact `text/html;profile=mcp-app` MIME type render.
- UI resources are capped at 2 MiB, placed behind a double-iframe proxy on a dedicated outer origin, loaded into an opaque inner App origin, and constrained by CSP derived from the resource metadata.
- App-only tools (`_meta.ui.visibility: ["app"]`) stay out of model tool lists. Apps can call only app-visible tools on their owning server that also pass the effective OpenClaw tool policy for the run that created the view.
- Same-server resource listing and reads require that same current App-interaction authority. OpenClaw rechecks after upstream resource work, so a grant revoked in flight cannot return resource data to the App.
- Origin-bound App permissions such as camera, microphone, and geolocation are not granted while inner App documents use opaque origins for cross-App isolation.
- App HTML, complete tool arguments, and raw results live in a bounded ten-minute in-memory view lease and are not written to disk or copied into transcript preview metadata. The transcript stores only a bounded server/tool/resource descriptor tied to the original tool-call ID. After a Gateway restart, the Control UI can verify that descriptor against the authenticated session transcript and refetch the `ui://` document for display; reconstructed views cannot call tools or use the resource bridge until a fresh run establishes current App-interaction authority.
- In channel conversations, the latest successful App view in a turn adds one **Open App**-style action to the final assistant reply. Telegram DMs use a native Mini App button; Slack and Discord render the same portable action as a link. Other channels keep the original reply text and append an understandable HTTPS link.
- Channel launch links are available only when Gateway Tailscale exposure has prepared a published HTTPS origin. `gateway.tailscale.mode: "serve"` is reachable only from the tailnet; password-authenticated `"funnel"` is reachable from the public internet. Externally managed Funnel routes targeting the ordinary Gateway listener must migrate to managed `"funnel"` mode before OpenClaw can publish an internet-reachable origin. See [Tailscale](/gateway/tailscale).
- Launch tickets are opaque, minted only while materializing the final channel reply, and expire after at most two minutes or when the underlying view lease expires, whichever comes first. The URL does not contain Gateway bearer credentials, session keys, view metadata, App HTML, tool input, or tool results.
- Standalone App windows allow 30 seconds to load the view. Each server's `requestTimeoutMs` applies to individual MCP requests, not to a complete App operation that may refresh the catalog before calling a tool. App request cancellation or closing the window aborts its browser request and propagates to the managed MCP runtime; other callers can still finish a shared catalog refresh. Cancellation cannot undo side effects already performed by the server.
- When an App requests teardown, existing calls and authorized cleanup calls can finish until the App acknowledges shutdown or the one-second grace period expires. Closing or navigating away from the window cancels immediately.
- Returning to a standalone App restored from the browser's back/forward cache reloads and revalidates the view instead of reviving its torn-down connection. This resets transient App state and does not automatically retry interrupted operations. If the launch ticket has expired, open a fresh App link.
- If no published origin or ticket capacity is available, the view or ticket has expired, or the transport cannot render native controls, the original assistant text remains available. The Control UI keeps its existing inline App canvas and does not receive a duplicate launch action.
- `openclaw security audit` warns while the bridge is enabled. Disable it with `openclaw config set mcp.apps.enabled false --strict-json` when it is not needed.
