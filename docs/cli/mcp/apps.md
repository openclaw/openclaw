---
summary: "Enable and secure the MCP Apps host bridge that renders server-provided HTML views"
title: "MCP Apps"
read_when:
  - Enabling the MCP Apps host bridge
  - Reviewing the sandbox origin, listener port, and security boundaries for Apps
---

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

## Plugin extensions

The Control UI also recognizes [OpenAI MCP Plugin Extensions](https://developers.openai.com/plugins/build/extensions). These extend the same MCP Apps host; they do not install a second plugin runtime or grant access to ChatGPT accounts. Connect the plugin's MCP server and enable Apps using the setting above. Existing server enablement, session tool access, and account permissions still apply.

Extensions let a server contribute:

- **Apps and conversation panels:** open an advertised global or thread entrypoint directly, without asking the model to discover and call its tool first. Each conversation keeps its own app instance.
- **Settings:** render server-provided fields and groups with native controls, or open an advertised settings action. The MCP server owns the saved values; these controls do not patch Gateway configuration.
- **Composer resources:** search a plugin's files and other resources and attach a selected reference to the conversation. These are separate from mentions of people.
- **Model context:** attach text, images, and resources from the current app selection. A later update replaces that app's earlier context. The next turn consumes the attachments and clears their composer chips. Removing an item updates the app as well. Presentation metadata stays out of model input, and app-supplied content remains conversation data rather than system instructions.
- **File viewers and editors:** choose an advertised viewer for a supported workspace file. The app receives an opaque resource URI, not unrestricted filesystem access. The host checks the current session and requester on reads, subscriptions, and saves. Conditional saves report a conflict when the supplied version no longer matches.
- **Onboarding:** explicitly run a packaged setup skill. Installing or discovering the plugin does not run that skill automatically.

A server advertises entrypoints on its normal tool descriptor:

```json
{
  "name": "parts.library",
  "title": "Parts library",
  "inputSchema": { "type": "object", "properties": {} },
  "_meta": {
    "ui": { "resourceUri": "ui://parts/library" },
    "openai/ui": { "entrypoints": [{ "type": "global" }, { "type": "thread" }] }
  }
}
```

Global and thread entrypoint tools accept `{}`. File entrypoints declare extensions with a leading dot, such as `.stl`, and receive the selected file's name and host-issued resource URI. The host supplies the initial tool result to the app; the app should render that result instead of repeating the opening tool call.

App resource metadata can declare supported and preferred display modes. Apps must inspect the actual host capabilities before using an extension: a standalone channel window does not have every capability of a connected Control UI conversation. Do not infer file, messaging, or model-context authority from a successful MCP connection alone.

File saves follow the extension protocol’s optional `ifMatch` precondition. Sending the ETag from the last read prevents a stale save from replacing a newer edit; omitting `ifMatch` performs an unconditional save (last writer wins). App authors should send the ETag when protecting concurrent edits. Both forms still require a writable read, the host-issued file URI, and current session and requester authority.

Native Codex Apps borrow the conversation’s existing MCP connection and retain
its approval policy. Interactive forms require a native policy that allows
prompting; see [Rich MCP forms](/plugins/codex-harness/native-features#rich-mcp-forms).
Only one native App tool call per server and conversation can be active at a time;
wait for it to finish before starting another. Each view also enforces limits of
four simultaneous requests, 120 requests per minute, and 30 tool calls per minute.
Background preview generation consumes the same limits as user-triggered calls.

The extensions use the existing sandbox and permission boundaries below. Server-owned settings and plugin data remain with their existing owners. Raw app state is not a new durable Gateway store, and a reconstructed transcript preview is not a fresh grant to run tools.

## Behavior and security boundaries

- OpenClaw advertises the `io.modelcontextprotocol/ui` extension only when Apps are enabled.
- Only `ui://` resources with the exact `text/html;profile=mcp-app` MIME type render.
- UI resources are capped at 2 MiB, placed behind a double-iframe proxy on a dedicated outer origin, loaded into an opaque inner App origin, and constrained by CSP derived from the resource metadata.
- App-only tools (`_meta.ui.visibility: ["app"]`) stay out of model tool lists. Apps can call only app-visible tools on their owning server that also pass the effective OpenClaw tool policy for the run that created the view.
- Same-server resource listing and reads require that same current App-interaction authority. OpenClaw rechecks after upstream resource work, so a grant revoked in flight cannot return resource data to the App.
- Origin-bound App permissions such as camera, microphone, and geolocation are not granted while inner App documents use opaque origins for cross-App isolation.
- App HTML, complete tool arguments, and raw results live in a bounded ten-minute in-memory view lease and are not written to disk or copied into transcript preview metadata. The transcript stores only a bounded server/tool/resource descriptor tied to the original tool-call ID. After a Gateway restart, the Control UI can verify that descriptor against the authenticated session transcript and refetch the `ui://` document for display; reconstructed views cannot call tools or use the resource bridge until a fresh run establishes current App-interaction authority. The Control UI marks inactive views with a recovery message. Entrypoint panels offer **Relaunch**; transcript previews ask you to send a message to interact again.
- In channel conversations, the latest successful App view in a turn adds one **Open App**-style action to the final assistant reply. Telegram DMs use a native Mini App button; Slack and Discord render the same portable action as a link. Other channels keep the original reply text and append an understandable HTTPS link.
- Channel launch links are available only when Gateway Tailscale exposure has prepared a published HTTPS origin. `gateway.tailscale.mode: "serve"` is reachable only from the tailnet; password-authenticated `"funnel"` is reachable from the public internet. Externally managed Funnel routes targeting the ordinary Gateway listener must migrate to managed `"funnel"` mode before OpenClaw can publish an internet-reachable origin. See [Tailscale](/gateway/tailscale).
- Launch tickets are opaque, minted only while materializing the final channel reply, and expire after at most two minutes or when the underlying view lease expires, whichever comes first. The URL does not contain Gateway bearer credentials, session keys, view metadata, App HTML, tool input, or tool results.
- Standalone App windows allow 30 seconds to load the view. Each server's `requestTimeoutMs` applies to individual MCP requests, not to a complete App operation that may refresh the catalog before calling a tool. App request cancellation or closing the window aborts its browser request and propagates to the managed MCP runtime; other callers can still finish a shared catalog refresh. Cancellation cannot undo side effects already performed by the server.
- Tool request time starts after approval. Pending human-input questions pause that clock for up to 120 seconds total per tool call; each question still expires on its own deadline. Ordinary tool calls retain the configured request timeout.
- When an App requests teardown, existing calls and authorized cleanup calls can finish until the App acknowledges shutdown or the one-second grace period expires. Closing or navigating away from the window cancels immediately.
- Returning to a standalone App restored from the browser's back/forward cache reloads and revalidates the view instead of reviving its torn-down connection. This resets transient App state and does not automatically retry interrupted operations. If the launch ticket has expired, open a fresh App link.
- If no published origin or ticket capacity is available, the view or ticket has expired, or the transport cannot render native controls, the original assistant text remains available. The Control UI keeps its existing inline App canvas and does not receive a duplicate launch action.
- `openclaw security audit` warns while the bridge is enabled. Disable it with `openclaw config set mcp.apps.enabled false --strict-json` when it is not needed.
