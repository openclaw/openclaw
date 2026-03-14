---
summary: "Deep dive into the Gateway's proxy-aware origin validation and double lock security model"
title: "Proxy-Aware Origin Validation and Double Lock Security"
read_when:
  - Deploying the Gateway behind a reverse proxy (Tailscale Serve, nginx, Cloudflare)
  - Configuring trusted proxy authentication
  - Understanding Gateway security defenses
---

# Proxy-Aware Origin Validation and Double Lock Security Model

The OpenClaw Gateway implements a sophisticated multi-layer security model for validating WebSocket connections when deployed behind reverse proxies such as Tailscale Serve, nginx, ngrok, or Cloudflare Tunnel. This model, referred to internally as the "double lock" design, provides defense-in-depth against common attack vectors including spoofed headers, protocol downgrade attacks, and cross-site request forgery (CSRF). The implementation lives primarily in `src/gateway/origin-check.ts`, with supporting logic in `src/gateway/net.ts` and `src/gateway/forwarded-headers.ts`.

## Understanding the Problem Space

When a Gateway sits directly on loopback or a local network, the origin of incoming WebSocket connections is straightforward to validate—the client connects directly, and the remote address and headers are trustworthy. However, when the Gateway is exposed through a reverse proxy, the picture changes significantly. The proxy terminates the TLS connection, rewrites headers, and forwards the request to the Gateway. This creates a fundamental trust challenge: how does the Gateway know whether the `X-Forwarded-*` headers it receives were set by a legitimate proxy, or were injected by an attacker trying to bypass security controls?

Traditional origin validation alone is insufficient in this scenario. An attacker could potentially spoof the `Origin` header to match an allowlisted value, or inject fake `X-Forwarded-Host` headers to trick the Gateway into thinking the request came from a trusted domain. The double lock model addresses these risks by requiring multiple independent validation checks to succeed before a connection is accepted.

## The Seven Layers of Defense

The origin validation system implements seven distinct security layers, each addressing a specific attack vector. These layers are evaluated in sequence, and the request fails closed at the first layer that rejects it.

### Layer 1: Missing or Invalid Origin Rejection

The first and most basic check validates that the browser's `Origin` header is present and well-formed. Requests with missing, malformed, or literal "null" origins are rejected immediately. This prevents attacks that rely on sending no origin at all, which is a common probe technique. The check appears at lines 69-71 of `origin-check.ts`:

```typescript
const parsedOrigin = parseOrigin(params.origin);
if (!parsedOrigin) {
  return { ok: false, reason: "origin missing or invalid" };
}
```

### Layer 2: Untrusted Proxy Rejection

When `X-Forwarded-Host` or other forwarded headers are present, the system verifies that the connecting client is from an explicitly configured trusted proxy IP. If forwarded headers exist but the proxy is not in the trusted proxies list, the request is rejected outright. This prevents attackers from injecting spoofed forwarding headers to bypass origin checks. The implementation is at lines 80-84:

```typescript
// Security: If forwarded-host is present but proxy is NOT trusted, reject outright.
// This prevents attackers from bypassing checks by spoofing X-Forwarded-Host.
if (requestForwardedHost && params.isTrustedProxy !== true) {
  return { ok: false, reason: "origin not allowed" };
}
```

This layer is critical because it establishes the foundational trust boundary. Without it, an attacker could simply claim to be behind a trusted proxy by adding fake headers to their request.

### Layer 3: Protocol Mismatch Detection

When behind a trusted proxy, the system validates that the protocol (http versus https) in the browser's `Origin` header matches the protocol reported in the forwarded headers. This prevents SSL stripping attacks where an attacker might try to downgrade a secure connection to insecure http. The check is at lines 86-98 and calls into `validateProtoMismatch` from `forwarded-headers.ts`:

```typescript
// Security: When behind a trusted proxy, validate protocol BEFORE allowlist check.
// Even allowlisted origins must have matching protocol to prevent SSL stripping attacks.
if (params.isTrustedProxy === true && params.strictProtoValidation !== false) {
  const forwardedProto = extractProtoFromForwardedHeader(params.forwardedHeader);
  const protoValidation = validateProtoMismatch({
    originProto: parsedOrigin.protocol,
    forwardedProto,
    xForwardedProto: params.requestForwardedProto,
  });
  if (!protoValidation.ok) {
    return protoValidation;
  }
}
```

This validation checks both the standard `Forwarded` header (RFC 7239) and the more common `X-Forwarded-Proto` header, ensuring compatibility with different proxy implementations.

### Layer 4: Allowlist Matching

After validating protocol integrity, the system checks the parsed origin against an explicit allowlist. This is the primary authorization mechanism. The allowlist can include specific origins like `https://control.example.com` or a wildcard `*` that matches any origin. The matching is case-insensitive and handles whitespace normalization:

```typescript
const wildcardMatched = allowlist.has("*");
if (wildcardMatched || allowlist.has(parsedOrigin.origin)) {
  return { ok: true, matchedBy: "allowlist", wildcardMatched };
}
```

### Layer 5: Origin-ForwardedHost Cross-Validation

When operating behind a trusted proxy, the system performs an additional cross-validation: the host in the browser's `Origin` header must match the host in the `X-Forwarded-Host` header. This prevents an attacker from using a legitimate allowlisted origin but spoofing the forwarded host to point to a different internal service. The check is at lines 105-108:

```typescript
if (params.isTrustedProxy === true) {
  if (requestForwardedHost && parsedOrigin.host !== requestForwardedHost) {
    return { ok: false, reason: "origin does not match forwarded host" };
  }
  // ...
}
```

This is the first part of the "double lock"—both the allowlist check and the cross-validation must work together. If an attacker manages to get a valid origin past the allowlist but can't control the forwarded host, the request still fails.

### Layer 6: Host Header Fallback

For deployments where explicit origin allowlisting is impractical (such as certain CDN or load balancer configurations), the system supports a host header fallback mode. When enabled via `allowHostHeaderOriginFallback`, the Gateway will accept the connection if the origin's host matches the request's `Host` header. This is intentionally more permissive and should only be used as a break-glass option:

```typescript
if (params.allowHostHeaderOriginFallback === true && parsedOrigin.host === directRequestHost) {
  return { ok: true, matchedBy: "host-header-fallback", wildcardMatched: false };
}
```

### Layer 7: Local Loopback Exemption

The final layer allows local clients connecting from loopback addresses to bypass strict origin checking. This is essential for development workflows and local tool integrations where the browser origin might not exactly match the Gateway's bound address. The check verifies that the origin's hostname is a recognized loopback address:

```typescript
if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
  return { ok: true, matchedBy: "local-loopback", wildcardMatched: false };
}
```

## The Double Lock Explained

The term "double lock" refers to the two independent validation gates that must both succeed for proxy-based connections. The first lock is the allowlist check (Layer 4), and the second lock is the cross-validation between the browser's Origin and the proxy's forwarded host (Layer 5). Even if an attacker manages to get a valid origin onto the allowlist, they cannot proceed without also controlling the forwarded host value—and conversely, having control of the forwarded host is useless without a matching allowlisted origin.

This design provides protection against several specific attack scenarios:

**Spoofed X-Forwarded-Host Attack**: An attacker sends a request with `Origin: https://gateway.example.com` and `X-Forwarded-Host: gateway.example.com`, hoping to bypass controls by appearing to come from a trusted domain. Without the double lock, this might succeed. With the double lock, the request fails at Layer 2 if the attacker isn't coming from a trusted proxy, or fails at Layer 5 if the origin-forwarded host cross-check fails.

**Protocol Downgrade Attack**: An attacker attempts to downgrade a secure HTTPS connection to HTTP by manipulating the `X-Forwarded-Proto` header. Layer 3 catches this by verifying that the protocol in the browser's Origin matches what the proxy reports.

**Allowlist + Fallback Bypass**: An attacker tries to exploit the host header fallback (Layer 6) by sending a request that matches the Host header but has a malicious origin. The double lock ensures that even if the fallback is enabled, the origin must still be validated against the forwarded host.

## Client IP Resolution and Fail-Closed Behavior

Complementing the origin validation is the client IP resolution logic in `src/gateway/net.ts`. The `resolveClientIp` function implements fail-closed behavior: when traffic arrives from a trusted proxy but the forwarded client IP headers are missing or invalid, the system returns `undefined` rather than falling back to the proxy's own IP address. This prevents accidental trust of unrelated requests:

```typescript
// Fail closed when traffic comes from a trusted proxy but client-origin headers
// are missing or invalid. Falling back to the proxy's own IP can accidentally
// treat unrelated requests as local/trusted.
const forwardedIp = resolveForwardedClientIp({
  forwardedFor: params.forwardedFor,
  trustedProxies: params.trustedProxies,
});
if (forwardedIp) {
  return forwardedIp;
}
if (params.allowRealIpFallback) {
  return parseRealIp(params.realIp);
}
return undefined;
```

This design choice ensures that misconfigured proxies or attacks that strip forwarding headers result in denied access rather than silently falling back to an insecure default.

## Configuration and Deployment

Proper deployment requires careful configuration of both the trusted proxies list and the origin allowlist. For Tailscale Serve deployments, the typical configuration includes the Tailscale proxy addresses in the trusted proxies list and the Gateway's Tailscale hostname in the allowed origins:

```json5
{
  gateway: {
    trustedProxies: [
      "100.100.100.100", // Tailscale node IP
      "127.0.0.1", // Local proxy if applicable
    ],
    controlUi: {
      allowedOrigins: ["https://gateway.tailnet.ts.net"],
    },
  },
}
```

For nginx or other reverse proxy deployments, the configuration would include the proxy's upstream IP addresses and the public-facing hostname:

```json5
{
  gateway: {
    trustedProxies: [
      "10.0.0.1", // nginx upstream
      "10.0.0.2", // nginx upstream backup
    ],
    controlUi: {
      allowedOrigins: ["https://gateway.example.com"],
    },
  },
}
```

The system also handles edge cases such as explicit ports in forwarded hosts (common with nginx configurations using `$host:$server_port`), non-standard ports, and IPv6 addresses. Tests in `origin-check.test.ts` verify these scenarios work correctly, including regression tests for allowlist priority when forwarded hosts are present.

## Security Audit Integration

The security audit system (`openclaw security audit`) includes checks related to this model. Key findings include:

- `gateway.control_ui.allowed_origins_required`: Warns when non-loopback Control UI access is allowed without explicit origin allowlisting
- `gateway.control_ui.host_header_origin_fallback`: Warns when the host header fallback is enabled, as it weakens the double lock
- `gateway.trusted_proxy_no_proxies`: Warns when trusted proxy mode is configured but no proxy IPs are specified

Operators can run the audit to identify misconfigurations that might weaken the origin validation model:

```bash
openclaw security audit --deep
```

## Summary

The proxy-aware origin validation with double lock model provides robust protection for Gateway deployments behind reverse proxies. By requiring both allowlist matching and cross-validation between the browser origin and forwarded host, combined with protocol validation and fail-closed client IP resolution, the system defends against a range of attacks including spoofed headers, protocol downgrades, and CSRF. The seven-layer defense-in-depth approach ensures that even if one layer is bypassed, subsequent layers provide additional protection. Operators should ensure their trusted proxies are correctly configured and avoid enabling the host header fallback unless absolutely necessary, as it weakens the double lock security model.
