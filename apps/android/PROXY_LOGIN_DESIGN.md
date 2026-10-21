# Android HTTPS proxy login

Related: https://github.com/openclaw/openclaw/issues/162240

This document describes the Android HTTP Basic ingress contract. Test and device
evidence belongs in the pull request.

## Scope and identity boundary

HTTP Basic authenticates the HTTP request to a reverse proxy before the Gateway
WebSocket handshake. It does not replace Gateway authentication, verified user
identity, operator scopes, or phone pairing.

- Proxy credentials are a separate credential family. They never populate protocol
  `auth.token`, `auth.password`, or `auth.bootstrapToken`.
- Android sends `Authorization: Basic …`, not forward-proxy `Proxy-Authorization`.
- The reverse proxy authenticates Basic and strips its Authorization header before
  forwarding to the Gateway, including WebSocket and protected HTTP requests.
- Verified per-user identity requires separately configured trusted identity
  forwarding. It can identify callers and apply operator roles, but it does not
  turn a shared Gateway into isolated user accounts. Android never manufactures
  identity or forwarded-address headers.
- Proxy acceptance is not Gateway admission. Chat/operator and phone/node retain
  separate authentication, pairing, readiness, and failure states.

Caddy exposes the authenticated Basic username through `{http.auth.user.id}`;
forwarding and trusting that identity remain administrator-owned configuration.
See [Caddy Basic auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth),
[Caddy upstream headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers),
and [Gateway trusted-proxy auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth).
No live proxy or Gateway configuration is changed by this feature.

OpenClaw supports one trust boundary per Gateway: a single operator or a mutually
trusting team. If users must not access one another’s history, tools, credentials,
or files, use separate Gateways with isolated state and appropriate OS-user or
host isolation. Different proxy usernames, verified identity headers, operator
roles, session ownership, and client-side device identities do not establish that
boundary within one shared Gateway. See the
[Gateway trust model](https://docs.openclaw.ai/gateway/security/trust-model#scope-one-trust-boundary-per-gateway).

## Account binding and Forget

A saved proxy record binds one confirmed HTTPS destination to a username. Once
the Gateway has a recorded connection or any stored role token, the username is
locked. The token check covers the interval before the connection timestamp is
persisted. An unreadable record or an unfinished Forget also remains locked.

**Edit** allows same-account password rotation. **Remove** deletes the password
but retains the username binding and Gateway pairing. Neither operation claims
that a protected Gateway will remain reachable without a valid proxy login.
A different username requires **Forget Gateway**, then adding the Gateway again.

Forget retires the proxy password and durably records the pending account binding
before clearing Gateway authentication. The binding is removed only after the
local chat cache and outbox have been purged. Failed cleanup keeps the binding
locked so retrying or re-adding cannot attach another proxy account to leftover
local chat data.

Forget clears Android-local Gateway credentials, role tokens, TLS pins, and cached
chat data. It does **not** replace the phone’s persistent device identity, revoke
Gateway-side device pairing, erase server history, or establish a different
Gateway user. Re-adding with another proxy username can therefore reuse the same
server-side pairing and retrieve any history the Gateway still authorizes.
Server revocation is an administrator action. Changing the proxy username or
device key does not partition history within one Gateway trust boundary. Enforce
access to each isolated Gateway at the proxy on every HTTP and WebSocket route.

## Storage and transport owners

`SecurePrefs` owns the encrypted destination, username, optional password, format
version, and pending-Forget state. Passwords are not duplicated as stored encoded
Authorization headers. Its durable commit result decides whether Save/Remove
succeeded; failed writes retain the old record. Successful mutations advance the
credential revision and retire grants derived from the old record.

`GatewayBasicProxyAuthorization` implements the existing
`GatewayIngressAuthorization` contract. A physical connection and its HTTP
requests retain one immutable grant. Admission checks the current credential
revision, canonical HTTPS authority, effective port, and mount boundary. Encoded
traversal/separator ambiguity, URL user-info, aliases, redirects, and cleartext
downgrades cannot inherit that grant. An existing custom Authorization header
causes a visible conflict rather than replacement or duplicate credentials.

Basic requires Android CA trust and hostname verification on the actual socket.
An existing certificate pin remains an additional check. Pin-only/TOFU behavior
is not sufficient for Basic and is not broadened; non-proxy TLS behavior remains
unchanged. Credential-bearing requests never follow redirects.

`NodeRuntime` owns connection replacement and draining across primary operator,
node, and background operator sessions. An already-admitted Add Gateway operation
remains the owner while updating an existing target’s proxy credentials and
selecting that target. An editor opening cannot reuse a retired admission. Old
media requests cannot borrow a replacement password. When setup also replaces
Gateway authentication, the proxy write must succeed before clearing the old
Gateway credentials, role tokens, cached chats, or composer drafts. A rejected
proxy header or failed proxy commit leaves that existing state intact and
surfaces an actionable onboarding error.

Source icons use the existing `controlUi.linkPreview` RPC on the captured,
authenticated operator WebSocket and consume only its bounded `faviconDataUrl`.
This avoids a second HTTP request whose Basic header would be stripped before
Gateway authentication. The old favicon-specific HTTP/Bearer retry path is removed;
other media requests retain their existing capability-ticket contract.

This is the Gateway’s page-preview contract, not a byte-for-byte substitution for
`/favicon.ico`: it may fetch the public root HTML and preview image, prefer a
declared icon, and follow guarded public HTTP(S) redirects. The Gateway owns those
anonymous, bounded, cached fetches and the `automaticallyFetchFavicons` preference.
Android accepts only bounded PNG/ICO data URLs, never a returned remote image URL.
The captured connection is checked before enqueue and again after completion. A
missing RPC, rejected request, or unusable result retains the generic source icon.

## Setup and recovery

One shared proxy selection and credential form serves manual setup, QR/setup-code
review, and saved-Gateway editing. **None** remains the default. The destination
is confirmed before credential-bearing I/O. QR/setup-code authentication and expiry
remain separate from the proxy draft; proxy passwords are not embedded in codes.
Expired scanned codes use the scan-error dialog so scanning can restart.

Credential drafts stay in composition memory, never saved-state Bundles or
navigation arguments. Saved passwords are not read back into the form. Cancel
discards the draft. Recovery after UI recreation must either recover the
non-secret destination from its existing owner or return to a usable setup step;
it must not route to a Settings screen hidden by unfinished onboarding.

A parsed HTTP 401 Basic challenge requests proxy login. TLS, redirects, other HTTP
rejections, Gateway identity/role failures, setup expiry, and pairing waits remain
distinct. Responses, headers, peer close reasons, and exception details must not
leak credentials into status or diagnostics.

Proxy-enabled network recovery permits one initial attempt plus at most two
retries. Terminal proxy/TLS/auth failures remain paused across foreground and
network wakes; explicit Retry or a credential edit owns resumption. Phone pairing
waits have a two-minute visible budget. Existing non-proxy retry behavior and the
[two-role bootstrap handoff](GATEWAY_AUTH_POLICY.md) remain unchanged.

Named-role operator admission requires verified user identity in addition to
node pairing. `AUTH_VERIFIED_USER_REQUIRED` offers a fresh setup-code entry,
explaining `openclaw qr --url` for the authenticated proxy's `wss://` address.
It does not rewrite a LAN code's destination, transfer credentials, reset saved
pairing, disable roles, or treat node connectivity as operator readiness.
Diagnostics show node and chat/operator connectivity separately. The proxy must
supply its validated identity on WebSocket upgrades; browser-only SSO has no
native sign-in mechanism in this Basic-only feature.

This is HTTP Basic support, not OAuth/OIDC/SSO or HTTP forward-proxy authentication.
Existing setup-code formats are supported; HTTPS join-link exchange and automatic
alternate-endpoint selection are separate capabilities.

## Validation boundaries

Focused regression coverage belongs at the real owning entry points:

- Add Gateway against an existing destination: credential persistence, preserved
  role tokens/pin, target selection, socket draining, and retired media access.
- Onboarding recovery after UI recreation: a usable proxy-entry path without
  persisting credentials or resetting Gateway authentication.
- HTTP resource reads through both proxy and Gateway authentication layers.
- Durable storage failures, token-before-timestamp binding, and partial Forget.
- Correct/incorrect proxy login, destination isolation, redirect refusal, system
  trust/hostname/pin failures, and unchanged non-proxy behavior.

Unit and Compose fixtures do not establish deployed identity forwarding or
server-history isolation. Real Caddy/Gateway/Android proof must identify the built
revision and distinguish ingress acceptance, verified identity, operator access,
node pairing, upgrade preservation, and server-side revocation. A deployment
claiming user isolation additionally needs separate-Gateway proof: user B must
not reach user A’s Gateway, reuse its credentials, or recover its history after
Forget/re-add. Do not use an ingress-only A-to-B username change on one Gateway
as an isolation test. Keep untested cases explicit rather than treating a
successful login as proof of the whole chain.
