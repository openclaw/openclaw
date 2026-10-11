---
summary: "Service-owned remote Control UI HTTP and WebSocket ingress"
title: "Remote Control UI ingress"
read_when:
  - You are implementing a trusted plugin transport for the Control UI
  - You need the remote ingress security and lifecycle contract
---

`openclaw/plugin-sdk/gateway-ingress` exports the version 1 remote Control UI
transport contract and `GatewayControlUiIngressError`. The host supplies the
optional `controlUiIngress` factory on a plugin's service context, only for
bundled plugins and verified official installations admitted by the plugin
loader. It is not part of `api.runtime.gateway` or a tool invocation.

A host without this capability requires an OpenClaw update. A plugin must report
that requirement and keep remote UI transport disabled; it must not substitute a
loopback connection or a synthetic Gateway client.

## Open a handle

```typescript
import type { GatewayControlUiIngressFactoryV1 } from "openclaw/plugin-sdk/gateway-ingress";

async function openRemoteUi(
  factory: GatewayControlUiIngressFactoryV1,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  return factory.open({
    audienceId: "example-grant-id",
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

`audienceId` identifies the plugin-owned grant; it is not an OAuth token or a
browser authentication credential or a device-token audience binding. Before
forwarding any HTTP request or opening any socket through the handle, the plugin
must authenticate the browser as the holder of that grant. The owner approves
the plugin grant locally with a pairing code; that live grant is the approval
boundary for browsers entering through the handle.

`assertCurrent` must check that grant's live authority. The host composes it with
service, plugin, and Gateway lifetime checks, including checks after asynchronous
admission and before publication. The assertion must be synchronous and throw
when its grant is stale.

Initially supported Gateway authentication is token or password mode without
`gateway.roles`. `open()` rejects no-auth, trusted-proxy, and role-configured
Gateways with an `unsupported-auth` error and configuration guidance. Browsers
use signed device identity and ordinary device tokens; they cannot present the
Gateway's configured shared token or password through this surface.

## HTTP and sockets

The returned `GatewayControlUiIngressV1` exposes:

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

A socket accepts text or binary `GatewayIngressMessage` values through
`send()`, exposes received values through the `messages` async iterable, and
reports its final close code and reason through `closed`. `send()` waits for
bounded admission and drain. The host limits request bodies, frame sizes,
concurrent HTTP streams, and sockets; per-plugin quotas do not depend on a
claimed client IP.

Each handle admits 16 HTTP streams, two main sockets, and two auxiliary sockets.
The plugin-wide limits are 32 handles, 64 HTTP streams, eight sockets, and 64 MiB
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

Core treats a live ingress handle like an authenticated trusted-proxy front door.
A fresh browser connects as `operator`, signs the normal device challenge, and
omits credentials. Core auto-approves it as an ordinary paired device and returns
the ordinary device token in `hello`. There is no separate enrollment API,
bootstrap credential, storage format, or audience-bound token.

Ingress-served documents carry `data-openclaw-remote-ingress="true"`. The embedded
UI stays connected to the Gateway serving the document, requests the handle's
scope ceiling, and ignores shared, bootstrap, and native credentials. It stores
the device token from `hello` for later loads. A rejected stored token triggers
one credential-free same-key recovery attempt. The shared-credential login gate,
Gateway URL and secret controls, and service-worker registration are disabled;
connection errors and retry remain available.

Hello advertises the handle's public origin, and board, Canvas, and MCP App
sandbox responses use its sandbox origin. Internal plugin-tab paths remain
relative to the selected Gateway so their read-cookie paths and registered
routes remain unchanged; explicitly external tab URLs retain their destinations.

The approved scopes are the requested scopes within `operatorScopeCeiling`;
omitting scopes grants the full ceiling. The ceiling contains `operator.read`
and optionally `operator.write`. Requests above that ceiling are refused,
including scope upgrades. A returning browser may use its device token, or
recover a lost token by proving the same paired key under the live grant, using
the trusted-proxy same-key rules. An existing device ID with a different public
key is refused, never auto-approved.

These browsers appear in the normal **Devices** list, `openclaw devices list`,
and device pairing RPCs. Use the existing device revoke operation to revoke an
individual device token. Closing the handle or revoking the plugin grant closes
the ingress path and its owned work; it does not delete paired-device rows or
revoke their ordinary device tokens.

The token is deliberately not pinned to the ingress. It also works on the
Gateway's direct listener at its issued read or read/write scopes, without admin
access. If it leaks, those scopes remain usable directly until device revocation.
This is an accepted tradeoff: a compromised relay can already exercise those
capabilities through the plugin grant. Protect the grant and use **Devices** to
revoke individual tokens when needed.

## Security boundary

Core marks every virtual request and connection `remote-forwarded` before
policy runs. Local-client trust, silent local pairing, browser owner recovery,
bootstrap credentials, Tailscale identity, trusted-proxy headers, device-less
access, and non-operator roles are unavailable. The live handle supplies the
remote authentication and approval boundary. Normal device challenge, signature,
token, scope, and revocation checks remain authoritative. The scope ceiling permits only
`operator.read` and optionally `operator.write`; admin, approvals, questions,
pairing, and Talk secrets remain outside this capability.

The HTTP surface permits Control UI documents, assets, configuration and media
resources, declared plugin panels, and a bounded liveness response. It refuses
general APIs, webhooks, `/v1`, standalone MCP, worker and node transfers, and
undeclared plugin routes. Service workers and local browser bootstrap recovery
are blocked. The sandbox surface serves only its dedicated shell and declared
public renderer resources, never Gateway data.

This is a transport capability, not arbitrary HTTP forwarding or a private
network proxy. A relay can read and modify the active content it forwards and
can exercise a compromised browser device's permitted capabilities; the
connection is not end-to-end encrypted against that relay.

The relay owns browser-session routing and hosting; this transport alone is not
a complete remote UI deployment.
