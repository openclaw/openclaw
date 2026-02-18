---
summary: "Expose the Gateway via Cloudflare Tunnel with Cloudflare Access authentication"
read_when:
  - setting up Cloudflare Tunnel for remote access
  - configuring Cloudflare Access authentication
  - running openclaw behind cloudflared
title: "Cloudflare"
---

# Cloudflare Tunnel & Access

OpenClaw can integrate with Cloudflare Tunnel and Cloudflare Access to expose the
Gateway securely over the internet with identity-aware authentication.

## Modes

- `managed`: OpenClaw spawns and manages a `cloudflared tunnel run` process using a
  tunnel token. Also verifies Cloudflare Access JWTs for authentication.
- `access-only`: You run `cloudflared` externally (e.g. via systemd, Docker sidecar,
  or Cloudflare's managed connector). OpenClaw only verifies incoming Cloudflare Access
  JWT headers.
- `off`: Default (no Cloudflare integration).

## Setup: Managed mode

Use managed mode when OpenClaw and `cloudflared` run on the same machine and you want
OpenClaw to manage the tunnel lifecycle.

### 1. Create a Cloudflare Tunnel

1. Go to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** > **Tunnels** > **Create a tunnel**
3. Choose **Cloudflared** as the connector type
4. Give your tunnel a name (e.g. `openclaw`)
5. On the **Install and run connectors** step, copy the tunnel token from the install
   command — it's the long `eyJ...` string after `--token`

### 2. Add a public hostname

Still in the tunnel configuration:

1. Go to the **Public Hostnames** tab
2. Click **Add a public hostname**
3. Set:
   - **Subdomain**: e.g. `openclaw`
   - **Domain**: pick one of your Cloudflare domains
   - **Service type**: `HTTP`
   - **URL**: `localhost:18789` (the default Gateway port)
4. Save the hostname

### 3. (Optional) Create a Cloudflare Access application

To require identity verification via Cloudflare Access:

1. In Zero Trust, go to **Access** > **Applications** > **Add an application**
2. Choose **Self-hosted**
3. Set the application domain to match the public hostname from step 2
4. Configure an access policy (e.g. allow specific email addresses)
5. Note your **team domain** (visible in **Settings** > **Custom Pages**, or from
   your `<team>.cloudflareaccess.com` URL)
6. Optionally copy the **Application Audience (AUD) tag** from the application's
   overview page

### 4. Configure OpenClaw

```json5
{
  gateway: {
    bind: "loopback",
    cloudflare: {
      mode: "managed",
      tunnelToken: "eyJ...", // or use OPENCLAW_CLOUDFLARE_TUNNEL_TOKEN env var
      teamDomain: "myteam",
      audience: "abc123...", // optional Application Audience tag
    },
  },
}
```

OpenClaw will spawn `cloudflared tunnel run`, which connects to the Cloudflare edge
and routes traffic to your local Gateway port.

### 5. Install cloudflared

The `cloudflared` binary must be available on the machine. Install it from
[Cloudflare's docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Setup: Access-only mode (Docker / external cloudflared)

Use this when you manage `cloudflared` yourself — e.g. as a Docker sidecar, a systemd
service, or Cloudflare's managed connector. This is the recommended approach for
Docker deployments.

### 1. Create a tunnel and public hostname

Follow steps 1-3 from the managed mode setup above, but set the **Service URL** to
point to the OpenClaw container by its Docker Compose service name:

- **Service type**: `HTTP`
- **URL**: `openclaw-gateway:18789` (Docker Compose) or `localhost:18789` (same host)

### 2. Run cloudflared externally

**Docker Compose example:**

```yaml
services:
  openclaw-gateway:
    image: openclaw:latest
    command:
      [
        "node",
        "openclaw.mjs",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--cloudflare",
        "access-only",
        "--cloudflare-team-domain",
        "myteam",
      ]

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: "eyJ..." # your tunnel token
    depends_on:
      - openclaw-gateway
```

**Systemd / bare-metal:** run `cloudflared tunnel run --token <TOKEN>` as a service,
pointing to `http://localhost:18789`.

### 3. Configure OpenClaw

```json5
{
  gateway: {
    bind: "lan", // "lan" when cloudflared runs in a separate container
    cloudflare: {
      mode: "access-only",
      teamDomain: "myteam",
      audience: "abc123...", // optional
    },
  },
}
```

## Authentication

When cloudflare mode is active, OpenClaw verifies the `Cf-Access-Jwt-Assertion`
header on incoming requests. The JWT is validated against the JWKS endpoint at
`https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`.

Verification checks:

- JWT signature (RS256/ES256 via JWKS)
- Expiry (`exp` claim)
- Issuer (`iss` must match `https://<teamDomain>.cloudflareaccess.com`)
- Audience (`aud` must match configured audience, if set)

On success, the user's email from the JWT `email` claim is used as the authenticated
identity (auth method: `cloudflare-access`).

### Auth interaction

By default, `allowCloudflareAccess` is `true` when cloudflare mode is `managed` or
`access-only` (unless auth mode is `trusted-proxy`). Cloudflare Access JWT
verification runs after Tailscale identity checks and before token/password auth.

The gateway still generates a pairing token on first start. You can use either the
Cloudflare Access identity (automatic via the JWT header) or the pairing token to
authenticate.

To disable Cloudflare Access identity and require explicit credentials:

```json5
{
  gateway: {
    cloudflare: { mode: "managed" /* ... */ },
    auth: { allowCloudflareAccess: false },
  },
}
```

## CLI examples

```bash
# Managed mode
openclaw gateway --cloudflare managed \
  --cloudflare-tunnel-token "eyJ..." \
  --cloudflare-team-domain myteam

# Access-only mode
openclaw gateway --cloudflare access-only \
  --cloudflare-team-domain myteam \
  --cloudflare-audience "abc123..."
```

## Environment variables

| Variable                           | Description                                               |
| ---------------------------------- | --------------------------------------------------------- |
| `OPENCLAW_CLOUDFLARE_TUNNEL_TOKEN` | Tunnel token for managed mode (alternative to config/CLI) |

## Configuration reference

| Field                                | Type                                      | Required              | Description                              |
| ------------------------------------ | ----------------------------------------- | --------------------- | ---------------------------------------- |
| `gateway.cloudflare.mode`            | `"off"` \| `"managed"` \| `"access-only"` | No                    | Cloudflare mode (default: `off`)         |
| `gateway.cloudflare.tunnelToken`     | string                                    | Managed only          | Tunnel token from Zero Trust dashboard   |
| `gateway.cloudflare.teamDomain`      | string                                    | Managed + Access-only | Team domain for JWKS endpoint            |
| `gateway.cloudflare.audience`        | string                                    | No                    | Application Audience (AUD) tag           |
| `gateway.auth.allowCloudflareAccess` | boolean                                   | No                    | Allow CF Access JWT auth (default: auto) |

## Validation rules

| Mode          | Requires                     | Bind     | Notes                            |
| ------------- | ---------------------------- | -------- | -------------------------------- |
| `off`         | nothing                      | any      | Default                          |
| `managed`     | `tunnelToken` + `teamDomain` | loopback | cloudflared proxies to localhost |
| `access-only` | `teamDomain`                 | any      | External cloudflared expected    |

## Learn more

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [Zero Trust dashboard](https://one.dash.cloudflare.com/)
