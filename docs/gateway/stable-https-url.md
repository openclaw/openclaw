---
summary: "Give a loopback-only Gateway a stable, tailnet-only HTTPS URL with Tailscale Serve"
read_when:
  - Replacing per-client SSH tunnels with one private Gateway URL
  - Connecting macOS, iOS, or Android clients to a remote Gateway
  - Diagnosing a Tailscale Serve URL that works locally but times out remotely
title: "Give your Gateway a stable HTTPS URL"
---

Tailscale Serve gives your Gateway one HTTPS URL without exposing the Gateway port on your LAN or the public internet. The Gateway keeps listening on loopback, while Tailscale terminates HTTPS with a valid certificate and proxies requests to it.

The result is `https://<host>.<tailnet>.ts.net`, reachable from permitted devices on your tailnet and not from the public internet. The matching WebSocket URL is `wss://<host>.<tailnet>.ts.net`.

If you need a public URL, use [Tailscale Funnel](/gateway/tailscale#public-internet-funnel-%2B-shared-password) instead. Funnel is public, and OpenClaw requires password auth for it.

## Before you begin

You need:

- [MagicDNS](https://tailscale.com/docs/features/magicdns) enabled for your tailnet.
- [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) enabled in the Tailscale admin console under **DNS > HTTPS Certificates**.
- Tailscale installed and logged in on the Gateway host.
- The Gateway already configured with token, password, or trusted-proxy auth. Serve cannot be combined with `gateway.auth.mode: "none"`.

OpenClaw locates the Tailscale CLI automatically. It checks `tailscale` on `PATH`, the macOS app bundle at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, other matching app installations under `/Applications`, and the system locate database. You do not need to add the macOS app-bundle binary to `PATH`.

## 1. Enable Serve while keeping loopback bind

Run these commands on the Gateway host:

```bash
openclaw config set gateway.bind loopback
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

The equivalent configuration is:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: {
      mode: "serve",
    },
  },
}
```

OpenClaw configures Tailscale to serve HTTPS on port `443` and proxy to a private ephemeral loopback listener owned by the Gateway. The ordinary Gateway listener remains on `127.0.0.1:18789` by default for direct local clients.

### Optional identity-header auth

To explicitly allow Tailscale identity headers for Control UI WebSocket auth:

```bash
openclaw config set gateway.auth.allowTailscale true
```

For Serve with token auth, OpenClaw enables this behavior by default unless you set it to `false`. Password and trusted-proxy modes keep their explicit auth boundary unless you opt in.

This setting lets a verified Tailscale identity satisfy the Control UI WebSocket shared-secret check. OpenClaw verifies the forwarded client address with `tailscale whois` and matches it to the `tailscale-user-login` header. It applies only when the request arrives through Serve on OpenClaw's dedicated managed-Tailscale listener with the expected forwarded headers.

It does not authenticate HTTP API endpoints, remove browser device identity requirements, authenticate node-role connections, or bypass node pairing. See [Tailscale identity headers](/gateway/tailscale#tailscale-identity-headers-serve-only) for the full contract.

## 2. Allow HTTPS in your tailnet policy

Tailscale access controls apply to Serve. If your tailnet has a restrictive policy, allow the client devices to reach the Gateway host on TCP port `443`.

Without this grant, the Serve URL can work on the Gateway host but time out silently from every other device. That symptom looks like a broken Gateway even though the tailnet policy is blocking the connection.

Use the form that matches your tailnet policy file.

### Modern grants policy

Add this object to the existing `grants` array:

```json
{
  "src": ["autogroup:member"],
  "dst": ["<gateway-host-or-ip>"],
  "ip": ["tcp:443"]
}
```

For example, replace `<gateway-host-or-ip>` with a host alias defined in your policy, such as `gateway-host`, or with an address such as `100.x.y.z`.

### Older ACL policy

Add this object to the existing `acls` array:

```json
{
  "action": "accept",
  "src": ["autogroup:member"],
  "dst": ["<gateway-host-or-ip>:443"]
}
```

`autogroup:member` allows every authenticated tailnet member. For a tighter policy, replace it with a narrower user, group, tag, or device selector that covers only the clients that need Gateway access. See the Tailscale documentation for [grants](https://tailscale.com/docs/features/access-control/grants) and [ACLs](https://tailscale.com/docs/features/access-control/acls).

## 3. Verify the route and loopback boundary

On the Gateway host, confirm that Serve is active:

```bash
tailscale serve status
```

The output should show an HTTPS route for `https://<host>.<tailnet>.ts.net` proxying to a private ephemeral loopback port owned by the Gateway.

From another device on the same tailnet, check the HTTPS response:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/
```

Expect `200` for the Control UI root. If this request times out but the same command returns `200` on the Gateway host, check the TCP `443` grant in the previous step first.

Finally, prove that the Gateway process did not open its own port to the network:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

For the default port, replace `<port>` with `18789`. The Gateway listener should be on `127.0.0.1:<port>`, not `0.0.0.0:<port>` or a LAN or tailnet address. Tailscale owns the HTTPS listener and proxy path.

## 4. Use the URL from clients

### macOS app

In the OpenClaw macOS app:

1. Open **Settings > Connection**.
2. Set **OpenClaw runs** to **Remote (another host)**.
3. Set **Transport** to **Direct (ws/wss)**.
4. Enter `wss://<host>.<tailnet>.ts.net` in **Gateway URL**.
5. Select **Test remote**.

The app now connects directly through Tailscale Serve, so the per-client SSH tunnel is no longer needed.

### iOS and Android companion apps

The iOS and Android apps connect directly to the Gateway WebSocket and do not manage an SSH-tunnel transport. Use the same `wss://<host>.<tailnet>.ts.net` endpoint when pairing or generating a setup code. This gives mobile clients a secure route they can use from anywhere on the tailnet.

See [iOS app setup](/platforms/ios) and [Android connection setup](/platforms/android#connection-runbook) for their pairing steps.

## Troubleshooting

### Serve startup reports non-interactive sudo failed

The Gateway cannot answer a sudo password prompt. On the Gateway host, grant Tailscale operator access to the user that runs the Gateway. If that is your current shell user, run this once in an interactive terminal:

```bash
sudo tailscale set --operator=$USER
openclaw gateway restart
```

If the Gateway runs as a different user, replace `$USER` with that account. Then check `tailscale serve status` again. See [Tailscale prerequisites and limits](/gateway/tailscale#tailscale-prerequisites-and-limits).

### The phone cannot resolve the Serve hostname

Confirm that Tailscale is connected on the phone and that its **Use Tailscale DNS** setting is enabled, as well as MagicDNS in the tailnet admin console. Retry the full `https://<host>.<tailnet>.ts.net` URL in the phone's browser before troubleshooting OpenClaw authentication. If the hostname resolves but the request times out, check the TCP `443` policy grant below.

### The URL times out from other devices

Run the same `curl` command on the Gateway host. If the host returns `200` while other tailnet devices time out, add or narrow the tailnet policy grant for TCP `443`.

### The certificate is not issued or the first request is slow

Confirm that MagicDNS and HTTPS certificates are enabled in the Tailscale admin console. Initial certificate issuance can make the first HTTPS request take longer; let it finish, then retry.

### The serve command is unavailable

Update Tailscale and confirm that your installed client build exposes the current `tailscale serve` command. The Serve CLI changed in Tailscale 1.52. See the [Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

### Tailscale identity headers are not accepted

Confirm that `gateway.auth.allowTailscale` is `true` and that the request arrives through the Serve URL. Direct loopback, LAN, raw tailnet-IP, and custom reverse-proxy requests do not qualify for Tailscale identity-header auth.

### Android says Connected (operator offline) although the browser works

Android uses separate operator and node connections. This status means the node is connected while the operator connection used for chat and UI actions is offline. Browser access through Tailscale identity headers does not establish Android operator authentication or device approval.

1. Open **Settings → Gateway** and read the authentication or pairing error for the selected Gateway.
2. For **Gateway token needed**, enter the required Gateway token or edit the connection. For an invalid saved credential or setup code, generate a fresh mobile setup code in **Control UI → Devices → Pair device** or with `openclaw qr`, using the secure `wss://<host>.<tailnet>.ts.net` endpoint. In **Settings → Gateway → Manual Gateway → Replace setup**, paste the code, tap **Connect**, and review the confirmation. Replacement clears saved setup credentials and device tokens and may require node approval again; **Add Gateway** retains an existing Gateway's credentials.
3. If approval is requested, review and approve the device using the displayed instructions. Node approval and operator access are separate; approving the node alone does not resolve an operator authentication failure.
4. Tap **Reconnect** and confirm that the operator connection is online.

See [Android connection setup](/platforms/android#connection-runbook) for setup codes, authentication, and pairing steps. A missing token requires restoring the credential; this symptom alone does not explain why it was missing.

## Related

- [Tailscale reference](/gateway/tailscale)
- [Remote access](/gateway/remote)
- [Gateway authentication](/gateway/authentication)
