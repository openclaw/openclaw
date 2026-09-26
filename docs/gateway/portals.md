---
title: "Portals"
summary: "Expose agent-run development servers to the operator through the Gateway"
read_when:
  - Showing a development server in the Control UI
  - Declaring workspace development servers for an agent
  - Troubleshooting portal access or live reload
---

Portals expose a development server running on the Gateway host or a node-backed cloud worker to the operator's browser. They proxy HTTP and WebSockets for live reload and appear in **Control UI → Portals**.

## Quick start

Ask the agent to open a portal:

- "Show me in a portal."
- "Start the app in a portal."

The agent opens a portal for the application's port, then starts the development server with a background `exec` call. Opening a portal allocates its proxy route; it does not inject environment variables into your server. The agent sets `PORT` (the port it opened) and `PUBLIC_URL` (the returned token-free `publicUrl`, including its initial path) in that `exec` command's own environment, so the app binds the expected port and generates correct absolute URLs.

For a session on a node-backed cloud worker, including the bundled Crabbox provider, the development server runs on the worker. Each portal connection receives its own single-use ticket, which the enrolled node redeems over a TLS-pinned WebSocket to the Gateway before connecting to the selected loopback port. This uses the existing authenticated node channel without exposing the worker to inbound traffic or creating an SSH tunnel. Stopping or replacing the worker closes its portals.

A background development server continues running after the agent finishes its
reply. Later turns in the same worker environment can inspect or stop it with
`process`. Closing the portal only closes the proxy; it does not stop the server.
See [Worker background processes](/gateway/background-process#worker-environments)
for process lifetime and capacity details.

An agent can also use a temporary Crabbox attached to its existing conversation
without moving the session's primary workspace. It passes the attachment's
`environmentId` to the `portal` tool and uses `screen` with `portal_show` and the
returned `portalId` to open that exact preview in the chat side panel. Commands
for the app run through the Crabbox tool on that environment. Its managed
background processes survive completed turns; stopping the attachment closes
its apps and portals. The portal retains the same separate-origin network and
access contract described below.

Opening a route does not prove that the application is running or that a remote
browser can reach it. Open the returned URL in **Control UI → Portals** and verify
that the page, assets, and live reload work. Use the returned URLs unchanged;
replacing their scheme, hostname, or port with the Gateway's address does not
create an ingress route.

## Remote access

Prefer managed private [Tailscale Serve](/gateway/tailscale) when the operator and
Gateway share a tailnet. Otherwise, configure the private wildcard ingress below.
A tunnel or reverse proxy that exposes only the Gateway endpoint does not expose
application portals.

### Managed private Tailscale Serve

With managed Gateway Tailscale ingress active, each portal gets its own private
Serve HTTPS port on the managed hostname. The portal owns a foreground route
claim until it closes. Closing it, losing its claim, stopping its worker, or
restarting the Gateway withdraws the route. Existing routes owned by other
applications are not adopted or cleared for portals.

Portal routes use **Serve, never Funnel**, even when the Gateway uses Funnel.
The operator's browser must be on the tailnet. Gateway access on port `443` does
not prove access to the portal's separate HTTPS port: restrictive tailnet grants
or ACLs must permit the port in the returned URL. OpenClaw does not edit those
policies. Portal bearer authentication remains required; Gateway identity-header
authentication does not grant portal access.

### Private wildcard reverse proxy

Use a dedicated DNS namespace such as `preview.example.net`, separate from the
Gateway and Control UI hostnames. Configure one private HTTPS wildcard route, not
one manual route per application:

```json5
{
  gateway: {
    portals: {
      ingress: { domain: "preview.example.net", port: 18890 },
    },
  },
}
```

`domain` is a bare DNS suffix, without a scheme, wildcard prefix, path, or port.
`port` is the dedicated ingress listener's TCP port on `127.0.0.1`, not the
application port or the external HTTPS port. Apply this Gateway configuration
with a Gateway restart. When configured, wildcard ingress takes precedence over
managed portal Serve routes.

Set up the operator-owned reverse proxy as follows:

1. Resolve `*.preview.example.net` to a private HTTPS edge reachable by the
   operator's browser. Provision a browser-trusted TLS certificate covering that
   wildcard. Do not make the preview namespace publicly accessible by default.
2. Terminate HTTPS on port `443` and forward requests to
   `http://127.0.0.1:18890` on the Gateway host. Preserve the original `Host`
   header, full request path and query, and WebSocket upgrades. Disable response
   buffering for streaming responses. Do not strip a path prefix or forward to
   the Gateway's ordinary HTTP port.
3. Keep the edge private using network access controls or an explicit
   identity-aware access policy covering the wildcard. Keep the loopback backend
   inaccessible to untrusted hosts. Authentication for the Gateway hostname does
   not automatically protect the preview wildcard. Remove edge-injected identity
   and credential headers before forwarding to the backend. The portal strips
   Tailscale and Cloudflare Access headers, but cannot identify every custom
   authentication edge's headers. Application `Authorization` headers are preserved.
4. Open a portal and verify the exact returned HTTPS URL from the remote browser,
   including assets, navigation, and WebSocket live reload. A host-local fetch or
   successful Gateway connection is not this verification.

OpenClaw does not install DNS records, issue certificates, configure the reverse
proxy, or copy Gateway access policies to this namespace. A proxy on another
machine needs a separately secured path to the loopback backend; that path is
not created by this setting. Edge login pages or third-party cookie restrictions
may prevent iframe loading even when a new tab works.

Each portal receives a random per-lifetime hostname under the configured suffix.
Only active portal hostnames route to applications; unknown or closed hostnames
cannot select local ports or Gateway APIs. Closing a portal removes its mapping
and active connections. The shared ingress listener belongs to the Gateway;
the external wildcard DNS, certificate, and proxy remain operator-owned across
portal closures and Gateway restarts.

### Direct and local listeners

Without configured wildcard ingress or managed Tailscale ingress, the returned
URL describes the actual direct listener and its HTTP or TLS scheme. Direct
listeners use the Gateway's bind interfaces. Wildcard listeners advertise the
Gateway's discovered private LAN IPv4 address when available, so browsers on that
LAN can use the returned URL without configuring ingress. The published address
stays fixed for the portal's lifetime; reopen the portal after a network change.
If no private LAN address is available, wildcard listeners publish a loopback URL.
A loopback URL works on the Gateway host, not on an unrelated remote browser.
Direct TLS listeners reuse the Gateway certificate. The service prefers a
certificate-valid hostname from `gateway.publicOrigin` or the configured Control
UI origins, then a certificate-valid bind address, then a concrete DNS name from
the certificate. Wildcard certificate names alone cannot identify a destination;
configure the existing `gateway.publicOrigin` when a concrete hostname is needed.
The hostname must resolve to the Gateway and the returned port must be reachable.
No additional portal ingress configuration is required for direct TLS.

Discovery and certificate names do not establish reachability through firewalls,
container port mappings, or remote proxies. A Gateway-only HTTPS proxy still
requires one of the ingress paths above; changing the displayed URL does not
expose its portal ports.

HTTPS portals use secure partitioned cookies so their authentication also works
when the Control UI is on another site. A direct HTTP portal can embed when the
Control UI uses the same scheme and hostname; different ports are supported.
Otherwise, the Portals page offers a new-tab launch instead of an embedded preview
whose authentication cookies may be blocked. The link keeps the service-published
URL unchanged. Applications that explicitly restrict their own cookies with
`SameSite=Strict` or `SameSite=Lax` retain that policy.

## Declare development servers

Optionally commit `.openclaw/portals.json` to the workspace repository so the agent can discover the available development servers:

```json
{
  "portals": [
    {
      "name": "web",
      "command": "pnpm dev",
      "cwd": ".",
      "port": 3000,
      "title": "App",
      "description": "Use the seeded test account."
    }
  ]
}
```

The Gateway never executes these commands automatically. The agent reads the file and decides when to run a declared server.

| Field         | Required | Description                                        |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | Stable name the agent uses to identify the server. |
| `command`     | yes      | Command the agent starts with background `exec`.   |
| `port`        | yes      | Local TCP port the application listens on.         |
| `cwd`         | no       | Working directory relative to the workspace root.  |
| `title`       | no       | Display title shown on the Portals page.           |
| `description` | no       | Operator guidance shown beside the portal.         |
| `path`        | no       | Initial URL path. It must begin with `/`.          |

## Application contract

The application must honor `PORT`. Use `PUBLIC_URL` when it needs to generate absolute URLs.

The server can listen on IPv4 or IPv6 loopback (`127.0.0.1` or `::1`), both on the Gateway host and on a worker, even when the machine's `localhost` records list only one address family. Worker streams also preserve the node's configured Gateway context path when connecting through a reverse proxy.

The proxy rewrites `Host` to the local target, so typical development servers such as Vite and Next.js need no additional configuration. WebSockets and hot module replacement are proxied through the same portal.

Streaming HTTP responses, including server-sent events, forward response headers without waiting for the first body chunk.

## Availability and configuration

The `portal` tool follows ordinary tool policy, described in [Tools configuration](/gateway/config-tools). The optional `gateway.portals.ingress` setting configures only the private wildcard ingress described above; it does not grant tool access.

Out of the box:

- `portal` belongs to `group:ui` and the `coding` profile, so coding agents have it while `messaging` and `minimal` agents do not.
- Sandboxed sessions never receive it, because opening a portal starts a listener on the Gateway host.
- It is blocked for HTTP `POST /tools/invoke`. The global tool, including Gateway-host ports and primary worker placements, remains restricted to the session owner.
- Non-owners can receive a restricted tool for a dedicated secondary worker attached to their conversation. The provider must explicitly attest that the current lease is not a shared host. Unknown classification, a shared machine, or a missing attachment hides this mode. After a Gateway restart, fresh provider inspection must qualify the lease again.
- Primary cloud-worker placements receive it only when their enrolled node advertises portal-stream support. Older node bundles without that capability do not receive the tool in that placement mode.

To turn portals off everywhere, deny the tool in the global policy:

```json5
{
  tools: { deny: ["portal"] },
}
```

To turn them off for a single agent, leaving the others unchanged:

```json5
{
  agents: { entries: { "<agentId>": { tools: { deny: ["portal"] } } } },
}
```

`tools.profile`, `tools.allow`, `byProvider`, and `toolsBySender` apply to `portal` as they do to any other tool, so portals can also be limited to specific providers, models, or senders without a portal-specific setting.

The restricted tool selects the conversation's attachment automatically. It has
no `environmentId` override and cannot expose Gateway-host ports. Its
`portal.session.open`, `portal.session.list`, and `portal.session.close` RPCs
require current write access to the named conversation and its effective `portal`
tool policy. An own-session write grant applies only to its own conversation;
broader collaborators retain the existing session-sharing rules. Required sandbox
isolation and all sessions with `modelSelectionLocked: true` exclude this mode.
Support for locked sessions requires a prepared session-ownership contract,
including native and imported session ownership;
the existing owner tool remains available under its ordinary policy. This does not change primary worker-turn
placement permissions or grant access to other attached environments.

Scoped previews have their own resource identity. Opening the same application
port through the global tool and the restricted tool produces separate links;
closing or retiring the scoped preview does not close the global one. Repeated
opens within the same session incarnation and attachment reuse that scoped link.
The restricted listing and close action cover only those scoped previews.

For secondary attachments, tool availability checks conversation policy and the
dedicated-machine qualification. Each open and connection separately verifies
the current node's portal-stream support. An eligible attachment can therefore
show the tool while its node is offline or needs an update; reconnect or update
that worker node, then retry.

A temporary provider inspection error preserves the last explicit qualification
for the same lease, node, and owner. A successful inspection that omits the host
classification, reports a shared host, or no longer recognizes the active lease
withdraws the restricted capability and its previews.

In direct mode, portal listeners bind the same interfaces as the Gateway. A Gateway bound to a LAN or tailnet address publishes its direct portal listener ports on that network too. Managed Serve uses a private loopback backend; configured wildcard ingress uses the dedicated loopback listener. Reaching one still requires the portal token, but deny the tool when the Gateway host must not offer operator-reachable application ports at all.

## Security model

Each portal uses a separate origin: its own port in direct/Serve mode, or its own hostname with wildcard ingress. Never mount an arbitrary application on the Control UI origin, even under a different URL path. Access requires the token in the portal URL. On the first request, the proxy stores that token in an HttpOnly cookie and removes it from subsequent upstream requests. The proxy validates this cookie itself and never forwards it to the application.

Browser cookies are hostname-scoped rather than port-scoped, so the proxy gives each portal instance a random `oc_portal_<instance>_` cookie-name prefix. Requests forward only cookies with the current portal's prefix and strip it before reaching the application; Gateway cookies, unprefixed cookies, and cookies from sibling or closed portals are dropped. Application `Set-Cookie` responses receive the prefix, and any `Domain` attribute is removed so the cookie stays host-only.

Wildcard ingress uses `Secure; SameSite=None; Partitioned` for portal authentication so embedded requests can remain authenticated under a different top-level site. Application cookies also receive `Secure` and `Partitioned`; cookies without an explicit `SameSite` attribute receive `SameSite=None`. Explicit application `SameSite=Lax` or `SameSite=Strict` restrictions remain unchanged and may prevent cross-site embedded sessions. Partitioned cookies are scoped to the top-level site, so opening the portal in a new tab can create a separate application session. Browser policies can still block embedding; the proxy does not override them.

The service returns `publicUrl` as the authoritative token-free application URL
and `url` as its authenticated launch URL. `listenPort` is transport metadata,
not a browser URL template. Read-only listings and change events omit `url` and
`tokenQuery`; authorized clients refetch them with write access. Do not put the
bearer credential in `PUBLIC_URL` or share it in logs or screenshots.

Authenticated portal URLs are shareable bearer links, including conversation-scoped
previews. Completing a turn or revoking its initiating actor does not invalidate
an already copied URL. Revocation prevents that actor from starting or managing
previews. The conversation-scoped resource ends when its session is reset or
deleted, its attachment is retired, its environment stops, or the Gateway
restarts. Losing the provider's explicit dedicated-machine qualification also
withdraws a scoped preview. Close the portal to withdraw a shared link immediately.

Portals proxy only the selected development server on the Gateway host or a node-backed cloud worker. Worker connections use single-use tickets and the enrolled node's TLS-pinned Gateway connection; they never expose a public worker port or require SSH forwarding. Portals never serve Gateway data, and every portal ends when the Gateway restarts.

## Limitations

- Older node bundles without portal-stream support cannot open worker portals. Update the node bundle, or move the session back to the Gateway with `sessions.move`.
- SSH-backed `remote-exec` placements, including Codex sessions, do not run the OpenClaw worker tool loop, so the `portal` tool does not apply there. Move the session back to the Gateway with `sessions.move` when a Gateway-hosted portal is needed.
- A Gateway-only proxy, SSH tunnel, or externally managed Serve route does not automatically create portal ingress. Configure private wildcard ingress or OpenClaw-managed Serve. The UI reports a remote loopback URL as requiring ingress; it does not invent a reachable URL.
- Browser reachability probes check transport only. A response can be an authentication page or a waiting page, not a rendered application. A Content Security Policy-blocked probe says nothing about iframe reachability.
- Portal ingress does not inherit Gateway trusted-proxy identities, Cloudflare Access policies, or tailnet ACL grants. Configure and verify those boundaries separately.
- The prefix isolates cookies forwarded to each target; it does not create separate browser cookie jars. In direct/Serve mode, browser-side code can see non-`HttpOnly` cookies for sibling portals on the same hostname through `document.cookie`. Wildcard ingress separates hostnames, but portals under a common DNS suffix are not necessarily separate sites, and the cookie-name prefix still applies. Use `HttpOnly` for sensitive application cookies. Applications that manage cookies in browser code must account for the prefix; unprefixed cookies written directly by browser code are not forwarded to the target.

## Troubleshooting

### The portal shows a 502 waiting page

The proxy is ready, but the application is not listening on the selected port or its worker node is temporarily disconnected. The page retries automatically. Check the background process, confirm that the server honors `PORT`, and verify that the worker node is connected.

### The portal is not reachable from this browser

Check the exact returned portal URL rather than substituting the Gateway host:

- **Loopback URL with a remote Gateway:** open it on the Gateway host, or configure
  managed private Serve or wildcard ingress. Forwarding only the Gateway port
  does not forward the portal.
- **Managed Serve URL times out:** verify tailnet membership and access to the
  returned HTTPS port, not only `443`. Check that its managed claim remains active.
- **Wildcard URL fails DNS or TLS:** check wildcard DNS and certificate coverage.
  Confirm that the private edge is reachable from the browser.
- **Wildcard URL returns an unknown-host response:** preserve the original `Host`
  header and reopen the portal if its lifetime ended. Do not rewrite it to the
  loopback backend hostname.
- **Page loads but streaming or live reload fails:** preserve WebSocket upgrades
  and request paths, disable buffering, and check the app's `PUBLIC_URL`.
- **New tab works but the preview does not:** inspect edge authentication,
  frame policies, and browser cookie restrictions. A blocked reachability probe
  alone does not prove the iframe is unreachable.

After correcting ingress, select **Retry**. Reopen a portal if its route was
withdrawn, and restart the application with the new `PUBLIC_URL` when it changes.

### Close a portal

Ask the agent to "close the portal," or use the close button on the **Control UI → Portals** page.
