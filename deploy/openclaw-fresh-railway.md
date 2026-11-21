# Fresh OpenClaw on Railway

The production destination is the Open-System Railway project's production
environment. Provision a separate service named `open-claw-fresh` and attach a
fresh persistent volume at `/home/node/.openclaw`. Keep the existing OpenClaw
service and volume available while validating the replacement. The legacy
Zeabur release deployment and Hermes remain independent.

## Service bindings

- Use the published `hillstreet/open-claw` image at a verified SHA-256 digest.
- Set `PORT` and `OPENCLAW_GATEWAY_PORT` to `18789`. Use a foreground LAN gateway
  listener and set the Railway domain target port to the same value.
- Set `OPENCLAW_STATE_DIR=/home/node/.openclaw`. Store the local gateway config
  on that volume. A PostgreSQL-backed gateway still keeps local credentials and
  database anchors there.
- Set a new `OPENCLAW_GATEWAY_TOKEN` in Railway Variables. Use a token-authenticated
  local-mode gateway. Allow the direct hostname during validation and the
  exact custom origin `https://open-claw.open-system.space` for cutover.
- Confirm the Open Platform Supabase project independently. Bind the dedicated
  PostgreSQL runtime role's TLS DSN as `OPENCLAW_DATABASE_DSN`, using direct or
  session-mode connectivity. Select a fresh OpenClaw schema prefix and verify
  the role and extensions against the [PostgreSQL guide](../docs/gateway/postgresql.md).
  No old SQLite files are needed for a fresh setup.
- Bind the Open-Connect provider credential in Railway and verify a
  model request through the configured Open-Connect gateway.

## GitHub Actions deployment

Create the GitHub environment `openclaw-fresh-production`. Set its
`OPENCLAW_DESTINATION_RAILWAY_TOKEN` secret using a Railway project token
scoped to the Open-System production environment. Set
`OPENCLAW_FRESH_SERVICE_ID` to the new service ID and
`OPENCLAW_FRESH_HEALTH_URL` to that service's direct HTTPS `/healthz` URL.

From main, dispatch the [fresh Railway workflow](../.github/workflows/openclaw-fresh-railway.yml)
with the published digest and the deployment switch off. After preflight
passes, dispatch with deployment enabled. The workflow checks the Railway
deployment status and the direct health endpoint.

Verify dashboard authentication and a model response before attaching the
custom hostname in Railway and updating the Cloudflare route. Check the same
flows over the custom hostname, then verify a controlled restart retains the
new state. Keep application release telemetry and external integrations
unverified until their own project bindings and smoke checks pass.
