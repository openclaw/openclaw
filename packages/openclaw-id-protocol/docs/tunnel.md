# Tunnel protocol `openclaw/tunnel/1` (v1-draft, OCF-189)

**Status: v1-draft.** Successor of the spike's `openclaw/tunnel/0` (TUNNEL.md), with the
coordinator decisions of 2026-10-30 folded in. Code: `src/tunnel/` (constants, HEAD shapes,
framing codecs, ingress header rules). The transports themselves (iroh endpoint, tunnel
child, Service Worker client) live with their owners.

## Roles

- **Client**: the browser Service Worker (Rust/WASM iroh, relay-only) or a native app.
- **Server**: the claw's **tunnel child**, a Gateway-supervised child process that owns the
  iroh endpoint key K_srv and proxies to the Gateway over a trusted local hop.
- The client dials **only** `binding.k_srv` from a ServerBinding it verified against its pin
  (statements.md, "Pins and rollback"). The relay URL in the descriptor is an untrusted
  hint. There is no fallback to a direct WebSocket.

## Connection

- ALPN `openclaw/tunnel/1` (UTF-8). A breaking wire change bumps the number.
- Endpoint config on both sides: iroh Minimal preset, a relay map with only our relay, no
  pkarr, no n0 DNS, no n0 relays. Browsers are relay-only.
- Endpoint ids are lowercase hex everywhere (`iroh:<64 hex>` in statements and APIs).
- **Admission**: after the handshake the server checks `conn.remoteId()` (the authenticated
  peer key W) against the Gateway's membership state (read locally, no Discovery policy, no
  TTL). Not admitted -> close with `not_a_member` **before accepting any stream**. Gateway
  unreachable -> admit nobody.
- **Revocation**: the server closes every live connection of the key with `revoked`.
- The client waits `ADMISSION_WAIT_MS` (500 ms) after the handshake for a `not_a_member`
  close before it reports "connected" (iroh's `connect()` resolves before the server can
  refuse).

### Connection close codes (QUIC application close)

| Code | Name           | Sent by | Meaning                                                  |
| ---- | -------------- | ------- | -------------------------------------------------------- |
| 0    | `shutdown`     | server  | normal close / server shutting down; reconnect allowed   |
| 1    | `not_a_member` | server  | peer key not admitted (reason `not a member`)            |
| 2    | `revoked`      | server  | key or member revoked while connected (reason `revoked`) |
| 10   | `claw_lost`    | client  | the liveness watchdog gave up on a silent connection     |

Clients match **codes, never reason text**.

## Streams

One QUIC **bidirectional stream per HTTP request or per WebSocket**. The client opens
streams; the server never does.

- At most **64 concurrent streams** per connection (QUIC stream credit). A 65th stream is
  **queued** by flow control, never reset.
- The server resets a stream that sends no HEAD within 10 s (`bad_request`).
- HTTP streams have a 120 s idle timeout. WebSocket streams have none while keep-alives flow.

### Framing

Frame = 4-byte big-endian payload length + payload. **Max frame 32 MiB** (one Control UI
WebSocket message with an inlined ~5 MB attachment is ~6.7 MB). HTTP bodies stream in DATA
frames of **at most 1 MiB**. HEAD frames are at most 64 KiB of UTF-8 JSON. A declared length
above the limit is a protocol error: reset with `bad_request` without buffering.

### Client -> server

1. HEAD frame (JSON), one of:
   - `{"kind":"http","method":"GET","path":"/...","headers":[["name","value"],...]}`
   - `{"kind":"ws","path":"/...","headers":[...],"protocols":["..."]}`
2. HTTP: zero or more DATA frames with the raw body, then FIN.
   WS: message frames until a close (below).

### Server -> client

1. HEAD frame: `{"status":200,"headers":[...]}`; for an accepted WebSocket
   `{"status":101,"protocol":"..."|null}`; a refused upgrade is a normal HTTP status + headers.
2. HTTP: DATA frames with the response body as the Gateway streams it (no full buffering;
   backpressure by awaiting stream writes), then FIN.
3. Errors: reset the stream with a stream reset code.

### WebSocket messages

Each message is one frame: first byte = opcode (`1` text, `2` binary, `8` close), rest =
data. A close payload is a 2-byte big-endian close code then a UTF-8 reason (or empty). Either
side sends a close, then FIN. No fragmentation.

### Stream reset codes

| Code | Name                  | Meaning                                                             |
| ---- | --------------------- | ------------------------------------------------------------------- |
| 3    | `gateway_unreachable` | the tunnel child could not reach the Gateway                        |
| 4    | `bad_request`         | malformed or oversized HEAD/frame, HEAD timeout, protocol violation |

## Keep-alive and liveness (client)

| Constant                       | Value                  |
| ------------------------------ | ---------------------- |
| QUIC keep-alive                | 1 s                    |
| Silence that starts a probe    | 3 s                    |
| Probe handshake deadline       | 5 s                    |
| Wait between unanswered probes | 5 s                    |
| Relay-denial backoff           | 10 s doubling to 120 s |

A probe is a fresh connection to the same K_srv over the endpoint's existing relay
connection; it is admitted or refused like any other connection. Open: 1 s vs 2 s keep-alive
(spike backlog item 14) - measure 2 s before changing.

## Ingress (tunnel child -> Gateway)

The tunnel child proxies each stream to the Gateway over the trusted local hop (a per-boot
proxy token passed over the supervisor IPC channel, or a Unix socket; the Gateway ingress
contract decides). Data stays on HTTP/WS; IPC is control only.

Client-supplied headers that are **always stripped**: hop-by-hop headers and `Host`; names
listed in `Connection`; `Forwarded`; every `X-Forwarded-*`, `X-OpenClaw-Id-*` and
`X-Tcid-*`; the identity headers `X-Forwarded-User`, `X-Forwarded-Email`,
`X-Forwarded-Groups`, `X-Forwarded-Preferred-Username`, `X-OpenClaw-Scopes`, `Remote-User`,
`X-Remote-User`; for WebSockets the `Sec-WebSocket-*` handshake headers. `Origin` is preserved.

Headers the child **sets** (proposal; final names belong to the Gateway ingress contract):

| Header                      | Value                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `X-OpenClaw-Id-Peer-Key`    | the authenticated peer key W (`iroh:<hex>`) from the QUIC handshake                    |
| `X-OpenClaw-Id-Proxy-Token` | per-boot token proving the request came through the supervised child                   |
| `X-Forwarded-For`           | synthetic per-device address: `fd69:726f:6800::/48` + first 80 bits of SHA-256(hex id) |
| `X-Forwarded-Proto`         | `https` when the loader origin is HTTPS (configured), else `http`                      |
| `X-Forwarded-Host`          | the client's `Host`                                                                    |

The child sends **only the peer key**, not a user or scopes: the Gateway is the membership
authority and maps W to a member, owner device and role itself. Device tokens are bound to W
at the Gateway (spec section 5, step 6), so a token presented with another W is refused and
logged. Relayed traffic must never count as direct loopback (no root ceremonies over the
tunnel, spec section 4).

## Changes from `openclaw/tunnel/0`

- ALPN `openclaw/tunnel/1`.
- The descriptor no longer carries `endpointId`: the client dials the K_srv of the verified
  ServerBinding (discovery.md, ClawDescriptor).
- Admission reads the Gateway's membership, not a Discovery-signed policy.
- The ingress passes the peer key instead of injecting `X-Forwarded-User` / scopes /
  `X-Tcid-*`; `X-Tcid-*` is now only stripped.
- Close code 10 (`claw_lost`, client watchdog) is documented.
