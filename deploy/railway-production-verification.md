# OpenClaw production verification

The OpenClaw destination uses `open-claw.open-system.space`. The separate
`open-system.space` hostname belongs to Hermes Agent.

## Start the destination gateway

In the destination service's Railway shell, confirm the active state directory
is the mounted OpenClaw volume and check the persisted gateway mode. If Doctor
reports an unset mode, set it once on that volume:

```bash
openclaw config set gateway.mode local
```

This command writes configuration and exits. Remove any Railway start-command
override that runs only the config command. For source builds the gateway
start command is defined in [railway.toml](../railway.toml). For a published
image, verify the Railway override or image command runs the gateway in the
foreground, binds to the LAN interface, and listens on Railway's `PORT`.
Ensure gateway authentication is configured before enabling public traffic.

Keep Railway's domain target port aligned with the gateway listener. Verify
the direct Railway hostname and its `/healthz` endpoint before changing the
custom domain. Preserve the original service and state until restored sessions
and workspace files have been verified on the destination.

## Verify the public routes

```bash
curl -fsS --max-time 15 https://open-system.space/api/status
curl -fsS --max-time 15 https://open-claw.open-system.space/healthz
```

Confirm the Hermes status response reports `gateway_running: true`. For
OpenClaw, confirm health on both the direct and custom hostnames and sign in
to the Control UI. Send a test message through the configured model provider
and verify it returns a response. Check restored sessions and workspace files
before cutover. Validate optional integrations only when they are configured
for this deployment, using the service's secret bindings.

Railway's `Application not found` response indicates that the edge did not
route the request to the application. Check deployment readiness, service
domain attachment, and the target port. If direct health passes while the
custom hostname fails, check DNS and TLS for the custom hostname separately.
