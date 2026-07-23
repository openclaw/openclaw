# HTTP Upstream Trace Context Design

## Summary

Allow OpenClaw Gateway HTTP requests to continue a caller-provided W3C
`traceparent` when the direct TCP peer is configured in
`gateway.trustedProxies`. OpenClaw creates a new request span beneath the
upstream parent and uses that context for the existing diagnostic and
OpenTelemetry flow.

This enables offline experiment runners and other trusted orchestrators to
associate an OpenClaw agent run with an existing Langfuse or OpenTelemetry
trace without changing the Gateway protocol or adding experiment-specific
fields.

## Goals

- Continue valid inbound W3C `traceparent` values on HTTP Gateway requests.
- Reuse the existing `gateway.trustedProxies` trust boundary.
- Preserve current behavior for direct clients, untrusted peers, missing
  headers, and malformed headers.
- Keep the propagated context compatible with the existing diagnostic trace
  context and OpenTelemetry exporter.
- Document the proxy sanitization requirement and the initial scope.

## Non-goals

- WebSocket upgrade or WebSocket message propagation.
- `tracestate` or `baggage` propagation.
- A new Gateway configuration option.
- Langfuse-specific experiment or dataset identifiers.
- Changing outbound provider-header behavior.

## Trust and Security Model

Inbound trace identifiers are accepted only when the direct TCP peer address
(`req.socket.remoteAddress`) matches `gateway.trustedProxies`.
`X-Forwarded-For` and other caller-controlled forwarding headers are not used
for this decision.

A trusted reverse proxy must remove any client-supplied `traceparent` before
injecting its own value. Otherwise an external client could choose trace IDs
that OpenClaw records as trusted upstream context.

When the peer is untrusted, the header is ignored. When the peer is trusted but
the header is malformed, OpenClaw silently creates a fresh trace exactly as it
does today. The request is never rejected because trace propagation is
observability metadata, not an application protocol requirement.

## Request Flow

1. The HTTP server receives a request.
2. It reads the current Gateway configuration snapshot.
3. It checks the socket peer with the existing trusted-proxy matcher.
4. For a trusted peer, it parses the `traceparent` header using the existing
   diagnostic trace parser.
5. For a valid header, OpenClaw creates a child diagnostic context:
   - upstream trace ID is preserved;
   - upstream span ID becomes `parentSpanId`;
   - OpenClaw generates a new request span ID;
   - upstream trace flags are preserved.
6. Otherwise, OpenClaw creates the same fresh diagnostic context used today.
7. The existing HTTP request handler runs inside that context, so logs,
   diagnostic events, provider calls, and OTLP export retain their current
   wiring.

## Implementation Shape

The HTTP server wrapper owns extraction because it has both the raw socket peer
and the request headers before request handling begins. It reuses:

- `isTrustedProxyAddress` for the configured trust boundary;
- `parseDiagnosticTraceparent` for W3C validation;
- `createChildDiagnosticTraceContext` for correct parent/child span semantics;
- `createDiagnosticTraceContext` for the unchanged fallback path.

The change remains local to the HTTP request entry point. WebSocket upgrade and
message handlers continue creating fresh contexts, making the first PR's
transport boundary explicit.

## Compatibility

No configuration schema changes are introduced. Existing installations that
do not configure `gateway.trustedProxies` behave exactly as before. Existing
trusted-proxy installations gain propagation only when a valid `traceparent`
header is present.

The behavior is additive and does not change Gateway request or response
payloads.

## Test Plan

Focused Gateway request-trace tests will cover:

- a valid header from a trusted loopback peer continues the trace and creates a
  new child span;
- a valid header from an untrusted peer is ignored;
- a malformed header from a trusted peer is ignored;
- a request without the header retains fresh-trace behavior;
- trace flags and parent span identity are preserved for the trusted case.

The affected Gateway test file will be benchmarked before and after, as
required by the scoped Gateway contribution guide. Targeted formatting,
changed-surface checks, and the relevant test file will run before the branch
is pushed.

## Documentation

The Gateway OpenTelemetry page will describe inbound HTTP propagation,
configuration through `gateway.trustedProxies`, proxy sanitization, and the
initial exclusion of WebSocket, `tracestate`, and `baggage`.

## Alternatives Considered

### Accept `traceparent` from every HTTP client

This is the simplest integration but treats external caller-controlled trace
identifiers as trusted telemetry. It is unsuitable for an Internet-facing
Gateway.

### Add a dedicated propagation allowlist

This provides separate control but expands an already large configuration
surface. The existing trusted-proxy boundary expresses the same operator intent
and already handles IP and CIDR matching.

### Add experiment identifiers to the Gateway protocol

This would couple OpenClaw to a particular evaluation model and would not
provide standard cross-service trace continuity. W3C propagation keeps
OpenClaw vendor-neutral and lets Langfuse or another backend attach experiment
metadata at the upstream root.

### Include WebSocket propagation in the same change

WebSocket handshakes and individual messages have different lifetime and
parenting semantics. Deferring them keeps the first change small and avoids
implying a context model that has not been designed.
