---
summary: "Registering plugin HTTP routes on the Gateway, and their auth, scope, and lifecycle rules"
read_when:
  - You are exposing an HTTP endpoint or webhook from a plugin
  - You need the auth and runtime scope rules for plugin routes
  - You are registering or replacing routes from channel lifecycle code
title: "Gateway routes"
sidebarTitle: "Gateway routes"
---

How a plugin registers HTTP endpoints on the Gateway, and the auth, scope,
replacement, and admission rules those routes follow. Part of the [Plugin
architecture internals](/plugins/architecture-internals) guide.

## Gateway HTTP routes

Plugins can expose HTTP endpoints with `api.registerHttpRoute(...)`.

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

Route fields:

- `path`: route path under the gateway HTTP server.
- `auth`: required, `"gateway"` or `"plugin"`. Use `"gateway"` to require normal gateway auth, or `"plugin"` for plugin-managed auth/webhook verification.
- `match`: optional. `"exact"` (default) or `"prefix"`.
- `handleUpgrade`: optional handler for WebSocket upgrade requests on the same route.
- `replaceExisting`: optional. Required only for dynamic lifecycle registration to replace its own existing route.
- `handler`: return `true` when the route handled the request.

Notes:

- `api.registerHttpHandler(...)` was removed and will cause a plugin-load error. Use `api.registerHttpRoute(...)` instead.
- Plugin routes must declare `auth` explicitly.
- Canonically equivalent paths with the same `match` mode occupy one route. Static `api.registerHttpRoute(...)` calls from the same plugin replace that route; another plugin cannot replace it.
- Overlapping routes with different `auth` levels are rejected. Keep `exact`/`prefix` fallthrough chains on the same auth level only.
- Dynamic lifecycle code using `registerPluginHttpRoute(...)` from `openclaw/plugin-sdk/webhook-ingress` must set `replaceExisting: true` to refresh its own canonical route. Named registrations can replace only the same nonempty `pluginId`; when either side sets a route `source`, both must set the same nonempty source. Same-plugin source-less-to-source-less refresh and anonymous-to-anonymous refresh remain supported for shipped SDK callers, but named and anonymous routes cannot replace each other.
- Set `reuseExistingSameOwner: true` to share a canonical route with the same nonempty `pluginId` and `source`. A dynamically created route remains until its last holder releases it; reusing a static `api.registerHttpRoute(...)` route leaves its lifetime with the plugin registry.
- Channel lifecycle callbacks use their Gateway's route registry. Startup routes expire when their task settles or recovery abandons it; `stopAccount` routes expire when that stop attempt settles or times out. Recovery revokes abandoned task routes before replacement startup, even if startup fails. Expired callbacks cannot dynamically register or replace routes.
- Treat route `source` as a stable same-plugin sub-owner, not a diagnostic label. Existing source-less callers may keep omitting it; source-aware callers must keep it unchanged across refreshes.
- Dynamic lifecycle registration logs and returns a no-op unregister callback on rejection by default. Set `throwOnFailure: true` when readiness depends on that route; required bundled webhook transports use strict registration so they cannot report ready without live ingress.
- `auth: "plugin"` routes do **not** receive operator runtime scopes automatically. They are for plugin-managed webhooks/signature verification, not privileged Gateway helper calls.
- `auth: "gateway"` routes run inside a Gateway request runtime scope. The default surface (`gatewayRuntimeScopeSurface: "write-default"`) is intentionally conservative:
  - shared-secret bearer auth (`gateway.auth.mode = "token"` / `"password"`) and any non-trusted-proxy auth method get a single `operator.write` scope, even if the caller sends `x-openclaw-scopes`
  - `trusted-proxy` callers without an explicit `x-openclaw-scopes` header also keep the legacy `operator.write`-only surface
  - `trusted-proxy` callers that do send `x-openclaw-scopes` get the declared scopes instead
  - a route can opt into `gatewayRuntimeScopeSurface: "trusted-operator"` to always honor `x-openclaw-scopes` for identity-bearing auth modes (falling back to the full CLI default scope set when the header is absent)
- Sandboxed external Control UI tabs backed by `auth: "gateway"` routes use a short-lived signed cookie grant minted only by authenticated bootstrap; plugin-auth tabs keep their direct iframe path. Before mounting, the parent runs a route-owned probe inside the same opaque sandbox and fails closed when browser privacy policy blocks the cookie. The grant is bound to the owning plugin, matched route root, and current auth generation; its process-random cookie name prevents trusted same-host Gateways from overwriting one another, but cookies never isolate TCP ports. The Gateway hostname is therefore one credential boundary: do not cohost mutually untrusted services on that hostname, including other ports. Route dispatch rejects reuse against a nested route owned by another plugin. Because sandbox descendants are cross-site for cookie purposes, the grant accepts only `GET` and `HEAD` with `operator.read`; mutations and WebSocket upgrades stay on explicit Gateway-authenticated surfaces. The cookie intentionally cannot use CHIPS: current browsers include a cross-site-ancestor bit in the partition key, so nested opaque sandbox frames would lose access to same-route assets. The cookie requires a secure context and browser permission for cross-site cookies, so gateway-auth external tabs are unavailable on plain-HTTP LAN origins or under full third-party-cookie blocking; use HTTPS/Tailscale Serve or browser-trusted loopback with a compatible cookie policy.
- The grant prevents Gateway bearer-token disclosure and accidental route/scope reuse; it does not create a security boundary between native plugins. Native plugin code and the UI content it serves remain part of the same trusted in-process plugin boundary.
- Practical rule: do not assume a gateway-auth plugin route is an implicit admin surface. If your route needs admin-only behavior, opt into `trusted-operator` scope surface, require an identity-bearing auth mode, and document the explicit `x-openclaw-scopes` header contract.
- Startup plugins register HTTP routes with their full runtime after the Gateway starts listening. Until startup sidecars are ready, an otherwise-unclaimed HTTP request returns `503` with `Retry-After: 1`; core routes continue to dispatch normally. This generic fallback covers plugin routes before the runtime registry can identify their owners.
- After route matching and authentication, ordinary handlers participate in Gateway root-work admission. A prepared or restarting Gateway returns `503` before invoking the handler. The narrow exception is a manifest-entitled `auth: "gateway"` route that also opts into the route-specific `trusted-operator` surface; it remains reachable so suspension control dispatch cannot be stranded, while ordinary sibling routes from the same plugin remain behind the admission boundary. WebSocket `handleUpgrade` ownership uses the same atomic admission boundary; once the handler accepts a socket, the socket's later lifetime is plugin-owned and is not tracked by this boundary.
