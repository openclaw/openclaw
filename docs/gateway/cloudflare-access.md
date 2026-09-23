---
summary: "Publish a loopback Gateway through a Cloudflare Tunnel and authenticate every client with Cloudflare Access"
read_when:
  - You want a public HTTPS Gateway URL without opening a port
  - You want Cloudflare Access (SSO) to authenticate the Control UI
  - Your CLI, TUI, or nodes get HTTP 302 from a Cloudflare-fronted Gateway
title: "Cloudflare Tunnel and Access"
---

Run the Gateway on loopback, publish it through a Cloudflare Tunnel, and let Cloudflare
Access authenticate every request before it reaches OpenClaw. The Gateway keeps
`gateway.bind: "loopback"`, so no port is exposed and no inbound firewall rule is
needed; `cloudflared` dials out from the host.

This is one supported remote-access topology alongside [Tailscale](/gateway/tailscale)
and an [SSH tunnel](/gateway/remote). Choose it when you want a
stable public HTTPS URL and identity-provider SSO in front of the Control UI.

## Before you begin

- A Cloudflare account with the zone for your hostname, and Cloudflare Zero Trust enabled.
- `cloudflared` installed on the Gateway host, and on any machine that will use the CLI.
- A running Gateway on `127.0.0.1:18789` with `gateway.bind: "loopback"`.
- Familiarity with [trusted-proxy auth](/gateway/trusted-proxy-auth), which this topology uses.

## How the pieces fit

```text
browser / CLI / node  ->  Cloudflare Access (identity)  ->  Tunnel  ->  127.0.0.1:18789
```

Access authenticates the request and injects identity headers. The Gateway does not
re-authenticate the person or verify the Access JWT signature; it checks the trusted
proxy source and configured header presence, then trusts the user header. Because
`allowLoopback` also lets other local processes present those headers, keep the Gateway
port private to the host and run only trusted workloads there.

## Step 1: Route the tunnel to loopback

Add an ingress rule mapping your hostname to the Gateway port, then run `cloudflared`
as a service on the Gateway host:

```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: gateway.example
    service: http://localhost:18789
  - service: http_status:404
```

See Cloudflare's own documentation for creating the tunnel and DNS record.

## Step 2: Protect the hostname with Access

Create an Access application for `gateway.example` with a policy that allows your
users. Note the two headers Access adds to authenticated requests, because the Gateway
consumes them in the next step:

- `cf-access-authenticated-user-email` — the authenticated identity.
- `cf-access-jwt-assertion` — Access's signed assertion. OpenClaw checks only that this
  header is present and non-blank; it does not verify the JWT signature.

### OIDC sign-in and existing people

For OIDC sign-in, configure an Access policy that admits the intended users through
that identity provider. For example, use a signed role claim maintained by the
provider. A GitHub organization policy applies to the GitHub identity provider;
it does not grant access through a separate OIDC provider.

OpenClaw verifies the OIDC identity through Cloudflare Access's identity endpoint
and requires its email to match the authenticated user header. It then resolves
that email through the existing person profile. Using the same email retains the
person's profile and role; a different email requires an existing linked alias to
resolve to that person. GitHub sign-in continues to verify the immutable GitHub
account ID. Failed identity verification does not fall back to email matching.

Keep the identity provider responsible for verifying email ownership. Creating an
OpenClaw person profile does not grant access through Cloudflare Access.

### Verified GitHub credit through OIDC

An OIDC provider can supply a verified GitHub account without changing the sign-in
email or the account used to publish pull requests. This is optional and disabled
until you explicitly trust one Access issuer, identity-provider ID, and claim name:

```json5
{
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        cloudflareAccessOidc: {
          issuer: "https://example.cloudflareaccess.com",
          providerId: "your-access-identity-provider-id",
          githubAccountIdClaim: "https://openclaw.ai/github-account-id",
        },
      },
    },
  },
}
```

The issuer is the Access team origin without a trailing slash. `providerId` is
the selected integration's ID from Access, not its name or an OIDC user subject.
The provider must verify ownership of the GitHub account and bind it to the
verified sign-in email. Its ID token must contain a canonical positive
decimal-string account ID, such as `"12345"`, within JavaScript's safe-integer
range. Configure Access to forward that exact [custom OIDC claim](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/#custom-oidc-claims).
OpenClaw reads it from `oidc_fields` in the Access identity response and verifies
the numeric account through GitHub to obtain its current public login.

A missing claim or an unselected issuer/provider keeps ordinary email-only
resolution. A malformed trusted claim or failed identity verification fails
identity enrichment instead of inventing credit. Existing email profiles retain
their identity, role, and saved co-author preference. A conflicting GitHub account
does not automatically merge profiles or move the email; an administrator must
resolve it through the existing `users.linkEmail` operation. This also applies
to a first-time email claiming an account that already belongs to another
profile: link that email explicitly before it can inherit the profile's role.
Explicitly linked secondary accounts retain the profile's primary account for public credit.
See [Gateway profiles and GitHub credit](/concepts/user-model#gateway-profile-and-github-credit).

## Step 3: Trust those headers in the Gateway

Set `gateway.auth.mode` to `trusted-proxy` and name the Access headers. `allowLoopback`
is required here: `cloudflared` connects from `127.0.0.1`, and trusted-proxy auth
otherwise expects a non-loopback proxy.

```json5
{
  gateway: {
    bind: "loopback",
    trustedProxies: ["127.0.0.1", "::1"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        allowLoopback: true,
      },
    },
  },
}
```

Requiring `cf-access-jwt-assertion` adds a second presence check, not cryptographic
verification. A local process that can connect to the Gateway can submit both headers,
so do not treat this setting as a defense against untrusted local code. The security
boundary is the locked-down loopback port plus Cloudflare Access and the tunnel being
the only path for external traffic.

## Step 4: Decide how nodes and workers get in

Access protects every route on the hostname, including the ones nodes use. A node can
authenticate to Access on every leg it needs — the join request, the main Gateway
WebSocket, the worker socket, and worker transfers — so the recommended path exposes
nothing publicly.

**Recommended: give the node an Access service token.** Add a Service Auth policy to the
application, then on the node host:

```bash
export CF_ACCESS_CLIENT_ID="<client-id>"
export CF_ACCESS_CLIENT_SECRET="<client-secret>"
openclaw connect https://gateway.example/j/<code> --service
```

`openclaw connect` persists these as env SecretRefs under
`gateway.cloudflareAccess.clientId` / `clientSecret`; see [Node CLI](/cli/node). The only
cost is that the node needs those two values before the join command, so a join link is no
longer paste-and-go on its own.

**Alternative: exempt the self-authenticating routes.** Allow `/j/*` and
`/__openclaw__/worker` without Access identity, keeping WebSocket upgrade enabled on the
worker route. Both enforce their own short-lived credentials — a join code is single-use
with a TTL, rate-limited per IP, and answers failures with an opaque 404; worker admission
carries its own expiring credential. This keeps join links paste-and-go, at the cost of
making those two routes publicly reachable. Prefer the service token unless you need that
onboarding flow. See [Nodes](/nodes/node-host#gateway-deployments-that-cannot-host-nodes).

If you do neither, `openclaw connect` fails against the tunnel even though the browser
works, because the join request is redirected to the Access login page.

## Step 5: Connect each client

**Control UI.** Open `https://gateway.example` and sign in through Access. With
trusted-proxy auth the Gateway maps your Access identity to an operator session.

If Access expires while a chat is open, the chat connection can remain active
while new image and file requests require renewed website access. The Control UI
first attempts automatic renewal through a hidden, sandboxed browser navigation.
If your global Cloudflare Access session is still valid and your browser permits
its cookies, Access can issue a fresh application cookie without another login.
OpenClaw verifies access before retrying failed attachments, keeping your
conversation and unsent draft open.

If renewal still requires sign-in, the Control UI opens one **Sign in to continue
loading content** dialog. An expired global session, an identity-provider challenge,
or blocked third-party cookies can require this manual step. Automatic renewal
does not extend the session durations configured in Cloudflare Access.
Choose **Sign in**, finish authentication in the new tab, and return to the
conversation. Visible failed attachments retry after access is verified; the
original conversation and unsent draft stay open. **Check again** repeats the
access check, and **Not now** dismisses the prompt without interrupting the chat.
Ordinary network failures and missing files do not trigger this dialog.

**CLI and TUI.** These do not carry browser cookies, so they present an Access token on
the WebSocket upgrade. Configure `gateway.remote.edgeAuth` as described in
[Remote access](/gateway/remote#gateway-behind-an-identity-aware-proxy), then run
`cloudflared access login https://gateway.example` once to cache a token.

**Nodes.** Follow the choice made in step 4.

## Verify

```bash
openclaw tui
```

Expect the TUI to reach `wss://gateway.example` and show `connected`. A first
connection may report `device pairing required`; approve it in the Control UI under
Settings → Devices, or run `openclaw devices approve --latest` on the Gateway host
to preview the request, then rerun the approval command it prints.

Reaching the Gateway's own pairing prompt is itself the proof that Access was
satisfied — an unauthenticated request never gets that far.

## Production readiness

- Keep `gateway.bind: "loopback"`. Binding wider re-exposes the Gateway beside the
  tunnel and bypasses Access entirely.
- Keep `trustedProxies` limited to loopback. It is the list of addresses whose identity
  headers the Gateway will believe.
- `trustedProxy.deviceAutoApprove` can pair devices automatically for
  Access-authenticated identities. It removes a manual approval step; enable it only
  when you accept that anyone who passes Access gets a paired device with the scopes you
  list.
- Access tokens expire on the application's session duration. Expect CLI users to re-run
  `cloudflared access login` when their token lapses.

## Troubleshooting

| Symptom                                                             | Cause and fix                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway rejected websocket upgrade (HTTP 302)` from the CLI or TUI | Access intercepted the upgrade. Configure `gateway.remote.edgeAuth`; see [Remote access](/gateway/remote#gateway-behind-an-identity-aware-proxy). |
| Browser works, `openclaw connect` fails                             | Node routes are still behind Access. Apply one of the options in step 4.                                                                          |
| `Exec provider ... exited with code 1`                              | The exec secret provider runs with a scrubbed environment; `cloudflared` needs `passEnv: ["HOME"]` to read its cached token.                      |
| `secrets.providers.*.command must not be a symlink`                 | Point `command` at the resolved binary, not a package-manager symlink.                                                                            |
| Gateway starts but every request is anonymous                       | `allowLoopback` is unset, so headers from the local `cloudflared` are ignored.                                                                    |

## Related

- [Remote access](/gateway/remote)
- [Trusted-proxy auth](/gateway/trusted-proxy-auth)
- [Nodes](/nodes)
- [Tailscale](/gateway/tailscale)
- [Authentication](/gateway/authentication)
