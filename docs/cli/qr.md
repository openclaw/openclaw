---
summary: "CLI reference for `openclaw qr` (generate mobile pairing QR + setup code)"
read_when:
  - You want to pair a mobile node app with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: "QR"
---

# `openclaw qr`

Generate a mobile pairing QR and setup code from your current Gateway configuration.

The legacy [`openclaw clawbot qr`](/cli/clawbot) alias accepts every flag below.

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --limited
openclaw qr --voice-node
openclaw qr --url wss://gateway.example/ws
```

Official OpenClaw iOS and Android apps connect automatically when their
setup-code metadata matches. If a request remains pending (for example, for a
non-official client or mismatched metadata), review and approve it:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

## Connect your phone without editing settings

If the Gateway is only reachable on this computer, run `openclaw qr` in an
interactive terminal. It offers **Same Wi-Fi or local network**, checks that an
address is available, and explains who will be able to connect.
Confirm to save the network settings and restart the Gateway. Once the phone
address is ready, the command continues with the QR code. Existing authentication
and unrelated settings, including the authored port, are preserved. A temporary
`OPENCLAW_GATEWAY_PORT` override is never saved to the configuration.

Local-network access listens on all interfaces: use a trusted network and keep
your firewall enabled. Plaintext LAN pairing still grants limited access.
This recovery does not enable Tailscale Serve or replace existing Tailscale
routes. Pairing through already configured Tailscale access or an explicit secure
`--url` remains supported. Cancel or select **Not now** before confirmation to
leave settings and the running Gateway unchanged.

Before changing settings and again after restart, recovery verifies that the
running Gateway owns the advertised port; a different service returning HTTP
200 is not sufficient. Default interactive LAN pairing repeats this check
before each setup code, including retries after a failed activation.
If a shell-only `OPENCLAW_GATEWAY_PORT` override points elsewhere, check or remove
that override before trying again.

If saving succeeds but restart, listener ownership, or readiness fails, the command explains how to
finish and does not issue a setup code. The saved settings remain in place; run
`openclaw gateway status` or `openclaw gateway restart`, then `openclaw qr` again.

Piped/noninteractive runs, `--json`, `--setup-code-only`, `--remote`, and explicit
URL or credential overrides never start this setup flow or change network
settings. Use an interactive `openclaw qr` first, or supply an already reachable
address with `--url`.

## Options

- `--remote`: prefer `gateway.remote.url` and remote credentials; fall back to Tailscale Serve/Funnel when the remote URL is unset. Ignores `device-pair` plugin `publicUrl`; explicit `--url` or `--public-url` still takes precedence.
- `--url <url>`: override the gateway URL used in the payload
- `--public-url <url>`: override the public URL used in the payload
- `--token <token>`: override the gateway token the bootstrap flow authenticates against
- `--password <password>`: override the gateway password the bootstrap flow authenticates against
- `--limited`: omit administrative Gateway access from the handed-off operator token
- `--voice-node`: issue node credentials plus only `operator.read` and `operator.talk`
- `--setup-code-only`: print only the setup code; `--json` takes precedence and emits the JSON document instead
- `--no-ascii`: skip ASCII QR rendering
- `--json`: emit JSON (`setupCode`, `gatewayUrl`, optional `gatewayUrls`, `auth`, `access`, optional `accessDowngraded`, `urlSource`)

`--token` and `--password` are mutually exclusive. `--limited` and `--voice-node` are mutually exclusive.

## Setup code contents

The setup code carries an opaque, short-lived `bootstrapToken`, not the shared gateway token/password. For a `wss://` endpoint (or same-host loopback), the default bootstrap flow issues:

- a primary `node` token with `scopes: []`
- a full native-mobile `operator` handoff token with `operator.admin`, `operator.approvals`, `operator.read`, `operator.talk.secrets`, and `operator.write`

Use `--limited` to keep the same node token while omitting `operator.admin` from the operator handoff. Pairing-mutation scope is never handed off by a setup code.

Use `--voice-node` for an embedded or room voice client. It keeps the node token and hands off a separate operator token limited to `operator.read` and `operator.talk`; it cannot send messages, mutate configuration, or invoke general write-scoped Gateway methods.

Plaintext LAN `ws://` setup remains available, but OpenClaw automatically uses
the limited profile because a network observer could capture and race the bearer
bootstrap token. Configure `wss://` or Tailscale Serve, then generate a new code
to get full access.

## Gateway URL resolution

Mobile pairing fails closed for Tailscale/public `ws://` gateway URLs: use Tailscale Serve/Funnel or a `wss://` gateway URL for those. Private LAN addresses and `.local` Bonjour hosts remain supported over plain `ws://`, with limited operator access as described above.

The QR command advertises Tailscale URLs only when OpenClaw owns the route through `gateway.tailscale.mode=serve|funnel`. Legacy external Serve routes that target the ordinary Gateway listener are not advertised because that listener rejects Tailscale-shaped proxy ingress.

If an older setup used `gateway.bind=lan` with a persistent default HTTPS Serve
route, run `openclaw doctor` to inspect it. Doctor does not migrate or clear the
route because its status cannot prove who owns it, even with `--fix`; if you
confirm it is stale, clear only its root handler, configure
`gateway.bind=loopback` plus `gateway.tailscale.mode=serve` manually, and restart
the Gateway. Custom Serve ports and retired named-Service routes require the
same manual cleanup; Doctor prints the relevant guidance.

Unless `--url` or `--public-url` is supplied, `--remote` requires either
`gateway.remote.url` or `gateway.tailscale.mode=serve|funnel` before URL resolution
runs. `gateway.publicOrigin` alone does not satisfy that prerequisite.

URL selection preserves existing routes: an explicit pairing override, a
preferred remote URL, Tailscale Serve/Funnel, a non-preferred remote URL, then
bind-derived addresses. For local QR setup, `gateway.publicOrigin` is the final
fallback before the loopback-only error. Without `--remote`, the configured
`plugins.entries.device-pair.config.publicUrl` supplies the override.
Unlike QR setup, [cloud enrollment](/gateway/cloud-workers) explicitly asks the
same resolver to prefer public ingress over discovery for fresh cloud workers.

QR setup, join codes, and cloud enrollment preserve context paths in fully
qualified URLs. The device-pair plugin's `/pair` command retains its historical
origin-only URLs, including when the configured `publicUrl` contains a path.

## Auth resolution (no `--remote`)

Gateways with `gateway.auth.mode="trusted-proxy"` can generate setup codes without a shared token or password.
The proxy still authenticates the mobile connection before it reaches the Gateway.
The setup code does not bypass Cloudflare Access or another proxy login.
Bootstrap expiry, device binding, and access profiles stay the same.

When no CLI auth override is passed, local gateway auth SecretRefs resolve as follows:

| Condition                                                                                                                    | Resolves                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `gateway.auth.mode="token"`, or inferred mode with no winning password source                                                | `gateway.auth.token`                      |
| `gateway.auth.mode="password"`, or inferred mode with no winning token from auth/env                                         | `gateway.auth.password`                   |
| Both `gateway.auth.token` and `gateway.auth.password` are configured (including SecretRefs) and `gateway.auth.mode` is unset | fails; set `gateway.auth.mode` explicitly |

## Auth resolution (`--remote`)

If effectively active remote credentials are configured as SecretRefs and neither `--token` nor `--password` is passed, the command resolves them from the active gateway snapshot. If the gateway is unavailable, the command fails fast.

<Note>
This command path requires a gateway that supports the `secrets.resolve` RPC method. Older gateways return an unknown-method error.
</Note>

## Related

- [CLI reference](/cli)
- [Devices](/cli/devices)
- [Pairing](/cli/pairing)
