---
summary: "Principal-bound remote Control UI transport and Gateway RPC for trusted plugin grants"
title: "Remote Control UI ingress"
read_when:
  - You are implementing a trusted plugin transport for the Control UI
  - You need the remote ingress security and lifecycle contract
  - You need Gateway RPC bound to the same person and grant as a remote UI
---

`openclaw/plugin-sdk/gateway-ingress` exports principal-bound Control UI transport,
Gateway RPC, and `GatewayControlUiIngressError`. The host supplies the
optional `controlUiIngress` factory on a plugin's service context, only for
bundled plugins and verified official installations admitted by the plugin
loader. It is not part of `api.runtime.gateway` or a tool invocation.

A plugin must check `capabilityVersion === 2` before calling `open()` or
`bindPrincipal()`. An older host could otherwise ignore a person option and open
an owner connection. If the capability is absent or older, report that OpenClaw
needs an update and keep delegated access disabled; do not substitute a loopback
connection or a synthetic Gateway client. The V1 type exports remain available
for source imports, but the current factory requires an explicit `principal`.
The factory capability version is separate from the Gateway wire protocol.

## Open a handle

```typescript
import type {
  GatewayControlUiIngressFactoryV1,
  GatewayControlUiIngressFactoryV2,
  GatewayIngressPrincipal,
} from "openclaw/plugin-sdk/gateway-ingress";

async function openRemoteUi(
  factory: GatewayControlUiIngressFactoryV1 | GatewayControlUiIngressFactoryV2 | undefined,
  principal: GatewayIngressPrincipal,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  if (!factory || !("capabilityVersion" in factory) || factory.capabilityVersion !== 2) {
    throw new Error("Update OpenClaw to enable principal-bound remote ingress.");
  }
  return factory.open({
    audienceId: "example-grant-id",
    principal,
    publicOrigin: "https://ui.example.com",
    sandboxOrigin: "https://sandbox.example.com",
    operatorScopeCeiling: ["operator.read", "operator.write"],
    frameAncestors: [
      "codex-sandbox:",
      "https://*.web-sandbox.oaiusercontent.com",
      "https://chatgpt.com",
    ],
    signal,
    assertCurrent,
  });
}
```

The public and sandbox origins must be exact, distinct HTTPS origins without
paths or credentials. WebSocket `origin` is the actual browser Origin and must
equal this handle's `publicOrigin` exactly. The contextual allowance does not
change `gateway.publicOrigin`, global allowed origins, or Host fallback policy.
Multiple live handles may share both origins; `audienceId` identifies each
plugin-owned grant. The relay must select and authenticate the grant for each
request on both origins, for example with its own browser session cookie.
Paths stay unchanged: the configured Control UI mount and existing root-owned
resource routes remain authoritative. There is no per-handle base-path option.
Publishing a changed Gateway origin policy retires existing handles; open a new
handle under the current policy.
The host validates the entire requested frame ancestor chain, including an
explicit `codex-sandbox:` ancestor when needed, exact HTTPS origins, and CSP
wildcard host sources of the form `https://*.<domain>`. Other wildcard forms are
rejected. The policy applies only to responses served by this handle. Sandbox
documents also allow the handle's public origin as an ancestor so the nested
Control UI frame can load them.

## Principal, consent, and lifetime

`principal` is required and selects the existing Gateway identity:

- `{ kind: "owner" }` uses the shared owner. It requires token or password
  authentication without `gateway.roles`.
- `{ kind: "person", profileId }` uses the person who approved the grant in the
  Gateway's own authenticated Control UI. It requires trusted-proxy authentication
  with verified Cloudflare Access profiles and `gateway.roles`. The proxy must use
  `cf-access-authenticated-user-email` and require `cf-access-jwt-assertion`.
  Missing, deleted, merged, and shared-owner profiles are rejected.

Unsupported authentication combinations return `unsupported-auth` with
configuration guidance. A Team grant must never use the shared owner or the
loopback maintenance password. The plugin derives `profileId` from the approving
Control UI caller's admitted profile, not a relay parameter or a claimed email.
This is delegation of an existing verified profile, not a new identity source.

The plugin owns the consent UI and durable grant record. Offer **Read + write**
by default, with `operatorScopeCeiling: ["operator.read", "operator.write"]`.
**Full** uses `["operator.admin"]`, which permits every operator scope only
within the principal's current authority. An administrator receives admin parity
only with Full; a restricted person remains restricted even with Full. These are
integration requirements, not a consent screen supplied by this SDK.

The ceiling accepts any known [operator scope](/gateway/operator-scopes), including
`operator.admin`, or an empty list. Core uses implication-aware intersection with
the person's current role: a Full grant for a read-only role yields read access;
an empty ceiling or role yields no operator scopes. Owner authority is full, so
its effective scopes are the chosen ceiling. Identity-scope grants and the
plugin caller's admin authority do not widen this delegation.

`audienceId` identifies the plugin-owned grant; it is not an OAuth token or a
browser credential. Before forwarding HTTP, opening a socket, or invoking RPC,
the plugin must authenticate the caller as the holder of that exact grant. The
plugin and relay own grant expiry, OAuth refresh limits, persistence, and
revocation. Do not reinterpret an old owner grant as a person grant; require new
approval when its stored principal is missing or inappropriate for the Gateway.

`assertCurrent` must synchronously check the exact grant's live authority and
throw when it is stale. Core composes it with service, plugin, Gateway, profile,
role, and additional access-policy authority on admission, each request, and
retained effects, including after asynchronous work and before disclosure or
publication. Abort `signal` when the grant is revoked so open transports and
retained work are canceled promptly. A signed or unexpired token alone does not
prove current authority.

Profile removal, identity rebinding or merging, role changes, and access-policy
revocation fence existing authority. Reopen under current authority after the
plugin verifies that its grant is still valid; closed operations do not revive.
This does not continuously reauthenticate against Cloudflare: removing access
only at the external identity provider does not itself revoke the plugin grant.

## Grant-bound Gateway RPC

For MCP tool calls or another plugin-owned RPC transport, use
`factory.bindPrincipal({ audienceId, principal, operatorScopeCeiling, signal, assertCurrent })`
after the same capability-version check. It needs no UI origins and returns a
`GatewayIngressPrincipalBindingV1`:

- `request<T>(method, params, { signal }?)` runs through normal Gateway method,
  session, role, and access-policy authorization with exactly the grant's effective
  scopes. It cannot inherit extra admin authority from the calling plugin request.
- `openControlUi({ publicOrigin, sandboxOrigin, frameAncestors })` opens UI
  transport sharing this binding's principal resolution and grant lifetime.
- `close()` fences the binding, closes its UI transports, and waits for owned
  work to settle.

Create one binding for a grant shared by UI and RPC. Do not separately construct
an owner client for MCP calls. `factory.open()` is the UI-first convenience form:
its returned handle adds `requestGateway(method, params, { signal }?)` for the
same grant-bound RPC, while `request()` remains the HTTP transport operation.
Closing a handle opened directly by `factory.open()` closes its binding too.
Closing a UI handle created with `binding.openControlUi()` leaves the binding
available for RPC and other UI handles; call `binding.close()` to revoke them all.

## HTTP and sockets

The returned `GatewayControlUiIngressV2` exposes:

- `presentation`: the configured `basePath`, exact public and sandbox origins,
  and the admitted operator scope ceiling.
- `request({ surface, method, pathAndQuery, headers, body?, signal })`: a
  streamed `Response` and `pluginReadCookies`. `surface` is `control-ui` or
  `sandbox`; paths retain the configured Control UI base path.
- `openWebSocket({ pathAndQuery, origin, protocols, signal })`: the selected
  protocol and a `GatewayIngressSocketV1`. The main socket is at the base path,
  without a `/ws` suffix. Existing Control UI auxiliary sockets retain their
  owning ticket and scope checks.
- `close()`: fences new admission, aborts reads and sockets, and waits for owned
  work to settle. Retained methods refuse work after closure or service retirement.
- `requestGateway(method, params, { signal }?)`: grant-bound Gateway RPC as above.

A socket accepts text or binary `GatewayIngressMessage` values through
`send()`, exposes received values through the `messages` async iterable, and
reports its final close code and reason through `closed`. `send()` waits for
bounded admission and drain. The host limits request bodies, frame sizes,
concurrent HTTP streams, and sockets; per-plugin quotas do not depend on a
claimed client IP.

Each handle admits 16 HTTP streams, two main sockets, and two auxiliary sockets.
The plugin-wide limits are 32 principal bindings, 32 handles, 64 HTTP streams, eight sockets, and 64 MiB
of buffered transport data. HTTP request and response bodies are capped at
100 MiB; WebSocket messages retain the Gateway's 25 MiB maximum and its lower
preauthentication limit. Endpoint-native limits still apply. Compressed request
bodies are refused; send decoded bytes.

Consume or cancel HTTP response bodies, and drain or close sockets. A remotely
closed socket keeps its final messages and quota slot until they are consumed or
discarded. Failed admission aborts transport immediately and settles owned work
before rejecting. A slow consumer or exceeded limit produces an explicit error.

`pluginReadCookies` describes only core-issued signed, read-only native-asset
or iframe grants. It does not authorize forwarding arbitrary `Set-Cookie`
headers or Gateway credentials. A transport must preserve the distinction.

The error `code` is one of `invalid-options`, `unsupported-auth`, `unavailable`,
`closed`, `limit-exceeded`, or `forbidden`. Treat `closed` as terminal for that
handle; do not retry through another authentication path.

## Browser device approval

Every ingress browser connects as `operator`, signs the normal device challenge,
and omits credentials. The live grant authenticates both owner and person
connections. Core keeps an ordinary paired-device row for visibility and key
checks, but never issues a reusable device token in ingress `hello`, at any
ceiling. Reconnects use the same signed key and the current grant. An existing
device ID with a different public key is refused, never auto-approved.

Ingress-served documents carry `data-openclaw-remote-ingress="true"`. The embedded
UI stays connected to the Gateway serving the document, requests the handle's
effective scope ceiling, and ignores stored device tokens and shared, bootstrap,
and native credentials. It never stores an ingress device token or warm-admits
cached state using a previous visitor's credentials. The shared-credential login gate,
Gateway URL and secret controls, and service-worker registration are disabled;
connection errors and retry remain available.

Person ingress preserves that person's session visibility, presence, and resource
access. Owner ingress retains shared-owner attribution, which does not expand
the handle's scopes. Questions require either the
separate `operator.questions` scope or a verified personal identity with eligible
session access; the shared owner is not a personal identity. The embedded UI
therefore skips owner question requests under a read/write ceiling, while an
eligible person or an explicitly questions/admin-scoped grant can use them.

Hello advertises the handle's public origin, and board, Canvas, and MCP App
sandbox responses use its sandbox origin. Internal plugin-tab paths remain
relative to the selected Gateway so their read-cookie paths and registered
routes remain unchanged; explicitly external tab URLs retain their destinations.

The approved scopes are requested scopes within the effective grant and role
ceiling; omitting scopes or sending an empty scope request selects that effective
ceiling. Requests above it are refused. Device scope upgrades cannot widen the
plugin grant; change consent through the plugin's grant owner instead.

These browsers appear in the normal **Devices** list, `openclaw devices list`,
and device pairing RPCs. Revoke the plugin grant to end delegated access.
Closing or revoking it fences its ingress path and retained work without deleting
the paired-device visibility row. Ingress creates no bearer credential that can
be reused on the Gateway's direct listener. Existing credentials obtained through
other authentication paths retain their own revocation owner.

## Security boundary

Core marks every virtual request and connection `remote-forwarded` before
policy runs. Local-client trust, silent local pairing, browser owner recovery,
bootstrap credentials, Tailscale identity, trusted-proxy headers, device-less
access, and non-operator roles are unavailable. The live handle supplies the
remote authentication and approval boundary. Normal device challenge, signature,
key, scope, session, and revocation checks remain authoritative. Forwarded identity
headers cannot change the bound principal.

The HTTP surface permits Control UI documents, assets, configuration and media
resources, declared plugin panels, and a bounded liveness response. Startup
configuration and read-only UI resources can use the live plugin grant without a
browser device token. Avatar, workspace icon, and private owner-background reads
retain their existing resource handlers. Owner-only resource exceptions remain
owner-only; a person grant never impersonates the shared owner to load a resource.
Signed resource cookies must match the selected person and remain bounded by the
live grant. Media tickets and
resource-specific policy remain required where the direct listener requires them.
The surface refuses
general APIs, webhooks, `/v1`, standalone MCP, worker and node transfers, and
undeclared plugin routes. Service workers and local browser bootstrap recovery
are blocked. The sandbox surface serves only its dedicated shell and declared
public renderer resources, never Gateway data.

The HTTP transport is not arbitrary forwarding or a private network proxy. MCP
integrations use the separate grant-bound RPC operation, not an HTTP route
allowance. A relay can read and modify the active content it forwards and
exercise the grant's permitted capabilities; the
connection is not end-to-end encrypted against that relay.

Transcript image tickets are issued by the message/media owner independently of
ingress grants. Their existing direct-listener bearer lifetime is unchanged;
ingress redemption additionally checks the selected principal and session.

The relay owns browser-session routing and hosting; this transport alone is not
a complete remote UI deployment.
