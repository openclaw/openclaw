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
    frameAncestors: ["https://app.example.com"],
    signal,
    assertCurrent,
  });
}
```

The public and sandbox origins must be exact, distinct HTTPS origins without
paths or credentials. WebSocket `origin` is the actual browser Origin and must
equal this handle's `publicOrigin` exactly. The contextual allowance does not
change `gateway.publicOrigin`, global allowed origins, or Host fallback policy.
Publishing a changed Gateway origin policy retires existing handles; open a new
handle under the current policy.
The host validates the entire requested frame ancestor chain, including an
explicit `codex-sandbox:` ancestor when needed, and applies it only to responses
served by this handle.

`audienceId` identifies the plugin-owned grant; it is not an OAuth token or a
browser authentication credential. `assertCurrent` must check that grant's live
authority. The host composes it with service, plugin, and Gateway lifetime
checks, including checks after asynchronous admission and before publication.
The assertion must be synchronous and throw when its grant is stale.

Initially supported Gateway authentication is token or password mode without
`gateway.roles`. `open()` rejects no-auth, trusted-proxy, and role-configured
Gateways with an `unsupported-auth` error and configuration guidance. The
browser still authenticates with its paired device; it cannot present the
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

## Enrollment contract (unavailable)

The handle declares two enrollment operations:

- `issuePairingBootstrap({ deviceId, publicKey, displayName, scopes, signal })`
  validates a canonical raw Ed25519 public key in unpadded base64url, its matching
  device ID, a bounded display name, and the exact requested scopes. Scopes must
  be `operator.read` or `operator.read` plus `operator.write`, within the handle's
  ceiling. Core rejects extra scopes instead of silently widening or stripping them.
- `cancelPairingBootstrap(enrollmentId)` addresses one enrollment. It does not
  mean device or audience revocation.

Both operations currently reject with `GatewayControlUiIngressError` code
`unavailable` for valid requests. They issue no credential, create no pending
pairing request, and do not report successful cancellation. Closed handles and
unsupported configurations retain their lifecycle errors. Method presence alone
does not mean enrollment is usable; keep enrollment disabled on `unavailable`.

The in-memory policy specifies manual owner approval, a maximum five-minute
bootstrap lifetime, one pending enrollment per call site, and three per audience.
Those issuance and quota rules await the durable storage implementation. The
bootstrap owner stops at `requireRemoteControlUiEnrollmentStorage` before any
write. It never falls back to the existing auto-approved `purpose: "control-ui"`
profile or a generic bootstrap token.

Durable device/key/audience/scope binding, trusted owner approval with grant
context and fingerprint, shared-auth issuer generation, cancellation, and
audience revocation require the accepted storage migration and downgrade
contract. No storage or credential representation changes are included here.
The existing transport still accepts ordinary pre-paired devices; it does not
yet enforce durable audience restrictions and is not ready for remote UI deployment.

## Security boundary

Core marks every virtual request and connection `remote-forwarded` before
policy runs. Local-client trust, silent local pairing, browser owner recovery,
Tailscale identity, trusted-proxy identity, device-less access, and non-operator
roles are unavailable. Normal device challenge, signature, token, scope, and
revocation checks remain authoritative. The scope ceiling permits only
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

Audience-bound enrollment and the embedded browser presentation remain
follow-up work; this transport alone is not a complete remote UI deployment.
