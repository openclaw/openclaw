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

Integrate this routing into your existing HTTPS site. Keep your existing Basic
usernames and bcrypt hashes, TLS setup, and Gateway origin policy. The example
uses `127.0.0.1:18789` for the Gateway; replace it with your actual private
upstream. Configure `gateway.auth.trustedProxy.userHeader` as `x-forwarded-user`.
For a loopback upstream, retain the explicit loopback trust opt-in.

```caddy
control.example.com {
    route {
        @verification path /plugins/shellgate/verify*
        respond @verification 404

        request_header -X-Forwarded-*
        request_header -Forwarded
        request_header -X-Real-IP
        request_header -X-Shellgate-*
        request_header -X-OpenClaw-Scopes
        request_header -X-Occ-*
        request_header -Remote-User
        request_header -X-Remote-User
        request_header -X-Auth-Request-*
        request_header -Cf-Access-*
        request_header -Tailscale-*

        @bearer header_regexp Authorization (?i)^Bearer(?:[[:space:]]|$)
        handle @bearer {
            route {
                forward_auth 127.0.0.1:18789 {
                    uri /plugins/shellgate/verify?
                    copy_headers X-Shellgate-User>X-Forwarded-User
                    header_up X-Forwarded-For {client_ip}
                    header_up -Connection
                    header_up -Upgrade
                }
                @missingSubject not header X-Forwarded-User *
                respond @missingSubject 503
            }
        }
        handle {
            route {
                basic_auth {
                    {$SHELLGATE_BASIC_USER} {$SHELLGATE_BASIC_HASH}
                }
                request_header X-Forwarded-User {http.auth.user.id}
            }
        }

        reverse_proxy 127.0.0.1:18789 {
            header_up -Authorization
            header_up X-Forwarded-For {client_ip}
        }
    }
}
```

The two Basic placeholders stand for an existing account and its password hash;
preserve all accounts you intend to keep. Keep the `route` blocks: their order
ensures Bearer failures cannot fall through to Basic auth. The verifier receives
a plain GET with a query-free request URL and no body or WebSocket upgrade headers.
Caddy still supplies the original URI in `X-Forwarded-Uri`; Shellgate does not
read or log it. Removing `Connection` and `Upgrade` from the verification subrequest is required:
the authentication check must not itself open a Gateway WebSocket. The final
proxy preserves the original request body and supports WebSocket upgrades.
Consumed proxy credentials are not forwarded to the Gateway.

For a separate EDGE before Caddy, configure Caddy's `trusted_proxies` with only
that EDGE's exact addresses, enable `trusted_proxies_strict`, and use its
`client_ip_headers X-Forwarded-For` support. `{client_ip}` is calculated before
the request headers are stripped. Without that trust configuration, it names
the immediate peer instead. Never fabricate a non-loopback client address to
make Gateway admission pass. A same-host browser whose actual client address is
loopback needs a topology supported by the Gateway's attribution rules.

The example regenerates forwarded host/proto from Caddy's connection. If EDGE
terminates TLS and connects to Caddy over HTTP, retain your existing safe,
canonical external host/proto handling rather than copying this block unchanged.
If you configured another identity header or identity-enrichment headers, strip
those client claims too; do not mix this local-account route with an external
provider's verified identity assertions.

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
