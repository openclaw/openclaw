---
summary: "Add per-account proxy Bearer credentials alongside Caddy Basic auth without an external identity provider"
read_when:
  - You want separate human or service identities behind a trusted reverse proxy
  - You already use Caddy Basic auth and need per-account Bearer tokens
title: "Shellgate"
---

Shellgate is an optional plugin that verifies per-account Bearer tokens for a
reverse proxy. Keep Caddy's existing Basic-auth accounts for browser users; add
tokens for clients that can send an HTTP `Authorization: Bearer …` header.
Both paths forward a stable subject to OpenClaw's existing
[trusted-proxy authentication](/gateway/trusted-proxy-auth). No external identity
provider is required.

Shellgate owns credential verifiers and subject bindings only. OpenClaw owns
profiles, display names, verified external identities, roles, and session access.
It does not add a login page, password database, proxy server, or Gateway auth mode.
A locally authenticated subject is not proof of an email address or GitHub account.

## Before enabling

- Keep the Gateway reachable only through your trusted proxy and private
  administrative path. Use HTTPS for clients.
- Configure [named operator roles](/gateway/operator-scopes#named-operator-roles),
  including `gateway.roles.default`, with a suitably limited default. A role is
  a permission ceiling, not a scope grant; existing device grants and
  `gateway.auth.identityScopes` still govern WebSocket connections.
- Keep a working private administrator connection while configuring roles.
  Sign in once to create a person's profile, then assign its configured role
  using `users.setRole`. Do not change an existing proxy subject to rename a person.
- Review the [same-host proxy warning](/gateway/trusted-proxy-auth#configuration):
  `allowLoopback` also trusts other local processes that can reach the Gateway.
  This is one trusted team boundary, not isolation between hostile tenants.

<Warning>
`identityScopes` and device auto-approval are not HTTP permission ceilings.
Trusted-proxy HTTP APIs can accept `X-OpenClaw-Scopes`; some use broad defaults
when it is absent. Strip client scope claims at the proxy **and** configure
Gateway named-role ceilings. Header removal alone is not least privilege.
</Warning>

## Enable and manage credentials

```bash
openclaw plugins enable shellgate
openclaw shellgate issue alice@example.test
openclaw shellgate issue local:build-service
openclaw shellgate list
openclaw shellgate rotate <credential-id>
openclaw shellgate revoke <credential-id>
```

The CLI uses the running Gateway's authenticated administration connection and
requires `operator.admin`. The usual Gateway client options, such as `--port`
and `--url`, select that connection. A Shellgate token is **not** a value for
the CLI's `--token`, `gateway.auth.token`, or the WebSocket connect payload.
It authenticates to the reverse proxy before the Gateway protocol starts.
Do not configure a shared Gateway token alongside trusted-proxy mode.

`issue` and `rotate` print JSON containing the new secret once. Save it directly
to your private credential manager; do not paste it into chat, logs, a URL, or a
repository. `list` returns credential IDs, subjects, and creation/rotation times,
never tokens or verifiers. The corresponding administrator-only Gateway methods
are `shellgate.credentials.issue` (`{ subject }`), `.list` (`{}`), `.rotate`
(`{ id }`), and `.revoke` (`{ id }`).

Subjects are 1–256 printable ASCII characters without spaces and must be
lowercase, matching the Gateway's generic proxy alias normalization. Reuse an
existing Basic username to give that same profile another sign-in credential.
Use a distinct stable subject for a separate service profile. Do not recycle a
subject for a different person or workload. The Gateway still applies its
`allowUsers` list; issuing a credential does not edit that list or grant a role.

Tokens contain 256 random secret bits. Only their SHA-256 verifiers and subject
bindings are stored in the plugin's existing shared-state namespace. The limit
is 1,000 active credentials, with no silent eviction or automatic expiry. Rotate
or revoke them explicitly. Existing state backup and access controls apply.
No core database schema or separate person table is added.

If a write loses its response, do not assume it failed and repeat it blindly.
List credentials, then rotate or revoke the affected ID. A lost token cannot
be recovered from storage. Rotation uses an atomic comparison so a concurrent
revoke cannot resurrect the credential.

## Caddy integration

Print the maintained drop-in once. This command needs no Gateway connection and
writes only to stdout; it does not inspect or change your Caddy configuration:

```bash
openclaw shellgate caddy > shellgate.caddy
```

Add two imports and keep your existing Basic-auth account block. Place the
second import **before Basic auth inside an ordered `route`**:

```caddy
import shellgate.caddy

control.example.com {
    route {
        import shellgate 127.0.0.1:18789 X-Forwarded-User

        # Keep your existing Basic usernames and password hashes here.
        basic_auth {
            {$SHELLGATE_BASIC_USER} {$SHELLGATE_BASIC_HASH}
        }
        reverse_proxy 127.0.0.1:18789 {
            header_up X-Forwarded-User {http.auth.user.id}
            header_up -Authorization
        }
    }
}
```

The snippet arguments are the private Gateway upstream and your configured
`gateway.auth.trustedProxy.userHeader`. Change both occurrences of the upstream
and identity header in this example to match your existing setup. For a
loopback upstream, retain the explicit loopback trust opt-in. Preserve TLS,
origin policy, all Basic accounts, and any separate node route. For a Bearer-only
site, keep the two imports and ordered `route`, then use `respond 401` after the
snippet import instead of the Basic-auth and final reverse-proxy blocks.

The drop-in handles Bearer requests completely and leaves other requests to
existing Basic auth. An invalid Bearer never falls back to Basic. It hides the
verification endpoint, overwrites identity, strips client scope/provider claims,
and removes the consumed Bearer credential before proxying. The existing Basic
upstream should likewise remove `Authorization` after authenticating, as above.

Verification uses a plain GET with a query-free URL, no body, and no WebSocket
upgrade headers. Only the final proxy upgrades WebSockets. Caddy still supplies
the original URI in `X-Forwarded-Uri`; Shellgate does not read or log it. The
original method/body remain intact on the final upstream request.

For a separate EDGE before Caddy, configure Caddy's `trusted_proxies` with only
that EDGE's exact addresses, enable `trusted_proxies_strict`, and use
`client_ip_headers X-Forwarded-For`. The drop-in uses `{client_ip}`, calculated
before stripping request headers. Without that trust, it names the immediate
peer. Never fabricate a non-loopback client address to make admission pass.

The drop-in is for local-account ingress, not an external identity provider's
verified assertions. Strip any other custom identity/enrichment headers used by
your Gateway. It regenerates host/proto from Caddy's connection: if EDGE
terminates TLS and talks HTTP to Caddy, preserve your safe canonical external
host/proto settings in the generated forwarding blocks. Validate with
`caddy validate --config Caddyfile` before reloading. Regenerate and review the
drop-in after an OpenClaw update; no proxy configuration is rewritten for you.

## Verification and revocation

Shellgate's private `GET /plugins/shellgate/verify` endpoint returns:

- **204** plus `X-Shellgate-User` for a valid credential. No operator scopes are
  returned. The Gateway independently authenticates the proxy and applies roles.
- **401** for absent, malformed, unknown, or revoked credentials.
- **405** for other methods.
- **503** if credential storage or its runtime is unavailable.

The public site must deny the verification path before its authentication routes.
A stopped or disabled plugin cannot successfully verify a token. Caddy propagates
verification failures; an unreachable upstream can produce **502**, not a login
fallback. Validate the Caddy configuration before reloading your proxy.

Check both HTTP and WebSocket clients with a limited subject and an administrator.
Confirm distinct profiles, denied administrator operations for the limited
subject, ignored client identity/scope claims, and rejected revoked credentials.
Native and custom WebSocket clients still need normal device identity/pairing;
a proxy token does not replace that handshake.

Revocation blocks **new proxy authentication**. It does not close an already
upgraded WebSocket, cancel accepted work, revoke paired devices, or remove a
profile. Use existing Gateway device/role revocation controls when those effects
are required. Keep any separate node route outside this browser-login recipe;
verify its device/bootstrap authentication and TLS independently.
