---
summary: "Gateway transports: WebSocket, paired-operator HTTP, frame limits, and WebRTC Talk control"
read_when:
  - Choosing the gateway protocol or client package to install
  - Sizing frames, payload limits, or compression behavior
  - Implementing Gateway-controlled WebRTC Talk
  - Connecting an already-paired operator over HTTPS polling
title: "Gateway protocol transport"
sidebarTitle: "Transport and framing"
doc-schema-version: 1
---

What the wire looks like before any method call: the published packages, the frame shapes, the payload limits, and the Gateway-controlled WebRTC Talk contract.

## npm packages

The verified stable package release is `2026.8.1`. Follow
[Install the packages](/gateway/clients#install-the-packages) for exact-version
commands and compatibility guidance. Package release versions are separate from
the wire protocol version and the root `openclaw` CLI release.

- [`@openclaw/gateway-protocol`](https://www.npmjs.com/package/@openclaw/gateway-protocol)
  publishes the schemas, validators, TypeScript types, lightweight frame and error
  helpers, and version constants. Its tarball includes the generated
  [`protocol.schema.json`](https://unpkg.com/@openclaw/gateway-protocol@2026.8.1/protocol.schema.json)
  machine-readable contract as a downloadable file, not an exported import subpath.
- [`@openclaw/gateway-client`](https://www.npmjs.com/package/@openclaw/gateway-client)
  publishes the reference Node client and a browser-safe entry at
  `@openclaw/gateway-client/browser`.

For application lifecycle guidance, see
[Building a Gateway client](https://docs.openclaw.ai/gateway/clients). For apps
that supervise the Gateway as a child process, see
[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding).

## Transport and framing

- WebSocket, text frames, JSON payloads.
- First frame **must** be a `connect` request.
- Pre-connect frames are capped at 64 KiB (`MAX_PREAUTH_PAYLOAD_BYTES`). After
  handshake, follow `hello-ok.policy.maxPayload` and
  `hello-ok.policy.maxBufferedBytes`. With diagnostics enabled, oversized
  inbound frames and slow outbound buffers emit `payload.large` events before
  the gateway closes or drops the frame. These events carry `surface`, byte
  sizes, limits, and a safe reason code, never message bodies, attachment
  contents, raw frame bytes, tokens, cookies, or secrets.
- The Gateway offers `permessage-deflate`. Peers that negotiate it (browsers, `ws`
  clients) receive frames of 4 KiB and up compressed; smaller frames such as
  streaming deltas stay raw. Context takeover is disabled in both directions, so
  each frame compresses independently. Peers that do not offer the extension are
  unaffected. Payload limits apply to the inflated size.

Frame shapes:

- Request: `{type:"req", id, method, params, traceparent?}`
- Response: `{type:"res", id, ok, payload|error}`
- Event: `{type:"event", event, payload, seq?, stateVersion?}`

After authentication, a client may include a W3C `traceparent` string on each
request frame. The Gateway continues a valid value as a child trace context for
that request. Missing or syntactically malformed values within the
128-character field limit keep the default fresh request trace and do not fail
the RPC; longer values make the request frame invalid. The initial `connect`
request never establishes trace context for later frames. Use a separate
`traceparent` for each logical request on a long-lived connection; do not treat
the WebSocket itself as one trace.

Response errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
Authenticated operator requests share a bounded queue for starting RPC handlers.
When waiting capacity is exhausted, the Gateway returns retryable `UNAVAILABLE`
before the method runs; retry within the request's budget. Started requests
complete concurrently, so responses can arrive out of order.

Ordinary UI/SDK requests may outlive a socket disconnect, but cannot start a
handler in a retiring Gateway instance. Shutdown fences new request entry and
joins pending handler loading and authorization before releasing their runtime.
Already-started methods retain their own shutdown behavior; shutdown does not
wait for every RPC to finish. Exact pending node progress and result replies
remain available during node cleanup, until transport shutdown seals entry.

Clients should branch on `code` and `details.code`; `message` remains human-readable
and can change except where a compatibility note says otherwise. Method-level
authorization failures use top-level `code: "FORBIDDEN"` with structured
missing-scope details:

- Missing scope: `{ code: "MISSING_SCOPE", missingScope, requiredScopes }`.
  `requiredScopes` is the complete known scope set for the requested operation.
  The legacy `missing scope: <scope>` message is retained for older clients.

Clients should read `details` first and use the legacy message only as a compatibility
fallback. `readMissingScopeError` and `readMissingScopeErrorDetails` are exported from
`@openclaw/gateway-protocol/gateway-error-details`; the browser-safe gateway client
re-exports them from `@openclaw/gateway-client/browser`.

The schemas are exported as `GatewayErrorDetailsSchema`,
`MissingScopeErrorDetailsSchema` from `@openclaw/gateway-protocol/schema`.
HTTP scope failures mirror the `MISSING_SCOPE` object under `error.details` and
use HTTP status `403`.

Side-effecting methods require idempotency keys (see schema).

## Operator HTTP transport

Already-paired operator clients can carry the same Gateway request, response,
and event frames over HTTPS instead of WebSocket. This is a transport building
block, not a complete standalone Apple Watch or Wear OS setup flow. Initial
pairing, native credential provisioning, and background execution are separate
client responsibilities.

Use `<basePath>/api/operator/connections`, where `basePath` is the configured
Control UI base path, or empty when none is configured. HTTPS is required except
on direct loopback. A trusted HTTPS proxy must forward `X-Forwarded-Proto: https`.
Requests and responses use JSON and `Cache-Control: no-store`; do not follow
redirects with credentials.

### Begin and authenticate

Send `POST` to the base route with `{}`. A `201` response contains:

```json validate=false
{
  "connectionId": "connection-id",
  "connectionKey": "connection-local-key",
  "challenge": { "nonce": "challenge-nonce", "ts": 1788912000000 },
  "handshakeExpiresAtMs": 1788912010000,
  "limits": {
    "maxPreauthPayloadBytes": 65536,
    "maxPayloadBytes": 26214400,
    "maxBufferedBytes": 52428800,
    "maxQueuedFrames": 256,
    "maxBatchFrames": 64,
    "maxPollWaitMs": 25000,
    "idleTimeoutMs": 60000,
    "maxConnections": 256
  }
}
```

Every subsequent request requires
`Authorization: Bearer <connectionKey>`. This random 256-bit key identifies one
in-memory connection; it is not a paired-device credential. Never put it in a
URL, cookie, or log. Begin does not authenticate the device.

Submit a standard signed `connect` frame to
`POST <base>/{connectionId}/frames`, using `challenge.nonce` for the device
signature. The signed POST supplies the actual authentication ingress. Its
envelope starts with `clientSeq: 1` and `ack: 0`:

```json validate=false
{
  "clientSeq": 1,
  "ack": 0,
  "frame": { "type": "req", "id": "connect", "method": "connect", "params": {} }
}
```

Replace `params` with the normal [signed connect parameters](/gateway/protocol/auth).
This transport requires `role: "operator"`, a signed device identity, and only
`auth.deviceToken`. Shared secrets, bootstrap tokens, and ambient proxy or
Tailscale identity cannot replace device-token verification. Connect does not
issue a new credential. Existing profile and session-access policy still applies;
deployments requiring a verified person cannot use a device token as that identity.

Requested and effective scopes are limited to `operator.read`, `operator.write`,
`operator.approvals`, and `operator.talk`. Admin, pairing, questions, and Talk
secret scopes are excluded. Methods use the ordinary Gateway authorization
policy; the transport does not maintain a separate RPC allowlist.

### Send, poll, and acknowledge

- Frame submission returns `202 { "acceptedClientSeq": 1 }`. This confirms
  sequence reservation, not RPC completion. Wait for this receipt before sending
  the next sequence; RPC responses may complete out of order.
- Retry an uncertain submission only on the same logical connection, with the
  same `clientSeq` and frame. The last accepted frame is deduplicated by JSON
  value, independent of object key order and envelope ACK. Gaps, older sequences,
  and conflicting retries return `409`.
- Poll with `POST <base>/{connectionId}/poll` and
  `{ "ack": 0, "waitMs": 25000 }`. Only one poll may be active. `waitMs: 0`
  returns immediately.
- A `200` poll returns `{acceptedClientSeq, frames:[{cursor,frame}]}`.
  Output cursors start at 1 and are unrelated to Gateway event `seq`.
  `hello-ok.server.connId` equals the begin response's `connectionId`.
- ACK is cumulative and monotonic; repeating it is allowed. It cannot exceed a
  cursor whose containing response finished writing. Unacknowledged output may
  replay; acknowledge only after processing it.
- `device.scopes.waitUpgrade` uses the existing external approval flow. Persist
  an approved replacement device token and its scopes **before ACK or reconnect**.
  Ordinary reapproval may rotate that token without closing the current narrow
  connection. Explicit token rotation, revocation, or device removal retires it
  and suppresses queued and replayable authenticated output.
- Cancelling a poll does not cancel an RPC. Server send completion means the
  containing HTTP response finished writing, not that output was enqueued or
  acknowledged. Repeated aborted writes eventually retire the connection.

Connections expire after 60 seconds without accepted transport activity.
The handshake has its own deadline reported by begin. Payload and buffer limits
match WebSocket limits; the queue additionally caps frame count and poll batches.
Begin shares the Gateway's per-client preauth budget, and at most 256 logical
HTTP connections, including retained closed connections, exist per runtime.

### Closure and recovery

`DELETE <base>/{connectionId>` returns `204` and retires the connection.
A poll can return `closed: {code, reason, resyncRequired: true}`. On closure,
overflow, or Gateway restart, create a new connection and resynchronize state.
Do not automatically replay an uncertain write across logical connections.

Transport errors have `{error:{code,message,resyncRequired?}}`. Common statuses
are `400` invalid envelope, `401` missing or invalid connection key, `403`
disallowed ingress or insecure transport, `404` missing/expired connection,
`409` sequence/ACK/poll conflict, `410` frame submission to a closed connection,
`413` payload limit, `408` body timeout, `429` connection capacity, and `503`
Gateway shutdown. RPC errors remain ordinary Gateway response frames.

Ingress is bound to the original client IP, listener attribution, Host, Origin,
and forwarding/scope headers. Network movement or a changed forwarding policy
closes the logical connection, even if the new path would be more trusted.
Reconnect with a fresh signed challenge; there is no network-handoff continuity
or promotion to local authority. Current origin policy is checked again after
awaited work and before dispatch and output.

Authenticated output is discarded on retirement, including hello and upgrade
grants. Only explicitly classified rejected-handshake output may remain briefly
available for terminal delivery. All connection keys, sequence state, and output
queues are in memory and are lost on restart.

## Gateway-controlled WebRTC Talk

`talk.client.create` accepts the additive capability `gateway-control-v1`.
The released browser/Gateway-owned WebRTC route tries OAuth first and falls
back to Platform API-key authentication. Direct backend sockets and unlisted
or private realtime routes require Platform API-key authentication. A
successful result includes
`clientControl: { owner: "gateway" }`, a 60-second single-use Gateway broker
token in `clientSecret`, and the relative
`offerUrl: "/plugins/openai/realtime/calls"`.

The client sends only `application/sdp` to that route with the broker token. It
must not create a provider control data channel. The Gateway creates the call,
attaches the provider sideband before returning the answer SDP, and owns tool,
transcript, steering, cancellation, and close lifecycle. Clients that omit the
capability retain the existing browser session behavior. A Gateway or
configured authentication path that cannot provide the requested owner returns
`UNAVAILABLE`; it never downgrades the request to client-owned control.

Clients must close their local media peer if the Gateway connection is lost or
a `talk.event` for their current `voiceSessionId` contains
`talkEvent.type: "session.closed"`. Ignore terminal events for other calls;
a recoverable `session.error` alone is not a close notification.
