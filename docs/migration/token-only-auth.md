# Migrating from `dangerouslyDisableDeviceAuth` to Per-Origin `tokenOnlyAuth`

## Background

The gateway Control UI normally requires **device identity** (Web Crypto API)
for authentication. This only works in secure contexts (HTTPS or localhost).
When the Control UI is accessed through a reverse proxy over plain HTTP on a
private LAN, browser SubtleCrypto is unavailable and device identity cannot be
established.

The legacy `gateway.controlUi.dangerouslyDisableDeviceAuth` flag was introduced
as a global escape hatch — it disables device identity checks for **all**
Control UI origins. This is overly broad and the flag name implies danger even
when the deployment is perfectly safe (e.g. a trusted LAN dashboard).

## What Changed

A new **per-origin** `tokenOnlyAuth` option was added to
`gateway.controlUi.allowedOrigins` entries. When `tokenOnlyAuth: true` is set
on an origin entry, connections from that origin are authenticated by
token/password only — device identity is not required.

This provides the same functionality as `dangerouslyDisableDeviceAuth` but
scoped to specific trusted origins instead of applying globally.

## Migration Steps

### Before (deprecated)

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["https://dash.example.com", "http://10.0.0.50:3001"],
      "dangerouslyDisableDeviceAuth": true,
      "allowInsecureAuth": true
    }
  }
}
```

### After (recommended)

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "https://dash.example.com",
        {
          "origin": "http://10.0.0.50:3001",
          "tokenOnlyAuth": true
        }
      ],
      "allowInsecureAuth": true
    }
  }
}
```

### Mixed origins

You can mix plain string origins (which require device identity) with
`tokenOnlyAuth` object entries in the same array:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "https://secure-ui.example.com",
        {
          "origin": "https://internal-dash.lan:3005",
          "tokenOnlyAuth": true
        },
        {
          "origin": "http://10.30.0.32:3001",
          "tokenOnlyAuth": true
        }
      ]
    }
  }
}
```

In this example:

- `https://secure-ui.example.com` — full device identity required (HTTPS
  provides the secure context for Web Crypto)
- `https://internal-dash.lan:3005` — token-only auth (no device identity
  needed)
- `http://10.30.0.32:3001` — token-only auth (HTTP on private LAN, device
  identity unavailable)

## How It Works

When a Control UI WebSocket connection is established:

1. The gateway checks the `Origin` header against `allowedOrigins`
2. If the matched entry has `tokenOnlyAuth: true`, device identity checks are
   skipped for that connection
3. The connection must still provide a valid gateway token or password
4. Device pairing is also skipped for `tokenOnlyAuth` origins (since there is
   no device identity to pair)

## Security Considerations

- **Only use `tokenOnlyAuth` for origins you fully trust.** Without device
  identity, any client that knows the gateway token can connect from that
  origin.
- **Prefer HTTPS origins when possible.** HTTPS provides a secure context for
  Web Crypto, making `tokenOnlyAuth` unnecessary.
- **Keep your gateway token/password strong.** With `tokenOnlyAuth`, the token
  is the sole authentication factor.
- **The security audit (`openclaw security audit`) will flag both the
  deprecated flag and per-origin `tokenOnlyAuth` entries** so you can track
  which origins skip device identity.

## Deprecation Timeline

`dangerouslyDisableDeviceAuth` is deprecated and will emit a warning at gateway
startup. It continues to work as before (both the global flag and per-origin
`tokenOnlyAuth` are checked). A future major version may remove the flag
entirely.

## Verification

After migrating, run `openclaw security audit` to confirm:

- The `gateway.control_ui.device_auth_disabled` critical finding is gone
- A `gateway.control_ui.per_origin_token_only_auth` warning appears listing
  your `tokenOnlyAuth` origins (this is expected and informational)
